import { randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageDraft, TimingInfo, TrafficEventDraft } from '../logging/traffic-log.js';
import { applyDelay, applyResponseReplace, applyRewriteOperations } from '../proxy/actions.js';
import { readBodyUpTo } from '../proxy/body.js';
import { fromNodeHeaders, headerValue, stripHopByHop } from '../proxy/headers.js';
import { applyGrpcResponsePatch, InvalidPatchError } from '../proxy/patch.js';
import type { StartedListener } from '../proxy/http-listener.js';
import type { ProxyRuntime } from '../proxy/pipeline.js';
import { parseUpstream, sendToUpstream, UpstreamError, type UpstreamReply } from '../proxy/upstream.js';
import {
  evaluateRequest,
  evaluateResponseMatch,
  type MatchedRuleInfo,
  type RuleErrorInfo,
} from '../rules/evaluate.js';
import {
  matcherUsesTrailers,
  type HeaderMap,
  type RequestSnapshot,
  type ResponseSnapshot,
} from '../rules/matcher.js';
import type { Rule } from '../rules/types.js';
import type { DescriptorRegistry, ResolvedMethod } from './descriptors.js';
import { decodeGrpcFrames, encodeGrpcFrame, encodeGrpcMessage } from './frames.js';

export interface GrpcRuntime extends ProxyRuntime {
  descriptors: DescriptorRegistry;
}

const GRPC_STATUS = {
  OK: 0,
  DEADLINE_EXCEEDED: 4,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAVAILABLE: 14,
} as const;

interface GrpcResponseInit {
  metadata?: HeaderMap;
  /** Already framed message bytes. */
  body?: Buffer;
  grpcStatus: number;
  grpcMessage?: string;
  trailers?: HeaderMap;
}

const RESERVED_RESPONSE_HEADERS = new Set([
  'grpc-status',
  'grpc-message',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
]);

function metadataToOutgoing(metadata: HeaderMap | undefined): http2.OutgoingHttpHeaders {
  const out: http2.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(metadata ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || RESERVED_RESPONSE_HEADERS.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

function respondGrpc(stream: http2.ServerHttp2Stream, init: GrpcResponseInit): void {
  if (stream.destroyed || stream.headersSent) return;
  try {
    stream.respond(
      {
        ':status': 200,
        'content-type': 'application/grpc',
        ...metadataToOutgoing(init.metadata),
      },
      { waitForTrailers: true },
    );
    stream.once('wantTrailers', () => {
      const trailers: http2.OutgoingHttpHeaders = {
        'grpc-status': String(init.grpcStatus),
        ...(init.grpcMessage !== undefined && init.grpcMessage !== ''
          ? { 'grpc-message': encodeGrpcMessage(init.grpcMessage) }
          : {}),
        ...metadataToOutgoing(init.trailers),
      };
      try {
        stream.sendTrailers(trailers);
      } catch {
        stream.destroy();
      }
    });
    stream.end(init.body);
  } catch {
    stream.destroy();
  }
}

function parseGrpcPath(path: string): { service?: string; method?: string } {
  const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return {};
  return { service: match[1] as string, method: match[2] as string };
}

function grpcStatusOf(headers: HeaderMap, trailers: HeaderMap): { status?: number; message?: string } {
  const raw = headerValue(trailers, 'grpc-status') ?? headerValue(headers, 'grpc-status');
  const rawMessage = headerValue(trailers, 'grpc-message') ?? headerValue(headers, 'grpc-message');
  const result: { status?: number; message?: string } = {};
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed)) result.status = parsed;
  }
  if (rawMessage !== undefined) result.message = decodeURIComponent(rawMessage);
  return result;
}

function messagesToLogBody(messages: unknown[] | undefined): Buffer | undefined {
  if (messages === undefined) return undefined;
  const value = messages.length === 1 ? messages[0] : messages;
  return Buffer.from(JSON.stringify(value), 'utf8');
}

interface StreamContext {
  stream: http2.ServerHttp2Stream;
  path: string;
  authority: string;
  metadata: HeaderMap;
  client: string;
  startedAt: Date;
  method: ResolvedMethod | null;
}

async function handleGrpcStream(runtime: GrpcRuntime, ctx: StreamContext): Promise<void> {
  const isUnary =
    ctx.method !== null && !ctx.method.requestStream && !ctx.method.responseStream;
  if (isUnary) {
    await handleUnary(runtime, ctx, ctx.method as ResolvedMethod);
  } else {
    await handleStreaming(runtime, ctx);
  }
}

interface LogAccumulator {
  matched: MatchedRuleInfo[];
  ruleErrors: RuleErrorInfo[];
  captureRules: Rule[];
  rule: Rule | null;
  flags: { mock: boolean; fault: boolean; modified: boolean; delayed: boolean; upstreamError: boolean };
  timing: TimingInfo;
  forwardedDraft?: MessageDraft & { modified: boolean };
  upstreamDraft?: MessageDraft & { received: boolean };
}

