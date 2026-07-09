// Thin client for the morpheus admin API. The base path is derived from the
// URL the SPA is served under (default /_morpheus).

function deriveBase(): string {
  const marker = '/_morpheus';
  const { pathname } = window.location;
  const index = pathname.indexOf(marker);
  if (index >= 0) return pathname.slice(0, index + marker.length);
  // dev server serves the app at / but proxies /_morpheus/api
  return marker;
}

export const BASE_PATH = deriveBase();
export const API = `${BASE_PATH}/api/v1`;

export interface ApiErrorShape {
  error: { code: string; message: string; details?: Array<{ path?: string; reason: string; message?: string }> };
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = data as ApiErrorShape | undefined;
    throw new ApiRequestError(
      res.status,
      err?.error?.code ?? 'error',
      err?.error?.message ?? res.statusText,
      err?.error?.details,
    );
  }
  return data as T;
}

// ---- types (mirrors of server shapes, kept loose on purpose)
export interface RuleState {
  ruleId: string;
  hits: number;
  consumed: number;
  remaining: number | null;
  lastMatchedAt: string | null;
}

export interface Rule {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  protocol: 'http' | 'grpc';
  match: unknown;
  request?: unknown;
  response?: unknown;
  consume?: { times: number; resetAfterMs?: number };
  logging: { capture: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface RuleListItem {
  rule: Rule;
  state: RuleState;
}

export interface LogEntry {
  id: string;
  startedAt: string;
  durationMs: number;
  protocol: string;
  outcome: string;
  loggingReason: string;
  request: { method?: string; path?: string; headers: Record<string, unknown>; bodyLogged: boolean; bodyPreview?: string };
  response: { statusCode?: number; grpcStatus?: number; headers: Record<string, unknown>; bodyLogged: boolean; bodyPreview?: string };
  forwardedRequest?: { modified: boolean; bodyPreview?: string };
  upstreamResponse?: { received: boolean; bodyPreview?: string; statusCode?: number; grpcStatus?: number };
  matchedRules: Array<{ id: string; action: string; consumed: boolean; remaining?: number }>;
  ruleErrors?: Array<{ ruleId: string; stage: string; error: string }>;
  timing?: { upstreamDurationMs?: number; delayMs?: number; delaySkipped?: boolean };
}

export const api = {
  status: () => request<Record<string, unknown>>('/status'),
  metrics: () => request<Record<string, unknown>>('/metrics'),

  listRules: () => request<{ revision: number; items: RuleListItem[] }>('/rules'),
  getRule: (id: string) => request<RuleListItem>(`/rules/${encodeURIComponent(id)}`),
  createRule: (rule: unknown) =>
    request<{ rule: Rule; warnings: unknown[]; revision: number }>('/rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  updateRule: (id: string, rule: unknown, expectedRevision: number) =>
    request<{ rule: Rule; revision: number }>(
      `/rules/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`,
      { method: 'PUT', body: JSON.stringify(rule) },
    ),
  deleteRule: (id: string, expectedRevision: number) =>
    request<{ deleted: string; revision: number }>(
      `/rules/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`,
      { method: 'DELETE' },
    ),
  disableAll: (expectedRevision: number) =>
    request<{ disabled: number; revision: number }>(
      `/rules:disable-all?expectedRevision=${expectedRevision}`,
      { method: 'POST' },
    ),
  validateRule: (rule: unknown) =>
    request<{ valid: boolean; errors: unknown[]; warnings: unknown[] }>('/rules:validate', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  simulate: (payload: unknown) =>
    request<{ results: unknown[]; draftWarnings: unknown[] }>('/rules:simulate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  exportRules: (ids?: string[]) =>
    request<{ formatVersion: number; rules: Rule[] }>('/rules:export', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    }),
  importRules: (payload: unknown) =>
    request<{ imported: number; revision: number }>('/rules:import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  resetState: (id: string) =>
    request<RuleState>(`/rules/${encodeURIComponent(id)}/state:reset`, { method: 'POST' }),

  listLogs: (query: string) =>
    request<{ items: LogEntry[]; nextCursor: string | null }>(`/logs${query}`),
  getLog: (id: string) => request<LogEntry>(`/logs/${encodeURIComponent(id)}`),
  clearLogs: () => request<{ removed: number }>('/logs', { method: 'DELETE' }),

  getMask: () => request<{ headers: string[]; jsonPaths: string[] }>('/logging/mask'),
  setMask: (mask: { headers: string[]; jsonPaths: string[] }) =>
    request<{ headers: string[]; jsonPaths: string[] }>('/logging/mask', {
      method: 'PUT',
      body: JSON.stringify(mask),
    }),

  listDescriptors: () => request<{ items: Array<Record<string, unknown>> }>('/grpc/descriptors'),
  addDescriptor: (payload: { name: string; format: string; content: string }) =>
    request<Record<string, unknown>>('/grpc/descriptors', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteDescriptor: (id: string) =>
    request<{ deleted: string }>(`/grpc/descriptors/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  logEventsUrl: () => `${API}/logs/events`,
  logBodyUrl: (id: string, side: 'request' | 'response', variant?: string) =>
    `${API}/logs/${encodeURIComponent(id)}/${side}${variant ? `?variant=${variant}` : ''}`,
};
