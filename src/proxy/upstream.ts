import http from 'node:http';
import http2 from 'node:http2';
import { Readable } from 'node:stream';
import type { HeaderMap } from '../rules/matcher.js';
import { fromNodeHeaders, toOutgoingHeaders } from './headers.js';

export interface UpstreamTarget {
  kind: 'http' | 'h2c';
  host: string;
  port: number;
}

export function parseUpstream(url: string): UpstreamTarget {
  const match = /^(http|h2c):\/\/([^/:]+)(?::(\d+))?\/?$/.exec(url);
  if (!match) throw new Error(`unsupported upstream URL: ${url}`);
  const kind = match[1] as 'http' | 'h2c';
  return {
    kind,
    host: match[2] as string,
    port: match[3] !== undefined ? Number(match[3]) : kind === 'http' ? 80 : 80,
  };
}

export type UpstreamFailureReason = 'connect_failed' | 'timeout' | 'reset';

export class UpstreamError extends Error {
  constructor(
    readonly reason: UpstreamFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamRequestInit {
  method: string;
  /** Path including the query string. */
  path: string;
  /** Original Host / :authority, forwarded unchanged (spec 4.1.1). */
  authority: string;
  /** Hop-by-hop headers already stripped. */
  headers: HeaderMap;
  body?: Buffer | Readable;
  /** Time allowed until response headers arrive. */
  timeoutMs: number;
}

export interface UpstreamReply {
  statusCode: number;
  headers: HeaderMap;
  stream: Readable;
  /** Available after `stream` ends (HTTP trailers / gRPC trailers). */
  trailers: () => HeaderMap;
}

function classifyError(err: NodeJS.ErrnoException): UpstreamFailureReason {
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'connect_failed';
    case 'ETIMEDOUT':
      return 'timeout';
    default:
      return 'reset';
  }
}

function sendHttp1(target: UpstreamTarget, init: UpstreamRequestInit): Promise<UpstreamReply> {
  return new Promise((resolve, reject) => {
    const headers = toOutgoingHeaders(init.headers);
    headers['host'] = init.authority;
    if (Buffer.isBuffer(init.body)) headers['content-length'] = String(init.body.byteLength);
    const req = http.request({
      host: target.host,
      port: target.port,
      method: init.method,
      path: init.path,
      headers,
      setHost: false,
    });
    let settled = false;
    const fail = (error: UpstreamError): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    req.setTimeout(init.timeoutMs, () => {
      fail(new UpstreamError('timeout', `upstream did not respond within ${init.timeoutMs}ms`));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      fail(new UpstreamError(classifyError(err), err.message));
    });
    req.on('response', (res) => {
      settled = true;
      req.setTimeout(0);
      resolve({
        statusCode: res.statusCode ?? 502,
        headers: fromNodeHeaders(res.headers),
        stream: res,
        trailers: () => fromNodeHeaders(res.trailers),
      });
    });
    if (Buffer.isBuffer(init.body)) {
      req.end(init.body);
    } else if (init.body) {
      init.body.pipe(req);
      init.body.on('error', () => req.destroy());
    } else {
      req.end();
    }
  });
}

function sendH2c(target: UpstreamTarget, init: UpstreamRequestInit): Promise<UpstreamReply> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://${target.host}:${target.port}`);
    let settled = false;
    const fail = (error: UpstreamError): void => {
      if (settled) return;
      settled = true;
      session.close();
      reject(error);
    };
    session.on('error', (err: NodeJS.ErrnoException) => {
      fail(new UpstreamError(classifyError(err), err.message));
    });
    const timer = setTimeout(() => {
      fail(new UpstreamError('timeout', `upstream did not respond within ${init.timeoutMs}ms`));
    }, init.timeoutMs);

    const requestHeaders: http2.OutgoingHttpHeaders = {
      ':method': init.method,
      ':path': init.path,
      ':authority': init.authority,
      ':scheme': 'http',
    };
    for (const [name, value] of Object.entries(init.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'keep-alive') continue;
      requestHeaders[lower] = value;
    }

    const stream = session.request(requestHeaders, {
      endStream: init.body === undefined,
    });
    let trailers: HeaderMap = {};
    stream.on('trailers', (incoming) => {
      trailers = fromNodeHeaders(incoming);
    });
    stream.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new UpstreamError(classifyError(err), err.message));
    });
    stream.on('response', (incoming) => {
      settled = true;
      clearTimeout(timer);
      const statusCode = Number(incoming[':status'] ?? 502);
      stream.on('close', () => session.close());
      resolve({
        statusCode,
        headers: fromNodeHeaders(incoming),
        stream: stream as unknown as Readable,
        trailers: () => trailers,
      });
    });
    if (Buffer.isBuffer(init.body)) {
      stream.end(init.body);
    } else if (init.body) {
      init.body.pipe(stream);
      init.body.on('error', () => stream.destroy());
    }
  });
}

/**
 * Forwards a request to the upstream (spec 4.1). `http://` upstreams use
 * HTTP/1.1, `h2c://` upstreams use HTTP/2 cleartext. Throws UpstreamError
 * when no response could be obtained; upstream responses are returned as-is
 * even when they carry errors (spec 4.1.2).
 */
export async function sendToUpstream(
  target: UpstreamTarget,
  init: UpstreamRequestInit,
): Promise<UpstreamReply> {
  return target.kind === 'h2c' ? sendH2c(target, init) : sendHttp1(target, init);
}
