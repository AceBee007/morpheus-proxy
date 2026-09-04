/**
 * gRPC Server Reflection client (spec 4.7.6).
 *
 * Fetches the protobuf descriptors an upstream serves through
 * `grpc.reflection.v1.ServerReflection` (falling back to `v1alpha`) and
 * assembles them into a `FileDescriptorSet` the descriptor registry can load.
 * This is the same discovery mechanism grpcurl, buf curl and Postman use, so it
 * works against any gRPC server that enabled reflection — not only the ones in
 * a particular environment.
 */
import protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor/index.js';
import { headerValue } from '../proxy/headers.js';
import {
  sendToUpstream,
  UpstreamError,
  type UpstreamReply,
  type UpstreamTarget,
} from '../proxy/upstream.js';
import type { HeaderMap } from '../rules/matcher.js';
import { decodeGrpcFrames, encodeGrpcFrame, GrpcFrameError } from './frames.js';
import {
  isInfrastructureService,
  REFLECTION_PROTOCOLS,
  reflectionMethodPath,
  reflectionTypes,
  type ReflectionProtocol,
} from './reflection-proto.js';

const FileDescriptorProto = (descriptorExt as unknown as { FileDescriptorProto: protobuf.Type })
  .FileDescriptorProto;

export type ReflectionFailureReason =
  | 'invalid_target'
  | 'unimplemented'
  | 'unavailable'
  | 'timeout'
  | 'rejected'
  | 'not_found'
  | 'no_services'
  | 'too_large'
  | 'invalid';

export class ReflectionError extends Error {
  constructor(
    readonly reason: ReflectionFailureReason,
    readonly target: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReflectionError';
  }
}

export interface ReflectionFetchOptions {
  /** Upstream `host:port` to query (the CONNECT authority or a reverse upstream). */
  target: string;
  /**
   * Fully qualified service names to import. When omitted, every service the
   * server lists (except reflection / health / channelz) is imported.
   */
  symbols?: string[];
  /** Deadline for each reflection RPC (headers + body). */
  timeoutMs: number;
  /** Upper bound on the total descriptor bytes accepted from the server. */
  maxBytes: number;
  /** Extra request metadata, e.g. credentials for an authenticated reflection service. */
  metadata?: Record<string, string>;
  /** Protocols to try, in order. Defaults to v1 then v1alpha. */
  protocols?: readonly ReflectionProtocol[];
}

export interface ReflectionFetchResult {
  target: string;
  protocol: ReflectionProtocol;
  /** Services whose descriptors are in the set. */
  services: string[];
  /**
   * Services the server listed but could not resolve (`file_containing_symbol`
   * answered NOT_FOUND — e.g. hand-written service descriptors without a
   * registered proto file). Only populated for discovered services; explicitly
   * requested symbols that are missing fail the fetch instead.
   */
  missing: string[];
  /** File names contained in the descriptor set (dependencies included). */
  files: string[];
  /** Serialized `google.protobuf.FileDescriptorSet`. */
  descriptorSet: Buffer;
}

const USER_AGENT = 'morpheus-proxy (reflection-import)';

/** Metadata the caller may not override: it is owned by the transport. */
const RESERVED_METADATA = new Set([
  'content-type',
  'te',
  'user-agent',
  'host',
  'connection',
  'grpc-timeout',
  'grpc-encoding',
  'grpc-accept-encoding',
]);

const GRPC_STATUS = {
  OK: 0,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  UNIMPLEMENTED: 12,
  UNAVAILABLE: 14,
} as const;

/** Parses `host:port` (IPv6 in brackets) into an h2c upstream target. */
export function parseReflectionTarget(target: string): UpstreamTarget {
  const match = /^(?:\[([^\]]+)\]|([^:/\s[\]]+)):(\d{1,5})$/.exec(target.trim());
  const host = match?.[1] ?? match?.[2];
  const port = match ? Number(match[3]) : Number.NaN;
  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ReflectionError(
      'invalid_target',
      target,
      `reflection target must be host:port (got ${JSON.stringify(target)})`,
    );
  }
  return { kind: 'h2c', host, port };
}

interface ReflectionResponse {
  error_response?: { error_code?: number; error_message?: string };
  list_services_response?: { service?: Array<{ name?: string }> };
  file_descriptor_response?: { file_descriptor_proto?: Uint8Array[] };
}

function grpcStatusOf(headers: HeaderMap, trailers: HeaderMap): { status?: number; message?: string } {
  const raw = headerValue(trailers, 'grpc-status') ?? headerValue(headers, 'grpc-status');
  const rawMessage = headerValue(trailers, 'grpc-message') ?? headerValue(headers, 'grpc-message');
  const result: { status?: number; message?: string } = {};
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed)) result.status = parsed;
  }
  if (rawMessage !== undefined) {
    try {
      result.message = decodeURIComponent(rawMessage);
    } catch {
      result.message = rawMessage;
    }
  }
  return result;
}

