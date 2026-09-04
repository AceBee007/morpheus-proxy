import http from 'node:http';
import http2 from 'node:http2';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startTestProxy,
  startTestUpstream,
  type TestProxy,
  type TestUpstream,
} from '../testing/harness.js';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  opts: Parameters<typeof startTestProxy>[0] extends infer T
    ? Omit<T & object, 'upstream'> & { upstream?: string }
    : never,
  handler?: Parameters<typeof startTestUpstream>[0],
): Promise<{ proxy: TestProxy; upstream: TestUpstream }> {
  const upstream = await startTestUpstream(handler);
  cleanups.push(() => upstream.close());
  const proxy = await startTestProxy({ upstream: upstream.url, ...opts });
  cleanups.push(() => proxy.close());
  return { proxy, upstream };
}

describe('transparent forwarding (spec 4.1)', () => {
  it('forwards requests and responses untouched when no rules exist', async () => {
    const { proxy, upstream } = await setup({});
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      // node:http allows an explicit Host header (fetch forbids it)
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: '/users/1?x=1',
          headers: { 'x-custom': 'keep', host: 'svc.internal' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { method: string; url: string };
    expect(body.method).toBe('GET');
    expect(body.url).toBe('/users/1?x=1');

    const received = upstream.received[0];
    expect(received?.headers['x-custom']).toBe('keep');
    // Host preserved, no proxy headers added (spec 4.1.1)
    expect(received?.headers['host']).toBe('svc.internal');
    expect(received?.headers['x-forwarded-for']).toBeUndefined();
    expect(received?.headers['via']).toBeUndefined();

    // unmatched passthrough is not logged (spec 4.9)
    expect(proxy.trafficLog.size()).toBe(0);
  });

  it('forwards POST bodies transparently', async () => {
    const { proxy, upstream } = await setup({});
    const res = await fetch(`${proxy.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello upstream',
    });
    expect(res.status).toBe(200);
    expect(upstream.received[0]?.body.toString()).toBe('hello upstream');
  });

  it('strips hop-by-hop headers when forwarding', async () => {
    const { upstream, proxy } = await setup({});
    await fetch(`${proxy.url}/`, { headers: { te: 'trailers' } });
    expect(upstream.received[0]?.headers['te']).toBeUndefined();
  });

  it('serves h2c clients and forwards to an http/1.1 upstream', async () => {
    const { proxy, upstream } = await setup({});
    const session = http2.connect(`http://127.0.0.1:${proxy.port}`);
    cleanups.push(() => Promise.resolve(session.close()));
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = session.request({
        ':method': 'GET',
        ':path': '/h2-test',
        ':authority': 'svc.h2.internal',
      });
      let status = 0;
      const chunks: Buffer[] = [];
      req.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString() }));
      req.on('error', reject);
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain('/h2-test');
    expect(upstream.received[0]?.headers['host']).toBe('svc.h2.internal');
  });
});

describe('upstream failures (spec 4.1.2)', () => {
  it('returns 502 with x-morpheus-error when the upstream is down', async () => {
    const proxy = await startTestProxy({ upstream: 'http://127.0.0.1:1' });
    cleanups.push(() => proxy.close());
    const res = await fetch(`${proxy.url}/anything`);
    expect(res.status).toBe(502);
    expect(res.headers.get('x-morpheus-error')).toBe('upstream_connect_failed');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('upstream_error');
    expect(entry?.upstreamResponse?.received).toBe(false);
  });

  it('returns 504 when the upstream times out', async () => {
    const { proxy } = await setup({ limits: { upstreamTimeoutMs: 100 } }, (_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 5_000);
    });
    const res = await fetch(`${proxy.url}/slow`);
    expect(res.status).toBe(504);
    expect(res.headers.get('x-morpheus-error')).toBe('upstream_timeout');
    expect(proxy.trafficLog.list().items[0]?.outcome).toBe('upstream_error');
  });
});

