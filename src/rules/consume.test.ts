import { describe, expect, it } from 'vitest';
import { ConsumeRegistry } from './consume.js';
import { validateRule } from './validate.js';
import type { Rule } from './types.js';

function makeRule(overrides: Record<string, unknown> = {}): Rule {
  const result = validateRule({
    id: 'r1',
    protocol: 'http',
    match: { type: 'regex', field: 'path', pattern: '.' },
    logging: { capture: true },
    ...overrides,
  });
  if (!result.rule) throw new Error(JSON.stringify(result.errors));
  return result.rule;
}

describe('ConsumeRegistry', () => {
  it('always passes rules without a consume spec', () => {
    const registry = new ConsumeRegistry();
    const rule = makeRule();
    for (let i = 0; i < 10; i++) expect(registry.tryConsume(rule)).toBe(true);
    expect(registry.remaining(rule)).toBeUndefined();
  });

  it('consumes exactly `times` applications, then reports exhaustion', () => {
    const registry = new ConsumeRegistry();
    const rule = makeRule({ consume: { times: 3 } });
    expect(registry.tryConsume(rule)).toBe(true);
    expect(registry.tryConsume(rule)).toBe(true);
    expect(registry.tryConsume(rule)).toBe(true);
    expect(registry.tryConsume(rule)).toBe(false);
    expect(registry.remaining(rule)).toBe(0);
  });

  it('resets the counter resetAfterMs after the last consumption', () => {
    let now = 1_000;
    const registry = new ConsumeRegistry(() => now);
    const rule = makeRule({ consume: { times: 1, resetAfterMs: 500 } });
    expect(registry.tryConsume(rule)).toBe(true);
    expect(registry.tryConsume(rule)).toBe(false);
    now += 499;
    expect(registry.tryConsume(rule)).toBe(false);
    now += 1;
    expect(registry.tryConsume(rule)).toBe(true);
  });

  it('tracks hits and lastMatchedAt separately from consumption', () => {
    let now = 1_700_000_000_000;
    const registry = new ConsumeRegistry(() => now);
    const rule = makeRule({ consume: { times: 2 } });
    registry.tryConsume(rule);
    registry.recordHit(rule);
    now += 1_000;
    registry.tryConsume(rule);
    registry.recordHit(rule);
    const state = registry.stateOf(rule);
    expect(state.hits).toBe(2);
    expect(state.consumed).toBe(2);
    expect(state.remaining).toBe(0);
    expect(state.lastMatchedAt).toBe(new Date(now).toISOString());
  });

  it('reset() clears hits and consumption', () => {
    const registry = new ConsumeRegistry();
    const rule = makeRule({ consume: { times: 1 } });
    registry.tryConsume(rule);
    registry.recordHit(rule);
    registry.reset(rule.id);
    const state = registry.stateOf(rule);
    expect(state.hits).toBe(0);
    expect(state.consumed).toBe(0);
    expect(state.remaining).toBe(1);
    expect(registry.tryConsume(rule)).toBe(true);
  });

  it('provides the ctx.ruleState view for matchers', () => {
    const registry = new ConsumeRegistry();
    const rule = makeRule({ consume: { times: 5 } });
    registry.tryConsume(rule);
    registry.recordHit(rule);
    expect(registry.view(rule)).toEqual({ hits: 1, remaining: 4 });
    expect(registry.view(makeRule({ id: 'r2' }))).toEqual({ hits: 0 });
  });
});
