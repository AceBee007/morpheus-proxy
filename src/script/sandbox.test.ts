import { afterEach, describe, expect, it } from 'vitest';
import { nullLogger } from '../logging/app-log.js';
import { ScriptSandbox, ScriptTimeoutError } from './sandbox.js';
import { startTestProxy, startTestUpstream } from '../testing/harness.js';

const sandboxes: ScriptSandbox[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

function makeSandbox(opts: { defaultTimeoutMs?: number; maxTimeoutMs?: number } = {}): ScriptSandbox {
  const sandbox = new ScriptSandbox({
    defaultTimeoutMs: opts.defaultTimeoutMs ?? 3_000,
    maxTimeoutMs: opts.maxTimeoutMs ?? 60_000,
    appLog: nullLogger(),
  });
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  while (sandboxes.length > 0) await sandboxes.pop()?.close();
});

describe('ScriptSandbox (spec 4.4.3)', () => {
  it('runs matcher scripts against ctx and returns booleans', async () => {
    const sandbox = makeSandbox();
    const runner = sandbox.matcherRunner();
    const input = {
      protocol: 'http' as const,
      stage: 'request' as const,
      request: { id: 'r', path: '/users/1', headers: { 'x-test': '1' } },
      ruleState: { hits: 0 },
    };
    const matcher = {
      type: 'script' as const,
      language: 'javascript' as const,
      source: "return ctx.request.path.startsWith('/users') && ctx.request.headers['x-test'] === '1';",
    };
    expect(await runner(matcher, input)).toBe(true);
    expect(
      await runner({ ...matcher, source: "return ctx.request.path.startsWith('/orders');" }, input),
    ).toBe(false);
  });

  it('runs manipulator scripts returning patches', async () => {
    const sandbox = makeSandbox();
    const runner = sandbox.manipulatorRunner();
    const patch = await runner(
      {
        type: 'script_manipulator',
        language: 'javascript',
        source: "return { body: ctx.response.body.replace('real', 'mock'), headers: { 'x-edited': 'yes' } };",
      },
      {
        protocol: 'http',
        stage: 'response',
        request: { id: 'r', path: '/', headers: {} },
        response: { statusCode: 200, headers: {}, body: 'real-value' },
        ruleState: { hits: 1 },
        upstream: { durationMs: 5 },
      },
    );
    expect(patch).toEqual({ body: 'mock-value', headers: { 'x-edited': 'yes' } });
  });

  it('rejects on compile errors', async () => {
    const sandbox = makeSandbox();
    await expect(sandbox.run('this is not javascript ~~~', {})).rejects.toThrow(/compile error/);
  });

  it('rejects on runtime errors', async () => {
    const sandbox = makeSandbox();
    await expect(sandbox.run('throw new Error("boom");', {})).rejects.toThrow(/boom/);
  });

  it('blocks require, process, and dynamic import inside scripts', async () => {
    const sandbox = makeSandbox();
    await expect(sandbox.run('return require("node:fs");', {})).rejects.toThrow(
      /require is not defined/,
    );
    await expect(sandbox.run('return process.env;', {})).rejects.toThrow(
      /process is not defined/,
    );
    await expect(sandbox.run('return typeof (await import("node:fs"));', {})).rejects.toThrow();
    await expect(sandbox.run('return eval("1+1");', {})).rejects.toThrow();
  });

  it('kills and restarts the subprocess on timeout, then keeps working', async () => {
    const sandbox = makeSandbox({ defaultTimeoutMs: 200 });
    await expect(sandbox.run('for(;;){}', {})).rejects.toThrow(ScriptTimeoutError);
    // the replacement worker serves the next job
    await new Promise((r) => setTimeout(r, 200));
    expect(await sandbox.run('return 41 + 1;', {})).toBe(42);
    expect(sandbox.status().restarts).toBeGreaterThanOrEqual(1);
  });

  it('times out async freezes too', async () => {
    const sandbox = makeSandbox({ defaultTimeoutMs: 200 });
    await expect(sandbox.run('await new Promise(() => {});', {})).rejects.toThrow(
      ScriptTimeoutError,
    );
  });

  it('clamps per-rule timeouts to the configured maximum', async () => {
    const sandbox = makeSandbox({ defaultTimeoutMs: 100, maxTimeoutMs: 300 });
    const started = Date.now();
    await expect(sandbox.run('for(;;){}', {}, 60_000)).rejects.toThrow(ScriptTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('script rules end-to-end (spec 4.4.3, 4.5.6)', () => {
  it('applies script matchers and manipulators through the proxy', async () => {
    const sandbox = makeSandbox();
    const upstream = await startTestUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"source":"real"}');
    });
    cleanups.push(() => upstream.close());
    const proxy = await startTestProxy({
      upstream: upstream.url,
      scriptRunner: sandbox.matcherRunner(),
      manipulatorRunner: sandbox.manipulatorRunner(),
      rules: [
        {
          id: 'script-rule',
          protocol: 'http',
          match: {
            type: 'script',
            language: 'javascript',
            source: "return ctx.request.headers['x-scripted'] === 'yes';",
          },
          response: {
            action: {
              type: 'script_manipulator',
              language: 'javascript',
              source: "return { statusCode: 299, body: ctx.response.body.replace('real', 'mock') };",
            },
          },
        },
      ],
    });
    cleanups.push(() => proxy.close());

    const unmatched = await fetch(`${proxy.url}/x`);
    expect(unmatched.status).toBe(200);
    expect(await unmatched.text()).toBe('{"source":"real"}');

    const matched = await fetch(`${proxy.url}/x`, { headers: { 'x-scripted': 'yes' } });
    expect(matched.status).toBe(299);
    expect(await matched.text()).toBe('{"source":"mock"}');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('modified');
    // upstream and returned bodies both preserved (spec 4.9.3)
    expect(entry?.upstreamResponse?.bodyPreview).toContain('real');
    expect(entry?.response.bodyPreview).toContain('mock');
  });

  it('script timeout falls back to passthrough with rule_error (spec 4.4.3, AC)', async () => {
    const sandbox = makeSandbox({ defaultTimeoutMs: 150 });
    const upstream = await startTestUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startTestProxy({
      upstream: upstream.url,
      scriptRunner: sandbox.matcherRunner(),
      manipulatorRunner: sandbox.manipulatorRunner(),
      rules: [
        {
          id: 'freezing-rule',
          protocol: 'http',
          match: { type: 'script', language: 'javascript', source: 'for(;;){}' },
          request: {
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 500 } },
          },
        },
      ],
    });
    cleanups.push(() => proxy.close());

    const res = await fetch(`${proxy.url}/anything`);
    expect(res.status).toBe(200); // passthrough, fault not applied
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('rule_error');
    expect(entry?.ruleErrors?.[0]?.error).toContain('timed out');
  });
});
