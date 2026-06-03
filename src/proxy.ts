import * as fs from 'node:fs';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import * as path from 'node:path';

type ProxyMode = 'tcp-forward' | 'http-connect' | 'grpc-early-return';

type ForwardConfig = {
  name: string;
  listenPort: number;
  listenHost: string;
  target: string;
};

type ConnectProxyConfig = {
  name: string;
  listenPort: number;
  listenHost: string;
};

type GrpcEarlyReturnConfig = {
  name: string;
  listenPort: number;
  listenHost: string;
  grpcPath: string;
  responseValue: string;
};

type Address = {
  host: string;
  port: number;
};

type ConnectRequest = {
  method: 'CONNECT';
  target: string;
  protocol: string;
  headers: Record<string, string>;
};

type LoggerMeta = {
  id: string;
  startedAt: string;
  requestPath: string;
  responsePath: string;
  mode: ProxyMode;
  target: string;
  client: string;
  connectRequest?: ConnectRequest;
  grpcPath?: string;
  earlyReturned?: boolean;
  error?: string;
  clientError?: string;
  upstreamError?: string;
  closedAt?: string;
};

type ConnectionLogger = {
  meta: LoggerMeta;
  request: fs.WriteStream;
  response: fs.WriteStream;
  closed?: boolean;
  writeMeta: () => void;
  close: () => void;
};

const logDir = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs', 'morpheus-proxy');
const maxConnectHeaderBytes = numberEnv('MAX_CONNECT_HEADER_BYTES', 8192);

fs.mkdirSync(logDir, { recursive: true });

let connectionSeq = 0;

function main(): void {
  const forwards: ForwardConfig[] = [
    {
      name: 'inbound-http',
      listenPort: numberEnv('HTTP_FORWARD_LISTEN_PORT', 18080),
      listenHost: process.env.HTTP_FORWARD_LISTEN_HOST ?? '0.0.0.0',
      target: env('HTTP_FORWARD_TARGET', '127.0.0.1:8080')
    },
    {
      name: 'inbound-grpc',
      listenPort: numberEnv('GRPC_FORWARD_LISTEN_PORT', 15051),
      listenHost: process.env.GRPC_FORWARD_LISTEN_HOST ?? '0.0.0.0',
      target: env('GRPC_FORWARD_TARGET', '127.0.0.1:50051')
    }
  ];

  for (const forward of forwards) {
    startTcpForward(forward);
  }

  startConnectProxy({
    name: 'outbound-connect',
    listenHost: process.env.CONNECT_LISTEN_HOST ?? '0.0.0.0',
    listenPort: numberEnv('CONNECT_LISTEN_PORT', 15000)
  });

  startGrpcEarlyReturnServer({
    name: 'animal-sound-early-return',
    listenHost: process.env.ANIMAL_SOUND_LISTEN_HOST ?? '0.0.0.0',
    listenPort: numberEnv('ANIMAL_SOUND_LISTEN_PORT', 15052),
    grpcPath: env('ANIMAL_SOUND_GRPC_PATH', '/demo.AnimalSoundService/Sound'),
    responseValue: env('ANIMAL_SOUND_DUMMY_VALUE', 'Dummy')
  });
}

function startTcpForward(config: ForwardConfig): void {
  const target = parseAddress(config.target);
  const server = net.createServer((client) => {
    const logger = createConnectionLogger(config.name, {
      mode: 'tcp-forward',
      target: config.target,
      client: remoteAddress(client)
    });

    const upstream = net.connect(target.port, target.host);
    bridge(client, upstream, logger);
  });

  server.on('error', (err) => {
    console.error(`[${config.name}] listen error:`, err);
    process.exitCode = 1;
  });

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[${config.name}] forwarding ${config.listenHost}:${config.listenPort} -> ${config.target}`);
  });
}

function startConnectProxy(config: ConnectProxyConfig): void {
  const server = net.createServer((client) => {
    let buffered = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');

      if (buffered.length > maxConnectHeaderBytes) {
        client.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
        return;
      }

      if (headerEnd === -1) {
        return;
      }

      client.off('data', onData);
      const header = buffered.subarray(0, headerEnd + 4).toString('utf8');
      const rest = buffered.subarray(headerEnd + 4);
      const request = parseConnectRequest(header);

      if (!request) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }

      const target = parseAddress(request.target);
      const logger = createConnectionLogger(config.name, {
        mode: 'http-connect',
        target: request.target,
        client: remoteAddress(client),
        connectRequest: request
      });

      const onUpstreamConnectError = (err: Error): void => {
        logger.meta.error = err.message;
        logger.writeMeta();
        logger.close();
        if (!client.destroyed) {
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      };

      const upstream = net.connect(target.port, target.host, () => {
        upstream.off('error', onUpstreamConnectError);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length > 0) {
          logger.request.write(rest);
          upstream.write(rest);
        }
        bridge(client, upstream, logger);
      });

      upstream.once('error', onUpstreamConnectError);
    };

    client.on('data', onData);
    client.on('error', () => {});
  });

  server.on('error', (err) => {
    console.error(`[${config.name}] listen error:`, err);
    process.exitCode = 1;
  });

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[${config.name}] listening ${config.listenHost}:${config.listenPort}`);
  });
}

