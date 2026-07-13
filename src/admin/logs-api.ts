import type { ServerResponse } from 'node:http';
import type { BodyKind, LogFilter, Outcome, TrafficLogEntry } from '../logging/traffic-log.js';
import { ApiError, queryInt, sendJson } from './http-util.js';
import type { AdminContext } from './server.js';

const OUTCOMES: Outcome[] = [
  'captured',
  'mock',
  'fault',
  'modified',
  'delayed',
  'upstream_error',
  'rule_error',
  'client_aborted',
];

export function parseLogFilter(params: URLSearchParams): LogFilter {
  const filter: LogFilter = {};
  const protocol = params.get('protocol');
  if (protocol !== null) {
    if (protocol !== 'http' && protocol !== 'grpc') {
      throw new ApiError(400, 'invalid_query', 'protocol must be http or grpc');
    }
    filter.protocol = protocol;
  }
  const outcome = params.get('outcome');
  if (outcome !== null) {
    if (!OUTCOMES.includes(outcome as Outcome)) {
      throw new ApiError(400, 'invalid_query', `outcome must be one of ${OUTCOMES.join(', ')}`);
    }
    filter.outcome = outcome as Outcome;
  }
  for (const key of ['method', 'path', 'grpcService', 'grpcMethod', 'ruleId', 'from', 'to', 'contains'] as const) {
    const value = params.get(key);
    if (value !== null) filter[key] = value;
  }
  const statusCode = queryInt(params, 'statusCode');
  if (statusCode !== undefined) filter.statusCode = statusCode;
  const grpcStatus = queryInt(params, 'grpcStatus');
  if (grpcStatus !== undefined) filter.grpcStatus = grpcStatus;
  return filter;
}

export function listLogs(ctx: AdminContext, params: URLSearchParams): unknown {
  const filter = parseLogFilter(params);
  const limit = Math.min(queryInt(params, 'limit') ?? 50, 200);
  const cursor = params.get('cursor') ?? undefined;
  const result = ctx.trafficLog.list(filter, limit, cursor);
  return { items: result.items, nextCursor: result.nextCursor };
}

export function getLog(ctx: AdminContext, id: string): TrafficLogEntry {
  const entry = ctx.trafficLog.get(id);
  if (!entry) throw new ApiError(404, 'log_not_found', `log "${id}" does not exist`);
  return entry;
}

function bodyKindFor(side: 'request' | 'response', variant: string | null): BodyKind {
  if (side === 'request') {
    if (variant === null || variant === 'original') return 'request';
    if (variant === 'forwarded') return 'forwarded-request';
    throw new ApiError(400, 'invalid_query', 'variant must be "original" or "forwarded"');
  }
  if (variant === null || variant === 'returned') return 'response';
  if (variant === 'upstream') return 'upstream-response';
  throw new ApiError(400, 'invalid_query', 'variant must be "returned" or "upstream"');
}

export async function sendLogBody(
  ctx: AdminContext,
  res: ServerResponse,
  id: string,
  side: 'request' | 'response',
  params: URLSearchParams,
): Promise<void> {
  const entry = getLog(ctx, id);
  const kind = bodyKindFor(side, params.get('variant'));
  const body = await ctx.trafficLog.readBody(id, kind);
  if (body === null) {
    const message = side === 'request' ? entry.request : entry.response;
    sendJson(res, 200, {
      id,
      kind,
      bodyLogged: false,
      ...(message.bodyLoggingSkippedReason !== undefined
        ? { bodyLoggingSkippedReason: message.bodyLoggingSkippedReason }
        : {}),
      metadata: message,
    });
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': body.byteLength,
    'x-morpheus-log-id': id,
    'x-morpheus-body-kind': kind,
  });
  res.end(body);
}

/** Self-contained JSON export of one log entry (spec 4.2.8 / 6.2). */
export async function exportLog(ctx: AdminContext, id: string): Promise<unknown> {
  const entry = getLog(ctx, id);
  const bodies: Record<string, string> = {};
  for (const kind of ctx.trafficLog.bodyKindsOf(id)) {
    const body = await ctx.trafficLog.readBody(id, kind);
    if (body !== null) bodies[kind] = body.toString('base64');
  }
  return { formatVersion: 1, exportedAt: new Date().toISOString(), entry, bodies };
}

export function deleteLogs(ctx: AdminContext): unknown {
  const removed = ctx.trafficLog.clear();
  ctx.appLog.info('traffic logs cleared', { removed });
  return { removed };
}

/** SSE stream of new traffic log entries (spec 4.2.8). */
export function streamLogEvents(ctx: AdminContext, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const unsubscribe = ctx.trafficLog.onEvent((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15_000);
  res.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}
