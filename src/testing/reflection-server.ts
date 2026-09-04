/**
 * Test upstream: a real @grpc/grpc-js server that serves one application
 * service plus gRPC server reflection (v1 and/or v1alpha), answering the
 * reflection requests morpheus sends (spec 4.7.6). Used by unit and
 * integration tests; not shipped in the runtime bundle.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  REFLECTION_PROTOCOLS,
  reflectionProtoSource,
  type ReflectionProtocol,
} from '../grpc/reflection-proto.js';

export interface ReflectionUpstreamOptions {
  /** `.proto` source of the application API served by the fake upstream. */
  protoSource: string;
  /** Fully qualified service name defined in `protoSource`, e.g. `demo.TimeService`. */
  serviceName: string;
  handlers: grpc.UntypedServiceImplementation;
  /** Reflection protocols to serve (default: both). Empty = no reflection at all. */
  protocols?: ReflectionProtocol[];
  /** Delay before answering each reflection request (timeout tests). */
  reflectionDelayMs?: number;
  /** Extra service names to report from list_services (they resolve to no files). */
  extraServiceNames?: string[];
  /**
   * Answer NOT_FOUND for every file_containing_symbol, like a server whose
   * services are hand-written without registered proto files.
   */
  unresolvable?: boolean;
}

export interface ReflectionRequestRecord {
  protocol: ReflectionProtocol;
  request: Record<string, unknown>;
  metadata: grpc.Metadata;
}

export interface ReflectionUpstream {
  port: number;
  /** `127.0.0.1:<port>` — the authority morpheus queries. */
  target: string;
  server: grpc.Server;
  /** Every reflection request received, in order. */
  reflectionRequests: ReflectionRequestRecord[];
  /** Serialized FileDescriptorProtos of the application proto, dependencies included. */
  fileDescriptorProtos: Buffer[];
  packageDefinition: protoLoader.PackageDefinition;
  close(): void;
}

const PACKAGE: Record<ReflectionProtocol, string> = {
  'grpc-v1': 'grpc.reflection.v1',
  'grpc-v1alpha': 'grpc.reflection.v1alpha',
};

/** Message / enum entries of a package definition carry the serialized descriptors. */
function isTypeDefinition(
  value: protoLoader.AnyDefinition,
): value is protoLoader.MessageTypeDefinition<object, object> | protoLoader.EnumTypeDefinition {
  return typeof value === 'object' && value !== null && 'fileDescriptorProtos' in value;
}

/** Service entries are plain maps of method definitions (no `format` / descriptors). */
function isServiceDefinition(value: protoLoader.AnyDefinition): value is protoLoader.ServiceDefinition {
  if (typeof value !== 'object' || value === null || isTypeDefinition(value)) return false;
  const methods = Object.values(value as Record<string, unknown>);
  return (
    methods.length > 0 &&
    methods.every((m) => typeof m === 'object' && m !== null && 'path' in m && 'requestStream' in m)
  );
}

export async function startReflectionUpstream(
  opts: ReflectionUpstreamOptions,
): Promise<ReflectionUpstream> {
  const dir = mkdtempSync(join(tmpdir(), 'morpheus-reflection-upstream-'));
  const appProtoPath = join(dir, 'app.proto');
  writeFileSync(appProtoPath, opts.protoSource);
  const packageDefinition = protoLoader.loadSync(appProtoPath, { keepCase: true, oneofs: true });
  const serviceDefinition = packageDefinition[opts.serviceName];
  if (serviceDefinition === undefined || !isServiceDefinition(serviceDefinition)) {
    throw new Error(`service ${opts.serviceName} is not defined in protoSource`);
  }
  const appPackage = opts.serviceName.split('.').slice(0, -1).join('.');
  // Every message type of the file shares the same descriptor list (the file
  // plus its dependencies), so any type in the application package will do.
  const typeDefinition = Object.entries(packageDefinition).find(
    ([name, definition]) =>
      isTypeDefinition(definition) && (appPackage === '' || name.startsWith(`${appPackage}.`)),
  )?.[1];
  if (typeDefinition === undefined || !isTypeDefinition(typeDefinition)) {
    throw new Error(`protoSource defines no message types in package ${appPackage}`);
  }
  const fileDescriptorProtos = typeDefinition.fileDescriptorProtos;
  const appServiceNames = Object.entries(packageDefinition)
    .filter(([, definition]) => isServiceDefinition(definition))
    .map(([name]) => name);
  // Symbols the server can resolve: its services and message / enum types.
  const knownSymbols = new Set(Object.keys(packageDefinition));
  const protocols = opts.protocols ?? [...REFLECTION_PROTOCOLS];
  const listedServices = [
    ...appServiceNames,
    ...(opts.extraServiceNames ?? []),
    ...protocols.map((p) => `${PACKAGE[p]}.ServerReflection`),
  ];

  const server = new grpc.Server();
  server.addService(serviceDefinition, opts.handlers);
  const reflectionRequests: ReflectionRequestRecord[] = [];

  const answer = (request: Record<string, unknown>): Record<string, unknown> => {
    const base = { valid_host: '', original_request: request };
    switch (request['message_request']) {
      case 'list_services':
        return {
          ...base,
          list_services_response: { service: listedServices.map((name) => ({ name })) },
        };
      case 'file_containing_symbol': {
        const symbol = String(request['file_containing_symbol']);
        if (opts.unresolvable !== true && knownSymbols.has(symbol)) {
          return { ...base, file_descriptor_response: { file_descriptor_proto: fileDescriptorProtos } };
        }
        return { ...base, error_response: { error_code: 5, error_message: `Symbol not found: ${symbol}` } };
      }
      default:
        return {
          ...base,
          error_response: { error_code: 12, error_message: 'not supported by the test server' },
        };
    }
  };

  for (const protocol of protocols) {
    const protoPath = join(dir, `${protocol}.proto`);
    writeFileSync(protoPath, reflectionProtoSource(protocol));
    const definition = protoLoader.loadSync(protoPath, { keepCase: true, oneofs: true });
    const reflectionService = definition[`${PACKAGE[protocol]}.ServerReflection`];
    if (reflectionService === undefined || !isServiceDefinition(reflectionService)) {
      throw new Error(`reflection service definition missing for ${protocol}`);
    }
    server.addService(reflectionService, {
      ServerReflectionInfo: (call: grpc.ServerDuplexStream<Record<string, unknown>, Record<string, unknown>>) => {
        call.on('data', (request: Record<string, unknown>) => {
          reflectionRequests.push({ protocol, request, metadata: call.metadata });
          const respond = (): void => {
            call.write(answer(request));
          };
          if (opts.reflectionDelayMs !== undefined && opts.reflectionDelayMs > 0) {
            setTimeout(respond, opts.reflectionDelayMs);
          } else {
            respond();
          }
        });
        call.on('end', () => {
          if (opts.reflectionDelayMs !== undefined && opts.reflectionDelayMs > 0) {
            setTimeout(() => call.end(), opts.reflectionDelayMs);
          } else {
            call.end();
          }
        });
      },
    });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolve(bound),
    );
  });
  return {
    port,
    target: `127.0.0.1:${port}`,
    server,
    reflectionRequests,
    fileDescriptorProtos,
    packageDefinition,
    close: () => server.forceShutdown(),
  };
}
