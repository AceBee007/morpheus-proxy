import type { HeaderMap } from '../rules/matcher.js';

export interface MaskSettings {
  headers: string[];
  jsonPaths: string[];
}

export const MASKED_VALUE = '***';

type JsonContainer = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is JsonContainer {
  return typeof value === 'object' && value !== null;
}

function applyPath(node: unknown, segments: string[]): void {
  if (!isContainer(node) || segments.length === 0) return;
  // Arrays are transparent: the same path applies to every element.
  if (Array.isArray(node)) {
    for (const item of node) applyPath(item, segments);
    return;
  }
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const record = node as Record<string, unknown>;
  const keys = head === '*' ? Object.keys(record) : head in record ? [head] : [];
  for (const key of keys) {
    if (rest.length === 0) {
      record[key] = MASKED_VALUE;
    } else {
      applyPath(record[key], rest);
    }
  }
}

/**
 * Holds the active mask settings (spec 4.9.5). Loaded from config at startup
 * and editable at runtime via the masking API; changes are in-memory only.
 */
export class MaskRegistry {
  private headers: Set<string>;
  private jsonPaths: string[][];
  private rawJsonPaths: string[];

  constructor(settings: MaskSettings) {
    this.headers = new Set();
    this.jsonPaths = [];
    this.rawJsonPaths = [];
    this.set(settings);
  }

  get(): MaskSettings {
    return { headers: [...this.headers], jsonPaths: [...this.rawJsonPaths] };
  }

  set(settings: MaskSettings): void {
    this.headers = new Set(settings.headers.map((h) => h.toLowerCase()));
    this.rawJsonPaths = settings.jsonPaths.filter((p) => p.startsWith('$.') && p.length > 2);
    this.jsonPaths = this.rawJsonPaths.map((p) => p.slice(2).split('.'));
  }

  maskHeaders(headers: HeaderMap): HeaderMap {
    const masked: HeaderMap = {};
    for (const [name, value] of Object.entries(headers)) {
      if (this.headers.has(name.toLowerCase())) {
        masked[name] = Array.isArray(value) ? value.map(() => MASKED_VALUE) : MASKED_VALUE;
      } else {
        masked[name] = value;
      }
    }
    return masked;
  }

  /**
   * Masks a JSON text body. Non-JSON bodies are returned untouched — raw
   * body files are never masked; exposure is limited by the body log policy
   * (spec 4.9.5).
   */
  maskJsonText(body: string): string {
    if (this.jsonPaths.length === 0) return body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body;
    }
    if (!isContainer(parsed)) return body;
    for (const path of this.jsonPaths) applyPath(parsed, path);
    return JSON.stringify(parsed);
  }

  /** Masks an already-decoded JSON value in place (gRPC decoded bodies). */
  maskJsonValue(value: unknown): void {
    for (const path of this.jsonPaths) applyPath(value, path);
  }
}
