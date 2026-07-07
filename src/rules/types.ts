export type Protocol = 'http' | 'grpc';
export type Stage = 'request' | 'response';

// ---------------------------------------------------------------------------
// Matcher

export interface RegexMatcher {
  type: 'regex';
  field: string;
  pattern: string;
  flags?: string;
}

export interface AllMatcher {
  type: 'all';
  conditions: Matcher[];
}

export interface AnyMatcher {
  type: 'any';
  conditions: Matcher[];
}

export interface NotMatcher {
  type: 'not';
  condition: Matcher;
}

export interface ScriptMatcher {
  type: 'script';
  language: 'javascript';
  source: string;
  timeoutMs?: number;
}

export type Matcher = RegexMatcher | AllMatcher | AnyMatcher | NotMatcher | ScriptMatcher;

// ---------------------------------------------------------------------------
// Actions

export interface Delay {
  durationMs: number;
  /** `total` is only valid on the response stage (spec 4.5.1). */
  mode?: 'fixed' | 'total';
}

export interface HttpMockResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface GrpcMockResponse {
  grpcStatus?: number;
  grpcMessage?: string;
  messages?: unknown[];
  metadata?: Record<string, string>;
}

export interface MockResponseAction {
  type: 'mock_response';
  response: HttpMockResponse & GrpcMockResponse;
}

export type FaultSpec =
  | {
      kind: 'http_response';
      statusCode: number;
      headers?: Record<string, string>;
      body?: string;
    }
  | {
      kind: 'grpc_status';
      status: number;
      message?: string;
      metadata?: Record<string, string>;
    }
  | { kind: 'connection'; mode: 'close' | 'reset' }
  | { kind: 'timeout'; durationMs?: number };

export interface FaultAction {
  type: 'fault';
  fault: FaultSpec;
}

export type RewriteOperation =
  | { op: 'set_header'; name: string; value: string }
  | { op: 'remove_header'; name: string }
  | { op: 'set_path'; value: string }
  | { op: 'set_query'; value: string }
  | { op: 'replace_body'; from: string; to: string };

export interface RequestRewriteAction {
  type: 'request_rewrite';
  operations: RewriteOperation[];
}

export interface ResponseReplaceAction {
  type: 'response_replace';
  /** Only `header.<name>` targets are supported (spec 4.5.5). */
  target: string;
  from: string;
  to: string;
}

export interface ScriptManipulatorAction {
  type: 'script_manipulator';
  language: 'javascript';
  source: string;
  timeoutMs?: number;
}

export type RequestAction = MockResponseAction | FaultAction | RequestRewriteAction;
export type ResponseAction = FaultAction | ResponseReplaceAction | ScriptManipulatorAction;

export interface RequestStage {
  delay?: Delay;
  action?: RequestAction;
}

export interface ResponseStage {
  match?: Matcher;
  delay?: Delay;
  action?: ResponseAction;
}

// ---------------------------------------------------------------------------
// Rule

export interface ConsumeSpec {
  /** Number of times the rule applies before it is exhausted. */
  times: number;
  /** Reset the counter this long after the last consumption. */
  resetAfterMs?: number;
}

export interface RuleLogging {
  capture: boolean;
}

export interface Rule {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  protocol: Protocol;
  match: Matcher;
  request?: RequestStage;
  response?: ResponseStage;
  consume?: ConsumeSpec;
  logging: RuleLogging;
  createdAt: string;
  updatedAt: string;
}

/** A rule with neither request nor response stage only captures traffic. */
export function isObservationRule(rule: Rule): boolean {
  return rule.request === undefined && rule.response === undefined;
}

/** Terminal request actions never forward to the upstream (spec 4.3.2). */
export function isTerminalRequestAction(action: RequestAction): boolean {
  return action.type === 'mock_response' || action.type === 'fault';
}
