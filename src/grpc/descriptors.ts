import { randomUUID } from 'node:crypto';
import protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor/index.js';

// The descriptor extension ships without usable typings: the module is a
// protobuf Root carrying descriptor.proto types, and it augments Root with
// fromDescriptor/toDescriptor at load time.
const FileDescriptorSet = (descriptorExt as unknown as { FileDescriptorSet: protobuf.Type })
  .FileDescriptorSet;
const RootWithDescriptor = protobuf.Root as unknown as {
  fromDescriptor(set: protobuf.Message | Uint8Array): protobuf.Root;
};

export interface DescriptorMethodInfo {
  name: string;
  requestType: string;
  responseType: string;
  requestStream: boolean;
  responseStream: boolean;
}

export interface DescriptorServiceInfo {
  fullName: string;
  methods: DescriptorMethodInfo[];
}

export interface RegisteredDescriptor {
  id: string;
  name: string;
  format: 'descriptor_set' | 'proto_source';
  services: DescriptorServiceInfo[];
  createdAt: string;
}

export interface ResolvedMethod {
  service: string;
  method: string;
  requestStream: boolean;
  responseStream: boolean;
  requestType: protobuf.Type;
  responseType: protobuf.Type;
}

export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescriptorError';
  }
}

interface StoredDescriptor {
  info: RegisteredDescriptor;
  root: protobuf.Root;
}

function collectServices(root: protobuf.Root): DescriptorServiceInfo[] {
  const services: DescriptorServiceInfo[] = [];
  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Service) {
        services.push({
          fullName: nested.fullName.replace(/^\./, ''),
          methods: nested.methodsArray.map((method) => ({
            name: method.name,
            requestType: method.requestType,
            responseType: method.responseType,
            requestStream: method.requestStream === true,
            responseStream: method.responseStream === true,
          })),
        });
      }
      if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(root);
  return services;
}

/**
 * Global registry of protobuf descriptors (spec 4.7.3). gRPC bodies can only
 * be decoded/encoded/logged when a registered descriptor covers the method.
 */
export class DescriptorRegistry {
  private readonly stored = new Map<string, StoredDescriptor>();

  list(): RegisteredDescriptor[] {
    return [...this.stored.values()].map((d) => d.info);
  }

  /**
   * Registers a descriptor. `content` is base64 for descriptor_set, UTF-8
   * proto source for proto_source. Throws DescriptorError when the input
   * cannot be parsed or defines no service (spec 4.7.3 validation).
   */
  add(input: { name: string; format: 'descriptor_set' | 'proto_source'; content: string }): RegisteredDescriptor {
    let root: protobuf.Root;
    if (input.format === 'descriptor_set') {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(input.content, 'base64');
      } catch {
        throw new DescriptorError('content must be base64-encoded FileDescriptorSet bytes');
      }
      try {
        const set = FileDescriptorSet.decode(bytes);
        root = RootWithDescriptor.fromDescriptor(set);
      } catch (err) {
        throw new DescriptorError(
          `failed to decode FileDescriptorSet: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      try {
        root = new protobuf.Root();
        // protobuf.parse does not resolve imports. Well-known types
        // (google/protobuf/*.proto) ship with protobufjs, so pre-register the
        // ones the source imports; anything else still fails at resolveAll
        // with a clear "unresolved" error (spec 4.7.3).
        for (const match of input.content.matchAll(/import\s+(?:public\s+)?"([^"]+)"\s*;/g)) {
          const common = protobuf.common.get(match[1] as string);
          if (common?.nested) root.addJSON(common.nested);
        }
        protobuf.parse(input.content, root, { keepCase: true });
      } catch (err) {
        throw new DescriptorError(
          `failed to parse .proto source: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      root.resolveAll();
    } catch (err) {
      throw new DescriptorError(
        `descriptor has unresolved references: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const services = collectServices(root);
    if (services.length === 0) {
      throw new DescriptorError('descriptor defines no service');
    }
    const info: RegisteredDescriptor = {
      id: `desc-${randomUUID().slice(0, 8)}`,
      name: input.name,
      format: input.format,
      services,
      createdAt: new Date().toISOString(),
    };
    this.stored.set(info.id, { info, root });
    return info;
  }

  remove(id: string): boolean {
    return this.stored.delete(id);
  }

  get(id: string): RegisteredDescriptor | undefined {
    return this.stored.get(id)?.info;
  }

  hasAny(): boolean {
    return this.stored.size > 0;
  }

  /** Resolves a gRPC :path (/pkg.Service/Method) against all descriptors. */
  lookupMethod(path: string): ResolvedMethod | null {
    const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
    if (!match) return null;
    const serviceName = match[1] as string;
    const methodName = match[2] as string;
    for (const { root } of this.stored.values()) {
      let service: protobuf.Service;
      try {
        service = root.lookupService(serviceName);
      } catch {
        continue;
      }
      const method = service.methods[methodName];
      if (!method) continue;
      method.resolve();
      const requestType = method.resolvedRequestType;
      const responseType = method.resolvedResponseType;
      if (!requestType || !responseType) continue;
      return {
        service: serviceName,
        method: methodName,
        requestStream: method.requestStream === true,
        responseStream: method.responseStream === true,
        requestType,
        responseType,
      };
    }
    return null;
  }

  /** Decodes a protobuf message to a plain JSON object. */
  decodeMessage(type: protobuf.Type, buffer: Buffer): unknown {
    const decoded = type.decode(buffer);
    return type.toObject(decoded, { longs: String, enums: String, bytes: String });
  }

  /** Encodes a JSON mapping to protobuf bytes, verifying it first (spec 4.7.3). */
  encodeMessage(type: protobuf.Type, value: unknown): Buffer {
    if (typeof value !== 'object' || value === null) {
      throw new DescriptorError('gRPC message body must be a JSON object');
    }
    const problem = type.verify(value);
    if (problem !== null) {
      throw new DescriptorError(`message does not match ${type.fullName}: ${problem}`);
    }
    return Buffer.from(type.encode(type.fromObject(value as Record<string, unknown>)).finish());
  }
}
