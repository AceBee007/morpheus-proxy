import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { defaultConfig } from '../config/defaults.js';
import type { LimitsConfig, ListenerConfig } from '../config/types.js';
import { nullLogger } from '../logging/app-log.js';
import { MaskRegistry } from '../logging/mask.js';
import { TrafficLogStore } from '../logging/traffic-log.js';
import { ConsumeRegistry } from '../rules/consume.js';
import { RuleStore } from '../rules/store.js';
import { validateRule } from '../rules/validate.js';
import type { Rule } from '../rules/types.js';
import { startHttpListener, type StartedListener } from '../proxy/http-listener.js';
import type { ManipulatorRunner, ProxyRuntime } from '../proxy/pipeline.js';
import type { ScriptMatcherRunner } from '../rules/matcher.js';

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface TestUpstream {
  port: number;
  url: string;
  received: ReceivedRequest[];
  close(): Promise<void>;
}

export type UpstreamHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

const defaultUpstreamHandler: UpstreamHandler = (req, res, body) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-upstream': 'yes',
  });
  res.end(
    JSON.stringify({
      method: req.method,
      url: req.url,
      body: body.toString('utf8'),
    }),
  );
};

/** Starts an HTTP/1.1 upstream that records every request. */
export function startTestUpstream(handler: UpstreamHandler = defaultUpstreamHandler): Promise<TestUpstream> {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

export interface TestProxyOptions {
  upstream: string;
  rules?: unknown[];
  limits?: Partial<LimitsConfig>;
  listener?: Partial<ListenerConfig>;
  scriptRunner?: ScriptMatcherRunner;
  manipulatorRunner?: ManipulatorRunner;
}

export interface TestProxy {
  port: number;
  url: string;
  runtime: ProxyRuntime;
  ruleStore: RuleStore;
  consume: ConsumeRegistry;
  trafficLog: TrafficLogStore;
  listener: StartedListener;
  addRule(input: unknown): Rule;
  close(): Promise<void>;
}

/** Boots a full HTTP proxy listener wired to in-memory stores for tests. */
export async function startTestProxy(opts: TestProxyOptions): Promise<TestProxy> {
  const consume = new ConsumeRegistry();
  const ruleStore = new RuleStore({ onRuleChanged: (id) => consume.reset(id) });
  const mask = new MaskRegistry(defaultConfig().logging.mask);
  const trafficLog = new TrafficLogStore({
    dir: mkdtempSync(join(tmpdir(), 'morpheus-proxy-test-')),
    maxEntries: 1000,
    maxBytes: 50_000_000,
    retentionMs: 3_600_000,
    mask,
  });

  const addRule = (input: unknown): Rule => {
    const result = validateRule(input);
    if (!result.rule) {
      throw new Error(`invalid test rule: ${JSON.stringify(result.errors)}`);
    }
    return ruleStore.create(result.rule);
  };
  for (const rule of opts.rules ?? []) addRule(rule);

  const listenerConfig: ListenerConfig = {
    name: 'http-test',
    protocol: 'http',
    host: '127.0.0.1',
    port: 0,
    upstream: opts.upstream,
    decodeBody: false,
    descriptors: [],
    maxRequestBodyBufferBytes: 1_048_576,
    maxResponseBodyBufferBytes: 1_048_576,
    ...opts.listener,
  };

  const runtime: ProxyRuntime = {
    listener: listenerConfig,
    limits: {
      maxConcurrentConnections: 128,
      maxActiveStreams: 128,
      upstreamTimeoutMs: 2_000,
      idleTimeoutMs: 10_000,
      ...opts.limits,
    },
    ruleStore,
    consume,
    trafficLog,
    appLog: nullLogger(),
    ...(opts.scriptRunner ? { scriptRunner: opts.scriptRunner } : {}),
    ...(opts.manipulatorRunner ? { manipulatorRunner: opts.manipulatorRunner } : {}),
  };

  const listener = await startHttpListener(runtime);
  return {
    port: listener.port,
    url: `http://127.0.0.1:${listener.port}`,
    runtime,
    ruleStore,
    consume,
    trafficLog,
    listener,
    addRule,
    close: async () => {
      await listener.close();
    },
  };
}
