import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaskRegistry, MASKED_VALUE } from './mask.js';
import {
  TrafficLogStore,
  type TrafficEventDraft,
  type TrafficLogStoreOptions,
} from './traffic-log.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'morpheus-traffic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(overrides: Partial<TrafficLogStoreOptions> = {}): TrafficLogStore {
  return new TrafficLogStore({
    dir,
    maxEntries: 100,
    maxBytes: 1_000_000,
    retentionMs: 86_400_000,
    mask: new MaskRegistry({ headers: ['authorization'], jsonPaths: ['$.password'] }),
    ...overrides,
  });
}

let clock = Date.parse('2026-06-10T00:00:00.000Z');

function draft(overrides: Partial<TrafficEventDraft> = {}): TrafficEventDraft {
  clock += 1000;
  const startedAt = new Date(clock);
  return {
    startedAt,
    endedAt: new Date(clock + 120),
    protocol: 'http',
    listener: 'http',
    client: '127.0.0.1:50000',
    target: '127.0.0.1:8080',
    request: {
      method: 'GET',
      path: '/users/1',
      headers: { authorization: 'Bearer x', accept: 'application/json' },
    },
    response: { statusCode: 200, headers: {} },
    outcome: 'captured',
    loggingReason: 'capture_rule',
    matchedRules: [],
    ...overrides,
  };
}

