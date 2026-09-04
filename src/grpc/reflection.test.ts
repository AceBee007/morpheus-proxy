import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startReflectionUpstream, type ReflectionUpstream } from '../testing/reflection-server.js';
import { DescriptorRegistry } from './descriptors.js';
import {
  fetchDescriptorsViaReflection,
  parseReflectionTarget,
  ReflectionError,
  type ReflectionFetchOptions,
} from './reflection.js';

const PROTO = `syntax = "proto3";
package demo;
service TimeService { rpc Now (NowRequest) returns (NowResponse); }
service Greeter { rpc Hello (HelloRequest) returns (HelloReply); }
message NowRequest { string tz = 1; }
message NowResponse { string iso = 1; }
message HelloRequest { string name = 1; }
message HelloReply { string text = 1; }
`;

const handlers = {
  Now: (_call: unknown, callback: (err: null, res: { iso: string }) => void) =>
    callback(null, { iso: '2026-01-01T00:00:00Z' }),
};

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function upstreamWith(
  overrides: Partial<Parameters<typeof startReflectionUpstream>[0]> = {},
): Promise<ReflectionUpstream> {
  const upstream = await startReflectionUpstream({
    protoSource: PROTO,
    serviceName: 'demo.TimeService',
    handlers,
    ...overrides,
  });
  cleanups.push(() => upstream.close());
  return upstream;
}

function options(target: string, overrides: Partial<ReflectionFetchOptions> = {}): ReflectionFetchOptions {
  return { target, timeoutMs: 2_000, maxBytes: 1_000_000, ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<ReflectionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ReflectionError);
    return err as ReflectionError;
  }
  throw new Error('expected the reflection fetch to fail');
}

describe('parseReflectionTarget', () => {
  it('accepts host:port and bracketed IPv6', () => {
    expect(parseReflectionTarget('svc.ns.svc:5000')).toEqual({ kind: 'h2c', host: 'svc.ns.svc', port: 5000 });
    expect(parseReflectionTarget(' 127.0.0.1:50051 ')).toEqual({ kind: 'h2c', host: '127.0.0.1', port: 50051 });
    expect(parseReflectionTarget('[::1]:50051')).toEqual({ kind: 'h2c', host: '::1', port: 50051 });
  });

  it('rejects schemes, missing ports and out-of-range ports', () => {
    for (const bad of ['h2c://svc:5000', 'svc', 'svc:0', 'svc:70000', 'svc:5000/path', '']) {
      expect(() => parseReflectionTarget(bad)).toThrow(ReflectionError);
    }
    try {
      parseReflectionTarget('svc');
    } catch (err) {
      expect((err as ReflectionError).reason).toBe('invalid_target');
    }
  });
});

