import { mkdtempSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nullLogger } from '../logging/app-log.js';
import { ScriptSandbox } from '../script/sandbox.js';
import { startTestProxy, type TestProxy } from '../testing/harness.js';
import { DescriptorRegistry } from './descriptors.js';

const PROTO_SOURCE = `syntax = "proto3";
package demo;

service TimeService {
  rpc Now (NowRequest) returns (NowResponse);
  rpc Watch (NowRequest) returns (stream NowResponse);
}

message NowRequest {
  string tz = 1;
}

message NowResponse {
  string iso = 1;
  string source = 2;
}
`;

let protoPath: string;
let packageDef: grpc.GrpcObject;
let upstreamServer: grpc.Server;
let upstreamPort: number;
/** Stashed callbacks for tz:'hang' calls, released manually by a test. */
const pendingNowCalls: grpc.sendUnaryData<NowResponse>[] = [];
/** Stashed Watch calls for tz:'hang', held open after the first message. */
const pendingWatchCalls: grpc.ServerWritableStream<NowRequest, NowResponse>[] = [];

interface NowRequest {
  tz: string;
}
interface NowResponse {
  iso: string;
  source: string;
}

type ServiceClientCtor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => grpc.Client & {
  Now(
    request: NowRequest,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res?: NowResponse) => void,
  ): grpc.ClientUnaryCall;
  Watch(request: NowRequest, metadata?: grpc.Metadata): grpc.ClientReadableStream<NowResponse>;
};