function makeWriteLog(
  runtime: GrpcRuntime,
  ctx: StreamContext,
  acc: LogAccumulator,
  requestDraft: () => MessageDraft,
) {
  return (responseDraft: MessageDraft): void => {
    const shouldLog =
      acc.rule !== null ||
      acc.captureRules.length > 0 ||
      acc.ruleErrors.length > 0 ||
      acc.flags.upstreamError;
    const outcome = acc.flags.upstreamError
      ? 'upstream_error'
      : acc.flags.mock
        ? 'mock'
        : acc.flags.fault
          ? 'fault'
          : acc.flags.modified
            ? 'modified'
            : acc.flags.delayed
              ? 'delayed'
              : acc.ruleErrors.length > 0
                ? 'rule_error'
                : 'captured';
    runtime.metrics?.recordRequest(
      shouldLog ? outcome : 'passthrough',
      acc.matched.map((m) => m.id),
      acc.timing.upstreamDurationMs,
    );
    for (let i = 0; i < acc.ruleErrors.length; i++) runtime.metrics?.recordScriptError();
    if (!shouldLog) return;
    const draft: TrafficEventDraft = {
      startedAt: ctx.startedAt,
      endedAt: (runtime.now ?? (() => new Date()))(),
      protocol: 'grpc',
      listener: runtime.listener.name,
      client: ctx.client,
      target: runtime.listener.upstream,
      request: requestDraft(),
      ...(acc.forwardedDraft !== undefined ? { forwardedRequest: acc.forwardedDraft } : {}),
      ...(acc.upstreamDraft !== undefined ? { upstreamResponse: acc.upstreamDraft } : {}),
      response: responseDraft,
      outcome,
      loggingReason:
        outcome === 'upstream_error' && acc.matched.length === 0
          ? 'upstream_error'
          : acc.rule !== null
            ? 'matched_rule'
            : acc.ruleErrors.length > 0 && acc.captureRules.length === 0
              ? 'rule_error'
              : 'capture_rule',
      matchedRules: acc.matched,
      ruleErrors: acc.ruleErrors,
      timing: acc.timing,
    };
    try {
      runtime.trafficLog.add(draft);
    } catch (err) {
      runtime.appLog.error('traffic log write failed', { error: String(err) });
    }
  };
}

function upstreamFailureResponse(err: unknown): { status: number; message: string } {
  if (err instanceof UpstreamError && err.reason === 'timeout') {
    return { status: GRPC_STATUS.DEADLINE_EXCEEDED, message: `upstream timeout: ${err.message}` };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: GRPC_STATUS.UNAVAILABLE, message: `upstream unavailable: ${message}` };
}

