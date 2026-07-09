import type { Rule } from './types.js';

export class RevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `rule set revision is ${actualRevision}, but the request expected ${expectedRevision}; reload the rules`,
    );
    this.name = 'RevisionConflictError';
  }
}

export class DuplicateRuleIdError extends Error {
  constructor(readonly ruleId: string) {
    super(`rule id "${ruleId}" already exists`);
    this.name = 'DuplicateRuleIdError';
  }
}

export class RuleNotFoundError extends Error {
  constructor(readonly ruleId: string) {
    super(`rule "${ruleId}" does not exist`);
    this.name = 'RuleNotFoundError';
  }
}

export interface RuleSetSnapshot {
  revision: number;
  /** Sorted by priority desc, createdAt asc, id asc (spec 4.3.2). */
  rules: Rule[];
}

export interface RuleStoreOptions {
  now?: () => Date;
  /** Called whenever a rule is mutated or removed; used to reset consume counters. */
  onRuleChanged?: (ruleId: string) => void;
}

function compareRules(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * In-memory rule store with a monotonically increasing revision. Every
 * mutation is atomic on the event loop; snapshots are immutable views used
 * for the whole lifetime of one proxied request (spec 4.10).
 */
export class RuleStore {
  private readonly rules = new Map<string, Rule>();
  private revisionValue = 1;
  private cachedSnapshot: RuleSetSnapshot | null = null;
  private readonly now: () => Date;
  private readonly onRuleChanged: (ruleId: string) => void;

  constructor(opts: RuleStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.onRuleChanged = opts.onRuleChanged ?? (() => {});
  }

  get revision(): number {
    return this.revisionValue;
  }

  private bump(): void {
    this.revisionValue += 1;
    this.cachedSnapshot = null;
  }

  private checkRevision(expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && expectedRevision !== this.revisionValue) {
      throw new RevisionConflictError(expectedRevision, this.revisionValue);
    }
  }

  list(): Rule[] {
    return this.snapshot().rules;
  }

  get(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  create(rule: Rule): Rule {
    if (this.rules.has(rule.id)) throw new DuplicateRuleIdError(rule.id);
    const timestamp = this.now().toISOString();
    const stored: Rule = {
      ...rule,
      createdAt: rule.createdAt !== '' ? rule.createdAt : timestamp,
      updatedAt: timestamp,
    };
    this.rules.set(stored.id, stored);
    this.bump();
    return stored;
  }

  update(id: string, rule: Rule, expectedRevision?: number): Rule {
    this.checkRevision(expectedRevision);
    const existing = this.rules.get(id);
    if (!existing) throw new RuleNotFoundError(id);
    const stored: Rule = {
      ...rule,
      id,
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString(),
    };
    this.rules.set(id, stored);
    this.bump();
    this.onRuleChanged(id);
    return stored;
  }

  delete(id: string, expectedRevision?: number): void {
    this.checkRevision(expectedRevision);
    if (!this.rules.delete(id)) throw new RuleNotFoundError(id);
    this.bump();
    this.onRuleChanged(id);
  }

  disableAll(expectedRevision?: number): number {
    this.checkRevision(expectedRevision);
    let changed = 0;
    const timestamp = this.now().toISOString();
    for (const [id, rule] of this.rules) {
      if (rule.enabled) {
        this.rules.set(id, { ...rule, enabled: false, updatedAt: timestamp });
        changed += 1;
      }
    }
    if (changed > 0) this.bump();
    return changed;
  }

  /**
   * Imports rules atomically (spec 4.2.7). `merge` overwrites rules with the
   * same id and adds the rest; `replace` swaps the whole rule set.
   */
  importRules(rules: Rule[], mode: 'merge' | 'replace', expectedRevision?: number): void {
    this.checkRevision(expectedRevision);
    const seen = new Set<string>();
    for (const rule of rules) {
      if (seen.has(rule.id)) throw new DuplicateRuleIdError(rule.id);
      seen.add(rule.id);
    }
    const timestamp = this.now().toISOString();
    if (mode === 'replace') {
      for (const id of this.rules.keys()) this.onRuleChanged(id);
      this.rules.clear();
    }
    for (const rule of rules) {
      const existing = this.rules.get(rule.id);
      if (existing) this.onRuleChanged(rule.id);
      this.rules.set(rule.id, {
        ...rule,
        createdAt: rule.createdAt !== '' ? rule.createdAt : timestamp,
        updatedAt: timestamp,
      });
    }
    this.bump();
  }

  snapshot(): RuleSetSnapshot {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = {
        revision: this.revisionValue,
        rules: [...this.rules.values()].sort(compareRules),
      };
    }
    return this.cachedSnapshot;
  }
}