function requestMetadata(opts: ReflectionFetchOptions): HeaderMap {
  const headers: HeaderMap = {
    'content-type': 'application/grpc',
    te: 'trailers',
    'user-agent': USER_AGENT,
  };
  for (const [name, value] of Object.entries(opts.metadata ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || RESERVED_METADATA.has(lower)) continue;
    headers[lower] = value;
  }
  return headers;
}

/** Reads the whole reply body within the deadline and the size limit. */
function readReply(
  reply: UpstreamReply,
  target: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reply.stream.destroy();
        reject(
          new ReflectionError(
            'timeout',
            target,
            `reflection response from ${target} did not complete within ${timeoutMs}ms`,
          ),
        );
      });
    }, timeoutMs);
    reply.stream.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        finish(() => {
          reply.stream.destroy();
          reject(
            new ReflectionError(
              'too_large',
              target,
              `reflection response from ${target} exceeds ${maxBytes} bytes`,
            ),
          );
        });
        return;
      }
      chunks.push(chunk);
    });
    reply.stream.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
    reply.stream.on('error', (err: Error) =>
      finish(() =>
        reject(new ReflectionError('unavailable', target, `reflection stream error: ${err.message}`)),
      ),
    );
  });
}

/**
 * Performs one ServerReflectionInfo exchange: a single request message on a
 * fresh stream, then every response message the server sends before closing.
 * (The RPC is bidirectional streaming, but one request per stream is enough
 * and keeps the client stateless; servers answer each request independently.)
 */
