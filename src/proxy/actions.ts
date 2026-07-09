import { setTimeout as sleep } from 'node:timers/promises';
import type { HeaderMap } from '../rules/matcher.js';
import type { Delay, ResponseReplaceAction, RewriteOperation } from '../rules/types.js';
import { deleteHeader, setHeader } from './headers.js';

export interface RewritableRequest {
  path: string;
  query: string;
  headers: HeaderMap;
  body?: Buffer;
}

export interface RewriteResult {
  modified: boolean;
  bodyModified: boolean;
}

/** Applies request_rewrite operations in order, mutating the request (spec 4.5.4). */
export function applyRewriteOperations(
  request: RewritableRequest,
  operations: RewriteOperation[],
): RewriteResult {
  let modified = false;
  let bodyModified = false;
  for (const operation of operations) {
    switch (operation.op) {
      case 'set_header':
        setHeader(request.headers, operation.name, operation.value);
        modified = true;
        break;
      case 'remove_header':
        if (deleteHeader(request.headers, operation.name)) modified = true;
        break;
      case 'set_path':
        if (request.path !== operation.value) {
          request.path = operation.value;
          modified = true;
        }
        break;
      case 'set_query':
        if (request.query !== operation.value) {
          request.query = operation.value;
          modified = true;
        }
        break;
      case 'replace_body': {
        if (request.body === undefined) break;
        const text = request.body.toString('utf8');
        const replaced = text.replace(new RegExp(operation.from, 'g'), operation.to);
        if (replaced !== text) {
          request.body = Buffer.from(replaced, 'utf8');
          modified = true;
          bodyModified = true;
        }
        break;
      }
    }
  }
  return { modified, bodyModified };
}

/**
 * Applies a response_replace header regex substitution (spec 4.5.5).
 * Returns true when any header value changed; missing headers are a no-op.
 */
export function applyResponseReplace(headers: HeaderMap, action: ResponseReplaceAction): boolean {
  const name = action.target.slice('header.'.length).toLowerCase();
  const current = headers[name];
  if (current === undefined) return false;
  const regex = new RegExp(action.from, 'g');
  if (Array.isArray(current)) {
    const replaced = current.map((value) => value.replace(regex, action.to));
    if (replaced.every((value, i) => value === current[i])) return false;
    headers[name] = replaced;
    return true;
  }
  const replaced = current.replace(regex, action.to);
  if (replaced === current) return false;
  headers[name] = replaced;
  return true;
}

export interface DelayPlan {
  waitMs: number;
  /** True when total-mode delay was already exceeded by real elapsed time. */
  skipped: boolean;
}

/**
 * Computes the wait for a delay setting (spec 4.5.1). For `total` mode,
 * elapsedMs is the time since the proxy accepted the request.
 */
export function computeDelay(delay: Delay, elapsedMs: number): DelayPlan {
  if (delay.mode === 'total') {
    const waitMs = Math.max(0, delay.durationMs - elapsedMs);
    return { waitMs, skipped: waitMs === 0 };
  }
  return { waitMs: delay.durationMs, skipped: false };
}

export async function applyDelay(delay: Delay, elapsedMs: number): Promise<DelayPlan> {
  const plan = computeDelay(delay, elapsedMs);
  if (plan.waitMs > 0) await sleep(plan.waitMs);
  return plan;
}
