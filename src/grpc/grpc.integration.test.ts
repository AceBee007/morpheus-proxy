import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ): void;
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
        } as grpc.ServiceError);
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
      for (let i = 0; i < 3; i++) call.write({ iso: `tick-${i}`, source: 'real' });
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

const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
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
