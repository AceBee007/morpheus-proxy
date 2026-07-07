import type { TrafficLogStore } from '../logging/traffic-log.js';
import type { ConsumeRegistry } from '../rules/consume.js';
import { evaluateRequest, evaluateResponseMatch } from '../rules/evaluate.js';
import type {
  HeaderMap,
  RequestSnapshot,
  ResponseSnapshot,
  ScriptMatcherRunner,
} from '../rules/matcher.js';
import type { RuleStore } from '../rules/store.js';
import type { Protocol, Rule } from '../rules/types.js';
import { validateRule, type ValidateRuleOptions } from '../rules/validate.js';
import { applyResponseReplace, applyRewriteOperations } from '../proxy/actions.js';
import { applyHttpResponsePatch } from '../proxy/patch.js';
import type { ManipulatorRunner } from '../proxy/pipeline.js';
import { ApiError } from './http-util.js';

export interface SimulationDeps {
  ruleStore: RuleStore;
  consume: ConsumeRegistry;
  trafficLog: TrafficLogStore;
  scriptRunner?: ScriptMatcherRunner;
  manipulatorRunner?: ManipulatorRunner;
  validateOptions: ValidateRuleOptions;
}

interface SimulationInput {
  label: { logId?: string; sample?: boolean };
  protocol: Protocol;
  request: RequestSnapshot;
  response?: ResponseSnapshot;
  responseBodyAvailable: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHeaderMap(value: unknown, path: string): HeaderMap {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ApiError(400, 'invalid_simulation', `${path} must be an object`);
  const headers: HeaderMap = {};
  for (const [name, v] of Object.entries(value)) {
    if (typeof v === 'string') headers[name.toLowerCase()] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      headers[name.toLowerCase()] = v as string[];
    } else {
      throw new ApiError(400, 'invalid_simulation', `${path}.${name} must be a string or string[]`);
    }
  }
  return headers;
}

function splitPath(rawPath: string): { path: string; query: string } {
  const index = rawPath.indexOf('?');
  return index === -1
    ? { path: rawPath, query: '' }
    : { path: rawPath.slice(0, index), query: rawPath.slice(index + 1) };
}

async function inputFromLog(
  deps: SimulationDeps,
  logId: string,
): Promise<SimulationInput> {
  const entry = deps.trafficLog.get(logId);
  if (!entry) throw new ApiError(404, 'log_not_found', `log "${logId}" does not exist`);
  const { path, query } = splitPath(entry.request.path ?? '/');
  const requestBody = await deps.trafficLog.readBody(logId, 'request');
  const request: RequestSnapshot = {
    id: logId,
    ...(entry.request.method !== undefined ? { method: entry.request.method } : {}),
    path,
    query,
    headers: entry.request.headers,
    ...(requestBody !== null
      ? { body: requestBody.toString('utf8'), rawBodyBase64: requestBody.toString('base64') }
      : {}),
  };
  const responseBody = await deps.trafficLog.readBody(logId, 'response');
  const response: ResponseSnapshot = {
    ...(entry.response.statusCode !== undefined ? { statusCode: entry.response.statusCode } : {}),
    headers: entry.response.headers,
    ...(entry.response.grpcStatus !== undefined
      ? { grpc: { status: entry.response.grpcStatus, trailers: entry.response.trailers ?? {} } }
      : {}),
    ...(responseBody !== null
      ? { body: responseBody.toString('utf8'), rawBodyBase64: responseBody.toString('base64') }
      : {}),
  };
  return {
    label: { logId },
    protocol: entry.protocol,
    request,
    response,
    responseBodyAvailable: responseBody !== null,
  };
}

