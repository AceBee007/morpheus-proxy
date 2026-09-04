import protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultReflection } from '../config/defaults.js';
import type { ReflectionConfig } from '../config/types.js';
import { AppLogger } from '../logging/app-log.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { DescriptorRegistry } from './descriptors.js';
import {
  globToRegExp,
  ReflectionImporter,
  serviceOfPath,
  type ReflectionFetcher,
} from './reflection-import.js';
import { ReflectionError, type ReflectionFetchOptions } from './reflection.js';

const FileDescriptorSet = (descriptorExt as unknown as { FileDescriptorSet: protobuf.Type })
  .FileDescriptorSet;

const PROTO = `syntax = "proto3";
package t;
service Svc { rpc Get (Req) returns (Res); }
message Req { string id = 1; }
message Res { string name = 1; }
`;

function descriptorSetFor(proto: string): Buffer {
  const root = protobuf.parse(proto, { keepCase: true }).root;
  root.resolveAll();
  const set = (root as unknown as { toDescriptor(syntax: string): protobuf.Message }).toDescriptor(
    'proto3',
  );
  return Buffer.from(FileDescriptorSet.encode(set).finish());
}

const SET = descriptorSetFor(PROTO);
const TARGET = '127.0.0.1:50052';

interface Harness {
  importer: ReflectionImporter;
  registry: DescriptorRegistry;
  metrics: MetricsRegistry;
  logger: AppLogger;
  fetcher: ReturnType<typeof vi.fn<ReflectionFetcher>>;
  calls: ReflectionFetchOptions[];
  clock: { now: number };
}

function okFetcher(calls: ReflectionFetchOptions[], delayMs = 0): ReturnType<typeof vi.fn<ReflectionFetcher>> {
  return vi.fn<ReflectionFetcher>(async (opts) => {
    calls.push(opts);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      target: opts.target,
      protocol: 'grpc-v1',
      services: opts.symbols ?? ['t.Svc'],
      missing: [],
      files: ['t.proto'],
      descriptorSet: SET,
    };
  });
}

function harness(
  settings: Partial<ReflectionConfig> = {},
  fetcher?: ReturnType<typeof vi.fn<ReflectionFetcher>>,
): Harness {
  const calls: ReflectionFetchOptions[] = [];
  const registry = new DescriptorRegistry();
  const metrics = new MetricsRegistry();
  const logger = new AppLogger({ dir: null, stderr: false });
  const clock = { now: 1_000_000 };
  const f = fetcher ?? okFetcher(calls);
  const importer = new ReflectionImporter({
    registry,
    appLog: logger,
    metrics,
    settings: { ...defaultReflection(), ...settings },
    fetcher: f,
    now: () => clock.now,
  });
  return { importer, registry, metrics, logger, fetcher: f, calls, clock };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('helpers', () => {
  it('globToRegExp matches whole authorities with * wildcards', () => {
    expect(globToRegExp('*').test('anything:1')).toBe(true);
    expect(globToRegExp('*:50052').test('svc.ns:50052')).toBe(true);
    expect(globToRegExp('*:50052').test('svc.ns:50053')).toBe(false);
    expect(globToRegExp('svc.ns:*').test('svcXns:1')).toBe(false); // the dot is literal
    expect(globToRegExp('*.internal:*').test('a.b.INTERNAL:9')).toBe(true); // case-insensitive
  });

  it('serviceOfPath extracts the service from a gRPC :path', () => {
    expect(serviceOfPath('/pkg.Svc/Method')).toBe('pkg.Svc');
    expect(serviceOfPath('/healthz')).toBeNull();
    expect(serviceOfPath('/a/b/c')).toBeNull();
  });
});

describe('ReflectionImporter.import (spec 4.7.6)', () => {
  it('registers the fetched descriptor set with reflection provenance', async () => {
    const h = harness();
    const info = await h.importer.import(TARGET);
    expect(info.source).toMatchObject({ type: 'reflection', target: TARGET, protocol: 'grpc-v1' });
    expect(info.services.map((s) => s.fullName)).toEqual(['t.Svc']);
    expect(h.registry.hasService('t.Svc')).toBe(true);
    expect(h.registry.lookupMethod('/t.Svc/Get')?.responseType.fullName).toBe('.t.Res');
    expect(h.calls[0]).toMatchObject({ target: TARGET, timeoutMs: 3_000, maxBytes: 16_777_216 });
    expect(h.importer.status().imports).toHaveLength(1);
    expect(h.importer.status().imports[0]).toMatchObject({ target: TARGET, descriptorId: info.id });
    expect(h.metrics.snapshot().reflectionImports).toEqual({ success: 1 });
  });

  it('replaces the descriptors previously imported from the same target', async () => {
    const h = harness();
    const first = await h.importer.import(TARGET);
    const second = await h.importer.import(TARGET, ['t.Svc']);
    expect(second.id).not.toBe(first.id);
    expect(h.registry.list().map((d) => d.id)).toEqual([second.id]);
    expect(h.calls[1]?.symbols).toEqual(['t.Svc']);
  });

  it('shares one in-flight fetch between concurrent imports of a target', async () => {
    const calls: ReflectionFetchOptions[] = [];
    const h = harness({}, okFetcher(calls, 30));
    const [a, b] = await Promise.all([h.importer.import(TARGET), h.importer.import(TARGET)]);
    expect(a.id).toBe(b.id);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.importer.status().inFlight).toEqual([]);
  });

  it('records failures once per distinct reason and exposes them in status / metrics', async () => {
    const fetcher = vi.fn<ReflectionFetcher>(() =>
      Promise.reject(new ReflectionError('unavailable', TARGET, 'connection refused')),
    );
    const h = harness({ negativeTtlMs: 5_000 }, fetcher);
    const warn = vi.spyOn(h.logger, 'warn');
    await expect(h.importer.import(TARGET)).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(h.importer.import(TARGET)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(warn).toHaveBeenCalledTimes(1);
    const status = h.importer.status();
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      target: TARGET,
      reason: 'unavailable',
      at: new Date(h.clock.now).toISOString(),
      retryAt: new Date(h.clock.now + 5_000).toISOString(),
    });
    expect(h.metrics.snapshot().reflectionImports).toEqual({ unavailable: 2 });
  });

  it('reports invalid when the server returns an unusable descriptor set', async () => {
    const fetcher = vi.fn<ReflectionFetcher>((opts) =>
      Promise.resolve({
        target: opts.target,
        protocol: 'grpc-v1',
        services: ['t.Svc'],
        missing: [],
        files: ['t.proto'],
        descriptorSet: Buffer.from('not a descriptor set'),
      }),
    );
    const h = harness({}, fetcher);
    await expect(h.importer.import(TARGET)).rejects.toMatchObject({ reason: 'invalid' });
    expect(h.registry.list()).toEqual([]);
  });
});

