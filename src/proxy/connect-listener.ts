import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { DescriptorRegistry } from '../grpc/descriptors.js';
import { grpcStreamHandler, type GrpcRuntime } from '../grpc/grpc-listener.js';
import { H2_PREFACE, h1Exchange, h2Exchange, type StartedListener } from './http-listener.js';
import { handleHttpExchange, type ProxyRuntime } from './pipeline.js';

/** Runtime for a CONNECT listener. `descriptors` is required for gRPC. */
export interface ConnectRuntime extends ProxyRuntime {
  descriptors?: DescriptorRegistry;
}

/** Cap the CONNECT request head to avoid unbounded buffering before the tunnel. */
const CONNECT_HEAD_LIMIT = 8192;

/** Extracts the `host:port` authority from a `CONNECT host:port HTTP/1.1` line. */
function parseConnectAuthority(head: Buffer): string | null {
  const firstLine = head.toString('latin1').split('\r\n', 1)[0] ?? '';
  const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
  return match ? (match[1] ?? null) : null;
}

/**
 * Starts a CONNECT listener (spec 4.14). It accepts HTTP CONNECT tunnels from a
 * client configured with a proxy (e.g. grpc-go `GRPC_PROXY_ADDR`, Go net/http
 * `HTTPS_PROXY`), answers `200 Connection Established`, then hands the tunnelled
 * plaintext h2c/HTTP connection to the normal proxy pipeline with a
 * per-connection upstream taken from the CONNECT authority. One listener can
 * therefore intercept a client's outbound calls to many downstreams without
 * rewriting each downstream address.
 */
export function startConnectListener(runtime: ConnectRuntime): Promise<StartedListener> {
  const { listener, limits, appLog } = runtime;
  const connections = new Set<net.Socket>();

  const dispatchGrpc = (socket: net.Socket, authority: string): void => {
    const descriptors = runtime.descriptors;
    if (!descriptors) {
      appLog.error('connect listener: gRPC requires a descriptor registry', {
        listener: listener.name,
      });
      socket.destroy();
      return;
    }
    const connRuntime: GrpcRuntime = {
      ...runtime,
      descriptors,
      listener: { ...listener, upstream: `h2c://${authority}` },
    };
    const server = http2.createServer();
    server.on('stream', grpcStreamHandler(connRuntime));
    server.on('sessionError', (err) =>
      appLog.error('connect grpc session error', { error: String(err) }),
    );
    server.on('error', (err) => appLog.error('connect grpc server error', { error: String(err) }));
    socket.on('close', () => {
      try {
        server.close();
      } catch {
        /* not running */
      }
    });
    server.emit('connection', socket);
  };

  const dispatchHttp = (socket: net.Socket, authority: string): void => {
    // Sniff the tunnelled protocol just like the reverse HTTP listener: an
    // h2c preface means HTTP/2, otherwise HTTP/1.1. The forwarded scheme
    // mirrors the client so the upstream sees the same protocol.
    socket.once('readable', () => {
      const chunk = socket.read() as Buffer | null;
      if (chunk === null || chunk.length === 0) {
        socket.destroy();
        return;
      }
      socket.unshift(chunk);
      const sample = chunk.subarray(0, H2_PREFACE.length);
      const isH2 = sample.length >= 4 && H2_PREFACE.subarray(0, sample.length).equals(sample);
      if (isH2) {
        const connRuntime: ProxyRuntime = {
          ...runtime,
          listener: { ...listener, upstream: `h2c://${authority}` },
        };
        const server = http2.createServer();
        server.on('stream', (stream, headers) => {
          handleHttpExchange(connRuntime, h2Exchange(stream, headers)).catch((err: unknown) => {
            appLog.error('connect h2 handler error', { error: String(err) });
            if (!stream.headersSent && !stream.destroyed) {
              try {
                stream.respond({ ':status': 500, 'content-type': 'application/json' });
                stream.end(JSON.stringify({ error: 'proxy_internal_error' }));
              } catch {
                stream.destroy();
              }
            } else {
              stream.destroy();
            }
          });
        });
        server.on('sessionError', (err) =>
          appLog.error('connect h2 session error', { error: String(err) }),
        );
        socket.on('close', () => {
          try {
            server.close();
          } catch {
            /* not running */
          }
        });
        server.emit('connection', socket);
      } else {
        const connRuntime: ProxyRuntime = {
          ...runtime,
          listener: { ...listener, upstream: `http://${authority}` },
        };
        const server = http.createServer((req, res) => {
          handleHttpExchange(connRuntime, h1Exchange(req, res)).catch((err: unknown) => {
            appLog.error('connect h1 handler error', { error: String(err) });
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'proxy_internal_error' }));
            } else {
              res.destroy();
            }
          });
        });
        socket.on('close', () => {
          try {
            server.close();
          } catch {
            /* not running */
          }
        });
        server.emit('connection', socket);
      }
    });
  };

  const handleTunnel = (socket: net.Socket, authority: string): void => {
    if (listener.protocol === 'grpc') dispatchGrpc(socket, authority);
    else dispatchHttp(socket, authority);
  };

  const netServer = net.createServer((socket) => {
    if (connections.size >= limits.maxConcurrentConnections) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {
      /* handled by close */
    });

    // Read the CONNECT request head (up to the blank line) without consuming
    // any tunnel bytes that arrive in the same segment.
    let head: Buffer = Buffer.alloc(0);
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) {
        head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end !== -1) {
          socket.removeListener('readable', onReadable);
          const authority = parseConnectAuthority(head.subarray(0, end));
          const leftover = head.subarray(end + 4);
          if (authority === null) {
            socket.end('HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\n\r\n');
            return;
          }
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (leftover.length > 0) socket.unshift(leftover);
          handleTunnel(socket, authority);
          return;
        }
        if (head.length > CONNECT_HEAD_LIMIT) {
          socket.destroy();
          return;
        }
      }
    };
    socket.on('readable', onReadable);
  });

  return new Promise((resolve, reject) => {
    netServer.once('error', reject);
    netServer.listen(listener.port, listener.host, () => {
      const address = netServer.address() as net.AddressInfo;
      appLog.info(`listener "${listener.name}" started`, {
        protocol: listener.protocol,
        mode: 'connect',
        port: address.port,
      });
      resolve({
        name: listener.name,
        port: address.port,
        address: address.address,
        activeConnections: () => connections.size,
        close: () =>
          new Promise<void>((res) => {
            for (const socket of connections) socket.destroy();
            netServer.close(() => res());
          }),
      });
    });
  });
}