function serviceCtor(): ServiceClientCtor {
  const demo = packageDef['demo'] as grpc.GrpcObject;
  return demo['TimeService'] as unknown as ServiceClientCtor;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpheus-grpc-proto-'));
  protoPath = join(dir, 'demo.proto');
  writeFileSync(protoPath, PROTO_SOURCE);
  const definition = protoLoader.loadSync(protoPath, { keepCase: true });
  packageDef = grpc.loadPackageDefinition(definition);

  upstreamServer = new grpc.Server();
  const demo = packageDef['demo'] as grpc.GrpcObject;
  const service = (demo['TimeService'] as grpc.ServiceClientConstructor).service;
  upstreamServer.addService(service, {
    Now: (
      call: grpc.ServerUnaryCall<NowRequest, NowResponse>,
      callback: grpc.sendUnaryData<NowResponse>,
    ) => {
      if (call.request.tz === 'fail') {
        callback({
          code: grpc.status.UNAVAILABLE,
          message: 'upstream says unavailable',
        });
        return;
      }
      if (call.request.tz === 'hang') {
        // held open until a test releases it via pendingNowCalls, to simulate
        // an upstream that is still slower than the client's own deadline.
        pendingNowCalls.push(callback);
        return;
      }
      const metadata = new grpc.Metadata();
      metadata.set('x-data-source', 'real-db');
      call.sendMetadata(metadata);
      callback(null, { iso: '2026-06-10T00:00:00.000Z', source: 'real' });
    },
    Watch: (call: grpc.ServerWritableStream<NowRequest, NowResponse>) => {
      const initial = new grpc.Metadata();
      initial.set('x-stream', 'yes');
      call.sendMetadata(initial);
      call.write({ iso: 'tick-0', source: 'real' });
      if (call.request.tz === 'hang') {
        // held open after the first message until a test releases it.
        pendingWatchCalls.push(call);
        return;
      }
      call.write({ iso: 'tick-1', source: 'real' });
      call.write({ iso: 'tick-2', source: 'real' });
      const trailers = new grpc.Metadata();
      trailers.set('x-stream-done', 'true');
      call.end(trailers);
    },
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

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  while (pendingNowCalls.length > 0) {
    pendingNowCalls.pop()?.(null, { iso: 'unused', source: 'real' });
  }
  while (pendingWatchCalls.length > 0) {
    pendingWatchCalls.pop()?.end();
  }
});

function registryWithProto(): DescriptorRegistry {
  const registry = new DescriptorRegistry();
  registry.add({ name: 'demo.proto', format: 'proto_source', content: PROTO_SOURCE });
  return registry;
}

async function setupGrpcProxy(
  rules: unknown[] = [],
  opts: { withDescriptor?: boolean; withSandbox?: boolean } = {},
): Promise<{ proxy: TestProxy; client: InstanceType<ServiceClientCtor> }> {
  const descriptors = opts.withDescriptor === false ? new DescriptorRegistry() : registryWithProto();
  let sandbox: ScriptSandbox | undefined;
  if (opts.withSandbox) {
    sandbox = new ScriptSandbox({ defaultTimeoutMs: 3_000, maxTimeoutMs: 60_000, appLog: nullLogger() });
    cleanups.push(() => sandbox!.close());
  }
  const proxy = await startTestProxy({
    upstream: `h2c://127.0.0.1:${upstreamPort}`,
    protocol: 'grpc',
    descriptors,
    rules,
    ...(sandbox ? { scriptRunner: sandbox.matcherRunner(), manipulatorRunner: sandbox.manipulatorRunner() } : {}),
  });
  cleanups.push(() => proxy.close());
  const Ctor = serviceCtor();
  const client = new Ctor(`127.0.0.1:${proxy.port}`, grpc.credentials.createInsecure());
  cleanups.push(() => client.close());
  return { proxy, client };
}

function callNow(
  client: InstanceType<ServiceClientCtor>,
  tz = 'utc',
  metadata = new grpc.Metadata(),
): Promise<{ response?: NowResponse; error?: grpc.ServiceError }> {
  return new Promise((resolve) => {
    client.Now({ tz }, metadata, (error, response) =>
      resolve({
        ...(error ? { error } : {}),
        ...(response !== undefined ? { response } : {}),
      }),
    );
  });
}

describe('gRPC unary proxying (spec 4.7)', () => {
  it('forwards unary calls transparently when no rules exist', async () => {
    const { proxy, client } = await setupGrpcProxy();
    const { response, error } = await callNow(client);
    expect(error).toBeUndefined();
    expect(response).toEqual({ iso: '2026-06-10T00:00:00.000Z', source: 'real' });
    expect(proxy.trafficLog.size()).toBe(0);
  });

  it('passes upstream gRPC errors through unchanged (spec 4.1.2)', async () => {
    const { client } = await setupGrpcProxy();
    const { error } = await callNow(client, 'fail');
    expect(error?.code).toBe(grpc.status.UNAVAILABLE);
    expect(error?.details).toBe('upstream says unavailable');
  });

  it('returns UNAVAILABLE when the upstream is down', async () => {
    const proxy = await startTestProxy({
      upstream: 'h2c://127.0.0.1:1',
      protocol: 'grpc',
      descriptors: registryWithProto(),
    });
    cleanups.push(() => proxy.close());
    const Ctor = serviceCtor();
    const client = new Ctor(`127.0.0.1:${proxy.port}`, grpc.credentials.createInsecure());
    cleanups.push(() => client.close());
    const { error } = await callNow(client);
    expect(error?.code).toBe(grpc.status.UNAVAILABLE);
    expect(proxy.trafficLog.list().items[0]?.outcome).toBe('upstream_error');
  });

  it('injects grpc-status faults for the first N calls (spec 4.6, AC)', async () => {
    const { proxy, client } = await setupGrpcProxy([
      {
        id: 'grpc-unavailable-2x',
        protocol: 'grpc',
        match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
        request: {
          action: {
            type: 'fault',
            fault: { kind: 'grpc_status', status: 14, message: 'injected unavailable' },
          },
        },
        consume: { times: 2 },
      },
    ]);
    for (let i = 0; i < 2; i++) {
      const { error } = await callNow(client);
      expect(error?.code).toBe(grpc.status.UNAVAILABLE);
      expect(error?.details).toBe('injected unavailable');
    }
    const third = await callNow(client);
    expect(third.error).toBeUndefined();
    expect(third.response?.source).toBe('real');
    expect(proxy.trafficLog.list({ outcome: 'fault' }).items).toHaveLength(2);
  });

  it('serves mock responses encoded from JSON messages (descriptor required)', async () => {
    const { proxy, client } = await setupGrpcProxy([
      {
        id: 'grpc-mock',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/Now$' },
        request: {
          action: {
            type: 'mock_response',
            response: {
              grpcStatus: 0,
              messages: [{ iso: 'mock-time', source: 'mock' }],
              metadata: { 'x-morpheus-mock': 'true' },
            },
          },
        },
      },
    ]);
    const { response, error } = await callNow(client);
    expect(error).toBeUndefined();
    expect(response).toEqual({ iso: 'mock-time', source: 'mock' });
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('mock');
    expect(entry?.response.bodyPreview).toContain('mock-time');
  });

  it('rejects mock message bodies without a descriptor (spec 4.7.3)', async () => {
    const proxy = await startTestProxy({
      upstream: `h2c://127.0.0.1:${upstreamPort}`,
      protocol: 'grpc',
      descriptors: new DescriptorRegistry(),
    });
    cleanups.push(() => proxy.close());
    expect(() =>
      proxy.addRule({
        id: 'no-descriptor-mock',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/Now$' },
        request: {
          action: { type: 'mock_response', response: { messages: [{ iso: 'x' }] } },
        },
      }),
    ).toThrow(/descriptor_required/);
  });

  it('rejects mock messages that do not match the response schema', async () => {
    const { proxy } = await setupGrpcProxy();
    expect(() =>
      proxy.addRule({
        id: 'bad-schema-mock',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/Now$' },
        request: {
          action: { type: 'mock_response', response: { messages: [{ iso: 123 }] } },
        },
      }),
    ).toThrow(/invalid_message/);
  });

  it('matches gRPC metadata and rewrites response metadata (spec 4.5.5)', async () => {
    const { client } = await setupGrpcProxy([
      {
        id: 'metadata-replace',
        protocol: 'grpc',
        match: {
          type: 'all',
          conditions: [
            { type: 'regex', field: 'grpc.service', pattern: '^demo\\.TimeService$' },
            { type: 'regex', field: 'header.x-test-case', pattern: '^replace$' },
          ],
        },
        response: {
          action: {
            type: 'response_replace',
            target: 'header.x-data-source',
            from: '^real-(.*)$',
            to: 'mock-$1',
          },
        },
      },
    ]);
    const metadata = new grpc.Metadata();
    metadata.set('x-test-case', 'replace');
    const received = await new Promise<grpc.Metadata>((resolve, reject) => {
      const call = client.Now({ tz: 'utc' }, metadata, (err) => {
        if (err) reject(err);
      });
      (call as unknown as { on(event: string, cb: (m: grpc.Metadata) => void): void }).on(
        'metadata',
        resolve,
      );
    });
    expect(received.get('x-data-source')).toEqual(['mock-db']);
  });

  it('gates response actions on grpc.status via response.match', async () => {
    const { client } = await setupGrpcProxy([
      {
        id: 'gate-unavailable',
        protocol: 'grpc',
        match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
        response: {
          match: { type: 'regex', field: 'grpc.status', pattern: '^14$' },
          action: {
            type: 'fault',
            fault: { kind: 'grpc_status', status: 3, message: 'rewritten by morpheus' },
          },
        },
      },
    ]);
    // healthy upstream response: passthrough
    const ok = await callNow(client);
    expect(ok.error).toBeUndefined();
    // failing upstream: grpc-status is rewritten 14 -> 3
    const failed = await callNow(client, 'fail');
    expect(failed.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(failed.error?.details).toBe('rewritten by morpheus');
  });

  it('captures decoded JSON bodies when a descriptor exists (spec 4.9.3)', async () => {
    const { proxy, client } = await setupGrpcProxy([
      {
        id: 'capture-grpc',
        protocol: 'grpc',
        match: { type: 'regex', field: 'grpc.service', pattern: '^demo\\.TimeService$' },
        logging: { capture: true },
      },
    ]);
    await callNow(client, 'tokyo');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('captured');
    expect(entry?.request.bodyLogged).toBe(true);
    expect(entry?.request.bodyPreview).toContain('tokyo');
    expect(entry?.response.bodyPreview).toContain('real');
    expect(entry?.response.grpcStatus).toBe(0);
  });

  it('logs metadata only (no bodies) without a descriptor (spec 4.9.3)', async () => {
    const proxy = await startTestProxy({
      upstream: `h2c://127.0.0.1:${upstreamPort}`,
      protocol: 'grpc',
      descriptors: new DescriptorRegistry(),
      rules: [
        {
          id: 'capture-blind',
          protocol: 'grpc',
          match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/' },
          logging: { capture: true },
        },
      ],
    });
    cleanups.push(() => proxy.close());
    const Ctor = serviceCtor();
    const client = new Ctor(`127.0.0.1:${proxy.port}`, grpc.credentials.createInsecure());
    cleanups.push(() => client.close());
    const { response } = await callNow(client);
    expect(response?.source).toBe('real');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.request.bodyLogged).toBe(false);
    expect(entry?.response.bodyLogged).toBe(false);
  });
});

describe('gRPC script matcher / manipulator (spec 4.4.3, 4.5.6)', () => {
  it('matches with a script and rewrites the message body via a script manipulator', async () => {
    const { proxy, client } = await setupGrpcProxy(
      [
        {
          id: 'grpc-script',
          protocol: 'grpc',
          match: {
            type: 'script',
            language: 'javascript',
            // gRPC metadata is exposed both as ctx.request.headers and ctx.request.grpc.metadata
            source: "return ctx.request.grpc.method === 'Now' && ctx.request.grpc.metadata['x-scripted'] === 'yes';",
          },
          response: {
            action: {
              type: 'script_manipulator',
              language: 'javascript',
              // ctx.response.grpc.messages is the decoded upstream message array
              source:
                "const m = ctx.response.grpc.messages[0]; return { messages: [{ iso: m.iso, source: 'scripted-' + m.source }] };",
            },
          },
        },
      ],
      { withSandbox: true },
    );

    // no header -> script matcher returns false -> passthrough
    const plain = await callNow(client, 'utc');
    expect(plain.response?.source).toBe('real');

    const md = new grpc.Metadata();
    md.set('x-scripted', 'yes');
    const scripted = await callNow(client, 'utc', md);
    expect(scripted.error).toBeUndefined();
    expect(scripted.response?.source).toBe('scripted-real'); // manipulator re-encoded the message
    expect(scripted.response?.iso).toBe('2026-06-10T00:00:00.000Z');

    const entry = proxy.trafficLog.list({ ruleId: 'grpc-script' }).items[0];
    expect(entry?.outcome).toBe('modified');
    expect(entry?.upstreamResponse?.bodyPreview).toContain('"source":"real"');
    expect(entry?.response.bodyPreview).toContain('scripted-real');
  });

  it('edits grpcStatus / trailers via a script manipulator', async () => {
    const { client } = await setupGrpcProxy(
      [
        {
          id: 'grpc-script-status',
          protocol: 'grpc',
          match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
          response: {
            action: {
              type: 'script_manipulator',
              language: 'javascript',
              source: "return { grpcStatus: 7, grpcMessage: 'denied by script', trailers: { 'x-by': 'script' } };",
            },
          },
        },
      ],
      { withSandbox: true },
    );
    const { error } = await callNow(client);
    expect(error?.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(error?.details).toBe('denied by script');
    expect(error?.metadata.get('x-by')).toEqual(['script']);
  });

  it('script manipulator error falls back to passthrough with rule_error', async () => {
    const { proxy, client } = await setupGrpcProxy(
      [
        {
          id: 'grpc-script-boom',
          protocol: 'grpc',
          match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
          response: {
            action: {
              type: 'script_manipulator',
              language: 'javascript',
              source: "throw new Error('boom in script');",
            },
          },
        },
      ],
      { withSandbox: true },
    );
    const { response, error } = await callNow(client);
    expect(error).toBeUndefined(); // upstream response passed through
    expect(response?.source).toBe('real');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('rule_error');
    expect(entry?.ruleErrors?.[0]?.error).toContain('boom in script');
  });
});

describe('gRPC streaming (spec 4.7.5)', () => {
  function watchAll(
    client: InstanceType<ServiceClientCtor>,
    metadata = new grpc.Metadata(),
  ): Promise<{ messages: NowResponse[]; initial: grpc.Metadata; status: grpc.StatusObject }> {
    return new Promise((resolve, reject) => {
      const call = client.Watch({ tz: 'utc' }, metadata);
      const messages: NowResponse[] = [];
      let initial: grpc.Metadata | undefined;
      call.on('metadata', (m) => {
        initial = m;
      });
      call.on('data', (m: NowResponse) => messages.push(m));
      call.on('status', (status) => {
        resolve({ messages, initial: initial ?? new grpc.Metadata(), status });
      });
      call.on('error', () => {
        /* resolved via status */
      });
      setTimeout(() => reject(new Error('watch timeout')), 5000);
    });
  }

  it('passes server streaming through with messages and trailers intact', async () => {
    const { proxy, client } = await setupGrpcProxy();
    const { messages, initial, status } = await watchAll(client);
    expect(messages.map((m) => m.iso)).toEqual(['tick-0', 'tick-1', 'tick-2']);
    expect(initial.get('x-stream')).toEqual(['yes']);
    expect(status.code).toBe(grpc.status.OK);
    expect(status.metadata.get('x-stream-done')).toEqual(['true']);
    expect(proxy.trafficLog.size()).toBe(0);
  });

  it('injects grpc-status faults on streaming methods without touching the body path', async () => {
    const { proxy, client } = await setupGrpcProxy([
      {
        id: 'stream-fault',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/Watch$' },
        request: {
          action: {
            type: 'fault',
            fault: { kind: 'grpc_status', status: 14, message: 'stream unavailable' },
          },
        },
        consume: { times: 1 },
      },
    ]);
    const first = await watchAll(client);
    expect(first.status.code).toBe(grpc.status.UNAVAILABLE);
    expect(first.messages).toHaveLength(0);
    const second = await watchAll(client);
    expect(second.status.code).toBe(grpc.status.OK);
    expect(second.messages).toHaveLength(3);
    expect(proxy.trafficLog.list({ outcome: 'fault' }).items).toHaveLength(1);
  });

  it('edits initial metadata on streaming responses (spec 4.7.5)', async () => {
    const { client } = await setupGrpcProxy([
      {
        id: 'stream-metadata',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/Watch$' },
        response: {
          action: {
            type: 'response_replace',
            target: 'header.x-stream',
            from: '^yes$',
            to: 'edited',
          },
        },
      },
    ]);
    const { messages, initial } = await watchAll(client);
    expect(initial.get('x-stream')).toEqual(['edited']);
    expect(messages).toHaveLength(3); // body untouched
  });

  it('skips body matchers on streaming methods (spec 4.7.5)', async () => {
    const { client } = await setupGrpcProxy([
      {
        id: 'stream-body-matcher',
        protocol: 'grpc',
        match: { type: 'regex', field: 'body', pattern: 'tick' },
        request: {
          action: { type: 'fault', fault: { kind: 'grpc_status', status: 14 } },
        },
      },
    ]);
    const { status, messages } = await watchAll(client);
    expect(status.code).toBe(grpc.status.OK);
    expect(messages).toHaveLength(3);
  });
});

describe('gRPC attempt logging is guaranteed exactly once (client_aborted)', () => {
  const capAllRule = {
    id: 'cap-all',
    protocol: 'grpc' as const,
    match: { type: 'regex' as const, field: 'path' as const, pattern: '^/' },
    logging: { capture: true },
  };

  it('evaluates an aborted partial unary request in normal priority order', async () => {
    const { proxy } = await setupGrpcProxy([
      {
        id: 'fault-once',
        protocol: 'grpc',
        priority: 100,
        match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
        request: { action: { type: 'fault', fault: { kind: 'grpc_status', status: 14 } } },
        consume: { times: 1 },
      },
      {
        ...capAllRule,
        priority: 1,
        match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
      },
    ]);
    const session = http2.connect(`http://127.0.0.1:${proxy.port}`);
    cleanups.push(() => Promise.resolve(session.close()));
    session.on('error', () => {});

    const abortPartial = async (): Promise<void> => {
      const req = session.request({
        ':method': 'POST',
        ':path': '/demo.TimeService/Now',
        'content-type': 'application/grpc',
        te: 'trailers',
      });
      req.on('error', () => {});
      req.write(Buffer.from([0, 0, 0])); // deliberately incomplete gRPC frame
      await sleep(20);
      req.close(http2.constants.NGHTTP2_CANCEL);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    };

    await abortPartial();
    await abortPartial();

    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(2);
    expect(items[1]?.outcome).toBe('client_aborted');
    expect(items[1]?.matchedRules.map((m) => m.id)).toEqual(['fault-once']);
    expect(items[0]?.outcome).toBe('client_aborted');
    expect(items[0]?.matchedRules.map((m) => m.id)).toEqual(['cap-all']);
    expect(proxy.consume.stateOf(proxy.ruleStore.get('fault-once')!).remaining).toBe(0);
  });

  it('logs a cancelled unary call once when no descriptor routes it through the streaming relay', async () => {
    // No descriptor: descriptors.lookupMethod() returns null, so
    // handleGrpcStream treats even this unary "Now" call as streaming and
    // dispatches it to handleStreaming — the path the real incident took.
    const { proxy, client } = await setupGrpcProxy([capAllRule], { withDescriptor: false });
    const call = client.Now({ tz: 'hang' }, new grpc.Metadata(), () => {
      /* the client gives up long before this would ever fire */
    });
    while (pendingNowCalls.length === 0) await sleep(5);
    call.cancel();
    await sleep(50);
    // the upstream finally answers, after the client already left
    pendingNowCalls.pop()?.(null, { iso: 'too-late', source: 'real' });
    await sleep(50);
    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.outcome).toBe('client_aborted');
  });

  it('records the cancelled attempt as client_aborted (not fault) via handleStreaming, alongside its capture-all sibling', async () => {
    // No descriptor: same real-incident path as the test above, but now with
    // a second, consume-once fault rule whose delay the client times out on
    // — the exact real-world reproduction, plus the
    // capture-all rule proving the retry is independently observable too.
    const { proxy, client } = await setupGrpcProxy(
      [
        capAllRule,
        {
          id: 'fault-once',
          protocol: 'grpc',
          match: { type: 'regex', field: 'path', pattern: '^/' },
          consume: { times: 1 },
          response: {
            delay: { durationMs: 3000 },
            action: { type: 'fault', fault: { kind: 'grpc_status', status: 14 } },
          },
        },
      ],
      { withDescriptor: false },
    );
    const call = client.Now({ tz: 'utc' }, new grpc.Metadata(), () => {
      /* the client gives up long before the delay elapses */
    });
    setTimeout(() => call.cancel(), 200);
    await sleep(3200);

    const second = await callNow(client);
    expect(second.error).toBeUndefined();

    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(2);
    const [retry, aborted] = items;
    expect(aborted?.outcome).toBe('client_aborted');
    expect(aborted?.matchedRules.map((m) => m.id)).toEqual(['cap-all', 'fault-once']);
    expect(retry?.outcome).toBe('captured');
    expect(retry?.matchedRules.map((m) => m.id)).toEqual(['cap-all']);
  }, 10_000);

  it('logs a cancelled Watch call once via the mid-relay close guard', async () => {
    const { proxy, client } = await setupGrpcProxy([capAllRule]);
    const call = client.Watch({ tz: 'hang' });
    call.on('error', () => {
      /* expected once cancelled below */
    });
    const first = await new Promise<NowResponse>((resolve) => call.once('data', resolve));
    expect(first.iso).toBe('tick-0');
    call.cancel();
    await sleep(100);
    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.outcome).toBe('client_aborted');
  });

  it('logs rule_error instead of dropping the attempt on an invalid response_replace regex (handleUnary defense-in-depth)', async () => {
    const { proxy, client } = await setupGrpcProxy();
    // bypasses validateRule (which would normally reject this pattern) to
    // prove the guard added around handleUnary holds even so. The client
    // still sees an INTERNAL error either way (unchanged, matches the
    // pre-fix top-level catch in grpcStreamHandler) — what the fix adds is
    // that this attempt is no longer dropped from the traffic log.
    proxy.ruleStore.create({
      schemaVersion: 1,
      id: 'bad-regex',
      name: '',
      description: '',
      enabled: true,
      priority: 10,
      protocol: 'grpc',
      match: { type: 'regex', field: 'grpc.method', pattern: '^Now$' },
      response: {
        action: { type: 'response_replace', target: 'header.x-data-source', from: '(', to: 'x' },
      },
      logging: { capture: true },
      createdAt: '',
      updatedAt: '',
    });
    const { error } = await callNow(client);
    expect(error?.code).toBe(grpc.status.INTERNAL);
    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.outcome).toBe('rule_error');
    expect(items[0]?.ruleErrors?.[0]?.error).toBeTruthy();
  });

  // Real-world usage pattern: a capture-all observation rule alongside a
  // separate consume-once fault rule, so a retried call's first (faulted)
  // attempt and second (passthrough) attempt are both independently visible
  // in Logs — the capture rule never stops evaluation (spec 4.3.2), so it
  // still records the attempt that the fault rule intercepted and consumed.
  it('records both the faulted attempt and its retry when a capture-all rule sits alongside a consume-once fault (handleUnary)', async () => {
    const { proxy, client } = await setupGrpcProxy([
      capAllRule,
      {
        id: 'fault-once',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/' },
        consume: { times: 1 },
        response: {
          action: { type: 'fault', fault: { kind: 'grpc_status', status: 14, message: 'injected' } },
        },
      },
    ]);
    const first = await callNow(client);
    expect(first.error?.code).toBe(grpc.status.UNAVAILABLE);
    const second = await callNow(client);
    expect(second.error).toBeUndefined();
    expect(second.response?.source).toBe('real');

    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(2);
    const [retry, faulted] = items;
    expect(faulted?.outcome).toBe('fault');
    expect(faulted?.matchedRules.map((m) => m.id)).toEqual(['cap-all', 'fault-once']);
    expect(retry?.outcome).toBe('captured');
    expect(retry?.matchedRules.map((m) => m.id)).toEqual(['cap-all']);
  });

  // Same pattern, but the fault is preceded by a delay long enough that the
  // client (simulating a retry policy's per-attempt deadline) cancels before
  // ever seeing it — reproduces the real-world incident this
  // fix targets. The first attempt must show client_aborted, not a
  // misleading 'fault' (the client never received it), while still
  // recording which rule was about to fire and how long it waited.
  it('records the cancelled attempt as client_aborted (not fault) when the client times out during a fault rule\'s delay (handleUnary)', async () => {
    const { proxy, client } = await setupGrpcProxy([
      capAllRule,
      {
        id: 'fault-once',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/' },
        consume: { times: 1 },
        response: {
          delay: { durationMs: 3000 },
          action: { type: 'fault', fault: { kind: 'grpc_status', status: 14, message: 'injected' } },
        },
      },
    ]);
    const call = client.Now({ tz: 'utc' }, new grpc.Metadata(), () => {
      /* the client gives up long before the delay elapses */
    });
    setTimeout(() => call.cancel(), 200);
    await sleep(3200);

    const second = await callNow(client);
    expect(second.error).toBeUndefined();

    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(2);
    const [retry, aborted] = items;
    expect(aborted?.outcome).toBe('client_aborted');
    expect(aborted?.matchedRules.map((m) => m.id)).toEqual(['cap-all', 'fault-once']);
    expect(aborted?.timing?.delayMs).toBe(3000);
    expect(retry?.outcome).toBe('captured');
    expect(retry?.matchedRules.map((m) => m.id)).toEqual(['cap-all']);
  }, 10_000);
});