describe('ReflectionImporter.ensure — on-demand import', () => {
  it('does nothing unless reflection.auto is enabled', async () => {
    const h = harness({ auto: false });
    h.importer.ensure(TARGET, '/t.Svc/Get');
    await flush();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('imports an unknown service once, even when many requests race', async () => {
    const calls: ReflectionFetchOptions[] = [];
    const h = harness({ auto: true }, okFetcher(calls, 20));
    for (let i = 0; i < 5; i++) h.importer.ensure(TARGET, '/t.Svc/Get');
    await new Promise((r) => setTimeout(r, 60));
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.registry.hasService('t.Svc')).toBe(true);
    // known service: nothing more to fetch
    h.importer.ensure(TARGET, '/t.Svc/Get');
    await flush();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('backs off a failing target until negativeTtlMs elapsed', async () => {
    const fetcher = vi.fn<ReflectionFetcher>(() =>
      Promise.reject(new ReflectionError('unavailable', TARGET, 'refused')),
    );
    const h = harness({ auto: true, negativeTtlMs: 10_000 }, fetcher);
    h.importer.ensure(TARGET, '/t.Svc/Get');
    await flush();
    h.importer.ensure(TARGET, '/t.Svc/Get');
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    h.clock.now += 10_001;
    h.importer.ensure(TARGET, '/t.Svc/Get');
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('remembers services a target does not serve instead of re-querying', async () => {
    const h = harness({ auto: true });
    h.importer.ensure(TARGET, '/other.Svc/Get');
    await flush();
    await flush();
    h.importer.ensure(TARGET, '/other.Svc/Get');
    await flush();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.registry.hasService('t.Svc')).toBe(true); // what the target did serve is kept
  });

  it('skips targets outside reflection.allow and warns once', async () => {
    const h = harness({ auto: true, allow: ['10.0.*:*'] });
    const warn = vi.spyOn(h.logger, 'warn');
    expect(h.importer.isAllowed('10.0.1.2:50052')).toBe(true);
    expect(h.importer.isAllowed(TARGET)).toBe(false);
    h.importer.ensure(TARGET, '/t.Svc/Get');
    h.importer.ensure(TARGET, '/t.Svc/Get');
    await flush();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('remembers the authority a known service was seen on', () => {
    const h = harness();
    h.importer.noteAuthority('t.Svc', TARGET);
    expect(h.importer.authorityFor('t.Svc')).toBe(TARGET);
    expect(h.importer.status().lastSeen).toEqual({ 't.Svc': TARGET });
  });
});

describe('ReflectionImporter.scheduleStartupImport', () => {
  it('retries with backoff until the upstream answers, without blocking', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetcher = vi.fn<ReflectionFetcher>((opts) => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new ReflectionError('unavailable', opts.target, 'not up yet'));
      }
      return Promise.resolve({
        target: opts.target,
        protocol: 'grpc-v1',
        services: ['t.Svc'],
        missing: [],
        files: ['t.proto'],
        descriptorSet: SET,
      });
    });
    const h = harness({}, fetcher);
    h.importer.scheduleStartupImport(TARGET, ['t.Svc']);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(h.registry.hasService('t.Svc')).toBe(true);
    expect(fetcher.mock.calls.at(-1)?.[0]?.symbols).toEqual(['t.Svc']);
    h.importer.close();
  });

  it('gives up after maxAttempts and stops retrying once closed', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<ReflectionFetcher>((opts) =>
      Promise.reject(new ReflectionError('unavailable', opts.target, 'never up')),
    );
    const h = harness({}, fetcher);
    const error = vi.spyOn(h.logger, 'error');
    h.importer.scheduleStartupImport(TARGET, undefined, 2);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const again = harness({}, fetcher);
    again.importer.scheduleStartupImport(TARGET);
    await vi.advanceTimersByTimeAsync(0);
    again.importer.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(3); // only the first attempt of the second importer
  });
});
