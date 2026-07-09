// Rule templates (spec 5.7.1). Each returns a rule draft object ready for the
// editor; parameters are filled in by the UI before saving.

export interface TemplateParam {
  key: string;
  label: string;
  default: string;
}

export interface RuleTemplate {
  id: string;
  name: string;
  params: TemplateParam[];
  build: (values: Record<string, string>) => unknown;
}

const escapePath = (p: string): string => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const TEMPLATES: RuleTemplate[] = [
  {
    id: 'http-5xx-n',
    name: 'HTTP 5xx for first N requests',
    params: [
      { key: 'path', label: 'Path prefix', default: '/users' },
      { key: 'status', label: 'Status code', default: '503' },
      { key: 'n', label: 'Times', default: '3' },
    ],
    build: (v) => ({
      name: `HTTP ${v.status} for first ${v.n}`,
      protocol: 'http',
      priority: 100,
      match: { type: 'regex', field: 'path', pattern: `^${escapePath(v.path ?? '')}` },
      request: {
        action: {
          type: 'fault',
          fault: { kind: 'http_response', statusCode: Number(v.status), body: '{"error":"injected"}' },
        },
      },
      consume: { times: Number(v.n) },
    }),
  },
  {
    id: 'grpc-unavailable-n',
    name: 'gRPC UNAVAILABLE for first N requests',
    params: [
      { key: 'service', label: 'Service', default: 'demo.TimeService' },
      { key: 'method', label: 'Method', default: 'Now' },
      { key: 'n', label: 'Times', default: '3' },
    ],
    build: (v) => ({
      name: `gRPC UNAVAILABLE for first ${v.n}`,
      protocol: 'grpc',
      priority: 100,
      match: {
        type: 'all',
        conditions: [
          { type: 'regex', field: 'grpc.service', pattern: `^${escapePath(v.service ?? '')}$` },
          { type: 'regex', field: 'grpc.method', pattern: `^${escapePath(v.method ?? '')}$` },
        ],
      },
      request: {
        action: { type: 'fault', fault: { kind: 'grpc_status', status: 14, message: 'injected unavailable' } },
      },
      consume: { times: Number(v.n) },
    }),
  },
  {
    id: 'delay-fixed',
    name: 'Delay response (fixed)',
    params: [
      { key: 'path', label: 'Path prefix', default: '/' },
      { key: 'ms', label: 'Duration (ms)', default: '500' },
    ],
    build: (v) => ({
      name: `Delay ${v.ms}ms`,
      protocol: 'http',
      match: { type: 'regex', field: 'path', pattern: `^${escapePath(v.path ?? '')}` },
      response: { delay: { durationMs: Number(v.ms) } },
    }),
  },
  {
    id: 'delay-total',
    name: 'Delay response (total, for client timeout tests)',
    params: [
      { key: 'path', label: 'Path prefix', default: '/' },
      { key: 'ms', label: 'Total duration (ms)', default: '3000' },
    ],
    build: (v) => ({
      name: `Total delay ${v.ms}ms`,
      protocol: 'http',
      match: { type: 'regex', field: 'path', pattern: `^${escapePath(v.path ?? '')}` },
      response: { delay: { durationMs: Number(v.ms), mode: 'total' } },
    }),
  },
  {
    id: 'replace-header',
    name: 'Replace response header',
    params: [
      { key: 'path', label: 'Path prefix', default: '/' },
      { key: 'header', label: 'Header name', default: 'x-data-source' },
      { key: 'from', label: 'From (regex)', default: '^real-(.*)$' },
      { key: 'to', label: 'To', default: 'mock-$1' },
    ],
    build: (v) => ({
      name: `Replace ${v.header}`,
      protocol: 'http',
      match: { type: 'regex', field: 'path', pattern: `^${escapePath(v.path ?? '')}` },
      response: {
        action: { type: 'response_replace', target: `header.${v.header}`, from: v.from, to: v.to },
      },
    }),
  },
  {
    id: 'mock-json',
    name: 'Mock JSON response',
    params: [
      { key: 'path', label: 'Path prefix', default: '/users' },
      { key: 'status', label: 'Status', default: '200' },
      { key: 'body', label: 'JSON body', default: '{"name":"mock-user"}' },
    ],
    build: (v) => ({
      name: `Mock ${v.path}`,
      protocol: 'http',
      match: { type: 'regex', field: 'path', pattern: `^${escapePath(v.path ?? '')}` },
      request: {
        action: {
          type: 'mock_response',
          response: {
            statusCode: Number(v.status),
            headers: { 'content-type': 'application/json' },
            body: v.body,
          },
        },
      },
    }),
  },
  {
    id: 'mock-grpc',
    name: 'Mock gRPC unary response (needs descriptor)',
    params: [
      { key: 'service', label: 'Service', default: 'demo.TimeService' },
      { key: 'method', label: 'Method', default: 'Now' },
      { key: 'message', label: 'JSON message', default: '{"iso":"mock-time"}' },
    ],
    build: (v) => ({
      name: `Mock gRPC ${v.method}`,
      protocol: 'grpc',
      match: { type: 'regex', field: 'path', pattern: `^/${escapePath(v.service ?? '')}/${escapePath(v.method ?? '')}$` },
      request: {
        action: {
          type: 'mock_response',
          response: { grpcStatus: 0, messages: [safeJson(v.message)] },
        },
      },
    }),
  },
  {
    id: 'capture',
    name: 'Capture traffic',
    params: [{ key: 'path', label: 'Path prefix', default: '/' }],
    build: (v) => ({
      name: `Capture ${v.path}`,
      protocol: 'http',
      priority: 10,
      match: { type: 'regex', field: 'path', pattern: `^${escapePath(v.path ?? '')}` },
      logging: { capture: true },
    }),
  },
];

function safeJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    return {};
  }
}
