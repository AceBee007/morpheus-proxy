import { afterEach, describe, expect, it } from 'vitest';
import { defaultReflection } from '../config/defaults.js';
import { DescriptorRegistry } from '../grpc/descriptors.js';
import { ReflectionImporter } from '../grpc/reflection-import.js';
import { nullLogger } from '../logging/app-log.js';
import { ScriptSandbox } from '../script/sandbox.js';
import {
  startTestStack,
  startTestUpstream,
  type TestStack,
  type TestUpstream,
} from '../testing/harness.js';
import { startReflectionUpstream } from '../testing/reflection-server.js';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  rules: unknown[] = [],
): Promise<{ stack: TestStack; upstream: TestUpstream }> {
  const upstream = await startTestUpstream();
  cleanups.push(() => upstream.close());
  const stack = await startTestStack({ upstream: upstream.url, rules });
  cleanups.push(() => stack.close());
  return { stack, upstream };
}

const json = (data: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

const captureRule = (id: string, pattern = '^/users'): Record<string, unknown> => ({
  id,
  protocol: 'http',
  match: { type: 'regex', field: 'path', pattern },
  logging: { capture: true },
});

const mockRule = (id: string, pattern = '^/users'): Record<string, unknown> => ({
  id,
  protocol: 'http',
  match: { type: 'regex', field: 'path', pattern },
  request: { action: { type: 'mock_response', response: { statusCode: 200, body: 'mock' } } },
});

describe('health and status (spec 4.2.2-4.2.3)', () => {
  it('serves liveness and readiness', async () => {
    const { stack } = await setup();
    expect((await stack.api('/healthz/live')).status).toBe(200);
    expect((await stack.api('/healthz/ready')).status).toBe(200);
  });

  it('readiness returns 503 before listeners are ready (spec 4.2.2)', async () => {
    const upstream = await startTestUpstream();
    cleanups.push(() => upstream.close());
    const stack = await startTestStack({ upstream: upstream.url, ready: () => false });
    cleanups.push(() => stack.close());
    expect((await stack.api('/healthz/live')).status).toBe(200);
    const ready = await stack.api('/healthz/ready');
    expect(ready.status).toBe(503);
  });

  it('reports status details', async () => {
    const { stack } = await setup([captureRule('r1')]);
    const res = await stack.api('/api/v1/status');
    const status = (await res.json()) as Record<string, unknown>;
    expect(status['ruleCount']).toBe(1);
    expect(status['ruleRevision']).toBeGreaterThan(1);
    expect(Array.isArray(status['listeners'])).toBe(true);
    expect(status['logRetention']).toBeDefined();
  });
});

describe('rules CRUD (spec 4.2.4)', () => {
  it('creates, lists, gets, updates, and deletes rules', async () => {
    const { stack } = await setup();

    const created = await stack.api('/api/v1/rules', json(mockRule('crud-1')));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { rule: { id: string }; revision: number };
    expect(createdBody.rule.id).toBe('crud-1');

    const list = (await (await stack.api('/api/v1/rules')).json()) as {
      revision: number;
      items: Array<{ rule: { id: string }; state: { hits: number } }>;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.state.hits).toBe(0);

    const got = await stack.api('/api/v1/rules/crud-1');
    expect(got.status).toBe(200);

    const updated = await stack.api(
      `/api/v1/rules/crud-1?expectedRevision=${list.revision}`,
      { ...json({ ...mockRule('crud-1'), priority: 7 }), method: 'PUT' },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { rule: { priority: number } }).rule.priority).toBe(7);

    const deleted = await stack.api('/api/v1/rules/crud-1', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await stack.api('/api/v1/rules/crud-1')).status).toBe(404);
  });

  it('generates an id when none is given', async () => {
    const { stack } = await setup();
    const rule = mockRule('x');
    delete rule['id'];
    const res = await stack.api('/api/v1/rules', json(rule));
    const body = (await res.json()) as { rule: { id: string } };
    expect(body.rule.id).toMatch(/^rule-/);
  });

  it('rejects invalid rules with detailed errors', async () => {
    const { stack } = await setup();
    const res = await stack.api(
      '/api/v1/rules',
      json({ protocol: 'http', match: { type: 'regex', field: 'path', pattern: '(' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe('rule_validation_failed');
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('enforces expectedRevision with 409 (spec 4.2.4)', async () => {
    const { stack } = await setup([mockRule('rev-1')]);
    const res = await stack.api('/api/v1/rules/rev-1?expectedRevision=999', {
      ...json(mockRule('rev-1')),
      method: 'PUT',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('revision_conflict');
  });

  it('duplicate create is rejected', async () => {
    const { stack } = await setup([mockRule('dup')]);
    const res = await stack.api('/api/v1/rules', json(mockRule('dup')));
    expect(res.status).toBe(400);
  });

  it('disable-all disables every rule', async () => {
    const { stack } = await setup([mockRule('a'), mockRule('b')]);
    const res = await stack.api('/api/v1/rules:disable-all', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { disabled: number }).disabled).toBe(2);
    const list = (await (await stack.api('/api/v1/rules')).json()) as {
      items: Array<{ rule: { enabled: boolean } }>;
    };
    expect(list.items.every((i) => !i.rule.enabled)).toBe(true);
  });

  it('validate endpoint reports errors and warnings without persisting', async () => {
    const { stack } = await setup();
    const res = await stack.api('/api/v1/rules:validate', json(captureRule('v1')));
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
    const list = (await (await stack.api('/api/v1/rules')).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
  });
});

describe('rule state (spec 4.2.5)', () => {
  it('exposes and resets consume state', async () => {
    const { stack } = await setup([
      { ...mockRule('consumable'), consume: { times: 2 } },
    ]);
    await fetch(`${stack.url}/users/1`);
    const state1 = (await (await stack.api('/api/v1/rules/consumable/state')).json()) as {
      hits: number;
      remaining: number;
    };
    expect(state1.hits).toBe(1);
    expect(state1.remaining).toBe(1);

    const reset = await stack.api('/api/v1/rules/consumable/state:reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    const state2 = (await (await stack.api('/api/v1/rules/consumable/state')).json()) as {
      hits: number;
      remaining: number;
    };
    expect(state2.hits).toBe(0);
    expect(state2.remaining).toBe(2);
  });
});

describe('import / export (spec 4.2.7)', () => {
  it('round-trips rules including script sources', async () => {
    const scriptRule = {
      id: 'script-rule',
      protocol: 'http',
      match: { type: 'script', language: 'javascript', source: 'return ctx.request.path === "/x";' },
      request: { action: { type: 'mock_response', response: { statusCode: 200 } } },
    };
    const { stack } = await setup([mockRule('plain'), scriptRule]);

    const exported = (await (
      await stack.api('/api/v1/rules:export', json({}))
    ).json()) as { formatVersion: number; rules: Array<Record<string, unknown>> };
    expect(exported.formatVersion).toBe(1);
    expect(exported.rules).toHaveLength(2);
    const exportedScript = exported.rules.find((r) => r['id'] === 'script-rule');
    expect(JSON.stringify(exportedScript)).toContain('ctx.request.path');

    // import into a fresh stack reproduces the same behavior
    const upstream2 = await startTestUpstream();
    cleanups.push(() => upstream2.close());
    const stack2 = await startTestStack({ upstream: upstream2.url });
    cleanups.push(() => stack2.close());
    const imported = await stack2.api(
      '/api/v1/rules:import',
      json({ mode: 'replace', rules: exported.rules }),
    );
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as { imported: number }).imported).toBe(2);
    const mocked = await fetch(`${stack2.url}/users/1`);
    expect(await mocked.text()).toBe('mock');
  });

  it('import is atomic: one invalid rule rejects the whole batch', async () => {
    const { stack } = await setup([mockRule('keep')]);
    const res = await stack.api(
      '/api/v1/rules:import',
      json({
        mode: 'replace',
        rules: [mockRule('ok'), { protocol: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    const list = (await (await stack.api('/api/v1/rules')).json()) as {
      items: Array<{ rule: { id: string } }>;
    };
    expect(list.items.map((i) => i.rule.id)).toEqual(['keep']);
  });

  it('export with unknown ids returns 404', async () => {
    const { stack } = await setup();
    const res = await stack.api('/api/v1/rules:export', json({ ids: ['ghost'] }));
    expect(res.status).toBe(404);
  });
});

describe('logs API (spec 4.2.8)', () => {
  it('lists, filters, gets, downloads bodies, exports, and clears logs', async () => {
    const { stack } = await setup([captureRule('cap')]);
    await fetch(`${stack.url}/users/7`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":7}',
    });
    await fetch(`${stack.url}/other`); // unmatched: not logged

    const list = (await (await stack.api('/api/v1/logs')).json()) as {
      items: Array<{ id: string; outcome: string }>;
      nextCursor: string | null;
    };
    expect(list.items).toHaveLength(1);
    const logId = list.items[0]?.id as string;

    const filtered = (await (
      await stack.api('/api/v1/logs?outcome=captured&path=/users')
    ).json()) as { items: unknown[] };
    expect(filtered.items).toHaveLength(1);
    const none = (await (await stack.api('/api/v1/logs?outcome=fault')).json()) as {
      items: unknown[];
    };
    expect(none.items).toHaveLength(0);

    const detail = await stack.api(`/api/v1/logs/${logId}`);
    expect(detail.status).toBe(200);

    const reqBody = await stack.api(`/api/v1/logs/${logId}/request`);
    expect(reqBody.headers.get('content-type')).toBe('application/octet-stream');
    expect(await reqBody.text()).toBe('{"q":7}');

    const exported = (await (await stack.api(`/api/v1/logs/${logId}/export`)).json()) as {
      entry: { id: string };
      bodies: Record<string, string>;
    };
    expect(exported.entry.id).toBe(logId);
    expect(Buffer.from(exported.bodies['request'] as string, 'base64').toString()).toBe('{"q":7}');

    const cleared = await stack.api('/api/v1/logs', { method: 'DELETE' });
    expect(((await cleared.json()) as { removed: number }).removed).toBe(1);
  });

  it('filters by outcome=client_aborted (spec 4.9)', async () => {
    const { stack } = await setup([captureRule('cap')]);
    await fetch(`${stack.url}/users/7`);
    stack.trafficLog.add({
      startedAt: new Date(),
      endedAt: new Date(),
      protocol: 'http',
      listener: 'http-test',
      client: '127.0.0.1:1',
      target: 'http://upstream',
      request: { headers: {}, bodySkippedReason: 'client_aborted' },
      response: { headers: {}, bodySkippedReason: 'client_aborted' },
      outcome: 'client_aborted',
      loggingReason: 'client_aborted',
      matchedRules: [],
    });

    const res = await stack.api('/api/v1/logs?outcome=client_aborted');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ outcome: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.outcome).toBe('client_aborted');
  });

  it('returns bodyLogged:false metadata when the body was not stored', async () => {
    const { stack } = await setup([
      {
        id: 'delay-only',
        protocol: 'http',
        match: { type: 'regex', field: 'path', pattern: '^/users' },
        response: { delay: { durationMs: 1 } },
      },
    ]);
    await fetch(`${stack.url}/users/1`);
    const list = (await (await stack.api('/api/v1/logs')).json()) as {
      items: Array<{ id: string }>;
    };
    const logId = list.items[0]?.id as string;
    const res = await stack.api(`/api/v1/logs/${logId}/request`);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(((await res.json()) as { bodyLogged: boolean }).bodyLogged).toBe(false);
  });

  it('streams new log entries over SSE', async () => {
    const { stack } = await setup([captureRule('cap')]);
    const controller = new AbortController();
    const ssePromise = (async () => {
      const res = await stack.api('/api/v1/logs/events', { signal: controller.signal });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');
        const match = /data: (.*)\n\n/.exec(buffer);
        if (match) {
          controller.abort();
          return JSON.parse(match[1] as string) as { id: string; outcome: string };
        }
      }
      throw new Error('no SSE event received');
    })();
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${stack.url}/users/1`);
    const event = await ssePromise;
    expect(event.outcome).toBe('captured');
  });
});

describe('masking API (spec 4.2.9)', () => {
  it('gets and replaces mask settings, affecting subsequent logs', async () => {
    const { stack } = await setup([captureRule('cap', '.')]);
    const initial = (await (await stack.api('/api/v1/logging/mask')).json()) as {
      headers: string[];
    };
    expect(initial.headers).toContain('authorization');

    const updated = await stack.api('/api/v1/logging/mask', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: ['x-secret'], jsonPaths: [] }),
    });
    expect(updated.status).toBe(200);

    await fetch(`${stack.url}/any`, { headers: { 'x-secret': 'hide', authorization: 'now-visible' } });
    const list = (await (await stack.api('/api/v1/logs')).json()) as {
      items: Array<{ request: { headers: Record<string, string> } }>;
    };
    expect(list.items[0]?.request.headers['x-secret']).toBe('***');
    expect(list.items[0]?.request.headers['authorization']).toBe('now-visible');
  });

  it('rejects malformed mask settings', async () => {
    const { stack } = await setup();
    const res = await stack.api('/api/v1/logging/mask', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('simulation (spec 4.2.6)', () => {
  it('simulates the current rule set against a stored log without consuming', async () => {
    const { stack } = await setup([captureRule('cap')]);
    await fetch(`${stack.url}/users/1`, { method: 'POST', body: '{"name":"real"}' });
    const logs = (await (await stack.api('/api/v1/logs')).json()) as {
      items: Array<{ id: string }>;
    };
    const logId = logs.items[0]?.id as string;

    // add a consumable fault rule, then simulate: counter must not move
    await stack.api('/api/v1/rules', json({ ...mockRule('sim-mock'), consume: { times: 3 } }));
    const res = await stack.api('/api/v1/rules:simulate', json({ logIds: [logId] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ interceptRule: string | null; outcome: string; matchedRules: unknown[] }>;
    };
    expect(body.results[0]?.interceptRule).toBe('sim-mock');
    expect(body.results[0]?.outcome).toBe('mock');

    const state = (await (await stack.api('/api/v1/rules/sim-mock/state')).json()) as {
      consumed: number;
    };
    expect(state.consumed).toBe(0);
  });

  it('simulates a rule draft against a sample request/response pair', async () => {
    const { stack } = await setup();
    const res = await stack.api(
      '/api/v1/rules:simulate',
      json({
        sampleRequest: { protocol: 'http', method: 'GET', path: '/users/1' },
        sampleResponse: {
          statusCode: 503,
          headers: { 'x-data-source': 'real-db' },
          body: '{}',
        },
        ruleDraft: {
          id: 'draft',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          response: {
            match: { type: 'regex', field: 'status', pattern: '^5..$' },
            action: {
              type: 'response_replace',
              target: 'header.x-data-source',
              from: '^real-(.*)$',
              to: 'mock-$1',
            },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        outcome: string;
        responseStage: { matched: boolean; headersAfter: Record<string, string> };
      }>;
    };
    expect(body.results[0]?.outcome).toBe('modified');
    expect(body.results[0]?.responseStage.headersAfter['x-data-source']).toBe('mock-db');
  });

  it('simulates a script_manipulator draft against a sample response (spec 4.2.6)', async () => {
    const upstream = await startTestUpstream();
    cleanups.push(() => upstream.close());
    const sandbox = new ScriptSandbox({ defaultTimeoutMs: 3_000, maxTimeoutMs: 60_000, appLog: nullLogger() });
    cleanups.push(() => sandbox.close());
    const stack = await startTestStack({
      upstream: upstream.url,
      scriptRunner: sandbox.matcherRunner(),
      manipulatorRunner: sandbox.manipulatorRunner(),
    });
    cleanups.push(() => stack.close());

    const res = await stack.api(
      '/api/v1/rules:simulate',
      json({
        sampleRequest: { protocol: 'http', method: 'GET', path: '/users/1' },
        sampleResponse: { statusCode: 200, headers: {}, body: '{"source":"real"}' },
        ruleDraft: {
          id: 'script-draft',
          protocol: 'http',
          match: { type: 'script', language: 'javascript', source: "return ctx.request.path.startsWith('/users');" },
          response: {
            action: {
              type: 'script_manipulator',
              language: 'javascript',
              source: "return { statusCode: 299, body: ctx.response.body.replace('real', 'mock') };",
            },
          },
        },
        options: { includeBodyDiff: true },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        interceptRule: string | null;
        outcome: string;
        responseStage: { action: string; changed: boolean; statusAfter: number; bodyAfter?: string };
      }>;
    };
    const r = body.results[0];
    expect(r?.interceptRule).toBe('script-draft'); // script matcher matched in the sandbox
    expect(r?.outcome).toBe('modified');
    expect(r?.responseStage.action).toBe('script_manipulator');
    expect(r?.responseStage.changed).toBe(true);
    expect(r?.responseStage.statusAfter).toBe(299);
    expect(r?.responseStage.bodyAfter).toBe('{"source":"mock"}');
  });

  it('reports skipped body simulation when the body was not logged', async () => {
    const { stack } = await setup([
      {
        id: 'delay-only',
        protocol: 'http',
        match: { type: 'regex', field: 'path', pattern: '^/users' },
        response: { delay: { durationMs: 1 } },
      },
    ]);
    await fetch(`${stack.url}/users/1`, { method: 'POST', body: 'data' });
    const logs = (await (await stack.api('/api/v1/logs')).json()) as {
      items: Array<{ id: string }>;
    };
    const logId = logs.items[0]?.id as string;
    const res = await stack.api(
      '/api/v1/rules:simulate',
      json({
        logIds: [logId],
        ruleDraft: {
          id: 'body-draft',
          protocol: 'http',
          match: { type: 'regex', field: 'body', pattern: 'needle' },
          logging: { capture: true },
        },
      }),
    );
    const body = (await res.json()) as { results: Array<{ outcome: string }> };
    // body not logged: matcher sees no body and does not match
    expect(body.results[0]?.outcome).toBe('passthrough');
  });

  it('rejects invalid simulation input', async () => {
    const { stack } = await setup();
    expect((await stack.api('/api/v1/rules:simulate', json({}))).status).toBe(400);
    expect(
      (await stack.api('/api/v1/rules:simulate', json({ logIds: ['missing-log'] }))).status,
    ).toBe(404);
  });
});

describe('metrics (spec 4.12)', () => {
  it('counts requests by outcome and rule hits', async () => {
    const { stack } = await setup([mockRule('m')]);
    await fetch(`${stack.url}/users/1`);
    await fetch(`${stack.url}/unmatched`);
    const metrics = (await (await stack.api('/api/v1/metrics')).json()) as {
      requestsByOutcome: Record<string, number>;
      ruleHits: Record<string, number>;
    };
    expect(metrics.requestsByOutcome['mock']).toBe(1);
    expect(metrics.requestsByOutcome['passthrough']).toBe(1);
    expect(metrics.ruleHits['m']).toBe(1);
  });

  it('exposes Prometheus text format at <basePath>/metrics', async () => {
    const { stack } = await setup([mockRule('m')]);
    await fetch(`${stack.url}/users/1`);
    const res = await stack.api('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('# TYPE morpheus_requests_total counter');
    expect(body).toMatch(/morpheus_requests_total\{outcome="mock"\} 1/);
    expect(body).toContain('morpheus_upstream_latency_ms_bucket');
  });
});

describe('gRPC descriptor registry API (spec 4.7.3)', () => {
  const PROTO = `syntax = "proto3";
package demo;
service Echo { rpc Say (Msg) returns (Msg); }
message Msg { string text = 1; }
`;

  it('registers, lists, and deletes proto descriptors', async () => {
    const { stack } = await setup();
    const created = await stack.api(
      '/api/v1/grpc/descriptors',
      json({ name: 'demo.proto', format: 'proto_source', content: PROTO }),
    );
    expect(created.status).toBe(201);
    const info = (await created.json()) as {
      id: string;
      services: Array<{ fullName: string; methods: Array<{ name: string }> }>;
    };
    expect(info.services[0]?.fullName).toBe('demo.Echo');
    expect(info.services[0]?.methods[0]?.name).toBe('Say');

    const list = (await (await stack.api('/api/v1/grpc/descriptors')).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);

    const deleted = await stack.api(`/api/v1/grpc/descriptors/${info.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(
      (await stack.api(`/api/v1/grpc/descriptors/${info.id}`, { method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('rejects invalid proto sources with validation errors', async () => {
    const { stack } = await setup();
    const res = await stack.api(
      '/api/v1/grpc/descriptors',
      json({ name: 'bad.proto', format: 'proto_source', content: 'not a proto {' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('descriptor_validation_failed');
  });

  it('rejects descriptors that define no service', async () => {
    const { stack } = await setup();
    const res = await stack.api(
      '/api/v1/grpc/descriptors',
      json({
        name: 'msg-only.proto',
        format: 'proto_source',
        content: 'syntax = "proto3"; message Lonely { string x = 1; }',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('error handling (spec 4.2.1)', () => {
  it('returns the shared error shape for unknown routes and bad JSON', async () => {
    const { stack } = await setup();
    const notFound = await stack.api('/api/v1/nope');
    expect(notFound.status).toBe(404);
    const body = (await notFound.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');

    const badJson = await stack.api('/api/v1/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe('invalid_json');
  });
});

describe('gRPC descriptor import via server reflection (spec 4.7.6)', () => {
  const REFLECTED_PROTO = `syntax = "proto3";
package demo;
service TimeService { rpc Now (NowRequest) returns (NowResponse); }
message NowRequest { string tz = 1; }
message NowResponse { string iso = 1; }
`;

  async function setupWithReflection(): Promise<{ stack: TestStack; target: string }> {
    const reflected = await startReflectionUpstream({
      protoSource: REFLECTED_PROTO,
      serviceName: 'demo.TimeService',
      handlers: { Now: (_call: unknown, cb: (e: null, r: unknown) => void) => cb(null, { iso: 'x' }) },
    });
    cleanups.push(() => Promise.resolve(reflected.close()));
    const upstream = await startTestUpstream();
    cleanups.push(() => upstream.close());
    const descriptors = new DescriptorRegistry();
    const reflection = new ReflectionImporter({
      registry: descriptors,
      appLog: nullLogger(),
      settings: defaultReflection(),
    });
    const stack = await startTestStack({ upstream: upstream.url, descriptors, reflection });
    cleanups.push(() => stack.close());
    return { stack, target: reflected.target };
  }

  it('imports descriptors from an upstream and lists them with provenance', async () => {
    const { stack, target } = await setupWithReflection();
    const res = await stack.api('/api/v1/grpc/descriptors:reflect', json({ target }));
    expect(res.status).toBe(201);
    const info = (await res.json()) as {
      id: string;
      format: string;
      source: { type: string; target: string; protocol: string };
      services: Array<{ fullName: string }>;
    };
    expect(info.format).toBe('descriptor_set');
    expect(info.source).toMatchObject({ type: 'reflection', target, protocol: 'grpc-v1' });
    expect(info.services.map((s) => s.fullName)).toEqual(['demo.TimeService']);

    const list = (await (await stack.api('/api/v1/grpc/descriptors')).json()) as {
      items: Array<{ id: string; source: { type: string } }>;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.source.type).toBe('reflection');

    const status = (await (await stack.api('/api/v1/grpc/reflection')).json()) as {
      auto: boolean;
      imports: Array<{ target: string; descriptorId: string }>;
      failures: unknown[];
    };
    expect(status.auto).toBe(false);
    expect(status.imports).toEqual([expect.objectContaining({ target, descriptorId: info.id })]);
    expect(status.failures).toEqual([]);

    // a mock rule with messages can now be validated against the imported schema
    const rule = await stack.api(
      '/api/v1/rules',
      json({
        id: 'mock-now',
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.TimeService/Now$' },
        request: {
          action: { type: 'mock_response', response: { grpcStatus: 0, messages: [{ iso: 'mocked' }] } },
        },
      }),
    );
    expect(rule.status).toBe(201);
  });

  it('validates the request and maps reflection failures to 400 / 502', async () => {
    const { stack } = await setupWithReflection();

    const missing = await stack.api('/api/v1/grpc/descriptors:reflect', json({}));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_reflection_request',
    );

    const badSymbols = await stack.api(
      '/api/v1/grpc/descriptors:reflect',
      json({ target: '127.0.0.1:1', symbols: 'demo.TimeService' }),
    );
    expect(badSymbols.status).toBe(400);

    const badTarget = await stack.api('/api/v1/grpc/descriptors:reflect', json({ target: 'no-port' }));
    expect(badTarget.status).toBe(400);
    const badTargetBody = (await badTarget.json()) as {
      error: { code: string; details: Array<{ reason: string }> };
    };
    expect(badTargetBody.error.code).toBe('reflection_failed');
    expect(badTargetBody.error.details[0]?.reason).toBe('invalid_target');

    const unreachable = await stack.api(
      '/api/v1/grpc/descriptors:reflect',
      json({ target: '127.0.0.1:1', timeoutMs: 500 }),
    );
    expect(unreachable.status).toBe(502);
    const unreachableBody = (await unreachable.json()) as {
      error: { code: string; details: Array<{ reason: string }> };
    };
    expect(unreachableBody.error.code).toBe('reflection_failed');
    expect(unreachableBody.error.details[0]?.reason).toBe('unavailable');

    const status = (await (await stack.api('/api/v1/grpc/reflection')).json()) as {
      failures: Array<{ target: string; reason: string }>;
    };
    expect(status.failures).toEqual([expect.objectContaining({ target: '127.0.0.1:1', reason: 'unavailable' })]);
  });

  it('answers 400 when the process has no reflection importer', async () => {
    const { stack } = await setup();
    const res = await stack.api('/api/v1/grpc/descriptors:reflect', json({ target: '127.0.0.1:1' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('reflection_unavailable');
    expect((await stack.api('/api/v1/grpc/reflection')).status).toBe(400);
  });
});