describe('fetchDescriptorsViaReflection (spec 4.7.6)', () => {
  it('imports every listed service through grpc.reflection.v1 and yields a loadable descriptor set', async () => {
    const upstream = await upstreamWith();
    const result = await fetchDescriptorsViaReflection(options(upstream.target));

    expect(result.protocol).toBe('grpc-v1');
    expect([...result.services].sort()).toEqual(['demo.Greeter', 'demo.TimeService']);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    // list_services first, then one file_containing_symbol per service; all on v1
    expect(upstream.reflectionRequests.map((r) => r.request['message_request'])).toEqual([
      'list_services',
      'file_containing_symbol',
      'file_containing_symbol',
    ]);
    expect(new Set(upstream.reflectionRequests.map((r) => r.protocol))).toEqual(new Set(['grpc-v1']));

    const registry = new DescriptorRegistry();
    const info = registry.add({
      name: 'via-reflection',
      format: 'descriptor_set',
      content: result.descriptorSet.toString('base64'),
    });
    expect(info.services.map((s) => s.fullName).sort()).toEqual(['demo.Greeter', 'demo.TimeService']);
    const method = registry.lookupMethod('/demo.TimeService/Now');
    expect(method?.responseType.fullName).toBe('.demo.NowResponse');
    expect(method?.requestStream).toBe(false);
  });

  it('never imports the reflection / health / channelz services themselves', async () => {
    const upstream = await upstreamWith({
      extraServiceNames: ['grpc.health.v1.Health', 'grpc.channelz.v1.Channelz'],
    });
    const result = await fetchDescriptorsViaReflection(options(upstream.target));
    expect(result.services.every((s) => s.startsWith('demo.'))).toBe(true);
  });

  it('skips listed services the server cannot resolve and imports the rest', async () => {
    const upstream = await upstreamWith({ extraServiceNames: ['demo.Ghost'] });
    const result = await fetchDescriptorsViaReflection(options(upstream.target));
    expect([...result.services].sort()).toEqual(['demo.Greeter', 'demo.TimeService']);
    expect(result.missing).toEqual(['demo.Ghost']);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
  });

  it('fails with not_found when the server resolves none of the services it lists', async () => {
    // A server whose services have no registered proto files (hand-written
    // descriptors) lists them but answers NOT_FOUND for every symbol.
    const upstream = await upstreamWith({ unresolvable: true });
    const err = await failure(fetchDescriptorsViaReflection(options(upstream.target)));
    expect(err.reason).toBe('not_found');
    expect(err.message).toContain('demo.TimeService');
    expect(err.message).toContain('resolves none');
  });

  it('does not import partially when an explicitly requested symbol is missing', async () => {
    const upstream = await upstreamWith();
    const err = await failure(
      fetchDescriptorsViaReflection(
        options(upstream.target, { symbols: ['demo.TimeService', 'demo.Ghost'] }),
      ),
    );
    expect(err.reason).toBe('not_found');
    expect(err.message).toContain('demo.Ghost');
  });

  it('imports only the requested symbols without listing services', async () => {
    const upstream = await upstreamWith();
    const result = await fetchDescriptorsViaReflection(
      options(upstream.target, { symbols: ['demo.Greeter'] }),
    );
    expect(result.services).toEqual(['demo.Greeter']);
    expect(upstream.reflectionRequests.map((r) => r.request['message_request'])).toEqual([
      'file_containing_symbol',
    ]);
    expect(upstream.reflectionRequests[0]?.request['file_containing_symbol']).toBe('demo.Greeter');
  });

  it('falls back to grpc.reflection.v1alpha when v1 is unimplemented', async () => {
    const upstream = await upstreamWith({ protocols: ['grpc-v1alpha'] });
    const result = await fetchDescriptorsViaReflection(options(upstream.target));
    expect(result.protocol).toBe('grpc-v1alpha');
    expect(new Set(upstream.reflectionRequests.map((r) => r.protocol))).toEqual(new Set(['grpc-v1alpha']));
  });

  it('reports unimplemented when the server exposes no reflection service', async () => {
    const upstream = await upstreamWith({ protocols: [] });
    const err = await failure(fetchDescriptorsViaReflection(options(upstream.target)));
    expect(err.reason).toBe('unimplemented');
    expect(err.target).toBe(upstream.target);
  });

  it('reports not_found for a symbol the server does not know', async () => {
    const upstream = await upstreamWith();
    const err = await failure(
      fetchDescriptorsViaReflection(options(upstream.target, { symbols: ['other.Svc'] })),
    );
    expect(err.reason).toBe('not_found');
    expect(err.message).toContain('other.Svc');
  });

  it('reports unavailable when nothing listens on the target', async () => {
    const port = await new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const bound = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(bound));
      });
    });
    const err = await failure(fetchDescriptorsViaReflection(options(`127.0.0.1:${port}`)));
    expect(err.reason).toBe('unavailable');
  });

  it('reports timeout when the server is too slow', async () => {
    const upstream = await upstreamWith({ reflectionDelayMs: 600 });
    const err = await failure(
      fetchDescriptorsViaReflection(options(upstream.target, { timeoutMs: 100 })),
    );
    expect(err.reason).toBe('timeout');
  });

  it('reports too_large when descriptors exceed maxBytes', async () => {
    const upstream = await upstreamWith();
    const err = await failure(
      fetchDescriptorsViaReflection(options(upstream.target, { maxBytes: 16 })),
    );
    expect(err.reason).toBe('too_large');
  });

  it('forwards extra metadata but never lets it override transport headers', async () => {
    const upstream = await upstreamWith();
    await fetchDescriptorsViaReflection(
      options(upstream.target, {
        metadata: { 'X-Test-Token': 'secret-for-test', 'content-type': 'text/plain' },
      }),
    );
    const first = upstream.reflectionRequests[0];
    expect(first?.metadata.get('x-test-token')).toEqual(['secret-for-test']);
    // the transport header was not overridden (grpc-js hides content-type from
    // Metadata; a text/plain override would have failed the call instead)
    expect(first?.metadata.get('content-type')).not.toContain('text/plain');
  });
});
