import type { HeaderMap } from '../rules/matcher.js';
import { deleteHeader, setHeader } from './headers.js';

/** Script manipulator patch for HTTP responses (spec 4.5.6). */
export interface HttpResponsePatch {
  statusCode?: number;
  headers?: Record<string, string | string[] | null>;
  body?: string;
  rawBodyBase64?: string;
}

/** Script manipulator patch for gRPC responses (spec 4.5.6). */
export interface GrpcResponsePatch {
  metadata?: Record<string, string | string[] | null>;
  messages?: unknown[];
  grpcStatus?: number;
  grpcMessage?: string;
  trailers?: Record<string, string | string[] | null>;
}

export type ResponsePatch = HttpResponsePatch | GrpcResponsePatch;

export interface PatchableHttpResponse {
  statusCode: number;
  headers: HeaderMap;
  body?: Buffer;
}

export interface PatchOutcome {
  changed: boolean;
  bodyChanged: boolean;
  /** Field names ignored because they do not apply to the protocol. */
  ignoredFields: string[];
}

export class InvalidPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPatchError';
  }
}

function applyHeaderPatch(
  headers: HeaderMap,
  patch: Record<string, string | string[] | null>,
): boolean {
  let changed = false;
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) {
      if (deleteHeader(headers, name)) changed = true;
    } else {
      setHeader(headers, name, value);
      changed = true;
    }
  }
  return changed;
}

/**
 * Applies a script manipulator patch to a buffered HTTP response. Fields not
 * present keep the upstream values (spec 4.5.6). gRPC-only fields are ignored
 * with a warning. Returning both body and rawBodyBase64 is an error.
 */
export function applyHttpResponsePatch(
  response: PatchableHttpResponse,
  patch: Record<string, unknown>,
): PatchOutcome {
  if (patch['body'] !== undefined && patch['rawBodyBase64'] !== undefined) {
    throw new InvalidPatchError('patch must not set both body and rawBodyBase64');
  }
  const outcome: PatchOutcome = { changed: false, bodyChanged: false, ignoredFields: [] };
  for (const field of ['metadata', 'messages', 'grpcStatus', 'grpcMessage', 'trailers']) {
    if (patch[field] !== undefined) outcome.ignoredFields.push(field);
  }
  const statusCode = patch['statusCode'];
  if (statusCode !== undefined) {
    if (
      typeof statusCode !== 'number' ||
      !Number.isInteger(statusCode) ||
      statusCode < 100 ||
      statusCode > 599
    ) {
      throw new InvalidPatchError('patch statusCode must be an integer 100-599');
    }
    if (statusCode !== response.statusCode) {
      response.statusCode = statusCode;
      outcome.changed = true;
    }
  }
  const headers = patch['headers'];
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new InvalidPatchError('patch headers must be an object');
    }
    for (const value of Object.values(headers)) {
      const ok =
        value === null ||
        typeof value === 'string' ||
        (Array.isArray(value) && value.every((v) => typeof v === 'string'));
      if (!ok) throw new InvalidPatchError('patch header values must be string, string[], or null');
    }
    if (applyHeaderPatch(response.headers, headers as Record<string, string | string[] | null>)) {
      outcome.changed = true;
    }
  }
  const body = patch['body'];
  if (body !== undefined) {
    if (typeof body !== 'string') throw new InvalidPatchError('patch body must be a string');
    response.body = Buffer.from(body, 'utf8');
    outcome.changed = true;
    outcome.bodyChanged = true;
  }
  const rawBody = patch['rawBodyBase64'];
  if (rawBody !== undefined) {
    if (typeof rawBody !== 'string') {
      throw new InvalidPatchError('patch rawBodyBase64 must be a string');
    }
    response.body = Buffer.from(rawBody, 'base64');
    outcome.changed = true;
    outcome.bodyChanged = true;
  }
  return outcome;
}