async function callReflection(
  upstream: UpstreamTarget,
  target: string,
  protocol: ReflectionProtocol,
  request: Record<string, unknown>,
  opts: ReflectionFetchOptions,
): Promise<ReflectionResponse[]> {
  const types = reflectionTypes(protocol);
  const body = encodeGrpcFrame(
    Buffer.from(types.request.encode(types.request.fromObject(request)).finish()),
  );
  let reply: UpstreamReply;
  try {
    reply = await sendToUpstream(upstream, {
      method: 'POST',
      path: reflectionMethodPath(protocol),
      authority: target,
      headers: requestMetadata(opts),
      body,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      throw new ReflectionError(
        err.reason === 'timeout' ? 'timeout' : 'unavailable',
        target,
        `reflection call to ${target} failed: ${err.message}`,
      );
    }
    throw err;
  }
  const raw = await readReply(reply, target, opts.timeoutMs, opts.maxBytes);
  if (reply.statusCode !== 200) {
    throw new ReflectionError(
      'rejected',
      target,
      `reflection call to ${target} answered HTTP ${reply.statusCode}`,
    );
  }
  const { status, message } = grpcStatusOf(reply.headers, reply.trailers());
  if (status === undefined) {
    throw new ReflectionError('rejected', target, `reflection call to ${target} returned no grpc-status`);
  }
  if (status === GRPC_STATUS.UNIMPLEMENTED) {
    throw new ReflectionError(
      'unimplemented',
      target,
      `${target} does not implement ${reflectionMethodPath(protocol)}`,
    );
  }
  if (status !== GRPC_STATUS.OK) {
    const reason: ReflectionFailureReason =
      status === GRPC_STATUS.UNAVAILABLE
        ? 'unavailable'
        : status === GRPC_STATUS.DEADLINE_EXCEEDED
          ? 'timeout'
          : 'rejected';
    throw new ReflectionError(
      reason,
      target,
      `reflection call to ${target} failed with grpc-status ${status}${message ? ` (${message})` : ''}`,
    );
  }
  let frames;
  try {
    frames = decodeGrpcFrames(raw);
  } catch (err) {
    if (err instanceof GrpcFrameError) {
      throw new ReflectionError('invalid', target, `malformed reflection response: ${err.message}`);
    }
    throw err;
  }
  return frames.map((frame) => {
    if (frame.compressed) {
      throw new ReflectionError(
        'invalid',
        target,
        'compressed reflection responses are not supported',
      );
    }
    try {
      return types.response.toObject(types.response.decode(frame.message), {
        longs: Number,
        enums: String,
      });
    } catch (err) {
      throw new ReflectionError(
        'invalid',
        target,
        `undecodable reflection response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

function errorOf(target: string, symbol: string, response: ReflectionResponse): ReflectionError | null {
  const error = response.error_response;
  if (!error) return null;
  const code = error.error_code ?? -1;
  return new ReflectionError(
    code === GRPC_STATUS.NOT_FOUND ? 'not_found' : 'rejected',
    target,
    `reflection error for ${symbol}: ${code} ${error.error_message ?? ''}`.trim(),
  );
}

function rejectOnError(target: string, symbol: string, response: ReflectionResponse): void {
  const error = errorOf(target, symbol, response);
  if (error) throw error;
}

async function fetchWithProtocol(
  upstream: UpstreamTarget,
  protocol: ReflectionProtocol,
  opts: ReflectionFetchOptions,
): Promise<ReflectionFetchResult> {
  const target = opts.target.trim();
  const call = (request: Record<string, unknown>): Promise<ReflectionResponse[]> =>
    callReflection(upstream, target, protocol, request, opts);

  let symbols = (opts.symbols ?? []).map((s) => s.trim()).filter((s) => s !== '');
  const explicit = symbols.length > 0;
  if (!explicit) {
    const responses = await call({ list_services: '' });
    for (const response of responses) rejectOnError(target, 'list_services', response);
    const listed = responses.find((r) => r.list_services_response)?.list_services_response;
    symbols = (listed?.service ?? [])
      .map((s) => s.name ?? '')
      .filter((name) => name !== '' && !isInfrastructureService(name));
    if (symbols.length === 0) {
      throw new ReflectionError(
        'no_services',
        target,
        `${target} lists no importable services (only reflection / health / channelz)`,
      );
    }
  }

  // Each file_containing_symbol answer carries the file plus its transitive
  // dependencies; symbols sharing files therefore overlap, so dedupe by name
  // while keeping the exact bytes the server sent.
  const files = new Map<string, Uint8Array>();
  const imported: string[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const symbol of symbols) {
    const responses = await call({ file_containing_symbol: symbol });
    // A server may list a service it cannot resolve (no registered proto file).
    // For discovered services that is skipped so the rest still imports;
    // an explicitly requested symbol that is missing is an error.
    const notFound = responses.find(
      (response) => errorOf(target, symbol, response)?.reason === 'not_found',
    );
    if (notFound !== undefined && !explicit) {
      missing.push(symbol);
      continue;
    }
    imported.push(symbol);
    for (const response of responses) {
      rejectOnError(target, symbol, response);
      for (const bytes of response.file_descriptor_response?.file_descriptor_proto ?? []) {
        let name: string | undefined;
        try {
          name = (FileDescriptorProto.decode(bytes) as unknown as { name?: string }).name;
        } catch (err) {
          throw new ReflectionError(
            'invalid',
            target,
            `undecodable FileDescriptorProto for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (name === undefined || name === '') {
          throw new ReflectionError('invalid', target, `FileDescriptorProto for ${symbol} has no name`);
        }
        if (files.has(name)) continue;
        total += bytes.byteLength;
        if (total > opts.maxBytes) {
          throw new ReflectionError(
            'too_large',
            target,
            `descriptors from ${target} exceed ${opts.maxBytes} bytes`,
          );
        }
        files.set(name, bytes);
      }
    }
  }
  if (files.size === 0) {
    if (missing.length > 0) {
      throw new ReflectionError(
        'not_found',
        target,
        `${target} lists ${missing.join(', ')} but resolves none of them (no registered proto files?)`,
      );
    }
    throw new ReflectionError('invalid', target, `${target} returned no file descriptors`);
  }

  // FileDescriptorSet { repeated FileDescriptorProto file = 1; } — written as
  // length-delimited field 1 entries so the server's bytes stay byte-identical.
  const writer = protobuf.Writer.create();
  for (const bytes of files.values()) writer.uint32(0x0a).bytes(bytes);
  return {
    target,
    protocol,
    services: imported,
    missing,
    files: [...files.keys()],
    descriptorSet: Buffer.from(writer.finish()),
  };
}

/**
 * Fetches descriptors from `target` via server reflection, trying the
 * protocols in order and moving on when a protocol is UNIMPLEMENTED.
 */
export async function fetchDescriptorsViaReflection(
  opts: ReflectionFetchOptions,
): Promise<ReflectionFetchResult> {
  const upstream = parseReflectionTarget(opts.target);
  const protocols = opts.protocols ?? REFLECTION_PROTOCOLS;
  let unimplemented: ReflectionError | undefined;
  for (const protocol of protocols) {
    try {
      return await fetchWithProtocol(upstream, protocol, opts);
    } catch (err) {
      if (err instanceof ReflectionError && err.reason === 'unimplemented') {
        unimplemented = err;
        continue;
      }
      throw err;
    }
  }
  throw (
    unimplemented ??
    new ReflectionError('unimplemented', opts.target, 'no reflection protocol configured')
  );
}
