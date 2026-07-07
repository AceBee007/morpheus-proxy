import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LimitsConfig, ListenerConfig } from '../config/types.js';
import type { AppLogger } from '../logging/app-log.js';
import type {
  MessageDraft,
  Outcome,
  TimingInfo,
  TrafficEventDraft,
  TrafficLogStore,
} from '../logging/traffic-log.js';
import type { ConsumeRegistry } from '../rules/consume.js';
import {
  evaluateRequest,
  evaluateResponseMatch,
  type MatchedRuleInfo,
  type RuleErrorInfo,
} from '../rules/evaluate.js';
import type {
  HeaderMap,
  MatchInput,
  RequestSnapshot,
  ResponseSnapshot,
  ScriptMatcherRunner,
} from '../rules/matcher.js';
import type { RuleStore } from '../rules/store.js';
import type { FaultSpec, Rule, ScriptManipulatorAction } from '../rules/types.js';
import { applyDelay, applyResponseReplace, applyRewriteOperations } from './actions.js';
import {
  concatStream,
  contentLengthOf,
  readBodyUpTo,
  requestBodyInterest,
  responseBodyInterest,
  type BodyReadResult,
} from './body.js';
import { headerValue, setHeader, stripHopByHop } from './headers.js';
import { applyHttpResponsePatch, InvalidPatchError } from './patch.js';
import {
  parseUpstream,
  sendToUpstream,
  UpstreamError,
  type UpstreamReply,
} from './upstream.js';

/** Context passed to script manipulators (spec 4.5.6). */
export interface ManipulatorInput extends MatchInput {
  upstream: {
    durationMs: number;
    error?: string;
  };
}

export type ManipulatorRunner = (
  action: ScriptManipulatorAction,
  input: ManipulatorInput,
) => Promise<Record<string, unknown>>;

export interface ProxyRuntime {
  listener: ListenerConfig;
  limits: LimitsConfig;
  ruleStore: RuleStore;
  consume: ConsumeRegistry;
  trafficLog: TrafficLogStore;
  appLog: AppLogger;
  scriptRunner?: ScriptMatcherRunner;
  manipulatorRunner?: ManipulatorRunner;
  now?: () => Date;
}

/** Protocol-agnostic view of one client HTTP exchange, backed by h1 or h2. */
export interface HttpExchange {
  method: string;
  /** Path including the query string, e.g. /users?id=1 */
  rawPath: string;
  /** Host header (h1) or :authority (h2). */
  authority: string;
  headers: HeaderMap;
  bodyStream: Readable;
  client: string;
  respond(status: number, headers: HeaderMap, body?: Buffer): void;
  respondStream(status: number, headers: HeaderMap, stream: Readable): void;
  destroy(reset: boolean): void;
}

interface OutcomeFlags {
  mock: boolean;
  fault: boolean;
  modified: boolean;
  delayed: boolean;
  upstreamError: boolean;
}

function decideOutcome(flags: OutcomeFlags, hasRuleErrors: boolean): Outcome {
  if (flags.upstreamError) return 'upstream_error';
  if (flags.mock) return 'mock';
  if (flags.fault) return 'fault';
  if (flags.modified) return 'modified';
  if (flags.delayed) return 'delayed';
  if (hasRuleErrors) return 'rule_error';
  return 'captured';
}

function splitRawPath(rawPath: string): { path: string; query: string } {
  const index = rawPath.indexOf('?');
  if (index === -1) return { path: rawPath, query: '' };
  return { path: rawPath.slice(0, index), query: rawPath.slice(index + 1) };
}

function joinPath(path: string, query: string): string {
  return query === '' ? path : `${path}?${query}`;
}

function toHeaderMap(record: Record<string, string> | undefined): HeaderMap {
  return { ...(record ?? {}) };
}

/**
 * Core HTTP proxying pipeline (spec 4.1, 4.3.2, 4.5, 4.8). One call handles
 * one client request end-to-end: rule evaluation, request-stage actions,
 * upstream forwarding, response-stage actions, and traffic logging.
 */