describe('mock and fault rules (spec 4.5)', () => {
  it('returns a mock response without contacting the upstream', async () => {
    const { proxy, upstream } = await setup({
      rules: [
        {
          id: 'mock-users',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          request: {
            action: {
              type: 'mock_response',
              response: {
                statusCode: 201,
                headers: { 'content-type': 'application/json', 'x-morpheus-mock': 'true' },
                body: '{"name":"mock-user"}',
              },
            },
          },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/users/1`);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-morpheus-mock')).toBe('true');
    expect(await res.text()).toBe('{"name":"mock-user"}');
    expect(upstream.received).toHaveLength(0);

    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('mock');
    expect(entry?.response.bodyPreview).toBe('{"name":"mock-user"}');
    // other paths still pass through untouched
    const other = await fetch(`${proxy.url}/orders`);
    expect(other.headers.get('x-upstream')).toBe('yes');
  });

  it('consumable fault applies N times then falls through (spec 4.6, AC)', async () => {
    const { proxy, upstream } = await setup({
      rules: [
        {
          id: 'fault-3x',
          protocol: 'http',
          priority: 100,
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          request: {
            action: {
              type: 'fault',
              fault: { kind: 'http_response', statusCode: 503, body: '{"error":"injected"}' },
            },
          },
          consume: { times: 3 },
        },
      ],
    });
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${proxy.url}/users/1`);
      expect(res.status).toBe(503);
    }
    const after = await fetch(`${proxy.url}/users/1`);
    expect(after.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    const state = proxy.consume.stateOf(proxy.ruleStore.get('fault-3x')!);
    expect(state.remaining).toBe(0);
    expect(state.hits).toBe(3);
  });

  it('exhausted high-priority rule lets a lower-priority rule apply (AC)', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'high',
          protocol: 'http',
          priority: 100,
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          request: {
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 503 } },
          },
          consume: { times: 1 },
        },
        {
          id: 'low',
          protocol: 'http',
          priority: 1,
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          request: {
            action: {
              type: 'mock_response',
              response: { statusCode: 299, body: 'low-priority-mock' },
            },
          },
        },
      ],
    });
    expect((await fetch(`${proxy.url}/users/1`)).status).toBe(503);
    const second = await fetch(`${proxy.url}/users/1`);
    expect(second.status).toBe(299);
    expect(await second.text()).toBe('low-priority-mock');
  });

  it('connection reset fault destroys the socket', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'reset',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/reset' },
          request: { action: { type: 'fault', fault: { kind: 'connection', mode: 'reset' } } },
        },
      ],
    });
    await expect(fetch(`${proxy.url}/reset`)).rejects.toThrow();
    expect(proxy.trafficLog.list().items[0]?.outcome).toBe('fault');
  });

  it('timeout fault holds the connection then closes it', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'hang',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/hang' },
          request: {
            action: { type: 'fault', fault: { kind: 'timeout', durationMs: 150 } },
          },
        },
      ],
    });
    const started = Date.now();
    await expect(fetch(`${proxy.url}/hang`)).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe('delay (spec 4.5.1)', () => {
  it('fixed delay adds latency on the response stage', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'delay',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/slow' },
          response: { delay: { durationMs: 200 } },
        },
      ],
    });
    const started = Date.now();
    const res = await fetch(`${proxy.url}/slow`);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(proxy.trafficLog.list().items[0]?.outcome).toBe('delayed');
  });

  it('total delay targets end-to-end latency (spec 4.5.1)', async () => {
    const { proxy } = await setup(
      {
        rules: [
          {
            id: 'total',
            protocol: 'http',
            match: { type: 'regex', field: 'path', pattern: '^/total' },
            response: { delay: { durationMs: 300, mode: 'total' } },
          },
        ],
      },
      (_req, res) => setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 50),
    );
    const started = Date.now();
    await fetch(`${proxy.url}/total`);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(600);
  });

  it('total delay is skipped when upstream already exceeded it', async () => {
    const { proxy } = await setup(
      {
        rules: [
          {
            id: 'total-skip',
            protocol: 'http',
            match: { type: 'regex', field: 'path', pattern: '^/total' },
            response: { delay: { durationMs: 50, mode: 'total' } },
          },
        ],
      },
      (_req, res) => setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 150),
    );
    const started = Date.now();
    await fetch(`${proxy.url}/total`);
    expect(Date.now() - started).toBeLessThan(400);
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.timing?.delaySkipped).toBe(true);
  });
});