function inputFromSample(sampleRequest: unknown, sampleResponse: unknown): SimulationInput {
  if (!isPlainObject(sampleRequest)) {
    throw new ApiError(400, 'invalid_simulation', 'sampleRequest must be an object');
  }
  const protocol = sampleRequest['protocol'];
  if (protocol !== 'http' && protocol !== 'grpc') {
    throw new ApiError(400, 'invalid_simulation', 'sampleRequest.protocol must be "http" or "grpc"');
  }
  const rawPath = sampleRequest['path'];
  if (typeof rawPath !== 'string' || rawPath === '') {
    throw new ApiError(400, 'invalid_simulation', 'sampleRequest.path must be a non-empty string');
  }
  const { path, query } = splitPath(rawPath);
  const method = sampleRequest['method'];
  const host = sampleRequest['host'];
  const body = sampleRequest['body'];
  const request: RequestSnapshot = {
    id: 'sample',
    ...(typeof method === 'string' ? { method } : {}),
    ...(typeof host === 'string' ? { host } : {}),
    path,
    query,
    headers: toHeaderMap(sampleRequest['headers'], 'sampleRequest.headers'),
    ...(typeof body === 'string'
      ? { body, rawBodyBase64: Buffer.from(body, 'utf8').toString('base64') }
      : {}),
  };
  if (protocol === 'grpc') {
    const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
    request.grpc = {
      ...(match?.[1] !== undefined ? { service: match[1] } : {}),
      ...(match?.[2] !== undefined ? { method: match[2] } : {}),
      metadata: request.headers,
    };
  }

  let response: ResponseSnapshot | undefined;
  let responseBodyAvailable = false;
  if (sampleResponse !== undefined) {
    if (!isPlainObject(sampleResponse)) {
      throw new ApiError(400, 'invalid_simulation', 'sampleResponse must be an object');
    }
    const statusCode = sampleResponse['statusCode'];
    const respBody = sampleResponse['body'];
    response = {
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
      headers: toHeaderMap(sampleResponse['headers'], 'sampleResponse.headers'),
      ...(typeof respBody === 'string'
        ? { body: respBody, rawBodyBase64: Buffer.from(respBody, 'utf8').toString('base64') }
        : {}),
    };
    const grpcStatus = sampleResponse['grpcStatus'];
    if (typeof grpcStatus === 'number') {
      response.grpc = {
        status: grpcStatus,
        trailers: toHeaderMap(sampleResponse['trailers'], 'sampleResponse.trailers'),
      };
    }
    responseBodyAvailable = typeof respBody === 'string';
  }

  return {
    label: { sample: true },
    protocol,
    request,
    ...(response !== undefined ? { response } : {}),
    responseBodyAvailable,
  };
}

/**
 * Applies the current rule set or a rule draft to stored logs or sample
 * requests without touching counters or the upstream (spec 4.2.6).
 */