export async function handleHttpExchange(
  runtime: ProxyRuntime,
  exchange: HttpExchange,
): Promise<void> {
  const now = runtime.now ?? (() => new Date());
  const startedAt = now();
  const listener = runtime.listener;
  const protocol = listener.protocol;
  const snapshot = runtime.ruleStore.snapshot();
  const activeRules = snapshot.rules.filter((r) => r.enabled && r.protocol === protocol);
  const { path, query } = splitRawPath(exchange.rawPath);

  // ---- request body buffering decision (spec 4.8.3)
  const interest = requestBodyInterest(activeRules);
  const requestLimit = listener.maxRequestBodyBufferBytes;
  const contentLength = contentLengthOf(exchange.headers);
  let requestBody: Buffer | undefined;
  let requestBodySkipReason: string | undefined;
  let requestTail: Readable | undefined;

  const reject413 = (): void => {
    exchange.respond(
      413,
      { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ error: 'payload_too_large', limitBytes: requestLimit })),
    );
  };

  if (activeRules.length === 0 || (!interest.need && !interest.want)) {
    // full transparent streaming
  } else if (contentLength !== undefined && contentLength > requestLimit) {
    // declared too large: reject without reading when the body is required
    if (interest.need) {
      reject413();
      return;
    }
    requestBodySkipReason = 'limit_exceeded';
  } else {
    let result: BodyReadResult;
    try {
      result = await readBodyUpTo(exchange.bodyStream, requestLimit);
    } catch {
      exchange.destroy(false);
      return;
    }
    if (result.complete) {
      // an empty body counts as "no body" (GET etc.)
      if (result.buffer.byteLength > 0) requestBody = result.buffer;
    } else if (interest.need) {
      reject413();
      return;
    } else {
      requestBodySkipReason = 'limit_exceeded';
      requestTail = concatStream(result.prefix, exchange.bodyStream);
    }
  }

  // ---- request-stage rule evaluation
  const requestSnapshot: RequestSnapshot = {
    id: randomUUID(),
    method: exchange.method,
    host: exchange.authority,
    path,
    query,
    headers: exchange.headers,
    ...(requestBody !== undefined
      ? { body: requestBody.toString('utf8'), rawBodyBase64: requestBody.toString('base64') }
      : {}),
  };

  const evaluation = await evaluateRequest({
    rules: snapshot.rules,
    protocol,
    request: requestSnapshot,
    consume: runtime.consume,
    ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
    streaming: requestBody === undefined,
  });

  const rule = evaluation.interceptRule;
  const matchedRules: MatchedRuleInfo[] = evaluation.matched;
  const ruleErrors: RuleErrorInfo[] = [...evaluation.errors];
  const captureRules = evaluation.captureRules;
  const flags: OutcomeFlags = {
    mock: false,
    fault: false,
    modified: false,
    delayed: false,
    upstreamError: false,
  };
  const timing: TimingInfo = {};
  const requestContentType = headerValue(exchange.headers, 'content-type');

  const persistNeeded = (): boolean =>
    captureRules.some((r) => r.logging.capture) ||
    (rule?.logging.capture ?? false) ||
    flags.mock ||
    flags.fault ||
    flags.modified;

  const requestDraft = (): MessageDraft => ({
    method: exchange.method,
    path: exchange.rawPath,
    headers: exchange.headers,
    ...(persistNeeded() && requestBody !== undefined ? { body: requestBody } : {}),
    ...(persistNeeded() && requestBodySkipReason !== undefined
      ? { bodySkippedReason: requestBodySkipReason }
      : {}),
    ...(requestContentType !== undefined ? { contentType: requestContentType } : {}),
  });

  let forwardedDraft: (MessageDraft & { modified: boolean }) | undefined;
  let upstreamDraft: (MessageDraft & { received: boolean }) | undefined;

  const writeLog = (responseDraft: MessageDraft): void => {
    const shouldLog =
      rule !== null || captureRules.length > 0 || ruleErrors.length > 0 || flags.upstreamError;
    if (!shouldLog) return;
    const outcome = decideOutcome(flags, ruleErrors.length > 0);
    const draft: TrafficEventDraft = {
      startedAt,
      endedAt: now(),
      protocol,
      listener: listener.name,
      client: exchange.client,
      target: listener.upstream,
      request: requestDraft(),
      ...(forwardedDraft !== undefined ? { forwardedRequest: forwardedDraft } : {}),
      ...(upstreamDraft !== undefined ? { upstreamResponse: upstreamDraft } : {}),
      response: responseDraft,
      outcome,
      loggingReason:
        outcome === 'upstream_error' && matchedRules.length === 0
          ? 'upstream_error'
          : rule !== null
            ? 'matched_rule'
            : ruleErrors.length > 0 && captureRules.length === 0
              ? 'rule_error'
              : 'capture_rule',
      matchedRules,
      ruleErrors,
      timing,
    };
    try {
      runtime.trafficLog.add(draft);
    } catch (err) {
      runtime.appLog.error('traffic log write failed', { error: String(err) });
    }
  };

  const executeFault = async (fault: FaultSpec, upstreamBody?: Buffer): Promise<void> => {
    flags.fault = true;
    switch (fault.kind) {
      case 'http_response': {
        const body = Buffer.from(fault.body ?? '', 'utf8');
        const headers = toHeaderMap(fault.headers);
        setHeader(headers, 'content-length', String(body.byteLength));
        exchange.respond(fault.statusCode, headers, body);
        writeLog({
          statusCode: fault.statusCode,
          headers,
          body,
          ...(headerValue(headers, 'content-type') !== undefined
            ? { contentType: headerValue(headers, 'content-type') as string }
            : {}),
        });
        return;
      }
      case 'connection': {
        writeLog({ headers: {}, bodySkippedReason: `connection_${fault.mode}` });
        exchange.destroy(fault.mode === 'reset');
        return;
      }
      case 'timeout': {
        writeLog({ headers: {}, bodySkippedReason: 'timeout_fault' });
        if (fault.durationMs !== undefined) {
          await sleep(fault.durationMs);
          exchange.destroy(false);
        }
        // without durationMs the connection is left hanging (spec 4.5.2)
        return;
      }
      case 'grpc_status':
        // unreachable on http listeners (validation enforces protocol match)
        exchange.destroy(false);
        return;
    }
    void upstreamBody;
  };

  // ---- request stage (spec 4.3.2)
  let forwardPath = path;
  let forwardQuery = query;
  let forwardHeaders: HeaderMap = { ...exchange.headers };
  let forwardBody: Buffer | undefined = requestBody;

  if (rule?.request) {
    if (rule.request.delay) {
      const plan = await applyDelay(rule.request.delay, 0);
      flags.delayed = true;
      timing.delayMs = plan.waitMs;
    }
    const action = rule.request.action;
    if (action) {
      if (action.type === 'mock_response') {
        flags.mock = true;
        const statusCode = action.response.statusCode ?? 200;
        const body = Buffer.from(action.response.body ?? '', 'utf8');
        const headers = toHeaderMap(action.response.headers);
        setHeader(headers, 'content-length', String(body.byteLength));
        exchange.respond(statusCode, headers, body);
        writeLog({
          statusCode,
          headers,
          body,
          ...(headerValue(headers, 'content-type') !== undefined
            ? { contentType: headerValue(headers, 'content-type') as string }
            : {}),
        });
        return;
      }
      if (action.type === 'fault') {
        await executeFault(action.fault);
        return;
      }
      // request_rewrite
      const rewritable = {
        path: forwardPath,
        query: forwardQuery,
        headers: forwardHeaders,
        ...(forwardBody !== undefined ? { body: forwardBody } : {}),
      };
      const result = applyRewriteOperations(rewritable, action.operations);
      forwardPath = rewritable.path;
      forwardQuery = rewritable.query;
      forwardHeaders = rewritable.headers;
      forwardBody = rewritable.body ?? forwardBody;
      if (result.modified) {
        flags.modified = true;
        forwardedDraft = {
          modified: true,
          method: exchange.method,
          path: joinPath(forwardPath, forwardQuery),
          headers: forwardHeaders,
          ...(result.bodyModified && forwardBody !== undefined ? { body: forwardBody } : {}),
          ...(requestContentType !== undefined ? { contentType: requestContentType } : {}),
        };
      }
    }
  }

  // ---- forward to upstream
  const target = parseUpstream(listener.upstream);
  const upstreamStartMs = Date.now();
  let reply: UpstreamReply;
  try {
    reply = await sendToUpstream(target, {
      method: exchange.method,
      path: joinPath(forwardPath, forwardQuery),
      authority: exchange.authority,
      headers: stripHopByHop(forwardHeaders),
      ...(forwardBody !== undefined
        ? { body: forwardBody }
        : requestTail !== undefined
          ? { body: requestTail }
          : requestBody === undefined
            ? { body: exchange.bodyStream }
            : {}),
      timeoutMs: runtime.limits.upstreamTimeoutMs,
    });
  } catch (err) {
    const reason = err instanceof UpstreamError ? err.reason : 'reset';
    const message = err instanceof Error ? err.message : String(err);
    flags.upstreamError = true;
    upstreamDraft = { received: false, headers: {} };
    const status = reason === 'timeout' ? 504 : 502;
    const body = Buffer.from(JSON.stringify({ error: `upstream_${reason}`, message }), 'utf8');
    const headers: HeaderMap = {
      'content-type': 'application/json',
      'x-morpheus-error': `upstream_${reason}`,
      'content-length': String(body.byteLength),
    };
    exchange.respond(status, headers, body);
    writeLog({ statusCode: status, headers, body, contentType: 'application/json' });
    return;
  }
  timing.upstreamDurationMs = Date.now() - upstreamStartMs;

  // ---- response body buffering decision
  let responseStatus = reply.statusCode;
  const responseHeaders = stripHopByHop(reply.headers);
  const respInterest = responseBodyInterest(rule, captureRules);
  const responseLimit = listener.maxResponseBodyBufferBytes;
  const respContentLength = contentLengthOf(reply.headers);
  const respContentType = headerValue(reply.headers, 'content-type');
  const eventStream = respContentType?.startsWith('text/event-stream') === true;
  let responseBody: Buffer | undefined;
  let responseBodySkipReason: string | undefined;
  let responseTail: Readable | undefined;

  if ((respInterest.want || respInterest.need) && !eventStream) {
    if (respContentLength !== undefined && respContentLength > responseLimit) {
      responseBodySkipReason = 'limit_exceeded';
    } else {
      let result: BodyReadResult;
      try {
        result = await readBodyUpTo(reply.stream, responseLimit);
      } catch (err) {
        flags.upstreamError = true;
        upstreamDraft = { received: true, headers: reply.headers };
        const message = err instanceof Error ? err.message : String(err);
        const body = Buffer.from(JSON.stringify({ error: 'upstream_reset', message }), 'utf8');
        const headers: HeaderMap = {
          'content-type': 'application/json',
          'x-morpheus-error': 'upstream_reset',
          'content-length': String(body.byteLength),
        };
        exchange.respond(502, headers, body);
        writeLog({ statusCode: 502, headers, body, contentType: 'application/json' });
        return;
      }
      if (result.complete) {
        responseBody = result.buffer;
      } else {
        responseBodySkipReason = 'limit_exceeded';
        responseTail = concatStream(result.prefix, reply.stream);
      }
    }
  } else if (respInterest.want && eventStream) {
    responseBodySkipReason = 'streaming';
  }
  if (responseBodySkipReason !== undefined && respInterest.need) {
    runtime.appLog.warn('response manipulation skipped: body not buffered', {
      rule: rule?.id,
      path: exchange.rawPath,
      reason: responseBodySkipReason,
    });
  }

  const responseContentType = headerValue(reply.headers, 'content-type');
  const upstreamBodySnapshot = responseBody;

  // ---- response stage (spec 4.3.2)
  let responseChanged = false;
  if (rule?.response) {
    const responseSnapshot: ResponseSnapshot = {
      statusCode: responseStatus,
      headers: responseHeaders,
      ...(responseBody !== undefined
        ? { body: responseBody.toString('utf8'), rawBodyBase64: responseBody.toString('base64') }
        : {}),
    };
    const matchResult = await evaluateResponseMatch({
      rule,
      protocol,
      request: requestSnapshot,
      response: responseSnapshot,
      consume: runtime.consume,
      ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
    });
    if (matchResult.error !== undefined) {
      ruleErrors.push({ ruleId: rule.id, stage: 'response', error: matchResult.error });
    }
    if (matchResult.matched) {
      if (rule.response.delay) {
        const elapsed = Date.now() - startedAt.getTime();
        const plan = await applyDelay(rule.response.delay, elapsed);
        flags.delayed = true;
        timing.delayMs = plan.waitMs;
        if (rule.response.delay.mode === 'total') timing.delaySkipped = plan.skipped;
      }
      const action = rule.response.action;
      if (action) {
        if (action.type === 'fault') {
          if (responseBody === undefined) reply.stream.destroy();
          upstreamDraft = {
            received: true,
            statusCode: reply.statusCode,
            headers: reply.headers,
            ...(upstreamBodySnapshot !== undefined ? { body: upstreamBodySnapshot } : {}),
            ...(responseContentType !== undefined ? { contentType: responseContentType } : {}),
          };
          await executeFault(action.fault);
          return;
        }
        if (action.type === 'response_replace') {
          if (applyResponseReplace(responseHeaders, action)) {
            responseChanged = true;
            flags.modified = true;
          }
        } else if (action.type === 'script_manipulator') {
          if (responseBody === undefined && responseBodySkipReason !== undefined) {
            // buffered body unavailable: passthrough (spec 4.8.3), warned above
          } else if (!runtime.manipulatorRunner) {
            ruleErrors.push({
              ruleId: rule.id,
              stage: 'response',
              error: 'script manipulator requires the script sandbox, which is not available',
            });
          } else {
            try {
              const patch = await runtime.manipulatorRunner(action, {
                protocol,
                stage: 'response',
                request: requestSnapshot,
                response: responseSnapshot,
                ruleState: runtime.consume.view(rule),
                upstream: { durationMs: timing.upstreamDurationMs ?? 0 },
              });
              const patchable = {
                statusCode: responseStatus,
                headers: responseHeaders,
                ...(responseBody !== undefined ? { body: responseBody } : {}),
              };
              const outcome = applyHttpResponsePatch(patchable, patch);
              responseStatus = patchable.statusCode;
              if (outcome.bodyChanged) responseBody = patchable.body;
              if (outcome.ignoredFields.length > 0) {
                runtime.appLog.warn('script patch fields ignored for http response', {
                  rule: rule.id,
                  fields: outcome.ignoredFields,
                });
              }
              if (outcome.changed) {
                responseChanged = true;
                flags.modified = true;
              }
            } catch (err) {
              const message =
                err instanceof InvalidPatchError || err instanceof Error
                  ? err.message
                  : String(err);
              ruleErrors.push({ ruleId: rule.id, stage: 'response', error: message });
            }
          }
        }
      }
    }
  }

  if (responseChanged) {
    upstreamDraft = {
      received: true,
      statusCode: reply.statusCode,
      headers: reply.headers,
      ...(upstreamBodySnapshot !== undefined ? { body: upstreamBodySnapshot } : {}),
      ...(responseContentType !== undefined ? { contentType: responseContentType } : {}),
    };
  }

  // ---- send the response to the client
  if (responseBody !== undefined) {
    if (responseChanged) {
      setHeader(responseHeaders, 'content-length', String(responseBody.byteLength));
    }
    exchange.respond(responseStatus, responseHeaders, responseBody);
  } else {
    exchange.respondStream(responseStatus, responseHeaders, responseTail ?? reply.stream);
  }

  writeLog({
    statusCode: responseStatus,
    headers: responseHeaders,
    ...(persistNeeded() && responseBody !== undefined ? { body: responseBody } : {}),
    ...(persistNeeded() && responseBodySkipReason !== undefined
      ? { bodySkippedReason: responseBodySkipReason }
      : {}),
    ...(responseContentType !== undefined ? { contentType: responseContentType } : {}),
  });
}