describe('request rewrite and response replace (spec 4.5.4-4.5.5)', () => {
  it('rewrites request headers, path, and body before forwarding', async () => {
    const { proxy, upstream } = await setup({
      rules: [
        {
          id: 'rewrite',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '^/v1/' },
          request: {
            action: {
              type: 'request_rewrite',
              operations: [
                { op: 'set_header', name: 'x-test-case', value: 'retry' },
                { op: 'set_path', value: '/v2/users' },
                { op: 'replace_body', from: '"env":"prod"', to: '"env":"test"' },
              ],
            },
          },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/v1/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"env":"prod"}',
    });
    expect(res.status).toBe(200);
    const received = upstream.received[0];
    expect(received?.url).toBe('/v2/users');
    expect(received?.headers['x-test-case']).toBe('retry');
    expect(received?.body.toString()).toBe('{"env":"test"}');

    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('modified');
    expect(entry?.forwardedRequest?.modified).toBe(true);
    // original and forwarded bodies both logged (spec 4.9.3)
    expect(entry?.request.bodyPreview).toContain('prod');
    expect(entry?.forwardedRequest?.bodyPreview).toContain('test');
  });

  it('replaces response header values via regex', async () => {
    const { proxy } = await setup(
      {
        rules: [
          {
            id: 'replace',
            protocol: 'http',
            match: { type: 'regex', field: 'path', pattern: '.' },
            response: {
              action: {
                type: 'response_replace',
                target: 'header.x-data-source',
                from: '^real-(.*)$',
                to: 'mock-$1',
              },
            },
          },
        ],
      },
      (_req, res) => {
        res.writeHead(200, { 'x-data-source': 'real-db' });
        res.end('body');
      },
    );
    const res = await fetch(`${proxy.url}/`);
    expect(res.headers.get('x-data-source')).toBe('mock-db');
    expect(await res.text()).toBe('body');
    expect(proxy.trafficLog.list().items[0]?.outcome).toBe('modified');
  });

  it('response.match gates the response action on upstream status (spec 4.3.1)', async () => {
    let status = 200;
    const { proxy } = await setup(
      {
        rules: [
          {
            id: 'gate',
            protocol: 'http',
            match: { type: 'regex', field: 'path', pattern: '.' },
            response: {
              match: { type: 'regex', field: 'status', pattern: '^5..$' },
              action: {
                type: 'fault',
                fault: { kind: 'http_response', statusCode: 599, body: 'replaced' },
              },
            },
          },
        ],
      },
      (_req, res) => {
        res.writeHead(status);
        res.end('upstream-body');
      },
    );
    const ok = await fetch(`${proxy.url}/`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('upstream-body');
    expect(proxy.trafficLog.list().items[0]?.outcome).toBe('captured');

    status = 503;
    const replaced = await fetch(`${proxy.url}/`);
    expect(replaced.status).toBe(599);
    expect(await replaced.text()).toBe('replaced');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('fault');
    // upstream response preserved in the log (spec 4.9.2)
    expect(entry?.upstreamResponse?.statusCode).toBe(503);
  });
});

describe('capture rules and logging (spec 4.9)', () => {
  it('captures bodies while passing traffic through unchanged', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'capture-users',
          protocol: 'http',
          priority: 10,
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          logging: { capture: true },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/users/1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":1}',
    });
    expect(res.status).toBe(200);
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('captured');
    expect(entry?.loggingReason).toBe('capture_rule');
    expect(entry?.request.bodyLogged).toBe(true);
    expect(entry?.response.bodyLogged).toBe(true);
    const raw = await proxy.trafficLog.readBody(entry!.id, 'request');
    expect(raw?.toString()).toBe('{"q":1}');

    // capture rules are non-terminal: an unmatched path is not logged
    await fetch(`${proxy.url}/other`);
    expect(proxy.trafficLog.size()).toBe(1);
  });

  it('capture rule does not stop a matching intercept rule (observation, spec 4.3.2)', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'capture',
          protocol: 'http',
          priority: 200,
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          logging: { capture: true },
        },
        {
          id: 'mock',
          protocol: 'http',
          priority: 100,
          match: { type: 'regex', field: 'path', pattern: '^/users' },
          request: {
            action: { type: 'mock_response', response: { statusCode: 200, body: 'mock' } },
          },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/users/1`);
    expect(await res.text()).toBe('mock');
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.matchedRules.map((m) => m.id)).toEqual(['capture', 'mock']);
    expect(entry?.outcome).toBe('mock');
  });
});

describe('body buffering limits (spec 4.8.3)', () => {
  it('rejects oversized bodies with 413 when a body matcher needs them', async () => {
    const { proxy } = await setup({
      listener: { maxRequestBodyBufferBytes: 64 },
      rules: [
        {
          id: 'body-matcher',
          protocol: 'http',
          match: { type: 'regex', field: 'body', pattern: 'needle' },
          request: {
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 500 } },
          },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/post`, {
      method: 'POST',
      body: 'x'.repeat(1000),
    });
    expect(res.status).toBe(413);
  });

  it('passes oversized bodies through when only capture wants them', async () => {
    const { proxy, upstream } = await setup({
      listener: { maxRequestBodyBufferBytes: 64 },
      rules: [
        {
          id: 'capture',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '.' },
          logging: { capture: true },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/post`, { method: 'POST', body: 'y'.repeat(1000) });
    expect(res.status).toBe(200);
    expect(upstream.received[0]?.body.byteLength).toBe(1000);
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.request.bodyLogged).toBe(false);
    expect(entry?.request.bodyLoggingSkippedReason).toBe('limit_exceeded');
  });
});

describe('rule errors (spec 4.4.3)', () => {
  it('script matcher without a sandbox passes through and logs rule_error', async () => {
    const { proxy } = await setup({
      rules: [
        {
          id: 'script',
          protocol: 'http',
          match: { type: 'script', language: 'javascript', source: 'return true;' },
          request: {
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 500 } },
          },
        },
      ],
    });
    const res = await fetch(`${proxy.url}/x`);
    expect(res.status).toBe(200); // passthrough, fault not applied
    const entry = proxy.trafficLog.list().items[0];
    expect(entry?.outcome).toBe('rule_error');
    expect(entry?.ruleErrors?.[0]?.ruleId).toBe('script');
  });
});

describe('hot reload (spec 4.10)', () => {
  it('applies rule changes to the next request without restart', async () => {
    const { proxy } = await setup({});
    expect((await fetch(`${proxy.url}/users/1`)).status).toBe(200);

    proxy.addRule({
      id: 'late-mock',
      protocol: 'http',
      match: { type: 'regex', field: 'path', pattern: '^/users' },
      request: { action: { type: 'mock_response', response: { statusCode: 222 } } },
    });
    expect((await fetch(`${proxy.url}/users/1`)).status).toBe(222);

    proxy.ruleStore.delete('late-mock');
    expect((await fetch(`${proxy.url}/users/1`)).status).toBe(200);
  });
});

describe('websocket/upgrade passthrough (spec 4.1.1)', () => {
  it('tunnels upgrade requests without rule processing', async () => {
    const upstream = http.createServer();
    const wsSockets: import('node:stream').Duplex[] = [];
    upstream.on('upgrade', (req, socket) => {
      wsSockets.push(socket);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.write('hello-ws');
      // behave like a real ws server: answer the peer FIN
      socket.on('end', () => socket.end());
      socket.on('error', () => socket.destroy());
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of wsSockets) socket.destroy();
          upstream.closeAllConnections();
          upstream.close(() => resolve(undefined));
        }),
    );

    const proxy = await startTestProxy({ upstream: `http://127.0.0.1:${upstreamPort}` });
    cleanups.push(() => proxy.close());

    const result = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        path: '/ws',
        headers: { connection: 'Upgrade', upgrade: 'websocket' },
      });
      req.on('upgrade', (_res, socket, head) => {
        if (head.length > 0) {
          socket.destroy();
          resolve(head.toString());
          return;
        }
        socket.once('data', (data: Buffer) => {
          socket.destroy();
          resolve(data.toString());
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(result).toBe('hello-ws');
  });
});

describe('HTTP attempt logging is guaranteed exactly once (client_aborted)', () => {
  it('logs rule_error instead of dropping the attempt on an invalid response_replace regex (handleHttpExchange defense-in-depth)', async () => {
    const { proxy } = await setup({}, (_req, res) => {
      res.writeHead(200, { 'x-data-source': 'real-db' });
      res.end('body');
    });
    // bypasses validateRule (which would normally reject this pattern) to
    // prove the guard added around handleHttpExchange holds even so.
    proxy.ruleStore.create({
      schemaVersion: 1,
      id: 'bad-regex',
      name: '',
      description: '',
      enabled: true,
      priority: 10,
      protocol: 'http',
      match: { type: 'regex', field: 'path', pattern: '.' },
      response: {
        action: { type: 'response_replace', target: 'header.x-data-source', from: '(', to: 'x' },
      },
      logging: { capture: true },
      createdAt: '',
      updatedAt: '',
    });
    const res = await fetch(`${proxy.url}/`);
    expect(res.status).toBe(500);
    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.outcome).toBe('rule_error');
    expect(items[0]?.ruleErrors?.[0]?.error).toBeTruthy();
  });

  const capAllRule = {
    id: 'cap-all',
    protocol: 'http' as const,
    match: { type: 'regex' as const, field: 'path' as const, pattern: '.' },
    logging: { capture: true },
  };

  it('evaluates an aborted partial HTTP/2 request in normal priority order', async () => {
    const { proxy, upstream } = await setup({
      rules: [
        {
          id: 'fault-once',
          protocol: 'http',
          priority: 100,
          match: { type: 'regex', field: 'path', pattern: '^/partial$' },
          request: {
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 503 } },
          },
          consume: { times: 1 },
        },
        {
          ...capAllRule,
          priority: 1,
          match: { type: 'regex', field: 'path', pattern: '^/partial$' },
        },
      ],
    });
    const session = http2.connect(`http://127.0.0.1:${proxy.port}`);
    cleanups.push(() => Promise.resolve(session.close()));
    session.on('error', () => {});

    const abortPartial = async (): Promise<void> => {
      // A partial request: the client declares 64 bytes, sends 23, then gives up.
      // Node half-closes the stream (END_STREAM) before the RST_STREAM(CANCEL)
      // reaches the proxy, so the proxy must recognise the short body from
      // content-length rather than from the timing of the reset.
      const req = session.request({ ':method': 'POST', ':path': '/partial', 'content-length': '64' });
      req.on('error', () => {});
      req.write('incomplete request body');
      await sleep(20);
      req.close(http2.constants.NGHTTP2_CANCEL);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    };

    // The high-priority intercept matches and is consumed; the lower capture
    // rule is never evaluated for this attempt.
    await abortPartial();
    // The exhausted intercept is skipped, so the same partial request now
    // reaches and records the lower-priority capture rule.
    await abortPartial();

    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(2);
    expect(items[1]?.outcome).toBe('client_aborted');
    expect(items[1]?.matchedRules.map((m) => m.id)).toEqual(['fault-once']);
    expect(items[0]?.outcome).toBe('client_aborted');
    expect(items[0]?.matchedRules.map((m) => m.id)).toEqual(['cap-all']);
    expect(proxy.consume.stateOf(proxy.ruleStore.get('fault-once')!).remaining).toBe(0);
    expect(upstream.received).toHaveLength(0);
  });

  // HTTP counterpart of the gRPC test with the same name: a capture-all
  // observation rule alongside a separate consume-once fault rule, so a
  // retried request's first (faulted) attempt and second (passthrough)
  // attempt are both independently visible in Logs.
  it('records both the faulted attempt and its retry when a capture-all rule sits alongside a consume-once fault', async () => {
    const { proxy } = await setup({
      rules: [
        capAllRule,
        {
          id: 'fault-once',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '.' },
          consume: { times: 1 },
          response: {
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 503, body: 'injected' } },
          },
        },
      ],
    });
    const first = await fetch(`${proxy.url}/x`);
    expect(first.status).toBe(503);
    const second = await fetch(`${proxy.url}/x`);
    expect(second.status).toBe(200);

    const items = proxy.trafficLog.list().items;
    expect(items).toHaveLength(2);
    const [retry, faulted] = items;
    expect(faulted?.outcome).toBe('fault');
    expect(faulted?.matchedRules.map((m) => m.id)).toEqual(['cap-all', 'fault-once']);
    expect(retry?.outcome).toBe('captured');
    expect(retry?.matchedRules.map((m) => m.id)).toEqual(['cap-all']);
  });

  // Same pattern, but the fault is preceded by a delay long enough that the
  // client cancels before ever seeing it. The first attempt must show
  // client_aborted, not a misleading 'fault' the client never received.
  it("records the cancelled attempt as client_aborted (not fault) when the client times out during a fault rule's delay", async () => {
    const { proxy } = await setup({
      rules: [
        capAllRule,
        {
          id: 'fault-once',
          protocol: 'http',
          match: { type: 'regex', field: 'path', pattern: '.' },
          consume: { times: 1 },
          response: {
            delay: { durationMs: 3000 },
            action: { type: 'fault', fault: { kind: 'http_response', statusCode: 503, body: 'injected' } },
          },
        },
      ],
    });
    const session = http2.connect(`http://127.0.0.1:${proxy.port}`);
    cleanups.push(() => Promise.resolve(session.close()));
    session.on('error', () => {});
    const req1 = session.request({ ':method': 'GET', ':path': '/x' });
    req1.on('error', () => {});
    await sleep(200);
    req1.close(http2.constants.NGHTTP2_CANCEL);
    await sleep(3200);

    const status2 = await new Promise<number>((resolve) => {
      const req2 = session.request({ ':method': 'GET', ':path': '/x' });
      req2.on('response', (headers) => resolve(Number(headers[':status'])));
      req2.on('error', () => resolve(-1));
    });
    expect(status2).toBe(200);

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
