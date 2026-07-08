import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/defaults.js';
import type { ListenerConfig } from '../config/types.js';
import { DescriptorRegistry } from '../grpc/descriptors.js';
import { grpcBodyValidatorFor } from '../grpc/rule-validation.js';
import { nullLogger } from '../logging/app-log.js';
import { MaskRegistry } from '../logging/mask.js';
import { TrafficLogStore } from '../logging/traffic-log.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { ConsumeRegistry } from '../rules/consume.js';
import { RuleStore } from '../rules/store.js';
import type { Rule } from '../rules/types.js';
import { validateRule } from '../rules/validate.js';
import { startTestUpstream, type TestUpstream } from '../testing/harness.js';
import { startConnectListener, type ConnectRuntime } from './connect-listener.js';
import type { StartedListener } from './http-listener.js';

interface ConnectStack {
  port: number;
  trafficLog: TrafficLogStore;
  addRule(input: unknown): Rule;
  listener: StartedListener;
  descriptors: DescriptorRegistry;
  close(): Promise<void>;
}

async function startConnect(opts: {
  protocol: 'http' | 'grpc';
  rules?: unknown[];
  descriptors?: DescriptorRegistry;
}): Promise<ConnectStack> {
  const consume = new ConsumeRegistry();
  const ruleStore = new RuleStore({ onRuleChanged: (id) => consume.reset(id) });
  const mask = new MaskRegistry(defaultConfig().logging.mask);
  const descriptors = opts.descriptors ?? new DescriptorRegistry();
  const trafficLog = new TrafficLogStore({
    dir: mkdtempSync(join(tmpdir(), 'morpheus-connect-test-')),
    maxEntries: 1000,
    maxBytes: 50_000_000,
    retentionMs: 3_600_000,
    mask,
  });
  const addRule = (input: unknown): Rule => {
    const result = validateRule(input, { grpcBodyValidator: grpcBodyValidatorFor(descriptors) });
    if (!result.rule) throw new Error(`invalid test rule: ${JSON.stringify(result.errors)}`);
    return ruleStore.create(result.rule);
  };
  for (const rule of opts.rules ?? []) addRule(rule);

  const listenerConfig: ListenerConfig = {
    name: `${opts.protocol}-connect-test`,
    protocol: opts.protocol,
    host: '127.0.0.1',
    port: 0,
    mode: 'connect',
    upstream: '',
    decodeBody: false,
    descriptors: [],
    maxRequestBodyBufferBytes: 1_048_576,
    maxResponseBodyBufferBytes: 1_048_576,
  };
  const runtime: ConnectRuntime = {
    listener: listenerConfig,
    limits: {
      maxConcurrentConnections: 128,
      maxActiveStreams: 128,
      upstreamTimeoutMs: 2_000,
      idleTimeoutMs: 10_000,
    },
    ruleStore,
    consume,
    trafficLog,
    appLog: nullLogger(),
    metrics: new MetricsRegistry(),
    descriptors,
  };
  const listener = await startConnectListener(runtime);
  return {
    port: listener.port,
    trafficLog,
    addRule,
    listener,
    descriptors,
    close: () => listener.close(),
  };
}

type CreateConnCb = (err: Error | null, socket?: net.Socket) => void;

/**
 * An http.Agent that reaches the target by opening an HTTP CONNECT tunnel
 * through the proxy — the same mechanism grpc-go / Go net/http use with a
 * proxy env var. The request host:port becomes the CONNECT authority.
 */
function tunnelAgent(proxyPort: number): http.Agent {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  (agent as unknown as { createConnection: (o: { host?: string; port?: number }, cb: CreateConnCb) => void }).createConnection =
    (options, cb) => {
      const authority = `${options.host ?? '127.0.0.1'}:${options.port ?? 80}`;
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.removeListener('data', onData);
        const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          cb(new Error(`unexpected CONNECT reply: ${statusLine}`));
          return;
        }
        const leftover = buf.subarray(end + 4);
        if (leftover.length > 0) socket.unshift(leftover);
        cb(null, socket);
      };
      socket.on('data', onData);
      socket.on('error', (err) => cb(err));
    };
  return agent;
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** GETs `path` at `targetPort` through a CONNECT tunnel on `proxyPort`. */
function getOverTunnel(proxyPort: number, targetPort: number, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { agent: tunnelAgent(proxyPort), host: '127.0.0.1', port: targetPort, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('CONNECT-inspect listener — HTTP (spec 4.14)', () => {
  let upstream: TestUpstream;
  beforeAll(async () => {
    upstream = await startTestUpstream();
  });
  afterAll(async () => {
    await upstream.close();
  });

  it('tunnels HTTP/1.1 and forwards to the CONNECT authority transparently', async () => {
    const stack = await startConnect({ protocol: 'http' });
    cleanups.push(() => stack.close());
    const res = await getOverTunnel(stack.port, upstream.port, '/echo?x=1');
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('yes');
    // upstream actually received the forwarded request
    expect(upstream.received.at(-1)?.url).toBe('/echo?x=1');
    // no rule matched -> unmatched passthrough is not logged (spec 4.1.4)
    expect(stack.trafficLog.size()).toBe(0);
  });

  it('applies a mock rule without contacting the CONNECT authority', async () => {
    const stack = await startConnect({
      protocol: 'http',
      rules: [
        {
          id: 'mock-users',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          request: {
            action: {
              type: 'mock_response',
              response: {
                statusCode: 222,
                headers: { 'content-type': 'application/json' },
                body: '{"name":"mock"}',
              },
            },
          },
        },
      ],
    });
    cleanups.push(() => stack.close());
    const authority = `127.0.0.1:${upstream.port}`;
    const before = upstream.received.length;
    const res = await getOverTunnel(stack.port, upstream.port, '/users/1');
    expect(res.status).toBe(222);
    expect(res.body).toBe('{"name":"mock"}');
    // upstream was not contacted
    expect(upstream.received.length).toBe(before);
    const entry = stack.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('mock');
    // the per-connection upstream (the CONNECT authority) is recorded as target
    expect(entry?.target).toBe(`http://${authority}`);
  });

  it('rejects a non-CONNECT request on a connect listener', async () => {
    const stack = await startConnect({ protocol: 'http' });
    cleanups.push(() => stack.close());
    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(stack.port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
      });
      let buf = Buffer.alloc(0);
      socket.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.includes('\r\n')) resolve(buf.subarray(0, buf.indexOf('\r\n')).toString('latin1'));
      });
      socket.on('error', reject);
    });
    expect(status).toMatch(/405/);
  });
});

