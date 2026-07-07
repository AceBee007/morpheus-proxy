import type { Rule } from './types.js';
import type { RuleStateView } from './matcher.js';

interface CounterState {
  hits: number;
  consumed: number;
  lastConsumedAt: number | null;
  lastMatchedAt: number | null;
}

export interface RuleRuntimeState {
  ruleId: string;
  hits: number;
  consumed: number;
  /** null when the rule has no consume spec. */
  remaining: number | null;
  lastMatchedAt: string | null;
}

function freshState(): CounterState {
  return { hits: 0, consumed: 0, lastConsumedAt: null, lastMatchedAt: null };
}

/**
 * Per-rule hit and consume counters (spec 4.6). Counters live in memory for
 * a single process; check/decrement happens synchronously, which is the
 * "short critical section" on the Node.js event loop.
 */
export class ConsumeRegistry {
  private readonly states = new Map<string, CounterState>();

  constructor(private readonly now: () => number = Date.now) {}

  private stateFor(ruleId: string): CounterState {
    let state = this.states.get(ruleId);
    if (!state) {
      state = freshState();
      this.states.set(ruleId, state);
    }
    return state;
  }

  private maybeReset(rule: Rule, state: CounterState): void {
    const resetAfterMs = rule.consume?.resetAfterMs;
    if (
      resetAfterMs !== undefined &&
      state.lastConsumedAt !== null &&
      this.now() - state.lastConsumedAt >= resetAfterMs
    ) {
      state.consumed = 0;
      state.lastConsumedAt = null;
    }
  }

  /**
   * Attempts to consume one application of the rule. Rules without a consume
   * spec always pass. Exhausted rules return false — the evaluator treats
   * them as "did not match" (spec 4.6).
   */
  tryConsume(rule: Rule): boolean {
    if (!rule.consume) return true;
    const state = this.stateFor(rule.id);
    this.maybeReset(rule, state);
    if (state.consumed >= rule.consume.times) return false;
    state.consumed += 1;
    state.lastConsumedAt = this.now();
    return true;
  }

  recordHit(rule: Rule): void {
    const state = this.stateFor(rule.id);
    state.hits += 1;
    state.lastMatchedAt = this.now();
  }

  remaining(rule: Rule): number | undefined {
    if (!rule.consume) return undefined;
    const state = this.stateFor(rule.id);
    this.maybeReset(rule, state);
    return Math.max(0, rule.consume.times - state.consumed);
  }

  /** View passed to matchers as ctx.ruleState (spec 4.4.3). */
  view(rule: Rule): RuleStateView {
    const state = this.stateFor(rule.id);
    const remaining = this.remaining(rule);
    return remaining !== undefined ? { hits: state.hits, remaining } : { hits: state.hits };
  }

  stateOf(rule: Rule): RuleRuntimeState {
    const state = this.stateFor(rule.id);
    this.maybeReset(rule, state);
    return {
      ruleId: rule.id,
      hits: state.hits,
      consumed: state.consumed,
      remaining: rule.consume ? Math.max(0, rule.consume.times - state.consumed) : null,
      lastMatchedAt:
        state.lastMatchedAt !== null ? new Date(state.lastMatchedAt).toISOString() : null,
    };
  }

  /** Full reset — used by state:reset and by rule update/delete (spec 4.2.5). */
  reset(ruleId: string): void {
    this.states.delete(ruleId);
  }

  /**
   * Copies the current counters into an isolated registry. Simulation uses
   * this so evaluation sees real remaining counts without consuming them
   * (spec 4.2.6).
   */
  clone(): ConsumeRegistry {
    const copy = new ConsumeRegistry(this.now);
    for (const [id, state] of this.states) {
      copy.states.set(id, { ...state });
    }
    return copy;
  }
}