export async function simulateRules(deps: SimulationDeps, body: unknown): Promise<unknown> {
  if (!isPlainObject(body)) {
    throw new ApiError(400, 'invalid_simulation', 'request body must be an object');
  }
  const logIds = body['logIds'];
  const sampleRequest = body['sampleRequest'];
  if (logIds !== undefined && sampleRequest !== undefined) {
    throw new ApiError(400, 'invalid_simulation', 'specify either logIds or sampleRequest, not both');
  }
  if (logIds === undefined && sampleRequest === undefined) {
    throw new ApiError(400, 'invalid_simulation', 'logIds or sampleRequest is required');
  }
  if (logIds !== undefined && (!Array.isArray(logIds) || !logIds.every((x) => typeof x === 'string'))) {
    throw new ApiError(400, 'invalid_simulation', 'logIds must be an array of strings');
  }
  const options = isPlainObject(body['options']) ? body['options'] : {};
  const includeBodyDiff = options['includeBodyDiff'] === true;

  let rules: Rule[];
  let draftWarnings: unknown[] = [];
  if (body['ruleDraft'] !== undefined) {
    const result = validateRule(body['ruleDraft'], deps.validateOptions);
    if (!result.rule) {
      throw new ApiError(400, 'rule_validation_failed', 'ruleDraft is invalid', result.errors);
    }
    rules = [result.rule];
    draftWarnings = result.warnings;
  } else {
    rules = deps.ruleStore.snapshot().rules;
  }

  const inputs: SimulationInput[] = [];
  if (logIds !== undefined) {
    for (const logId of logIds as string[]) {
      inputs.push(await inputFromLog(deps, logId));
    }
  } else {
    inputs.push(inputFromSample(sampleRequest, body['sampleResponse']));
  }

  const results: unknown[] = [];
  for (const input of inputs) {
    // Isolated counters: evaluation sees real remaining counts, nothing is consumed
    const consume = deps.consume.clone();
    const evaluation = await evaluateRequest({
      rules,
      protocol: input.protocol,
      request: input.request,
      consume,
      ...(deps.scriptRunner ? { scriptRunner: deps.scriptRunner } : {}),
    });
    const rule = evaluation.interceptRule;
    const errors = [...evaluation.errors];
    let outcome = evaluation.captureRules.length > 0 ? 'captured' : 'passthrough';
    let requestStage: unknown = null;
    let responseStage: unknown = null;

    if (rule?.request) {
      const action = rule.request.action;
      if (action?.type === 'mock_response') {
        outcome = 'mock';
        requestStage = { action: 'mock_response', wouldRespond: action.response };
      } else if (action?.type === 'fault') {
        outcome = 'fault';
        requestStage = { action: 'fault', wouldRespond: action.fault };
      } else if (action?.type === 'request_rewrite') {
        const rewritable = {
          path: input.request.path ?? '/',
          query: input.request.query ?? '',
          headers: structuredClone(input.request.headers),
          ...(input.request.body !== undefined
            ? { body: Buffer.from(input.request.body, 'utf8') }
            : {}),
        };
        const rewriteResult = applyRewriteOperations(rewritable, action.operations);
        if (rewriteResult.modified) outcome = 'modified';
        requestStage = {
          action: 'request_rewrite',
          modified: rewriteResult.modified,
          forwarded: {
            path: rewritable.path,
            query: rewritable.query,
            headers: rewritable.headers,
            ...(includeBodyDiff && rewriteResult.bodyModified && rewritable.body !== undefined
              ? { bodyBefore: input.request.body, bodyAfter: rewritable.body.toString('utf8') }
              : {}),
          },
        };
      } else if (rule.request.delay) {
        outcome = 'delayed';
        requestStage = { action: 'delay', delay: rule.request.delay };
      }
    }

    const terminal =
      rule?.request?.action?.type === 'mock_response' || rule?.request?.action?.type === 'fault';
    if (rule?.response && !terminal) {
      if (!input.response) {
        responseStage = { evaluated: false, skipped: 'no_response_data' };
      } else {
        const matchResult = await evaluateResponseMatch({
          rule,
          protocol: input.protocol,
          request: input.request,
          response: input.response,
          consume,
          ...(deps.scriptRunner ? { scriptRunner: deps.scriptRunner } : {}),
        });
        if (matchResult.error !== undefined) {
          errors.push({ ruleId: rule.id, stage: 'response', error: matchResult.error });
        }
        if (!matchResult.matched) {
          responseStage = { evaluated: true, matched: false };
        } else {
          const action = rule.response.action;
          if (action?.type === 'fault') {
            outcome = 'fault';
            responseStage = { evaluated: true, matched: true, action: 'fault', wouldRespond: action.fault };
          } else if (action?.type === 'response_replace') {
            const headers = structuredClone(input.response.headers);
            const changed = applyResponseReplace(headers, action);
            if (changed) outcome = 'modified';
            responseStage = {
              evaluated: true,
              matched: true,
              action: 'response_replace',
              changed,
              headersAfter: headers,
            };
          } else if (action?.type === 'script_manipulator') {
            if (!input.responseBodyAvailable && input.label.logId !== undefined) {
              responseStage = { evaluated: true, matched: true, action: 'script_manipulator', skipped: 'body_not_logged' };
            } else if (!deps.manipulatorRunner) {
              errors.push({
                ruleId: rule.id,
                stage: 'response',
                error: 'script manipulator requires the script sandbox, which is not available',
              });
              responseStage = { evaluated: true, matched: true, action: 'script_manipulator', skipped: 'sandbox_unavailable' };
            } else {
              try {
                const patch = await deps.manipulatorRunner(action, {
                  protocol: input.protocol,
                  stage: 'response',
                  request: input.request,
                  response: input.response,
                  ruleState: consume.view(rule),
                  upstream: { durationMs: 0 },
                });
                const patchable = {
                  statusCode: input.response.statusCode ?? 200,
                  headers: structuredClone(input.response.headers),
                  ...(input.response.body !== undefined
                    ? { body: Buffer.from(input.response.body, 'utf8') }
                    : {}),
                };
                const patchOutcome = applyHttpResponsePatch(patchable, patch);
                if (patchOutcome.changed) outcome = 'modified';
                responseStage = {
                  evaluated: true,
                  matched: true,
                  action: 'script_manipulator',
                  changed: patchOutcome.changed,
                  statusAfter: patchable.statusCode,
                  headersAfter: patchable.headers,
                  ...(includeBodyDiff && patchOutcome.bodyChanged
                    ? {
                        bodyBefore: input.response.body ?? '',
                        bodyAfter: patchable.body?.toString('utf8') ?? '',
                      }
                    : {}),
                };
              } catch (err) {
                errors.push({
                  ruleId: rule.id,
                  stage: 'response',
                  error: err instanceof Error ? err.message : String(err),
                });
                responseStage = { evaluated: true, matched: true, action: 'script_manipulator', skipped: 'script_error' };
              }
            }
          } else if (rule.response.delay) {
            outcome = outcome === 'passthrough' ? 'delayed' : outcome;
            responseStage = { evaluated: true, matched: true, action: 'delay', delay: rule.response.delay };
          }
        }
      }
    }

    if (errors.length > 0 && outcome === 'passthrough') outcome = 'rule_error';

    results.push({
      ...input.label,
      matchedRules: evaluation.matched,
      interceptRule: rule?.id ?? null,
      outcome,
      requestStage,
      responseStage,
      errors,
    });
  }

  return { results, draftWarnings };
}