async function handleUnary(
  runtime: GrpcRuntime,
  ctx: StreamContext,
  method: ResolvedMethod,
): Promise<void> {
  const { stream, path, metadata } = ctx;
  const limit = runtime.listener.maxRequestBodyBufferBytes;

  const read = await readBodyUpTo(stream as unknown as Readable, limit).catch(() => null);
  if (read === null) {
    stream.destroy();
    return;
  }
  if (!read.complete) {
    respondGrpc(stream, {
      grpcStatus: GRPC_STATUS.RESOURCE_EXHAUSTED,
      grpcMessage: `request body exceeds the ${limit} byte buffer limit`,
    });
    return;
  }
  const rawBody = read.buffer;

  // decode request messages when the descriptor covers them (spec 4.7.3)
  let requestMessages: unknown[] | undefined;
  try {
    const frames = decodeGrpcFrames(rawBody);
    if (frames.every((f) => !f.compressed)) {
      requestMessages = frames.map((f) =>
        runtime.descriptors.decodeMessage(method.requestType, f.message),
      );
    }
  } catch (err) {
    runtime.appLog.error('grpc request decode failed; passing through', {
      path,
      error: String(err),
    });
  }

  const grpcPath = parseGrpcPath(path);
  const requestSnapshot: RequestSnapshot = {
    id: randomUUID(),
    method: 'POST',
    host: ctx.authority,
    path,
    query: '',
    headers: metadata,
    rawBodyBase64: rawBody.toString('base64'),
    ...(requestMessages !== undefined
      ? { body: messagesToLogBody(requestMessages)?.toString('utf8') as string }
      : {}),
    grpc: {
      ...(grpcPath.service !== undefined ? { service: grpcPath.service } : {}),
      ...(grpcPath.method !== undefined ? { method: grpcPath.method } : {}),
      metadata,
      ...(requestMessages !== undefined ? { messages: requestMessages } : {}),
    },
  };

  const snapshot = runtime.ruleStore.snapshot();
  const evaluation = await evaluateRequest({
    rules: snapshot.rules,
    protocol: 'grpc',
    request: requestSnapshot,
    consume: runtime.consume,
    ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
  });

  const acc: LogAccumulator = {
    matched: evaluation.matched,
    ruleErrors: [...evaluation.errors],
    captureRules: evaluation.captureRules,
    rule: evaluation.interceptRule,
    flags: { mock: false, fault: false, modified: false, delayed: false, upstreamError: false },
    timing: {},
  };
  const rule = acc.rule;

  const persistNeeded = (): boolean =>
    acc.captureRules.some((r) => r.logging.capture) ||
    (rule?.logging.capture ?? false) ||
    acc.flags.mock ||
    acc.flags.fault ||
    acc.flags.modified;

  const requestLogBody = messagesToLogBody(requestMessages);
  const requestDraft = (): MessageDraft => ({
    method: 'POST',
    path,
    headers: metadata,
    // gRPC bodies are only logged as decoded JSON when a descriptor exists (spec 4.9.3)
    ...(persistNeeded() && requestLogBody !== undefined
      ? { body: requestLogBody, contentType: 'application/json' }
      : {}),
  });
  const writeLog = makeWriteLog(runtime, ctx, acc, requestDraft);

  // ---- request stage
  let forwardMetadata: HeaderMap = { ...metadata };
  if (rule?.request) {
    if (rule.request.delay) {
      const plan = await applyDelay(rule.request.delay, 0);
      acc.flags.delayed = true;
      acc.timing.delayMs = plan.waitMs;
    }
    const action = rule.request.action;
    if (action?.type === 'mock_response') {
      acc.flags.mock = true;
      let body: Buffer | undefined;
      try {
        const frames = (action.response.messages ?? []).map((message) =>
          encodeGrpcFrame(runtime.descriptors.encodeMessage(method.responseType, message)),
        );
        body = frames.length > 0 ? Buffer.concat(frames) : undefined;
      } catch (err) {
        acc.flags.mock = false;
        acc.ruleErrors.push({
          ruleId: rule.id,
          stage: 'request',
          error: `mock encode failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        respondGrpc(stream, {
          grpcStatus: GRPC_STATUS.INTERNAL,
          grpcMessage: 'morpheus-proxy: mock response encoding failed',
        });
        writeLog({ statusCode: 200, grpcStatus: GRPC_STATUS.INTERNAL, headers: {} });
        return;
      }
      const grpcStatus = action.response.grpcStatus ?? 0;
      respondGrpc(stream, {
        metadata: action.response.metadata ?? {},
        ...(body !== undefined ? { body } : {}),
        grpcStatus,
        ...(action.response.grpcMessage !== undefined
          ? { grpcMessage: action.response.grpcMessage }
          : {}),
      });
      writeLog({
        statusCode: 200,
        grpcStatus,
        headers: action.response.metadata ?? {},
        ...(action.response.messages !== undefined
          ? { body: messagesToLogBody(action.response.messages) as Buffer, contentType: 'application/json' }
          : {}),
      });
      return;
    }
    if (action?.type === 'fault') {
      const fault = action.fault;
      if (fault.kind === 'grpc_status') {
        acc.flags.fault = true;
        respondGrpc(stream, {
          metadata: fault.metadata ?? {},
          grpcStatus: fault.status,
          ...(fault.message !== undefined ? { grpcMessage: fault.message } : {}),
        });
        writeLog({ statusCode: 200, grpcStatus: fault.status, headers: fault.metadata ?? {} });
        return;
      }
      if (fault.kind === 'connection') {
        acc.flags.fault = true;
        writeLog({ headers: {}, bodySkippedReason: `connection_${fault.mode}` });
        const socket = stream.session?.socket as Socket | undefined;
        if (fault.mode === 'reset' && socket) socket.resetAndDestroy();
        else stream.destroy();
        return;
      }
      if (fault.kind === 'timeout') {
        acc.flags.fault = true;
        writeLog({ headers: {}, bodySkippedReason: 'timeout_fault' });
        if (fault.durationMs !== undefined) {
          await sleep(fault.durationMs);
          stream.destroy();
        }
        return;
      }
    }
    if (action?.type === 'request_rewrite') {
      const rewritable = { path: '', query: '', headers: forwardMetadata };
      const result = applyRewriteOperations(rewritable, action.operations);
      forwardMetadata = rewritable.headers;
      if (result.modified) {
        acc.flags.modified = true;
        acc.forwardedDraft = { modified: true, method: 'POST', path, headers: forwardMetadata };
      }
    }
  }

  // ---- forward to upstream
  const target = parseUpstream(runtime.listener.upstream);
  const upstreamStart = Date.now();
  let reply: UpstreamReply;
  try {
    reply = await sendToUpstream(
      { ...target, kind: 'h2c' },
      {
        method: 'POST',
        path,
        authority: ctx.authority,
        headers: stripHopByHop(forwardMetadata),
        body: rawBody,
        timeoutMs: runtime.limits.upstreamTimeoutMs,
      },
    );
  } catch (err) {
    acc.flags.upstreamError = true;
    acc.upstreamDraft = { received: false, headers: {} };
    const failure = upstreamFailureResponse(err);
    respondGrpc(stream, { grpcStatus: failure.status, grpcMessage: failure.message });
    writeLog({ statusCode: 200, grpcStatus: failure.status, headers: {} });
    return;
  }
  acc.timing.upstreamDurationMs = Date.now() - upstreamStart;

  const respRead = await readBodyUpTo(
    reply.stream,
    runtime.listener.maxResponseBodyBufferBytes,
  ).catch(() => null);
  if (respRead === null || !respRead.complete) {
    // treat as transport failure / oversized unary response: relay is not possible cleanly
    acc.flags.upstreamError = true;
    acc.upstreamDraft = { received: true, headers: reply.headers };
    respondGrpc(stream, {
      grpcStatus: GRPC_STATUS.INTERNAL,
      grpcMessage: 'morpheus-proxy: upstream unary response could not be buffered',
    });
    writeLog({ statusCode: 200, grpcStatus: GRPC_STATUS.INTERNAL, headers: {} });
    return;
  }
  const upstreamBody = respRead.buffer;
  const upstreamTrailers = reply.trailers();
  const upstreamStatus = grpcStatusOf(reply.headers, upstreamTrailers);

  let responseMessages: unknown[] | undefined;
  try {
    const frames = decodeGrpcFrames(upstreamBody);
    if (frames.every((f) => !f.compressed)) {
      responseMessages = frames.map((f) =>
        runtime.descriptors.decodeMessage(method.responseType, f.message),
      );
    }
  } catch (err) {
    runtime.appLog.error('grpc response decode failed; passing through', {
      path,
      error: String(err),
    });
  }

  const cleanTrailers: HeaderMap = {};
  for (const [name, value] of Object.entries(upstreamTrailers)) {
    const lower = name.toLowerCase();
    if (lower === 'grpc-status' || lower === 'grpc-message') continue;
    cleanTrailers[lower] = value;
  }

  let outMetadata: HeaderMap = {};
  for (const [name, value] of Object.entries(reply.headers)) {
    const lower = name.toLowerCase();
    if (RESERVED_RESPONSE_HEADERS.has(lower) || lower.startsWith(':') || lower === 'content-type') {
      continue;
    }
    outMetadata[lower] = value;
  }
  let outMessages = responseMessages;
  let outBody: Buffer | undefined = upstreamBody.byteLength > 0 ? upstreamBody : undefined;
  let outStatus = upstreamStatus.status ?? 0;
  let outMessage = upstreamStatus.message;
  let outTrailers = cleanTrailers;
  let responseChanged = false;
  let messagesChanged = false;

  const captureUpstream = (): void => {
    acc.upstreamDraft = {
      received: true,
      statusCode: reply.statusCode,
      ...(upstreamStatus.status !== undefined ? { grpcStatus: upstreamStatus.status } : {}),
      headers: reply.headers,
      trailers: upstreamTrailers,
      ...(messagesToLogBody(responseMessages) !== undefined
        ? { body: messagesToLogBody(responseMessages) as Buffer, contentType: 'application/json' }
        : {}),
    };
  };

  // ---- response stage
  if (rule?.response) {
    const responseSnapshot: ResponseSnapshot = {
      statusCode: reply.statusCode,
      headers: reply.headers,
      ...(messagesToLogBody(responseMessages) !== undefined
        ? {
            body: (messagesToLogBody(responseMessages) as Buffer).toString('utf8'),
            rawBodyBase64: upstreamBody.toString('base64'),
          }
        : { rawBodyBase64: upstreamBody.toString('base64') }),
      grpc: {
        ...(upstreamStatus.status !== undefined ? { status: upstreamStatus.status } : {}),
        ...(upstreamStatus.message !== undefined ? { message: upstreamStatus.message } : {}),
        trailers: upstreamTrailers,
        ...(responseMessages !== undefined ? { messages: responseMessages } : {}),
      },
    };
    const matchResult = await evaluateResponseMatch({
      rule,
      protocol: 'grpc',
      request: requestSnapshot,
      response: responseSnapshot,
      consume: runtime.consume,
      ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
    });
    if (matchResult.error !== undefined) {
      acc.ruleErrors.push({ ruleId: rule.id, stage: 'response', error: matchResult.error });
    }
    if (matchResult.matched) {
      if (rule.response.delay) {
        const elapsed = Date.now() - ctx.startedAt.getTime();
        const plan = await applyDelay(rule.response.delay, elapsed);
        acc.flags.delayed = true;
        acc.timing.delayMs = plan.waitMs;
        if (rule.response.delay.mode === 'total') acc.timing.delaySkipped = plan.skipped;
      }
      const action = rule.response.action;
      if (action?.type === 'fault' && action.fault.kind === 'grpc_status') {
        acc.flags.fault = true;
        captureUpstream();
        respondGrpc(stream, {
          metadata: action.fault.metadata ?? {},
          grpcStatus: action.fault.status,
          ...(action.fault.message !== undefined ? { grpcMessage: action.fault.message } : {}),
        });
        writeLog({
          statusCode: 200,
          grpcStatus: action.fault.status,
          headers: action.fault.metadata ?? {},
        });
        return;
      }
      if (action?.type === 'fault' && action.fault.kind === 'connection') {
        acc.flags.fault = true;
        captureUpstream();
        writeLog({ headers: {}, bodySkippedReason: `connection_${action.fault.mode}` });
        const socket = stream.session?.socket as Socket | undefined;
        if (action.fault.mode === 'reset' && socket) socket.resetAndDestroy();
        else stream.destroy();
        return;
      }
      if (action?.type === 'fault' && action.fault.kind === 'timeout') {
        acc.flags.fault = true;
        captureUpstream();
        writeLog({ headers: {}, bodySkippedReason: 'timeout_fault' });
        if (action.fault.durationMs !== undefined) {
          await sleep(action.fault.durationMs);
          stream.destroy();
        }
        return;
      }
      if (action?.type === 'response_replace') {
        if (applyResponseReplace(outMetadata, action)) {
          responseChanged = true;
          acc.flags.modified = true;
        }
      } else if (action?.type === 'script_manipulator') {
        if (!runtime.manipulatorRunner) {
          acc.ruleErrors.push({
            ruleId: rule.id,
            stage: 'response',
            error: 'script manipulator requires the script sandbox, which is not available',
          });
        } else {
          try {
            const patch = await runtime.manipulatorRunner(action, {
              protocol: 'grpc',
              stage: 'response',
              request: requestSnapshot,
              response: responseSnapshot,
              ruleState: runtime.consume.view(rule),
              upstream: { durationMs: acc.timing.upstreamDurationMs ?? 0 },
            });
            const patchable = {
              metadata: outMetadata,
              ...(outMessages !== undefined ? { messages: outMessages } : {}),
              grpcStatus: outStatus,
              ...(outMessage !== undefined ? { grpcMessage: outMessage } : {}),
              trailers: outTrailers,
            };
            const outcome = applyGrpcResponsePatch(patchable, patch, {
              allowMessages: responseMessages !== undefined,
            });
            outMetadata = patchable.metadata;
            outStatus = patchable.grpcStatus;
            outMessage = patchable.grpcMessage;
            outTrailers = patchable.trailers;
            if (outcome.messagesChanged) {
              outMessages = patchable.messages;
              messagesChanged = true;
            }
            if (outcome.ignoredFields.length > 0) {
              runtime.appLog.warn('script patch fields ignored for grpc response', {
                rule: rule.id,
                fields: outcome.ignoredFields,
              });
            }
            if (outcome.changed) {
              responseChanged = true;
              acc.flags.modified = true;
            }
          } catch (err) {
            acc.ruleErrors.push({
              ruleId: rule.id,
              stage: 'response',
              error:
                err instanceof InvalidPatchError || err instanceof Error
                  ? err.message
                  : String(err),
            });
          }
        }
      }
    }
  }

  if (messagesChanged && outMessages !== undefined) {
    try {
      const frames = outMessages.map((message) =>
        encodeGrpcFrame(runtime.descriptors.encodeMessage(method.responseType, message)),
      );
      outBody = frames.length > 0 ? Buffer.concat(frames) : undefined;
    } catch (err) {
      // encode failure: pass the upstream response through unchanged (spec 4.7.3)
      acc.ruleErrors.push({
        ruleId: (rule as Rule).id,
        stage: 'response',
        error: `patched message encode failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      outBody = upstreamBody.byteLength > 0 ? upstreamBody : undefined;
      outStatus = upstreamStatus.status ?? 0;
      outMessage = upstreamStatus.message;
      acc.flags.modified = false;
    }
  }

  if (responseChanged) captureUpstream();

  respondGrpc(stream, {
    metadata: outMetadata,
    ...(outBody !== undefined ? { body: outBody } : {}),
    grpcStatus: outStatus,
    ...(outMessage !== undefined ? { grpcMessage: outMessage } : {}),
    trailers: outTrailers,
  });

  const finalLogBody = messagesChanged
    ? messagesToLogBody(outMessages)
    : messagesToLogBody(responseMessages);
  writeLog({
    statusCode: 200,
    grpcStatus: outStatus,
    headers: outMetadata,
    trailers: outTrailers,
    ...(persistNeeded() && finalLogBody !== undefined
      ? { body: finalLogBody, contentType: 'application/json' }
      : {}),
  });
}

async function handleStreaming(runtime: GrpcRuntime, ctx: StreamContext): Promise<void> {
  const { stream, path, metadata } = ctx;
  const grpcPath = parseGrpcPath(path);
  const requestSnapshot: RequestSnapshot = {
    id: randomUUID(),
    method: 'POST',
    host: ctx.authority,
    path,
    query: '',
    headers: metadata,
    grpc: {
      ...(grpcPath.service !== undefined ? { service: grpcPath.service } : {}),
      ...(grpcPath.method !== undefined ? { method: grpcPath.method } : {}),
      metadata,
    },
  };

  const snapshot = runtime.ruleStore.snapshot();
  const evaluation = await evaluateRequest({
    rules: snapshot.rules,
    protocol: 'grpc',
    request: requestSnapshot,
    consume: runtime.consume,
    streaming: true,
    ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
  });

  const acc: LogAccumulator = {
    matched: evaluation.matched,
    ruleErrors: [...evaluation.errors],
    captureRules: evaluation.captureRules,
    rule: evaluation.interceptRule,
    flags: { mock: false, fault: false, modified: false, delayed: false, upstreamError: false },
    timing: {},
  };
  const rule = acc.rule;
  const requestDraft = (): MessageDraft => ({
    method: 'POST',
    path,
    headers: metadata,
    bodySkippedReason: 'streaming',
  });
  const writeLog = makeWriteLog(runtime, ctx, acc, requestDraft);

  // ---- request stage (metadata-level only, spec 4.7.5)
  let forwardMetadata: HeaderMap = { ...metadata };
  if (rule?.request) {
    if (rule.request.delay) {
      const plan = await applyDelay(rule.request.delay, 0);
      acc.flags.delayed = true;
      acc.timing.delayMs = plan.waitMs;
    }
    const action = rule.request.action;
    if (action?.type === 'fault' && action.fault.kind === 'grpc_status') {
      acc.flags.fault = true;
      respondGrpc(stream, {
        metadata: action.fault.metadata ?? {},
        grpcStatus: action.fault.status,
        ...(action.fault.message !== undefined ? { grpcMessage: action.fault.message } : {}),
      });
      writeLog({ statusCode: 200, grpcStatus: action.fault.status, headers: action.fault.metadata ?? {} });
      return;
    }
    if (action?.type === 'fault' && (action.fault.kind === 'connection' || action.fault.kind === 'timeout')) {
      acc.flags.fault = true;
      writeLog({ headers: {}, bodySkippedReason: `${action.fault.kind}_fault` });
      if (action.fault.kind === 'timeout' && action.fault.durationMs !== undefined) {
        await sleep(action.fault.durationMs);
        stream.destroy();
      } else if (action.fault.kind === 'connection' && action.fault.mode === 'reset') {
        (stream.session?.socket as Socket | undefined)?.resetAndDestroy();
      } else if (action.fault.kind === 'connection') {
        stream.destroy();
      }
      return;
    }
    if (action?.type === 'mock_response') {
      acc.ruleErrors.push({
        ruleId: rule.id,
        stage: 'request',
        error: 'mock responses are not supported on streaming methods; passing through (spec 4.7.5)',
      });
    }
    if (action?.type === 'request_rewrite') {
      const rewritable = { path: '', query: '', headers: forwardMetadata };
      const result = applyRewriteOperations(rewritable, action.operations);
      forwardMetadata = rewritable.headers;
      if (result.modified) {
        acc.flags.modified = true;
        acc.forwardedDraft = { modified: true, method: 'POST', path, headers: forwardMetadata };
      }
    }
  }

  // ---- forward: bidirectional relay
  const target = parseUpstream(runtime.listener.upstream);
  const upstreamStart = Date.now();
  let reply: UpstreamReply;
  try {
    reply = await sendToUpstream(
      { ...target, kind: 'h2c' },
      {
        method: 'POST',
        path,
        authority: ctx.authority,
        headers: stripHopByHop(forwardMetadata),
        body: stream,
        timeoutMs: runtime.limits.upstreamTimeoutMs,
      },
    );
  } catch (err) {
    acc.flags.upstreamError = true;
    acc.upstreamDraft = { received: false, headers: {} };
    const failure = upstreamFailureResponse(err);
    respondGrpc(stream, { grpcStatus: failure.status, grpcMessage: failure.message });
    writeLog({ statusCode: 200, grpcStatus: failure.status, headers: {} });
    return;
  }
  acc.timing.upstreamDurationMs = Date.now() - upstreamStart;

  const respStage = rule?.response;
  const needsTrailers = respStage?.match !== undefined && matcherUsesTrailers(respStage.match);

  let outHeaders: HeaderMap = {};
  for (const [name, value] of Object.entries(reply.headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || lower === 'content-length' || lower === 'transfer-encoding') continue;
    outHeaders[lower] = value;
  }

  let headerStageMatched = false;
  if (respStage && !needsTrailers) {
    const responseSnapshot: ResponseSnapshot = {
      statusCode: reply.statusCode,
      headers: reply.headers,
      grpc: { trailers: {}, ...(grpcStatusOf(reply.headers, {}).status !== undefined ? { status: grpcStatusOf(reply.headers, {}).status as number } : {}) },
    };
    const matchResult = await evaluateResponseMatch({
      rule: rule,
      protocol: 'grpc',
      request: requestSnapshot,
      response: responseSnapshot,
      consume: runtime.consume,
      ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
    });
    if (matchResult.error !== undefined) {
      acc.ruleErrors.push({ ruleId: (rule).id, stage: 'response', error: matchResult.error });
    }
    headerStageMatched = matchResult.matched;
    if (headerStageMatched) {
      if (respStage.delay) {
        const elapsed = Date.now() - ctx.startedAt.getTime();
        const plan = await applyDelay(respStage.delay, elapsed);
        acc.flags.delayed = true;
        acc.timing.delayMs = plan.waitMs;
        if (respStage.delay.mode === 'total') acc.timing.delaySkipped = plan.skipped;
      }
      const action = respStage.action;
      if (action?.type === 'response_replace') {
        if (applyResponseReplace(outHeaders, action)) acc.flags.modified = true;
      } else if (action?.type === 'script_manipulator' && runtime.manipulatorRunner) {
        try {
          const patch = await runtime.manipulatorRunner(action, {
            protocol: 'grpc',
            stage: 'response',
            request: requestSnapshot,
            response: { statusCode: reply.statusCode, headers: reply.headers, grpc: { trailers: {} } },
            ruleState: runtime.consume.view(rule),
            upstream: { durationMs: acc.timing.upstreamDurationMs ?? 0 },
          });
          const patchable = { metadata: outHeaders, grpcStatus: 0, trailers: {} };
          const outcome = applyGrpcResponsePatch(patchable, patch, { allowMessages: false });
          outHeaders = patchable.metadata;
          if (outcome.ignoredFields.length > 0) {
            runtime.appLog.warn('script patch fields ignored for streaming grpc response', {
              rule: (rule).id,
              fields: outcome.ignoredFields,
            });
          }
          if (outcome.changed) acc.flags.modified = true;
        } catch (err) {
          acc.ruleErrors.push({
            ruleId: (rule).id,
            stage: 'response',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (action?.type === 'fault' && action.fault.kind === 'grpc_status') {
        // headers-based match with a status fault: replace the whole response
        acc.flags.fault = true;
        reply.stream.destroy();
        respondGrpc(stream, {
          metadata: action.fault.metadata ?? {},
          grpcStatus: action.fault.status,
          ...(action.fault.message !== undefined ? { grpcMessage: action.fault.message } : {}),
        });
        writeLog({ statusCode: 200, grpcStatus: action.fault.status, headers: action.fault.metadata ?? {} });
        return;
      }
    }
  }

  // relay headers, pipe body, then rewrite trailers on arrival (spec 4.7.5)
  let pendingTrailers: http2.OutgoingHttpHeaders = {};
  try {
    stream.respond({ ':status': 200, ...metadataToOutgoing(outHeaders), 'content-type': headerValue(reply.headers, 'content-type') ?? 'application/grpc' }, { waitForTrailers: true });
  } catch {
    stream.destroy();
    return;
  }
  stream.once('wantTrailers', () => {
    try {
      stream.sendTrailers(pendingTrailers);
    } catch {
      stream.destroy();
    }
  });

  reply.stream.pipe(stream, { end: false });
  reply.stream.on('error', () => stream.destroy());
  stream.on('close', () => reply.stream.destroy());

  reply.stream.on('end', () => {
    void (async () => {
      const upstreamTrailers = reply.trailers();
      const upstreamStatus = grpcStatusOf(reply.headers, upstreamTrailers);
      let outStatus = upstreamStatus.status ?? 0;
      let outMessage = upstreamStatus.message;
      const outTrailers: HeaderMap = {};
      for (const [name, value] of Object.entries(upstreamTrailers)) {
        const lower = name.toLowerCase();
        if (lower === 'grpc-status' || lower === 'grpc-message') continue;
        outTrailers[lower] = value;
      }

      if (respStage && needsTrailers) {
        const responseSnapshot: ResponseSnapshot = {
          statusCode: reply.statusCode,
          headers: reply.headers,
          grpc: {
            ...(upstreamStatus.status !== undefined ? { status: upstreamStatus.status } : {}),
            ...(upstreamStatus.message !== undefined ? { message: upstreamStatus.message } : {}),
            trailers: upstreamTrailers,
          },
        };
        const matchResult = await evaluateResponseMatch({
          rule: rule,
          protocol: 'grpc',
          request: requestSnapshot,
          response: responseSnapshot,
          consume: runtime.consume,
          ...(runtime.scriptRunner ? { scriptRunner: runtime.scriptRunner } : {}),
        });
        if (matchResult.error !== undefined) {
          acc.ruleErrors.push({ ruleId: (rule).id, stage: 'response', error: matchResult.error });
        }
        if (matchResult.matched) {
          const action = respStage.action;
          if (action?.type === 'fault' && action.fault.kind === 'grpc_status') {
            acc.flags.fault = true;
            outStatus = action.fault.status;
            outMessage = action.fault.message;
          } else if (action?.type === 'script_manipulator' && runtime.manipulatorRunner) {
            try {
              const patch = await runtime.manipulatorRunner(action, {
                protocol: 'grpc',
                stage: 'response',
                request: requestSnapshot,
                response: responseSnapshot,
                ruleState: runtime.consume.view(rule),
                upstream: { durationMs: acc.timing.upstreamDurationMs ?? 0 },
              });
              const patchable = {
                metadata: {},
                grpcStatus: outStatus,
                ...(outMessage !== undefined ? { grpcMessage: outMessage } : {}),
                trailers: outTrailers,
              };
              const outcome = applyGrpcResponsePatch(patchable, patch, {
                allowMetadata: false,
                allowMessages: false,
              });
              outStatus = patchable.grpcStatus;
              outMessage = patchable.grpcMessage;
              if (outcome.ignoredFields.length > 0) {
                runtime.appLog.warn('script patch fields ignored after headers were sent', {
                  rule: (rule).id,
                  fields: outcome.ignoredFields,
                });
              }
              if (outcome.changed) acc.flags.modified = true;
            } catch (err) {
              acc.ruleErrors.push({
                ruleId: (rule).id,
                stage: 'response',
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else if (action?.type === 'response_replace') {
            runtime.appLog.warn(
              'response_replace skipped: headers already sent for streaming response',
              { rule: (rule).id },
            );
          }
        }
      }

      pendingTrailers = {
        'grpc-status': String(outStatus),
        ...(outMessage !== undefined && outMessage !== ''
          ? { 'grpc-message': encodeGrpcMessage(outMessage) }
          : {}),
        ...metadataToOutgoing(outTrailers),
      };
      stream.end();
      writeLog({
        statusCode: 200,
        grpcStatus: outStatus,
        headers: outHeaders,
        trailers: outTrailers,
        bodySkippedReason: 'streaming',
      });
    })();
  });
  void headerStageMatched;
}

/**
 * Builds the HTTP/2 `stream` handler for a gRPC runtime. Shared by the reverse
 * gRPC listener and the CONNECT listener (which binds a per-connection runtime
 * whose upstream is the CONNECT authority, spec 4.14).
 */
export function grpcStreamHandler(
  runtime: GrpcRuntime,
): (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void {
  const { appLog } = runtime;
  return (stream, headers) => {
    const ctx: StreamContext = {
      stream,
      path: String(headers[':path'] ?? '/'),
      authority: String(headers[':authority'] ?? headers['host'] ?? ''),
      metadata: fromNodeHeaders(headers),
      client: (() => {
        const socket = stream.session?.socket;
        return socket ? `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}` : 'unknown';
      })(),
      startedAt: (runtime.now ?? (() => new Date()))(),
      method: runtime.descriptors.lookupMethod(String(headers[':path'] ?? '/')),
    };
    handleGrpcStream(runtime, ctx).catch((err: unknown) => {
      appLog.error('grpc handler error', { path: ctx.path, error: String(err) });
      if (!stream.headersSent && !stream.destroyed) {
        respondGrpc(stream, {
          grpcStatus: GRPC_STATUS.INTERNAL,
          grpcMessage: 'morpheus-proxy: internal error',
        });
      } else {
        stream.destroy();
      }
    });
  };
}

/** Starts the gRPC (HTTP/2 cleartext) proxy listener (spec 3.5, 4.7). */
export function startGrpcListener(runtime: GrpcRuntime): Promise<StartedListener> {
  const { listener, limits, appLog } = runtime;
  const sessions = new Set<http2.ServerHttp2Session>();

  const server = http2.createServer();
  server.on('session', (session) => {
    if (sessions.size >= limits.maxConcurrentConnections) {
      session.destroy();
      return;
    }
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    session.on('error', () => sessions.delete(session));
  });
  server.on('stream', grpcStreamHandler(runtime));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listener.port, listener.host, () => {
      const address = server.address() as AddressInfo;
      appLog.info(`listener "${listener.name}" started`, {
        protocol: 'grpc',
        port: address.port,
        upstream: listener.upstream,
      });
      resolve({
        name: listener.name,
        port: address.port,
        address: address.address,
        activeConnections: () => sessions.size,
        close: () =>
          new Promise<void>((res) => {
            for (const session of sessions) session.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
