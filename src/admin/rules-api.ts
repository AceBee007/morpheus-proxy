import {
  DuplicateRuleIdError,
  RevisionConflictError,
  RuleNotFoundError,
} from '../rules/store.js';
import { validateRule, type RuleValidationResult } from '../rules/validate.js';
import type { Rule } from '../rules/types.js';
import { ApiError } from './http-util.js';
import type { AdminContext } from './server.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mapStoreError(err: unknown): never {
  if (err instanceof RevisionConflictError) {
    throw new ApiError(409, 'revision_conflict', err.message);
  }
  if (err instanceof RuleNotFoundError) {
    throw new ApiError(404, 'rule_not_found', err.message);
  }
  if (err instanceof DuplicateRuleIdError) {
    throw new ApiError(400, 'duplicate_rule_id', err.message);
  }
  throw err;
}

function requireValidRule(ctx: AdminContext, input: unknown): { rule: Rule; warnings: unknown[] } {
  const result = validateRule(input, ctx.validateOptions);
  if (!result.rule) {
    throw new ApiError(400, 'rule_validation_failed', 'rule definition is invalid', result.errors);
  }
  return { rule: result.rule, warnings: result.warnings };
}

function ruleWithState(ctx: AdminContext, rule: Rule): unknown {
  return { rule, state: ctx.consume.stateOf(rule) };
}

export function listRules(ctx: AdminContext): unknown {
  const snapshot = ctx.ruleStore.snapshot();
  return {
    revision: snapshot.revision,
    items: snapshot.rules.map((rule) => ruleWithState(ctx, rule)),
  };
}

export function createRule(ctx: AdminContext, body: unknown): unknown {
  const { rule, warnings } = requireValidRule(ctx, body);
  try {
    const created = ctx.ruleStore.create(rule);
    ctx.appLog.info('rule created', { id: created.id });
    return { rule: created, warnings, revision: ctx.ruleStore.revision };
  } catch (err) {
    return mapStoreError(err);
  }
}

export function getRule(ctx: AdminContext, id: string): unknown {
  const rule = ctx.ruleStore.get(id);
  if (!rule) throw new ApiError(404, 'rule_not_found', `rule "${id}" does not exist`);
  return ruleWithState(ctx, rule);
}

export function putRule(
  ctx: AdminContext,
  id: string,
  body: unknown,
  expectedRevision: number | undefined,
): unknown {
  const { rule, warnings } = requireValidRule(ctx, body);
  if (rule.id !== id && isPlainObject(body) && body['id'] !== undefined) {
    throw new ApiError(400, 'id_mismatch', 'rule id in the body must match the URL');
  }
  try {
    const updated = ctx.ruleStore.update(id, { ...rule, id }, expectedRevision);
    ctx.appLog.info('rule updated', { id });
    return { rule: updated, warnings, revision: ctx.ruleStore.revision };
  } catch (err) {
    return mapStoreError(err);
  }
}

export function deleteRule(
  ctx: AdminContext,
  id: string,
  expectedRevision: number | undefined,
): unknown {
  try {
    ctx.ruleStore.delete(id, expectedRevision);
    ctx.appLog.info('rule deleted', { id });
    return { deleted: id, revision: ctx.ruleStore.revision };
  } catch (err) {
    return mapStoreError(err);
  }
}

export function disableAllRules(ctx: AdminContext, expectedRevision: number | undefined): unknown {
  try {
    const changed = ctx.ruleStore.disableAll(expectedRevision);
    ctx.appLog.info('all rules disabled', { changed });
    return { disabled: changed, revision: ctx.ruleStore.revision };
  } catch (err) {
    return mapStoreError(err);
  }
}

export function validateRules(ctx: AdminContext, body: unknown): unknown {
  const toResult = (input: unknown): unknown => {
    const result: RuleValidationResult = validateRule(input, ctx.validateOptions);
    return {
      valid: result.rule !== undefined,
      errors: result.errors,
      warnings: result.warnings,
    };
  };
  if (Array.isArray(body)) return { results: body.map(toResult) };
  return toResult(body);
}

export function exportRules(ctx: AdminContext, body: unknown): unknown {
  let ids: string[] | undefined;
  if (isPlainObject(body) && body['ids'] !== undefined) {
    if (!Array.isArray(body['ids']) || !body['ids'].every((x) => typeof x === 'string')) {
      throw new ApiError(400, 'invalid_export', 'ids must be an array of strings');
    }
    ids = body['ids'];
  }
  const rules = ctx.ruleStore
    .list()
    .filter((rule) => ids === undefined || ids.includes(rule.id));
  if (ids !== undefined) {
    for (const id of ids) {
      if (!rules.some((rule) => rule.id === id)) {
        throw new ApiError(404, 'rule_not_found', `rule "${id}" does not exist`);
      }
    }
  }
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    rules,
  };
}

export function importRules(ctx: AdminContext, body: unknown): unknown {
  if (!isPlainObject(body)) {
    throw new ApiError(400, 'invalid_import', 'request body must be an object');
  }
  const mode = body['mode'] ?? 'merge';
  if (mode !== 'merge' && mode !== 'replace') {
    throw new ApiError(400, 'invalid_import', 'mode must be "merge" or "replace"');
  }
  const expectedRevision = body['expectedRevision'];
  if (expectedRevision !== undefined && typeof expectedRevision !== 'number') {
    throw new ApiError(400, 'invalid_import', 'expectedRevision must be a number');
  }
  const rawRules = body['rules'];
  if (!Array.isArray(rawRules)) {
    throw new ApiError(400, 'invalid_import', 'rules must be an array');
  }
  // Validate everything before touching the store (atomic import, spec 4.2.7)
  const validated: Rule[] = [];
  const allWarnings: unknown[] = [];
  const allErrors: Array<{ index: number; errors: unknown }> = [];
  rawRules.forEach((raw, index) => {
    const result = validateRule(raw, ctx.validateOptions);
    if (!result.rule) {
      allErrors.push({ index, errors: result.errors });
    } else {
      validated.push(result.rule);
      if (result.warnings.length > 0) allWarnings.push({ index, warnings: result.warnings });
    }
  });
  if (allErrors.length > 0) {
    throw new ApiError(
      400,
      'rule_validation_failed',
      'one or more rules are invalid; nothing was imported',
      allErrors.map(({ index, errors }) => ({
        path: `rules[${index}]`,
        reason: 'invalid_rule',
        message: JSON.stringify(errors),
      })),
    );
  }
  try {
    ctx.ruleStore.importRules(validated, mode, expectedRevision);
  } catch (err) {
    return mapStoreError(err);
  }
  ctx.appLog.info('rules imported', { mode, count: validated.length });
  return {
    imported: validated.length,
    mode,
    revision: ctx.ruleStore.revision,
    warnings: allWarnings,
  };
}

export function getRuleState(ctx: AdminContext, id: string): unknown {
  const rule = ctx.ruleStore.get(id);
  if (!rule) throw new ApiError(404, 'rule_not_found', `rule "${id}" does not exist`);
  return ctx.consume.stateOf(rule);
}

export function resetRuleState(ctx: AdminContext, id: string): unknown {
  const rule = ctx.ruleStore.get(id);
  if (!rule) throw new ApiError(404, 'rule_not_found', `rule "${id}" does not exist`);
  ctx.consume.reset(id);
  return ctx.consume.stateOf(rule);
}
