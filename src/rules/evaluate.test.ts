import { describe, expect, it } from 'vitest';
import { ConsumeRegistry } from './consume.js';
import { evaluateRequest, evaluateResponseMatch } from './evaluate.js';
import { validateRule } from './validate.js';
import type { RequestSnapshot, ResponseSnapshot } from './matcher.js';
import type { Rule } from './types.js';

function makeRule(overrides: Record<string, unknown> = {}): Rule {
  const result = validateRule({
    protocol: 'http',
    match: { type: 'regex', field: 'path', pattern: '^/users' },
    logging: { capture: true },
    ...overrides,
  });
  if (!result.rule) throw new Error(JSON.stringify(result.errors));
  return result.rule;
}

const mockAction = { type: 'mock_response', response: { statusCode: 200, body: 'mock' } };
const faultAction = { type: 'fault', fault: { kind: 'http_response', statusCode: 503 } };

function request(path = '/users/1'): RequestSnapshot {
  return { id: 'req', method: 'GET', path, headers: {} };
}

describe('evaluateRequest', () => {
  it('returns no intercept rule when nothing matches', async () => {
    const result = await evaluateRequest({
      rules: [makeRule({ match: { type: 'regex', field: 'path', pattern: '^/orders' } })],
      protocol: 'http',
      request: request(),
      consume: new ConsumeRegistry(),
    });
    expect(result.interceptRule).toBeNull();
    expect(result.matched).toEqual([]);
  });

  it('skips disabled rules and protocol mismatches', async () => {
    const result = await evaluateRequest({
      rules: [
        makeRule({ id: 'disabled', enabled: false, request: { action: mockAction } }),
        makeRule({
          id: 'grpc-only',
          protocol: 'grpc',
          match: { type: 'regex', field: 'path', pattern: '.' },
          request: { action: { type: 'fault', fault: { kind: 'grpc_status', status: 14 } } },
        }),
      ],
      protocol: 'http',
      request: request(),
      consume: new ConsumeRegistry(),
    });
    expect(result.interceptRule).toBeNull();
  });

  it('observation rules keep evaluation going; first intercept rule wins', async () => {
    const rules = [
      makeRule({ id: 'capture-1' }),
      makeRule({ id: 'intercept-1', request: { action: mockAction } }),
      makeRule({ id: 'intercept-2', request: { action: faultAction } }),
    ];
    const consume = new ConsumeRegistry();
    const result = await evaluateRequest({ rules, protocol: 'http', request: request(), consume });
    expect(result.captureRules.map((r) => r.id)).toEqual(['capture-1']);
    expect(result.interceptRule?.id).toBe('intercept-1');
    expect(result.matched.map((m) => m.id)).toEqual(['capture-1', 'intercept-1']);
    // intercept-2 was never evaluated
    expect(consume.stateOf(rules[2] as Rule).hits).toBe(0);
  });

  it('exhausted consumable rules are skipped so lower-priority rules apply (spec 4.6)', async () => {
    const high = makeRule({
      id: 'high',
      priority: 100,
      consume: { times: 2 },
      request: { action: faultAction },
    });
    const low = makeRule({ id: 'low', priority: 1, request: { action: mockAction } });
    const consume = new ConsumeRegistry();

    for (let i = 0; i < 2; i++) {
      const result = await evaluateRequest({
        rules: [high, low],
        protocol: 'http',
        request: request(),
        consume,
      });
      expect(result.interceptRule?.id).toBe('high');
    }
    const after = await evaluateRequest({
      rules: [high, low],
      protocol: 'http',
      request: request(),
      consume,
    });
    expect(after.interceptRule?.id).toBe('low');
    expect(consume.stateOf(high).remaining).toBe(0);
  });

  it('falls through to passthrough when every matching rule is exhausted', async () => {
    const only = makeRule({ id: 'only', consume: { times: 1 }, request: { action: mockAction } });
    const consume = new ConsumeRegistry();
    await evaluateRequest({ rules: [only], protocol: 'http', request: request(), consume });
    const second = await evaluateRequest({
      rules: [only],
      protocol: 'http',
      request: request(),
      consume,
    });
    expect(second.interceptRule).toBeNull();
    expect(second.matched).toEqual([]);
  });

  it('records matcher failures as rule errors and continues (spec 4.4.3)', async () => {
    const broken = makeRule({
      id: 'script-rule',
      match: { type: 'script', language: 'javascript', source: 'return true;' },
      request: { action: faultAction },
    });
    const fallback = makeRule({ id: 'fallback', request: { action: mockAction } });
    const result = await evaluateRequest({
      rules: [broken, fallback],
      protocol: 'http',
      request: request(),
      consume: new ConsumeRegistry(),
      // no scriptRunner: the script matcher throws
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.ruleId).toBe('script-rule');
    expect(result.interceptRule?.id).toBe('fallback');
  });

  it('treats body matchers as non-matching on streaming traffic (spec 4.7.5)', async () => {
    const bodyRule = makeRule({
      id: 'body-rule',
      match: { type: 'regex', field: 'body', pattern: '.' },
      request: { action: faultAction },
    });
    const pathRule = makeRule({ id: 'path-rule', request: { action: mockAction } });
    const result = await evaluateRequest({
      rules: [bodyRule, pathRule],
      protocol: 'http',
      request: { ...request(), body: 'data' },
      consume: new ConsumeRegistry(),
      streaming: true,
    });
    expect(result.interceptRule?.id).toBe('path-rule');
  });

  it('reports consumed and remaining in matched rule info', async () => {
    const rule = makeRule({ id: 'c', consume: { times: 3 }, request: { action: mockAction } });
    const result = await evaluateRequest({
      rules: [rule],
      protocol: 'http',
      request: request(),
      consume: new ConsumeRegistry(),
    });
    expect(result.matched[0]).toEqual({
      id: 'c',
      action: 'mock_response',
      consumed: true,
      remaining: 2,
    });
  });
});

describe('evaluateResponseMatch', () => {
  const response: ResponseSnapshot = { statusCode: 503, headers: {} };

  it('matches when the rule has no response.match', async () => {
    const rule = makeRule({ response: { delay: { durationMs: 1 } } });
    const result = await evaluateResponseMatch({
      rule,
      protocol: 'http',
      request: request(),
      response,
      consume: new ConsumeRegistry(),
    });
    expect(result).toEqual({ matched: true });
  });

  it('evaluates response.match against the upstream response', async () => {
    const rule = makeRule({
      response: {
        match: { type: 'regex', field: 'status', pattern: '^5..$' },
        action: { type: 'response_replace', target: 'header.x-a', from: '.', to: 'b' },
      },
    });
    const hit = await evaluateResponseMatch({
      rule,
      protocol: 'http',
      request: request(),
      response,
      consume: new ConsumeRegistry(),
    });
    expect(hit.matched).toBe(true);
    const miss = await evaluateResponseMatch({
      rule,
      protocol: 'http',
      request: request(),
      response: { statusCode: 200, headers: {} },
      consume: new ConsumeRegistry(),
    });
    expect(miss.matched).toBe(false);
  });

  it('reports matcher errors as non-matching with an error message', async () => {
    const rule = makeRule({
      response: {
        match: { type: 'script', language: 'javascript', source: 'return true;' },
        delay: { durationMs: 1 },
      },
    });
    const result = await evaluateResponseMatch({
      rule,
      protocol: 'http',
      request: request(),
      response,
      consume: new ConsumeRegistry(),
    });
    expect(result.matched).toBe(false);
    expect(result.error).toContain('script matcher');
  });
});
