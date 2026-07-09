import {
  evalMatcher,
  matcherUsesBody,
  type MatchInput,
  type RequestSnapshot,
  type ResponseSnapshot,
  type ScriptMatcherRunner,
} from './matcher.js';
import type { ConsumeRegistry } from './consume.js';
import { isObservationRule, type Protocol, type Rule, type Stage } from './types.js';

export interface MatchedRuleInfo {
  id: string;
  /** Short label for logs: "capture" or the applied action type. */
  action: string;
  consumed: boolean;
  remaining?: number;
}

export interface RuleErrorInfo {
  ruleId: string;
  stage: Stage;
  error: string;
}

export interface RequestEvaluation {
  /** The intercept rule that applies to this request, if any. */
  interceptRule: Rule | null;
  /** Observation rules that matched (logging.capture). */
  captureRules: Rule[];
  matched: MatchedRuleInfo[];
  errors: RuleErrorInfo[];
}

export interface EvaluateRequestOptions {
  /** Sorted rule list from a RuleSetSnapshot. */
  rules: Rule[];
  protocol: Protocol;
  request: RequestSnapshot;
  consume: ConsumeRegistry;
  scriptRunner?: ScriptMatcherRunner;
  /** Streaming traffic: body matchers are treated as non-matching (spec 4.7.5). */
  streaming?: boolean;
}

function describeRuleAction(rule: Rule): string {
  if (isObservationRule(rule)) return 'capture';
  if (rule.request?.action) return rule.request.action.type;
  if (rule.response?.action) return rule.response.action.type;
  return 'delay';
}

/**
 * Request-stage rule evaluation (spec 4.3.2). Observation rules never stop
 * evaluation; the first matching intercept rule wins. Exhausted consumable
 * rules and rules whose matcher fails (script error) are skipped as if they
 * had not matched.
 */
export async function evaluateRequest(opts: EvaluateRequestOptions): Promise<RequestEvaluation> {
  const { rules, protocol, request, consume, scriptRunner, streaming = false } = opts;
  const result: RequestEvaluation = {
    interceptRule: null,
    captureRules: [],
    matched: [],
    errors: [],
  };

  for (const rule of rules) {
    if (!rule.enabled || rule.protocol !== protocol) continue;
    if (streaming && matcherUsesBody(rule.match)) continue;

    const input: MatchInput = {
      protocol,
      stage: 'request',
      request,
      ruleState: consume.view(rule),
    };
    let matched: boolean;
    try {
      matched = await evalMatcher(rule.match, input, scriptRunner);
    } catch (err) {
      result.errors.push({
        ruleId: rule.id,
        stage: 'request',
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!matched) continue;
    if (!consume.tryConsume(rule)) continue;
    consume.recordHit(rule);

    const remaining = consume.remaining(rule);
    result.matched.push({
      id: rule.id,
      action: describeRuleAction(rule),
      consumed: rule.consume !== undefined,
      ...(remaining !== undefined ? { remaining } : {}),
    });

    if (isObservationRule(rule)) {
      result.captureRules.push(rule);
      continue;
    }
    result.interceptRule = rule;
    break;
  }
  return result;
}

export interface ResponseMatchResult {
  matched: boolean;
  error?: string;
}

/**
 * Evaluates the optional response.match condition of the intercept rule
 * against the upstream response (spec 4.3.2). A matcher failure counts as
 * "did not match" and is reported as a rule error.
 */
export async function evaluateResponseMatch(opts: {
  rule: Rule;
  protocol: Protocol;
  request: RequestSnapshot;
  response: ResponseSnapshot;
  consume: ConsumeRegistry;
  scriptRunner?: ScriptMatcherRunner;
}): Promise<ResponseMatchResult> {
  const matcher = opts.rule.response?.match;
  if (!matcher) return { matched: true };
  const input: MatchInput = {
    protocol: opts.protocol,
    stage: 'response',
    request: opts.request,
    response: opts.response,
    ruleState: opts.consume.view(opts.rule),
  };
  try {
    return { matched: await evalMatcher(matcher, input, opts.scriptRunner) };
  } catch (err) {
    return {
      matched: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
