import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { HeaderMap } from '../rules/matcher.js';

/** Hop-by-hop headers stripped when forwarding (RFC 9110, spec 4.1.1). */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Converts Node's incoming headers to a HeaderMap, dropping pseudo-headers. */
export function fromNodeHeaders(raw: IncomingHttpHeaders): HeaderMap {
  const headers: HeaderMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || name.startsWith(':')) continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * Returns a copy without hop-by-hop headers, including any header named by
 * the Connection header itself.
 */
export function stripHopByHop(headers: HeaderMap): HeaderMap {
  const extra = new Set<string>();
  const connection = headers['connection'];
  if (connection !== undefined) {
    const tokens = Array.isArray(connection) ? connection.join(',') : connection;
    for (const token of tokens.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') extra.add(name);
    }
  }
  const result: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || extra.has(lower)) continue;
    result[name] = value;
  }
  return result;
}

export function toOutgoingHeaders(headers: HeaderMap): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value;
  }
  return out;
}

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Case-insensitive delete; returns true when something was removed. */
export function deleteHeader(headers: HeaderMap, name: string): boolean {
  const lower = name.toLowerCase();
  let removed = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
      removed = true;
    }
  }
  return removed;
}

/** Case-insensitive set: removes any existing casing first. */
export function setHeader(headers: HeaderMap, name: string, value: string | string[]): void {
  deleteHeader(headers, name);
  headers[name.toLowerCase()] = value;
}
