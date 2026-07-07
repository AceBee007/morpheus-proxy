import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startAdminServer, type AdminServer } from '../admin/server.js';
import { defaultConfig } from '../config/defaults.js';
import type { LimitsConfig, ListenerConfig, MorpheusConfig } from '../config/types.js';
import { DescriptorRegistry } from '../grpc/descriptors.js';
import { startGrpcListener } from '../grpc/grpc-listener.js';
import { grpcBodyValidatorFor } from '../grpc/rule-validation.js';
import { nullLogger } from '../logging/app-log.js';
import { MaskRegistry } from '../logging/mask.js';
import { TrafficLogStore } from '../logging/traffic-log.js';
import { MetricsRegistry } from '../observability/metrics.js';
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
  /** 'grpc' boots a gRPC listener instead of the HTTP one. */
  protocol?: 'http' | 'grpc';
  /** Pre-registered descriptors for gRPC stacks. */
  descriptors?: DescriptorRegistry;
}

export interface TestProxy {
  port: number;
  url: string;
  runtime: ProxyRuntime;
  ruleStore: RuleStore;
  consume: ConsumeRegistry;
  trafficLog: TrafficLogStore;
  mask: MaskRegistry;
  metrics: MetricsRegistry;
  descriptors: DescriptorRegistry;
  listener: StartedListener;
  addRule(input: unknown): Rule;
  close(): Promise<void>;
}

/** Boots a full proxy listener (HTTP by default, gRPC on request) for tests. */
export async function startTestProxy(opts: TestProxyOptions): Promise<TestProxy> {
  const consume = new ConsumeRegistry();
  const ruleStore = new RuleStore({ onRuleChanged: (id) => consume.reset(id) });
  const mask = new MaskRegistry(defaultConfig().logging.mask);
  const metrics = new MetricsRegistry();
  const descriptors = opts.descriptors ?? new DescriptorRegistry();
  const protocol = opts.protocol ?? 'http';
  const trafficLog = new TrafficLogStore({
    dir: mkdtempSync(join(tmpdir(), 'morpheus-proxy-test-')),
    maxEntries: 1000,
    maxBytes: 50_000_000,
    retentionMs: 3_600_000,
    mask,
  });

  const addRule = (input: unknown): Rule => {
    const result = validateRule(input, { grpcBodyValidator: grpcBodyValidatorFor(descriptors) });
    if (!result.rule) {
      throw new Error(`invalid test rule: ${JSON.stringify(result.errors)}`);
    }
    return ruleStore.create(result.rule);
  };
  for (const rule of opts.rules ?? []) addRule(rule);

  const listenerConfig: ListenerConfig = {
    name: `${protocol}-test`,
    protocol,
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
    metrics,
    ...(opts.scriptRunner ? { scriptRunner: opts.scriptRunner } : {}),
    ...(opts.manipulatorRunner ? { manipulatorRunner: opts.manipulatorRunner } : {}),
  };

  const listener =
    protocol === 'grpc'
      ? await startGrpcListener({ ...runtime, descriptors })
      : await startHttpListener(runtime);
  return {
    port: listener.port,
    url: `http://127.0.0.1:${listener.port}`,
    runtime,
    ruleStore,
    consume,
    trafficLog,
    mask,
    metrics,
    descriptors,
    listener,
    addRule,
    close: async () => {
      await listener.close();
    },
  };
}

export interface TestStack extends TestProxy {
  admin: AdminServer;
  /** Base URL including the admin base path, e.g. http://127.0.0.1:1234/_morpheus */
  adminUrl: string;
  api(path: string, init?: RequestInit): Promise<Response>;
}

/** Boots the proxy plus an admin server sharing the same stores. */
export async function startTestStack(
  opts: TestProxyOptions & { ready?: () => boolean },
): Promise<TestStack> {
  const proxy = await startTestProxy(opts);
  const config: MorpheusConfig = {
    ...defaultConfig(),
    admin: { host: '127.0.0.1', port: 0, basePath: '/_morpheus' },
    listeners: [proxy.runtime.listener],
  };
  const admin = await startAdminServer({
    config,
    ruleStore: proxy.ruleStore,
    consume: proxy.consume,
    trafficLog: proxy.trafficLog,
    mask: proxy.mask,
    appLog: nullLogger(),
    metrics: proxy.metrics,
    descriptors: proxy.descriptors,
    listeners: () => [proxy.listener],
    ready: opts.ready ?? (() => true),
    startedAt: new Date(),
    validateOptions: {
      scriptMaxTimeoutMs: 60_000,
      grpcBodyValidator: grpcBodyValidatorFor(proxy.descriptors),
    },
    ...(opts.scriptRunner ? { scriptRunner: opts.scriptRunner } : {}),
    ...(opts.manipulatorRunner ? { manipulatorRunner: opts.manipulatorRunner } : {}),
  });
  const adminUrl = `http://127.0.0.1:${admin.port}/_morpheus`;
  return {
    ...proxy,
    admin,
    adminUrl,
    api: (path, init) => fetch(`${adminUrl}${path}`, init),
    close: async () => {
      await admin.close();
      await proxy.close();
    },
  };
}
