import { afterEach, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { DescriptorRegistry } from './descriptors.js';
import { startTestProxy, type TestProxy } from '../testing/harness.js';
import { startReflectionUpstream, type ReflectionUpstream } from '../testing/reflection-server.js';

// A gRPC client may send the same metadata key several times; grpc
// implementations emit one HTTP/2 header field per value and, for `-bin`
// keys, base64-encode each value separately. Node's http2 joins repeated
// fields with ", " in its headers object, which would corrupt the base64 and
// make the receiving server reject the call ("malformed binary metadata").
// The proxy must relay repeated metadata field by field in both directions.

const PROTO = `syntax = "proto3";
package demo;
service TimeService { rpc Now (NowRequest) returns (NowResponse); }
message NowRequest { string tz = 1; }
message NowResponse { string iso = 1; string source = 2; }
`;

const BIN_KEY = 'x-request-ids-bin';
const ASCII_KEY = 'x-tags';
const values = [Buffer.from('0-11111111-2222-3333-4444-555555555555'), Buffer.from('1-second-value')];

interface NowResponse {
  iso: string;
  source: string;
}
type TimeClient = grpc.Client & {
  Now(
    request: { tz: string },
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, res?: NowResponse) => void,
  ): grpc.ClientUnaryCall;
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Upstream that echoes the repeated request metadata it received into its response metadata. */
async function startEchoUpstream(): Promise<ReflectionUpstream> {
  const upstream = await startReflectionUpstream({
    protoSource: PROTO,
    serviceName: 'demo.TimeService',
    protocols: [],
    handlers: {
      Now: (
        call: grpc.ServerUnaryCall<{ tz: string }, NowResponse>,
        callback: grpc.sendUnaryData<NowResponse>,
      ) => {
        const received = call.metadata.get(BIN_KEY) as Buffer[];
        const tags = call.metadata.get(ASCII_KEY) as string[];
        const initial = new grpc.Metadata();
        const trailing = new grpc.Metadata();
        for (const v of received) {
          initial.add(`x-echo-initial-bin`, v);
          trailing.add(`x-echo-trailing-bin`, v);
        }
        call.sendMetadata(initial);
        // grpc clients may legitimately join repeated ASCII values with ", "
        // themselves (the gRPC spec allows it); normalise so the assertion is
        // about both values arriving, not about who joined them.
        callback(
          null,
          { iso: `${received.length}`, source: tags.flatMap((t) => t.split(', ')).join('|') },
          trailing,
        );
      },
    },
  });
  cleanups.push(() => upstream.close());
  return upstream;
}

async function startProxyFor(upstream: ReflectionUpstream, withDescriptor: boolean): Promise<TestProxy> {
  const descriptors = new DescriptorRegistry();
  if (withDescriptor) descriptors.add({ name: 'demo', format: 'proto_source', content: PROTO });
  const proxy = await startTestProxy({
    protocol: 'grpc',
    upstream: `h2c://${upstream.target}`,
    descriptors,
    rules: [
      {
        id: 'cap-all',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/' },
        logging: { capture: true },
      },
    ],
  });
  cleanups.push(() => proxy.close());
  return proxy;
}

function callThrough(proxy: TestProxy, upstream: ReflectionUpstream): Promise<{
  response?: NowResponse;
  error?: grpc.ServiceError;
  initial: grpc.Metadata | null;
  trailing: grpc.Metadata | null;
}> {
  const pkg = grpc.loadPackageDefinition(upstream.packageDefinition)['demo'] as grpc.GrpcObject;
  const Ctor = pkg['TimeService'] as unknown as new (a: string, c: grpc.ChannelCredentials) => TimeClient;
  const client = new Ctor(`127.0.0.1:${proxy.port}`, grpc.credentials.createInsecure());
  cleanups.push(() => client.close());
  const md = new grpc.Metadata();
  for (const v of values) md.add(BIN_KEY, v);
  md.add(ASCII_KEY, 'alpha');
  md.add(ASCII_KEY, 'beta');
  return new Promise((resolve) => {
    let initial: grpc.Metadata | null = null;
    let trailing: grpc.Metadata | null = null;
    const call = client.Now({ tz: 'utc' }, md, (error, response) => {
      // status (with trailers) arrives after the callback; wait for it
      call.on('status', (status) => {
        trailing = status.metadata;
        resolve({ ...(error ? { error } : {}), ...(response ? { response } : {}), initial, trailing });
      });
    });
    call.on('metadata', (m) => {
      initial = m;
    });
  });
}

describe.each([
  { label: 'streaming relay (no descriptor)', withDescriptor: false },
  { label: 'unary handling (descriptor registered)', withDescriptor: true },
])('repeated gRPC metadata through the proxy — $label', ({ withDescriptor }) => {
  it('delivers every value of a repeated -bin key to the upstream and back', async () => {
    const upstream = await startEchoUpstream();
    const proxy = await startProxyFor(upstream, withDescriptor);
    const result = await callThrough(proxy, upstream);

    expect(result.error).toBeUndefined();
    // the upstream saw both binary values, each decoded on its own
    expect(result.response?.iso).toBe('2');
    // repeated ASCII metadata is delivered as separate values too
    expect(result.response?.source).toBe('alpha|beta');
    // response metadata and trailers come back with both values intact
    expect((result.initial?.get('x-echo-initial-bin') as Buffer[]).map((b) => b.toString())).toEqual(
      values.map((v) => v.toString()),
    );
    expect((result.trailing?.get('x-echo-trailing-bin') as Buffer[]).map((b) => b.toString())).toEqual(
      values.map((v) => v.toString()),
    );
    // the traffic log keeps the repeated field as an array, not a joined string
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.request.headers[BIN_KEY]).toEqual(values.map((v) => v.toString('base64')));
  });
});