const GRPC_PROTO = `syntax = "proto3";
package demo;
service TimeService {
  rpc Now (NowRequest) returns (NowResponse);
}
message NowRequest { string tz = 1; }
message NowResponse { string iso = 1; string source = 2; }
`;

interface NowResponse {
  iso: string;
  source: string;
}
type TimeClient = grpc.Client & {
  Now(
    request: { tz: string },
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res?: NowResponse) => void,
  ): void;
};

describe('CONNECT-inspect listener — gRPC via grpc_proxy (spec 4.14)', () => {
  let upstreamServer: grpc.Server;
  let upstreamPort: number;
  let ctor: new (a: string, c: grpc.ChannelCredentials) => TimeClient;
  let savedProxy: string | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morpheus-connect-grpc-'));
    const protoPath = join(dir, 'demo.proto');
    writeFileSync(protoPath, GRPC_PROTO);
    const packageDef = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath, { keepCase: true }));
    const demo = packageDef['demo'] as grpc.GrpcObject;
    ctor = demo['TimeService'] as unknown as new (
      a: string,
      c: grpc.ChannelCredentials,
    ) => TimeClient;
    upstreamServer = new grpc.Server();
    upstreamServer.addService((demo['TimeService'] as grpc.ServiceClientConstructor).service, {
      Now: (
        _call: grpc.ServerUnaryCall<{ tz: string }, NowResponse>,
        callback: grpc.sendUnaryData<NowResponse>,
      ) => callback(null, { iso: '2026-06-10T00:00:00.000Z', source: 'real' }),
    });
    upstreamPort = await new Promise<number>((resolve, reject) => {
      upstreamServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) =>
        err ? reject(err) : resolve(port),
      );
    });
  });

  afterAll(() => {
    upstreamServer.forceShutdown();
  });

  afterEach(() => {
    if (savedProxy === undefined) delete process.env['grpc_proxy'];
    else process.env['grpc_proxy'] = savedProxy;
  });

  function registryWithProto(): DescriptorRegistry {
    const registry = new DescriptorRegistry();
    registry.add({ name: 'demo.proto', format: 'proto_source', content: GRPC_PROTO });
    return registry;
  }

  function callNow(client: TimeClient): Promise<{ response?: NowResponse; error?: grpc.ServiceError }> {
    return new Promise((resolve) => {
      client.Now({ tz: 'utc' }, new grpc.Metadata(), (error, response) =>
        resolve({ ...(error ? { error } : {}), ...(response ? { response } : {}) }),
      );
    });
  }

  it('tunnels gRPC through a client proxy and injects a consumable fault', async () => {
    const stack = await startConnect({
      protocol: 'grpc',
      descriptors: registryWithProto(),
      rules: [
        {
          id: 'grpc-unavailable-2x',
          protocol: 'grpc',
          match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
          request: {
            action: { type: 'fault', fault: { kind: 'grpc_status', status: 14, message: 'injected' } },
          },
          consume: { times: 2 },
        },
      ],
    });
    cleanups.push(() => stack.close());

    savedProxy = process.env['grpc_proxy'];
    process.env['grpc_proxy'] = `http://127.0.0.1:${stack.port}`;

    const client = new ctor(`127.0.0.1:${upstreamPort}`, grpc.credentials.createInsecure());
    cleanups.push(() => client.close());

    for (let i = 0; i < 2; i++) {
      const { error } = await callNow(client);
      expect(error?.code).toBe(grpc.status.UNAVAILABLE);
      expect(error?.details).toBe('injected');
    }
    const third = await callNow(client);
    expect(third.error).toBeUndefined();
    expect(third.response?.source).toBe('real');

    const faults = stack.trafficLog.list({ outcome: 'fault' }).items;
    expect(faults).toHaveLength(2);
    // the CONNECT authority became the per-connection upstream target
    expect(faults[0]?.target).toBe(`h2c://127.0.0.1:${upstreamPort}`);
  });
});
