import * as fs from 'node:fs';
import * as http from 'node:http';
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

type StatusWebConfig = {
  listenPort: number;
  listenHost: string;
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
  requestBytes: number;
  responseBytes: number;
  closed?: boolean;
  writeMeta: () => void;
  close: () => void;
};

type AccessLogPhase = 'opened' | 'early-returned' | 'error' | 'closed';

type AccessLogEntry = {
  sequence: number;
  timestamp: string;
  id: string;
  phase: AccessLogPhase;
  mode: ProxyMode;
  client: string;
  target: string;
  requestBytes: number;
  responseBytes: number;
  grpcPath?: string;
  message?: string;
};

const logDir = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs', 'morpheus-proxy');
const maxConnectHeaderBytes = numberEnv('MAX_CONNECT_HEADER_BYTES', 8192);
const maxAccessLogLines = numberEnv('ACCESS_LOG_MAX_LINES', 100);

fs.mkdirSync(logDir, { recursive: true });

let connectionSeq = 0;
let accessLogSeq = 0;
const accessLogs: AccessLogEntry[] = [];
const accessLogClients = new Set<http.ServerResponse>();

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

  startStatusWebServer({
    listenHost: process.env.STATUS_LISTEN_HOST ?? '0.0.0.0',
    listenPort: numberEnv('STATUS_LISTEN_PORT', 18081)
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
          writeRequest(logger, rest);
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
      writeRequest(logger, chunk);
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
      writeResponse(logger, responseBody);
      logger.writeMeta();
      publishAccessLog(logger, 'early-returned', `returned ${config.responseValue}`);

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

function startStatusWebServer(config: StatusWebConfig): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok\n');
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/api/logs') {
      sendJson(res, accessLogs);
      return;
    }

    if (url.pathname === '/events') {
      startAccessLogEvents(res);
      req.on('close', () => {
        accessLogClients.delete(res);
      });
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      });
      res.end(statusPageHtml());
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });

  server.on('error', (err) => {
    console.error('[status-web] listen error:', err);
    process.exitCode = 1;
  });

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[status-web] listening ${config.listenHost}:${config.listenPort}`);
  });
}

function bridge(client: net.Socket, upstream: net.Socket, logger: ConnectionLogger): void {
  client.on('data', (chunk: Buffer) => {
    writeRequest(logger, chunk);
    if (!upstream.write(chunk)) {
      client.pause();
    }
  });
  upstream.on('drain', () => client.resume());

  upstream.on('data', (chunk: Buffer) => {
    writeResponse(logger, chunk);
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
    publishAccessLog(logger, 'error', err.message);
  });
  upstream.on('error', (err) => {
    logger.meta.upstreamError = err.message;
    logger.writeMeta();
    publishAccessLog(logger, 'error', err.message);
  });
  client.on('close', close);
  upstream.on('close', close);
}

function writeRequest(logger: ConnectionLogger, chunk: Buffer): void {
  logger.requestBytes += chunk.length;
  logger.request.write(chunk);
}

function writeResponse(logger: ConnectionLogger, chunk: Buffer): void {
  logger.responseBytes += chunk.length;
  logger.response.write(chunk);
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
    requestBytes: 0,
    responseBytes: 0,
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
      publishAccessLog(logger, 'closed');
      logger.request.end();
      logger.response.end();
    }
  };
  logger.writeMeta();
  publishAccessLog(logger, 'opened');
  return logger;
}

function publishAccessLog(logger: ConnectionLogger, phase: AccessLogPhase, message?: string): void {
  accessLogSeq += 1;
  const entry: AccessLogEntry = {
    sequence: accessLogSeq,
    timestamp: new Date().toISOString(),
    id: logger.meta.id,
    phase,
    mode: logger.meta.mode,
    client: logger.meta.client,
    target: logger.meta.target,
    requestBytes: logger.requestBytes,
    responseBytes: logger.responseBytes
  };

  if (logger.meta.grpcPath !== undefined) {
    entry.grpcPath = logger.meta.grpcPath;
  }
  if (message !== undefined) {
    entry.message = message;
  }

  accessLogs.push(entry);
  if (accessLogs.length > maxAccessLogLines) {
    accessLogs.splice(0, accessLogs.length - maxAccessLogLines);
  }

  const payload = JSON.stringify(entry);
  for (const client of accessLogClients) {
    client.write(`event: access-log\ndata: ${payload}\n\n`);
  }
}

function startAccessLogEvents(res: http.ServerResponse): void {
  res.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
    'x-accel-buffering': 'no'
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(accessLogs)}\n\n`);
  accessLogClients.add(res);
}

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function statusPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Morpheus Proxy</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --text: #16181d;
        --muted: #68707d;
        --line: #dfe3ea;
        --panel: #ffffff;
        --green: #13795b;
        --amber: #a05a00;
        --red: #b42318;
        --blue: #2458a6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 24px;
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }
      h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 650;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--muted);
        white-space: nowrap;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--amber);
        display: inline-block;
      }
      .dot.live { background: var(--green); }
      main { padding: 18px 24px 24px; }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
        color: var(--muted);
      }
      button {
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        border-radius: 6px;
        padding: 7px 10px;
        font: inherit;
        cursor: pointer;
      }
      .table-wrap {
        overflow: auto;
        border: 1px solid var(--line);
        background: var(--panel);
      }
      table {
        width: 100%;
        min-width: 980px;
        border-collapse: collapse;
      }
      th, td {
        padding: 9px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        position: sticky;
        top: 0;
        background: #fbfcfd;
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
        text-transform: uppercase;
      }
      td {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      tr:last-child td { border-bottom: 0; }
      .phase {
        font-family: inherit;
        font-weight: 700;
      }
      .opened { color: var(--blue); }
      .closed { color: var(--green); }
      .error { color: var(--red); }
      .early-returned { color: var(--amber); }
      .empty {
        padding: 36px;
        color: var(--muted);
        text-align: center;
        border: 1px solid var(--line);
        background: var(--panel);
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Morpheus Proxy</h1>
      <div class="meta"><span id="live-dot" class="dot"></span><span id="state">Connecting</span><span id="count">0 / ${maxAccessLogLines}</span></div>
    </header>
    <main>
      <div class="toolbar">
        <span>Access Log</span>
        <button id="clear" type="button">Clear View</button>
      </div>
      <div id="empty" class="empty">No access logs</div>
      <div id="table-wrap" class="table-wrap" hidden>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Phase</th>
              <th>Mode</th>
              <th>Client</th>
              <th>Target</th>
              <th>Path</th>
              <th>Bytes</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </main>
    <script>
      const maxLines = ${maxAccessLogLines};
      const logs = [];
      const rows = document.getElementById('rows');
      const empty = document.getElementById('empty');
      const tableWrap = document.getElementById('table-wrap');
      const count = document.getElementById('count');
      const state = document.getElementById('state');
      const liveDot = document.getElementById('live-dot');
      const clear = document.getElementById('clear');

      clear.addEventListener('click', () => {
        logs.length = 0;
        render();
      });

      const events = new EventSource('/events');
      events.addEventListener('open', () => {
        state.textContent = 'Live';
        liveDot.classList.add('live');
      });
      events.addEventListener('error', () => {
        state.textContent = 'Reconnecting';
        liveDot.classList.remove('live');
      });
      events.addEventListener('snapshot', (event) => {
        logs.length = 0;
        logs.push(...JSON.parse(event.data).slice(-maxLines));
        render();
      });
      events.addEventListener('access-log', (event) => {
        logs.push(JSON.parse(event.data));
        if (logs.length > maxLines) logs.splice(0, logs.length - maxLines);
        render();
      });

      function render() {
        count.textContent = logs.length + ' / ' + maxLines;
        empty.hidden = logs.length !== 0;
        tableWrap.hidden = logs.length === 0;
        rows.replaceChildren(...logs.map(row));
      }

      function row(log) {
        const tr = document.createElement('tr');
        addCell(tr, String(log.sequence));
        addCell(tr, new Date(log.timestamp).toLocaleTimeString());
        addCell(tr, log.phase, 'phase ' + log.phase);
        addCell(tr, log.mode);
        addCell(tr, log.client);
        addCell(tr, log.target);
        addCell(tr, log.grpcPath || '');
        addCell(tr, String(log.requestBytes) + ' / ' + String(log.responseBytes));
        addCell(tr, log.message || '');
        return tr;
      }

      function addCell(tr, text, className) {
        const td = document.createElement('td');
        if (className) td.className = className;
        td.textContent = text;
        tr.appendChild(td);
      }
    </script>
  </body>
</html>`;
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