function startGrpcEarlyReturnServer(config: GrpcEarlyReturnConfig): void {
  const server = http2.createServer();

  server.on('stream', (stream, headers) => {
    const grpcPath = singleHeaderValue(headers[':path']) ?? '';
    const logger = createConnectionLogger(config.name, {
      mode: 'grpc-early-return',
      target: config.grpcPath,
      client: stream.session ? remoteAddress(stream.session.socket) : 'unknown:0',
      grpcPath
    });

    stream.on('data', (chunk: Buffer) => {
      logger.request.write(chunk);
    });
    stream.on('error', (err) => {
      logger.meta.clientError = err.message;
      logger.writeMeta();
    });
    stream.on('close', () => logger.close());

    stream.on('end', () => {
      if (grpcPath !== config.grpcPath) {
        sendGrpcStatus(stream, logger, 12, `unimplemented path: ${grpcPath}`);
        return;
      }

      const responseBody = grpcResponseFrame(encodeStringValue(config.responseValue));
      logger.meta.earlyReturned = true;
      logger.response.write(responseBody);
      logger.writeMeta();

      stream.respond(
        {
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-encoding': 'identity'
        },
        { waitForTrailers: true }
      );
      stream.on('wantTrailers', () => {
        stream.sendTrailers({
          'grpc-status': '0',
          'grpc-message': ''
        });
      });
      stream.end(responseBody);
    });
  });

  server.on('error', (err) => {
    console.error(`[${config.name}] listen error:`, err);
    process.exitCode = 1;
  });

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `[${config.name}] returning ${config.responseValue} for ${config.grpcPath} on ${config.listenHost}:${config.listenPort}`
    );
  });
}

function bridge(client: net.Socket, upstream: net.Socket, logger: ConnectionLogger): void {
  client.on('data', (chunk: Buffer) => {
    logger.request.write(chunk);
    if (!upstream.write(chunk)) {
      client.pause();
    }
  });
  upstream.on('drain', () => client.resume());

  upstream.on('data', (chunk: Buffer) => {
    logger.response.write(chunk);
    if (!client.write(chunk)) {
      upstream.pause();
    }
  });
  client.on('drain', () => upstream.resume());

  const close = (): void => {
    logger.close();
    if (!client.destroyed) {
      client.destroy();
    }
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };

  client.on('error', (err) => {
    logger.meta.clientError = err.message;
    logger.writeMeta();
  });
  upstream.on('error', (err) => {
    logger.meta.upstreamError = err.message;
    logger.writeMeta();
  });
  client.on('close', close);
  upstream.on('close', close);
}

function sendGrpcStatus(
  stream: http2.ServerHttp2Stream,
  logger: ConnectionLogger,
  status: number,
  message: string
): void {
  logger.meta.error = message;
  logger.writeMeta();
  stream.respond({
    ':status': 200,
    'content-type': 'application/grpc',
    'grpc-status': String(status),
    'grpc-message': encodeURIComponent(message)
  });
  stream.end();
}

function grpcResponseFrame(payload: Buffer): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function encodeStringValue(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 127) {
    throw new Error('StringValue payload is too long for the minimal encoder');
  }

  return Buffer.concat([Buffer.from([0x0a, bytes.length]), bytes]);
}

function createConnectionLogger(
  name: string,
  metaInput: Omit<LoggerMeta, 'id' | 'startedAt' | 'requestPath' | 'responsePath' | 'closedAt'>
): ConnectionLogger {
  connectionSeq += 1;
  const id = `${timestamp()}-${String(connectionSeq).padStart(6, '0')}-${sanitize(name)}`;
  const requestPath = path.join(logDir, `${id}.request.bin`);
  const responsePath = path.join(logDir, `${id}.response.bin`);
  const metaPath = path.join(logDir, `${id}.meta.json`);
  const meta: LoggerMeta = {
    id,
    startedAt: new Date().toISOString(),
    requestPath,
    responsePath,
    ...metaInput
  };

  const logger: ConnectionLogger = {
    meta,
    request: fs.createWriteStream(requestPath),
    response: fs.createWriteStream(responsePath),
    writeMeta: () => {
      fs.writeFileSync(metaPath, `${JSON.stringify(logger.meta, null, 2)}\n`);
    },
    close: () => {
      if (logger.closed) {
        return;
      }
      logger.closed = true;
      logger.meta.closedAt = new Date().toISOString();
      logger.writeMeta();
      logger.request.end();
      logger.response.end();
    }
  };
  logger.writeMeta();
  return logger;
}

function parseConnectRequest(header: string): ConnectRequest | null {
  const lines = header.split(/\r\n/).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const [method, target, protocol] = firstLine.split(/\s+/);

  if (method !== 'CONNECT' || !target || !protocol) {
    return null;
  }

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  return { method, target, protocol, headers };
}

function parseAddress(address: string): Address {
  const trimmed = address.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1 || trimmed[end + 1] !== ':') {
      throw new Error(`address must include a bracketed host and port: ${address}`);
    }
    const host = trimmed.slice(1, end);
    const port = parsePort(trimmed.slice(end + 2), address);
    return { host, port };
  }

  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) {
    throw new Error(`address must include a port: ${address}`);
  }
  return {
    host: trimmed.slice(0, colon),
    port: parsePort(trimmed.slice(colon + 1), address)
  };
}

function parsePort(value: string, address: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`address has an invalid port: ${address}`);
  }
  return port;
}

function remoteAddress(socket: net.Socket): string {
  return `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function numberEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number`);
  }
  return parsed;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

main();
