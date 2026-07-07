import type { IncomingMessage, ServerResponse } from 'node:http';

export const ADMIN_BODY_LIMIT = 5 * 1024 * 1024;

export interface ApiErrorDetail {
  path?: string;
  reason: string;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.byteLength,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: ApiError): void {
  sendJson(res, error.status, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > ADMIN_BODY_LIMIT) {
      throw new ApiError(400, 'request_too_large', 'admin request body exceeds 5 MiB');
    }
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

export function queryInt(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, 'invalid_query', `${name} must be a non-negative integer`);
  }
  return value;
}