describe('TrafficLogStore', () => {
  it('builds entries with ids, durations, and masked headers', () => {
    const store = makeStore();
    const entry = store.add(draft());
    expect(entry.id).toMatch(/^2026-.*-000001$/);
    expect(entry.durationMs).toBe(120);
    expect(entry.request.headers['authorization']).toBe(MASKED_VALUE);
    expect(entry.request.headers['accept']).toBe('application/json');
    expect(entry.request.bodyLogged).toBe(false);
    expect(store.get(entry.id)).toBe(entry);
  });

  it('persists bodies to files and masks JSON previews', async () => {
    const store = makeStore();
    const body = Buffer.from('{"password":"secret","name":"n"}');
    const entry = store.add(
      draft({
        request: {
          method: 'POST',
          path: '/login',
          headers: {},
          body,
          contentType: 'application/json',
        },
      }),
    );
    expect(entry.request.bodyLogged).toBe(true);
    expect(entry.request.bodySize).toBe(body.byteLength);
    expect(entry.request.bodyPreview).toContain(`"password":"${MASKED_VALUE}"`);
    expect(entry.request.bodyPreviewEncoding).toBe('utf8');

    // raw body file is stored unmasked
    const raw = await store.readBody(entry.id, 'request');
    expect(raw?.toString()).toContain('secret');
  });

  it('uses base64 previews for binary bodies', () => {
    const store = makeStore();
    const body = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const entry = store.add(draft({ response: { statusCode: 200, headers: {}, body } }));
    expect(entry.response.bodyPreviewEncoding).toBe('base64');
    expect(entry.response.bodyPreview).toBe(body.toString('base64'));
  });

  it('records bodyLoggingSkippedReason without a body', () => {
    const store = makeStore();
    const entry = store.add(
      draft({
        request: { method: 'POST', path: '/big', headers: {}, bodySkippedReason: 'limit_exceeded' },
      }),
    );
    expect(entry.request.bodyLogged).toBe(false);
    expect(entry.request.bodyLoggingSkippedReason).toBe('limit_exceeded');
  });

  it('evicts oldest entries over maxEntries and deletes their body files', async () => {
    const store = makeStore({ maxEntries: 2 });
    const first = store.add(
      draft({ request: { method: 'GET', path: '/1', headers: {}, body: Buffer.from('one') } }),
    );
    await store.flush();
    const firstFile = join(dir, `${first.id}.request.bin`);
    expect(existsSync(firstFile)).toBe(true);

    store.add(draft());
    store.add(draft());
    expect(store.size()).toBe(2);
    expect(store.get(first.id)).toBeUndefined();
    await store.flush();
    expect(existsSync(firstFile)).toBe(false);
  });

  it('evicts oldest entries when total body bytes exceed maxBytes', () => {
    const store = makeStore({ maxBytes: 10 });
    const first = store.add(
      draft({ request: { method: 'GET', path: '/1', headers: {}, body: Buffer.alloc(8) } }),
    );
    store.add(
      draft({ request: { method: 'GET', path: '/2', headers: {}, body: Buffer.alloc(8) } }),
    );
    expect(store.get(first.id)).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it('applies time-based retention', () => {
    let now = Date.parse('2026-06-10T01:00:00.000Z');
    const store = makeStore({ retentionMs: 60_000, now: () => new Date(now) });
    store.add(draft()); // startedAt is ~2026-06-10T00:00 (old clock)
    expect(store.applyRetention()).toBe(1);
    expect(store.size()).toBe(0);
    now += 1;
  });

  it('filters by protocol, method, path, outcome, status, ruleId, and contains', () => {
    const store = makeStore();
    store.add(
      draft({
        outcome: 'fault',
        matchedRules: [{ id: 'rule-1', action: 'fault', consumed: true, remaining: 2 }],
        response: { statusCode: 503, headers: {} },
      }),
    );
    store.add(draft({ request: { method: 'POST', path: '/orders', headers: {} } }));

    expect(store.list({ outcome: 'fault' }).items).toHaveLength(1);
    expect(store.list({ method: 'POST' }).items).toHaveLength(1);
    expect(store.list({ path: '/users' }).items).toHaveLength(1);
    expect(store.list({ statusCode: 503 }).items).toHaveLength(1);
    expect(store.list({ ruleId: 'rule-1' }).items).toHaveLength(1);
    expect(store.list({ ruleId: 'nope' }).items).toHaveLength(0);
    expect(store.list({ contains: 'orders' }).items).toHaveLength(1);
  });

  it('filters gRPC service/method from the request path', () => {
    const store = makeStore();
    store.add(
      draft({
        protocol: 'grpc',
        request: { method: 'POST', path: '/demo.TimeService/Now', headers: {} },
        response: { statusCode: 200, grpcStatus: 14, headers: {} },
      }),
    );
    expect(store.list({ grpcService: 'demo.TimeService' }).items).toHaveLength(1);
    expect(store.list({ grpcService: 'demo.TimeService', grpcMethod: 'Now' }).items).toHaveLength(1);
    expect(store.list({ grpcMethod: 'Other' }).items).toHaveLength(0);
    expect(store.list({ grpcStatus: 14 }).items).toHaveLength(1);
  });

  it('paginates newest-first with an opaque cursor', () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) store.add(draft());
    const page1 = store.list({}, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1]?.id);
    const page2 = store.list({}, 2, page1.nextCursor ?? undefined);
    expect(page2.items).toHaveLength(2);
    // No overlap and strictly older
    const ids = new Set(page1.items.map((e) => e.id));
    expect(page2.items.some((e) => ids.has(e.id))).toBe(false);
    const page3 = store.list({}, 2, page2.nextCursor ?? undefined);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('notifies event listeners on add', () => {
    const store = makeStore();
    const seen: string[] = [];
    const unsubscribe = store.onEvent((entry) => seen.push(entry.id));
    const entry = store.add(draft());
    unsubscribe();
    store.add(draft());
    expect(seen).toEqual([entry.id]);
  });

  it('clear() removes everything', async () => {
    const store = makeStore();
    const entry = store.add(
      draft({ request: { method: 'GET', path: '/1', headers: {}, body: Buffer.from('x') } }),
    );
    await store.flush();
    expect(store.clear()).toBe(1);
    expect(store.size()).toBe(0);
    expect(await store.readBody(entry.id, 'request')).toBeNull();
  });

  it('readBody returns null for unknown ids or unlogged kinds', async () => {
    const store = makeStore();
    const entry = store.add(draft());
    expect(await store.readBody('nope', 'request')).toBeNull();
    expect(await store.readBody(entry.id, 'response')).toBeNull();
  });
});
