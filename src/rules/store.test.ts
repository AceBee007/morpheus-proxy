import { describe, expect, it } from 'vitest';
import {
  DuplicateRuleIdError,
  RevisionConflictError,
  RuleNotFoundError,
  RuleStore,
} from './store.js';
import { validateRule } from './validate.js';
import type { Rule } from './types.js';

function makeRule(overrides: Record<string, unknown> = {}): Rule {
  const result = validateRule({
    protocol: 'http',
    match: { type: 'regex', field: 'path', pattern: '.' },
    logging: { capture: true },
    ...overrides,
  });
  if (!result.rule) throw new Error(JSON.stringify(result.errors));
  return result.rule;
}

describe('RuleStore', () => {
  it('creates rules, bumping the revision and stamping timestamps', () => {
    const store = new RuleStore({ now: () => new Date('2026-06-10T00:00:00.000Z') });
    expect(store.revision).toBe(1);
    const created = store.create(makeRule({ id: 'a' }));
    expect(store.revision).toBe(2);
    expect(created.createdAt).toBe('2026-06-10T00:00:00.000Z');
    expect(created.updatedAt).toBe('2026-06-10T00:00:00.000Z');
  });

  it('rejects duplicate ids', () => {
    const store = new RuleStore();
    store.create(makeRule({ id: 'a' }));
    expect(() => store.create(makeRule({ id: 'a' }))).toThrow(DuplicateRuleIdError);
  });

  it('updates keep createdAt, bump updatedAt, and notify onRuleChanged', () => {
    const changed: string[] = [];
    let tick = 0;
    const store = new RuleStore({
      now: () => new Date(1_700_000_000_000 + tick++ * 1000),
      onRuleChanged: (id) => changed.push(id),
    });
    const created = store.create(makeRule({ id: 'a' }));
    const updated = store.update('a', makeRule({ id: 'a', priority: 5 }));
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.priority).toBe(5);
    expect(changed).toEqual(['a']);
  });

  it('throws RuleNotFoundError for unknown ids', () => {
    const store = new RuleStore();
    expect(() => store.update('nope', makeRule({ id: 'nope' }))).toThrow(RuleNotFoundError);
    expect(() => store.delete('nope')).toThrow(RuleNotFoundError);
  });

  it('enforces expectedRevision with RevisionConflictError', () => {
    const store = new RuleStore();
    store.create(makeRule({ id: 'a' }));
    const staleRevision = store.revision - 1;
    expect(() => store.update('a', makeRule({ id: 'a' }), staleRevision)).toThrow(
      RevisionConflictError,
    );
    expect(() => store.delete('a', staleRevision)).toThrow(RevisionConflictError);
    store.delete('a', store.revision);
  });

  it('sorts rules by priority desc, then createdAt asc, then id', () => {
    let tick = 0;
    const store = new RuleStore({ now: () => new Date(1_700_000_000_000 + tick++ * 1000) });
    store.create(makeRule({ id: 'low', priority: 1 }));
    store.create(makeRule({ id: 'high-old', priority: 10 }));
    store.create(makeRule({ id: 'high-new', priority: 10 }));
    expect(store.list().map((r) => r.id)).toEqual(['high-old', 'high-new', 'low']);
  });

  it('updatedAt does not affect ordering (createdAt tiebreak, spec 4.3.2)', () => {
    let tick = 0;
    const store = new RuleStore({ now: () => new Date(1_700_000_000_000 + tick++ * 1000) });
    store.create(makeRule({ id: 'first', priority: 10 }));
    store.create(makeRule({ id: 'second', priority: 10 }));
    store.update('first', makeRule({ id: 'first', priority: 10, name: 'edited' }));
    expect(store.list().map((r) => r.id)).toEqual(['first', 'second']);
  });

  it('disableAll disables everything and bumps the revision once', () => {
    const store = new RuleStore();
    store.create(makeRule({ id: 'a' }));
    store.create(makeRule({ id: 'b', enabled: false }));
    const revisionBefore = store.revision;
    const changed = store.disableAll();
    expect(changed).toBe(1);
    expect(store.revision).toBe(revisionBefore + 1);
    expect(store.list().every((r) => !r.enabled)).toBe(true);
  });

  it('importRules merge overwrites matching ids and keeps others', () => {
    const changed: string[] = [];
    const store = new RuleStore({ onRuleChanged: (id) => changed.push(id) });
    store.create(makeRule({ id: 'keep' }));
    store.create(makeRule({ id: 'overwrite', priority: 1 }));
    store.importRules(
      [makeRule({ id: 'overwrite', priority: 99 }), makeRule({ id: 'added' })],
      'merge',
    );
    expect(store.get('keep')).toBeDefined();
    expect(store.get('overwrite')?.priority).toBe(99);
    expect(store.get('added')).toBeDefined();
    expect(changed).toContain('overwrite');
  });

  it('importRules replace swaps the whole rule set', () => {
    const store = new RuleStore();
    store.create(makeRule({ id: 'old' }));
    store.importRules([makeRule({ id: 'new' })], 'replace');
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')).toBeDefined();
  });

  it('importRules rejects duplicate ids in the payload without mutating', () => {
    const store = new RuleStore();
    store.create(makeRule({ id: 'a' }));
    const revisionBefore = store.revision;
    expect(() =>
      store.importRules([makeRule({ id: 'x' }), makeRule({ id: 'x' })], 'replace'),
    ).toThrow(DuplicateRuleIdError);
    expect(store.revision).toBe(revisionBefore);
    expect(store.get('a')).toBeDefined();
  });

  it('snapshot is cached until the next mutation', () => {
    const store = new RuleStore();
    store.create(makeRule({ id: 'a' }));
    const s1 = store.snapshot();
    expect(store.snapshot()).toBe(s1);
    store.create(makeRule({ id: 'b' }));
    expect(store.snapshot()).not.toBe(s1);
    expect(store.snapshot().revision).toBe(store.revision);
  });
});
