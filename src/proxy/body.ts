import { PassThrough, type Readable } from 'node:stream';
import { matcherUsesBody } from '../rules/matcher.js';
import type { Matcher, Rule } from '../rules/types.js';

/** Splices an already-consumed prefix back in front of the remaining stream. */
export function concatStream(prefix: Buffer, rest: Readable): Readable {
  const out = new PassThrough();
  out.write(prefix);
  rest.pipe(out);
  rest.on('error', (err) => out.destroy(err));
  rest.resume();
  return out;
}

export interface BodyInterest {
  /** Some matcher/action needs the body content to work (matcher, replace_body, script). */
  need: boolean;
  /** The body should be persisted when logged (capture / intercept). */
  want: boolean;
}

function matcherHasScript(matcher: Matcher): boolean {
  switch (matcher.type) {
    case 'script':
      return true;
    case 'all':
    case 'any':
      return matcher.conditions.some(matcherHasScript);
    case 'not':
      return matcherHasScript(matcher.condition);
    default:
      return false;
  }
}

function ruleNeedsRequestBody(rule: Rule): boolean {
  if (matcherUsesBody(rule.match) || matcherHasScript(rule.match)) return true;
  if (rule.request?.action?.type === 'request_rewrite') {
    return rule.request.action.operations.some((op) => op.op === 'replace_body');
  }
  return false;
}

function ruleNeedsResponseBody(rule: Rule): boolean {
  const response = rule.response;
  if (!response) return false;
  if (response.match && (matcherUsesBody(response.match) || matcherHasScript(response.match))) {
    return true;
  }
  return response.action?.type === 'script_manipulator';
}

/** Decides request-body buffering interest across the active rules (spec 4.8.3). */
export function requestBodyInterest(rules: Rule[]): BodyInterest {
  let need = false;
  let want = false;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (ruleNeedsRequestBody(rule)) need = true;
    if (rule.logging.capture || rule.request !== undefined || rule.response !== undefined) {
      want = true;
    }
    if (need) break;
  }
  return { need, want: want || need };
}

/** Response-body interest given the rules that actually matched. */
export function responseBodyInterest(interceptRule: Rule | null, captureRules: Rule[]): BodyInterest {
  const need = interceptRule !== null && ruleNeedsResponseBody(interceptRule);
  const want =
    need ||
    interceptRule !== null ||
    captureRules.some((rule) => rule.logging.capture);
  return { need, want };
}

export type BodyReadResult =
  | { complete: true; buffer: Buffer }
  | { complete: false; prefix: Buffer };

/**
 * Reads a stream up to limitBytes (spec 4.8.3: without content-length, count
 * while reading). On overflow the stream is paused and the consumed prefix is
 * returned so the caller can splice it back for passthrough.
 */
export function readBodyUpTo(stream: Readable, limitBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > limitBytes) {
        cleanup();
        stream.pause();
        resolve({ complete: false, prefix: Buffer.concat(chunks) });
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve({ complete: true, buffer: Buffer.concat(chunks) });
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

export class BodyLimitExceededError extends Error {
  constructor(readonly limitBytes: number) {
    super(`body exceeds the ${limitBytes} byte buffer limit`);
    this.name = 'BodyLimitExceededError';
  }
}

/**
 * Reads a stream fully into a buffer, aborting once `limitBytes` is
 * exceeded (spec 4.8.3). The caller must have checked content-length first
 * where available.
 */
export function readBodyWithLimit(stream: Readable, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > limitBytes) {
        cleanup();
        stream.pause();
        reject(new BodyLimitExceededError(limitBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** Parses content-length; returns undefined when absent or invalid. */
export function contentLengthOf(headers: Record<string, string | string[]>): number | undefined {
  const raw = headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
