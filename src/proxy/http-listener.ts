import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { fromNodeHeaders, toOutgoingHeaders } from './headers.js';
import { parseUpstream } from './upstream.js';
import { handleHttpExchange, type HttpExchange, type ProxyRuntime } from './pipeline.js';

export const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'ascii');

export interface StartedListener {
  name: string;
  port: number;
  address: string;
  activeConnections(): number;
  close(): Promise<void>;
}

function clientOf(socket: net.Socket): string {
  return `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
}

export function h1Exchange(req: http.IncomingMessage, res: http.ServerResponse): HttpExchange {
  res.sendDate = false;
  let responded = false;
  return {
    method: req.method ?? 'GET',
    rawPath: req.url ?? '/',
    authority: req.headers.host ?? '',
    headers: fromNodeHeaders(req.headers),
    bodyStream: req,
    client: clientOf(req.socket),
    respond(status, headers, body) {
      if (responded) return;
      responded = true;
      try {
        res.writeHead(status, toOutgoingHeaders(headers));
        if (body !== undefined && req.method !== 'HEAD' && status !== 204 && status !== 304) {
          res.end(body);
        } else {
          res.end();
        }
      } catch {
        res.destroy();
      }
    },
    respondStream(status, headers, stream) {
      if (responded) return;
      responded = true;
      try {
        res.writeHead(status, toOutgoingHeaders(headers));
      } catch {
        res.destroy();
        stream.destroy();
        return;
      }
      stream.pipe(res);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
    },
    destroy(reset) {
      responded = true;
      if (reset) {
        req.socket.resetAndDestroy();
      } else {
        req.socket.destroy();
      }
    },
    isDestroyed() {
      return req.socket.destroyed || res.destroyed;
    },
  };
}

export function h2Exchange(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): HttpExchange {
  let responded = false;
  return {
    method: String(headers[':method'] ?? 'GET'),
    rawPath: String(headers[':path'] ?? '/'),
    authority: String(headers[':authority'] ?? headers['host'] ?? ''),
    headers: fromNodeHeaders(headers),
    bodyStream: stream,
    client: clientOf(stream.session?.socket as net.Socket),
    respond(status, outHeaders, body) {
      if (responded || stream.destroyed) return;
      responded = true;
      try {
        const flat: http2.OutgoingHttpHeaders = { ':status': status };
        for (const [name, value] of Object.entries(outHeaders)) {
          const lower = name.toLowerCase();
          if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') {
            continue;
          }
          flat[lower] = value;
        }
        stream.respond(flat);
        stream.end(body);
      } catch {
        stream.destroy();
      }
    },
    respondStream(status, outHeaders, body) {
      if (responded || stream.destroyed) return;
      responded = true;
      try {
        const flat: http2.OutgoingHttpHeaders = { ':status': status };
        for (const [name, value] of Object.entries(outHeaders)) {
          const lower = name.toLowerCase();
          if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') {
            continue;
          }
          flat[lower] = value;
        }
        stream.respond(flat);
        body.pipe(stream);
        body.on('error', () => stream.destroy());
        stream.on('close', () => body.destroy());
      } catch {
        stream.destroy();
      }
    },
    destroy(reset) {
      responded = true;
      const socket = stream.session?.socket as net.Socket | undefined;
      if (reset && socket) {
        socket.resetAndDestroy();
      } else if (socket) {
        socket.destroy();
      } else {
        stream.destroy();
      }
    },
    isDestroyed() {
      return stream.destroyed;
    },
  };
}

/** Rebuilds the HTTP/1.1 request head for an Upgrade tunnel (spec 4.1.1). */
function rebuildRequestHead(req: http.IncomingMessage): string {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Starts an HTTP listener: a TCP server that sniffs the HTTP/2 cleartext
 * preface and dispatches each connection to an HTTP/1.1 or HTTP/2 server
 * (spec 3.5). WebSocket/Upgrade requests bypass rules as byte passthrough.
 */
export function startHttpListener(runtime: ProxyRuntime): Promise<StartedListener> {
  const { listener, limits, appLog } = runtime;
  const connections = new Set<net.Socket>();

  const handleError = (err: unknown, where: string): void => {
    appLog.error(`http listener error in ${where}`, { error: String(err) });
  };

  const httpServer = http.createServer((req, res) => {
    handleHttpExchange(runtime, h1Exchange(req, res)).catch((err: unknown) => {
      handleError(err, 'h1 handler');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_internal_error' }));
      } else {
        res.destroy();
      }
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const target = parseUpstream(listener.upstream);
    const upstreamSocket = net.connect(target.port, target.host, () => {
      upstreamSocket.write(rebuildRequestHead(req));
      if (head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    // No half-open tunnels: answer a peer FIN with our own so both sides close.
    socket.on('end', () => socket.end());
    upstreamSocket.on('end', () => upstreamSocket.end());
  });

  const http2Server = http2.createServer();
  http2Server.on('stream', (stream, headers) => {
    handleHttpExchange(runtime, h2Exchange(stream, headers)).catch((err: unknown) => {
      handleError(err, 'h2 handler');
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
  http2Server.on('sessionError', (err) => handleError(err, 'h2 session'));

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
    socket.once('readable', () => {
      const chunk = socket.read() as Buffer | null;
      if (chunk === null || chunk.length === 0) {
        socket.destroy();
        return;
      }
      socket.unshift(chunk);
      const sample = chunk.subarray(0, H2_PREFACE.length);
      const isH2 =
        sample.length >= 4 && H2_PREFACE.subarray(0, sample.length).equals(sample);
      if (isH2) {
        http2Server.emit('connection', socket);
      } else {
        httpServer.emit('connection', socket);
      }
    });
  });

  return new Promise((resolve, reject) => {
    netServer.once('error', reject);
    netServer.listen(listener.port, listener.host, () => {
      const address = netServer.address() as net.AddressInfo;
      appLog.info(`listener "${listener.name}" started`, {
        protocol: listener.protocol,
        port: address.port,
        upstream: listener.upstream,
      });
      resolve({
        name: listener.name,
        port: address.port,
        address: address.address,
        activeConnections: () => connections.size,
        close: () =>
          new Promise<void>((res) => {
            for (const socket of connections) socket.destroy();
            // httpServer/http2Server never listen themselves (connections are
            // injected), so only the TCP server's close callback is reliable.
            try {
              httpServer.close();
            } catch {
              /* not running */
            }
            try {
              http2Server.close();
            } catch {
              /* not running */
            }
            netServer.close(() => res());
          }),
      });
    });
  });
}
