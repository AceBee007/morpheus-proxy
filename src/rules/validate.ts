import { randomUUID } from 'node:crypto';
import { matcherUsesBody } from './matcher.js';
import {
  isTerminalRequestAction,
  type ConsumeSpec,
  type Delay,
  type FaultSpec,
  type Matcher,
  type Protocol,
  type RequestAction,
  type RequestStage,
  type ResponseAction,
  type ResponseStage,
  type RewriteOperation,
  type Rule,
  type Stage,
} from './types.js';

export interface RuleValidationIssue {
  path: string;
  reason: string;
  message: string;
}

export interface RuleValidationResult {
  rule?: Rule;
  errors: RuleValidationIssue[];
  warnings: RuleValidationIssue[];
}

export interface ValidateRuleOptions {
  /** Upper bound for script timeoutMs (config script.maxTimeoutMs). */
  scriptMaxTimeoutMs?: number;
  /**
   * Hook for gRPC message body validation against registered descriptors
   * (spec 4.7.3). When absent, rules carrying gRPC message bodies are
   * rejected because nothing can encode them.
   */
  grpcBodyValidator?: (rule: Rule) => RuleValidationIssue[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const REQUEST_FIELD_RULES: Record<string, Protocol[] | 'both'> = {
  method: ['http'],
  host: 'both',
  path: 'both',
  query: ['http'],
  body: 'both',
  rawBodyBase64: 'both',
  'grpc.service': ['grpc'],
  'grpc.method': ['grpc'],
};

const RESPONSE_FIELD_RULES: Record<string, Protocol[] | 'both'> = {
  status: ['http'],
  body: 'both',
  rawBodyBase64: 'both',
  'grpc.status': ['grpc'],
};

class Issues {
  errors: RuleValidationIssue[] = [];
  warnings: RuleValidationIssue[] = [];

  error(path: string, reason: string, message: string): void {
    this.errors.push({ path, reason, message });
  }

  warning(path: string, reason: string, message: string): void {
    this.warnings.push({ path, reason, message });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string');
}

function validRegex(pattern: string, flags: string | undefined): string | null {
  try {
    new RegExp(pattern, flags ?? '');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function parseMatcher(
  input: unknown,
  path: string,
  stage: Stage,
  protocol: Protocol,
  issues: Issues,
): Matcher | undefined {
  if (!isPlainObject(input)) {
    issues.error(path, 'invalid_matcher', 'matcher must be an object');
    return undefined;
  }
  const type = input['type'];
  switch (type) {
    case 'regex': {
      const field = input['field'];
      const pattern = input['pattern'];
      const flags = input['flags'];
      if (typeof field !== 'string' || field === '') {
        issues.error(`${path}.field`, 'invalid_field', 'field must be a non-empty string');
        return undefined;
      }
      if (typeof pattern !== 'string') {
        issues.error(`${path}.pattern`, 'invalid_pattern', 'pattern must be a string');
        return undefined;
      }
      if (flags !== undefined && typeof flags !== 'string') {
        issues.error(`${path}.flags`, 'invalid_flags', 'flags must be a string');
        return undefined;
      }
      const regexError = validRegex(pattern, flags);
      if (regexError !== null) {
        issues.error(`${path}.pattern`, 'invalid_regex', regexError);
        return undefined;
      }
      validateFieldForStage(field, path, stage, protocol, issues);
      return flags !== undefined
        ? { type: 'regex', field, pattern, flags }
        : { type: 'regex', field, pattern };
    }
    case 'all':
    case 'any': {
      const conditions = input['conditions'];
      if (!Array.isArray(conditions) || conditions.length === 0) {
        issues.error(
          `${path}.conditions`,
          'invalid_conditions',
          'conditions must be a non-empty array',
        );
        return undefined;
      }
      const parsed: Matcher[] = [];
      conditions.forEach((condition, i) => {
        const m = parseMatcher(condition, `${path}.conditions[${i}]`, stage, protocol, issues);
        if (m) parsed.push(m);
      });
      if (parsed.length !== conditions.length) return undefined;
      return { type, conditions: parsed };
    }
    case 'not': {
      const condition = parseMatcher(input['condition'], `${path}.condition`, stage, protocol, issues);
      if (!condition) return undefined;
      return { type: 'not', condition };
    }
    case 'script': {
      const language = input['language'];
      const source = input['source'];
      const timeoutMs = input['timeoutMs'];
      if (language !== 'javascript') {
        issues.error(`${path}.language`, 'invalid_language', 'language must be "javascript"');
        return undefined;
      }
      if (typeof source !== 'string' || source.trim() === '') {
        issues.error(`${path}.source`, 'invalid_source', 'source must be a non-empty string');
        return undefined;
      }
      if (timeoutMs === undefined) return { type: 'script', language, source };
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        issues.error(`${path}.timeoutMs`, 'invalid_timeout', 'timeoutMs must be a positive integer');
        return undefined;
      }
      return { type: 'script', language, source, timeoutMs };
    }
    default:
      issues.error(
        `${path}.type`,
        'invalid_matcher_type',
        'matcher type must be one of regex, all, any, not, script',
      );
      return undefined;
  }
}

function validateFieldForStage(
  field: string,
  path: string,
  stage: Stage,
  protocol: Protocol,
  issues: Issues,
): void {
  if (field.startsWith('header.')) {
    if (field.length <= 'header.'.length) {
      issues.error(`${path}.field`, 'invalid_field', 'header.<name> requires a header name');
    }
    return;
  }
  if (stage === 'response' && field.startsWith('grpc.trailer.')) {
    if (protocol !== 'grpc') {
      issues.error(`${path}.field`, 'field_protocol_mismatch', `${field} is only valid for grpc rules`);
    }
    return;
  }
  const table = stage === 'request' ? REQUEST_FIELD_RULES : RESPONSE_FIELD_RULES;
  const allowed = table[field];
  if (allowed === undefined) {
    issues.error(
      `${path}.field`,
      'invalid_field',
      `${field} is not a valid ${stage} matcher field`,
    );
    return;
  }
  if (allowed !== 'both' && !allowed.includes(protocol)) {
    issues.error(
      `${path}.field`,
      'field_protocol_mismatch',
      `${field} is only valid for ${allowed.join('/')} rules`,
    );
  }
}

function parseDelay(input: unknown, path: string, stage: Stage, issues: Issues): Delay | undefined {
  if (!isPlainObject(input)) {
    issues.error(path, 'invalid_delay', 'delay must be an object');
    return undefined;
  }
  const durationMs = input['durationMs'];
  const mode = input['mode'];
  if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs <= 0) {
    issues.error(`${path}.durationMs`, 'invalid_duration', 'durationMs must be a positive integer');
    return undefined;
  }
  if (mode !== undefined && mode !== 'fixed' && mode !== 'total') {
    issues.error(`${path}.mode`, 'invalid_delay_mode', 'mode must be "fixed" or "total"');
    return undefined;
  }
  if (mode === 'total' && stage === 'request') {
    issues.error(
      `${path}.mode`,
      'total_delay_on_request',
      'delay mode "total" is only valid on the response stage (spec 4.5.1)',
    );
    return undefined;
  }
  return mode !== undefined ? { durationMs, mode } : { durationMs };
}

function parseFault(
  input: unknown,
  path: string,
  protocol: Protocol,
  issues: Issues,
): FaultSpec | undefined {
  if (!isPlainObject(input)) {
    issues.error(path, 'invalid_fault', 'fault must be an object');
    return undefined;
  }
  const kind = input['kind'];
  switch (kind) {
    case 'http_response': {
      if (protocol !== 'http') {
        issues.error(`${path}.kind`, 'fault_protocol_mismatch', 'http_response fault requires protocol "http"');
        return undefined;
      }
      const statusCode = input['statusCode'];
      if (
        typeof statusCode !== 'number' ||
        !Number.isInteger(statusCode) ||
        statusCode < 100 ||
        statusCode > 599
      ) {
        issues.error(`${path}.statusCode`, 'invalid_status', 'statusCode must be an integer 100-599');
        return undefined;
      }
      const headers = input['headers'];
      if (headers !== undefined && !isStringRecord(headers)) {
        issues.error(`${path}.headers`, 'invalid_headers', 'headers must be a string map');
        return undefined;
      }
      const body = input['body'];
      if (body !== undefined && typeof body !== 'string') {
        issues.error(`${path}.body`, 'invalid_body', 'body must be a string');
        return undefined;
      }
      const spec: FaultSpec = { kind: 'http_response', statusCode };
      if (headers !== undefined) spec.headers = headers;
      if (body !== undefined) spec.body = body;
      return spec;
    }
    case 'grpc_status': {
      if (protocol !== 'grpc') {
        issues.error(`${path}.kind`, 'fault_protocol_mismatch', 'grpc_status fault requires protocol "grpc"');
        return undefined;
      }
      const status = input['status'];
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 16) {
        issues.error(`${path}.status`, 'invalid_grpc_status', 'status must be an integer 0-16');
        return undefined;
      }
      const message = input['message'];
      if (message !== undefined && typeof message !== 'string') {
        issues.error(`${path}.message`, 'invalid_message', 'message must be a string');
        return undefined;
      }
      const metadata = input['metadata'];
      if (metadata !== undefined && !isStringRecord(metadata)) {
        issues.error(`${path}.metadata`, 'invalid_metadata', 'metadata must be a string map');
        return undefined;
      }
      const spec: FaultSpec = { kind: 'grpc_status', status };
      if (message !== undefined) spec.message = message;
      if (metadata !== undefined) spec.metadata = metadata;
      return spec;
    }
    case 'connection': {
      const mode = input['mode'];
      if (mode !== 'close' && mode !== 'reset') {
        issues.error(`${path}.mode`, 'invalid_connection_mode', 'mode must be "close" or "reset"');
        return undefined;
      }
      return { kind: 'connection', mode };
    }
    case 'timeout': {
      const durationMs = input['durationMs'];
      if (durationMs === undefined) return { kind: 'timeout' };
      if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs <= 0) {
        issues.error(`${path}.durationMs`, 'invalid_duration', 'durationMs must be a positive integer');
        return undefined;
      }
      return { kind: 'timeout', durationMs };
    }
    default:
      issues.error(
        `${path}.kind`,
        'invalid_fault_kind',
        'fault kind must be one of http_response, grpc_status, connection, timeout',
      );
      return undefined;
  }
}

function parseScriptTimeout(
  input: Record<string, unknown>,
  path: string,
  issues: Issues,
  opts: ValidateRuleOptions,
): number | undefined | null {
  const timeoutMs = input['timeoutMs'];
  if (timeoutMs === undefined) return undefined;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    issues.error(`${path}.timeoutMs`, 'invalid_timeout', 'timeoutMs must be a positive integer');
    return null;
  }
  if (opts.scriptMaxTimeoutMs !== undefined && timeoutMs > opts.scriptMaxTimeoutMs) {
    issues.error(
      `${path}.timeoutMs`,
      'timeout_exceeds_max',
      `timeoutMs exceeds the configured maximum of ${opts.scriptMaxTimeoutMs}`,
    );
    return null;
  }
  return timeoutMs;
}

function parseRequestAction(
  input: unknown,
  path: string,
  protocol: Protocol,
  issues: Issues,
): RequestAction | undefined {
  if (!isPlainObject(input)) {
    issues.error(path, 'invalid_action', 'action must be an object');
    return undefined;
  }
  const type = input['type'];
  switch (type) {
    case 'mock_response': {
      const response = input['response'];
      if (!isPlainObject(response)) {
        issues.error(`${path}.response`, 'invalid_mock', 'response must be an object');
        return undefined;
      }
      if (protocol === 'http') {
        for (const key of ['grpcStatus', 'grpcMessage', 'messages', 'metadata']) {
          if (key in response) {
            issues.error(`${path}.response.${key}`, 'protocol_mismatch', `${key} is not valid for http rules`);
            return undefined;
          }
        }
        const statusCode = response['statusCode'] ?? 200;
        if (
          typeof statusCode !== 'number' ||
          !Number.isInteger(statusCode) ||
          statusCode < 100 ||
          statusCode > 599
        ) {
          issues.error(`${path}.response.statusCode`, 'invalid_status', 'statusCode must be an integer 100-599');
          return undefined;
        }
        const headers = response['headers'];
        if (headers !== undefined && !isStringRecord(headers)) {
          issues.error(`${path}.response.headers`, 'invalid_headers', 'headers must be a string map');
          return undefined;
        }
        const body = response['body'];
        if (body !== undefined && typeof body !== 'string') {
          issues.error(`${path}.response.body`, 'invalid_body', 'body must be a string');
          return undefined;
        }
        return {
          type: 'mock_response',
          response: {
            statusCode,
            ...(headers !== undefined ? { headers } : {}),
            ...(body !== undefined ? { body } : {}),
          },
        };
      }
      // grpc mock
      for (const key of ['statusCode', 'body']) {
        if (key in response) {
          issues.error(`${path}.response.${key}`, 'protocol_mismatch', `${key} is not valid for grpc rules`);
          return undefined;
        }
      }
      const grpcStatus = response['grpcStatus'] ?? 0;
      if (
        typeof grpcStatus !== 'number' ||
        !Number.isInteger(grpcStatus) ||
        grpcStatus < 0 ||
        grpcStatus > 16
      ) {
        issues.error(`${path}.response.grpcStatus`, 'invalid_grpc_status', 'grpcStatus must be an integer 0-16');
        return undefined;
      }
      const grpcMessage = response['grpcMessage'];
      if (grpcMessage !== undefined && typeof grpcMessage !== 'string') {
        issues.error(`${path}.response.grpcMessage`, 'invalid_message', 'grpcMessage must be a string');
        return undefined;
      }
      const messages = response['messages'];
      if (messages !== undefined && !Array.isArray(messages)) {
        issues.error(`${path}.response.messages`, 'invalid_messages', 'messages must be an array');
        return undefined;
      }
      const metadata = response['metadata'];
      if (metadata !== undefined && !isStringRecord(metadata)) {
        issues.error(`${path}.response.metadata`, 'invalid_metadata', 'metadata must be a string map');
        return undefined;
      }
      return {
        type: 'mock_response',
        response: {
          grpcStatus,
          ...(grpcMessage !== undefined ? { grpcMessage } : {}),
          ...(messages !== undefined ? { messages } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        },
      };
    }
    case 'fault': {
      const fault = parseFault(input['fault'], `${path}.fault`, protocol, issues);
      if (!fault) return undefined;
      return { type: 'fault', fault };
    }
    case 'request_rewrite': {
      const operations = input['operations'];
      if (!Array.isArray(operations) || operations.length === 0) {
        issues.error(`${path}.operations`, 'invalid_operations', 'operations must be a non-empty array');
        return undefined;
      }
      const parsed: RewriteOperation[] = [];
      for (let i = 0; i < operations.length; i++) {
        const op = parseRewriteOperation(operations[i], `${path}.operations[${i}]`, issues);
        if (!op) return undefined;
        if (protocol === 'grpc' && op.op !== 'set_header' && op.op !== 'remove_header') {
          issues.error(
            `${path}.operations[${i}]`,
            'grpc_rewrite_unsupported',
            'gRPC request_rewrite supports header operations only (spec 4.7.5)',
          );
          return undefined;
        }
        parsed.push(op);
      }
      return { type: 'request_rewrite', operations: parsed };
    }
    default:
      issues.error(
        `${path}.type`,
        'invalid_action_type',
        'request action must be one of mock_response, fault, request_rewrite',
      );
      return undefined;
  }
}

function parseRewriteOperation(
  input: unknown,
  path: string,
  issues: Issues,
): RewriteOperation | undefined {
  if (!isPlainObject(input)) {
    issues.error(path, 'invalid_operation', 'operation must be an object');
    return undefined;
  }
  const op = input['op'];
  switch (op) {
    case 'set_header': {
      const name = input['name'];
      const value = input['value'];
      if (typeof name !== 'string' || name === '' || typeof value !== 'string') {
        issues.error(path, 'invalid_operation', 'set_header requires string name and value');
        return undefined;
      }
      return { op: 'set_header', name, value };
    }
    case 'remove_header': {
      const name = input['name'];
      if (typeof name !== 'string' || name === '') {
        issues.error(path, 'invalid_operation', 'remove_header requires a string name');
        return undefined;
      }
      return { op: 'remove_header', name };
    }
    case 'set_path':
    case 'set_query': {
      const value = input['value'];
      if (typeof value !== 'string') {
        issues.error(path, 'invalid_operation', `${op} requires a string value`);
        return undefined;
      }
      return { op, value };
    }
    case 'replace_body': {
      const from = input['from'];
      const to = input['to'];
      if (typeof from !== 'string' || typeof to !== 'string') {
        issues.error(path, 'invalid_operation', 'replace_body requires string from and to');
        return undefined;
      }
      const regexError = validRegex(from, undefined);
      if (regexError !== null) {
        issues.error(`${path}.from`, 'invalid_regex', regexError);
        return undefined;
      }
      return { op: 'replace_body', from, to };
    }
    default:
      issues.error(
        `${path}.op`,
        'invalid_operation',
        'op must be one of set_header, remove_header, set_path, set_query, replace_body',
      );
      return undefined;
  }
}

function parseResponseAction(
  input: unknown,
  path: string,
  protocol: Protocol,
  issues: Issues,
  opts: ValidateRuleOptions,
): ResponseAction | undefined {
  if (!isPlainObject(input)) {
    issues.error(path, 'invalid_action', 'action must be an object');
    return undefined;
  }
  const type = input['type'];
  switch (type) {
    case 'fault': {
      const fault = parseFault(input['fault'], `${path}.fault`, protocol, issues);
      if (!fault) return undefined;
      return { type: 'fault', fault };
    }
    case 'response_replace': {
      const target = input['target'];
      const from = input['from'];
      const to = input['to'];
      if (typeof target !== 'string' || !/^header\..+$/.test(target)) {
        issues.error(
          `${path}.target`,
          'invalid_target',
          'target must be "header.<name>" (body/trailer changes require a script manipulator, spec 4.5.5)',
        );
        return undefined;
      }
      if (typeof from !== 'string' || typeof to !== 'string') {
        issues.error(path, 'invalid_replace', 'from and to must be strings');
        return undefined;
      }
      const regexError = validRegex(from, undefined);
      if (regexError !== null) {
        issues.error(`${path}.from`, 'invalid_regex', regexError);
        return undefined;
      }
      return { type: 'response_replace', target, from, to };
    }
    case 'script_manipulator': {
      const language = input['language'];
      const source = input['source'];
      if (language !== 'javascript') {
        issues.error(`${path}.language`, 'invalid_language', 'language must be "javascript"');
        return undefined;
      }
      if (typeof source !== 'string' || source.trim() === '') {
        issues.error(`${path}.source`, 'invalid_source', 'source must be a non-empty string');
        return undefined;
      }
      const timeoutMs = parseScriptTimeout(input, path, issues, opts);
      if (timeoutMs === null) return undefined;
      return timeoutMs !== undefined
        ? { type: 'script_manipulator', language, source, timeoutMs }
        : { type: 'script_manipulator', language, source };
    }
    default:
      issues.error(
        `${path}.type`,
        'invalid_action_type',
        'response action must be one of fault, response_replace, script_manipulator',
      );
      return undefined;
  }
}

function parseConsume(input: unknown, issues: Issues): ConsumeSpec | undefined {
  if (!isPlainObject(input)) {
    issues.error('consume', 'invalid_consume', 'consume must be an object');
    return undefined;
  }
  const times = input['times'];
  if (typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
    issues.error('consume.times', 'invalid_times', 'times must be an integer >= 1');
    return undefined;
  }
  const resetAfterMs = input['resetAfterMs'];
  if (resetAfterMs === undefined) return { times };
  if (typeof resetAfterMs !== 'number' || !Number.isInteger(resetAfterMs) || resetAfterMs <= 0) {
    issues.error('consume.resetAfterMs', 'invalid_reset', 'resetAfterMs must be a positive integer');
    return undefined;
  }
  return { times, resetAfterMs };
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return undefined;
}

/**
 * Validates and normalizes a rule definition (spec 4.3.1). Returns the
 * normalized rule when there are no errors; warnings never block.
 */
export function validateRule(input: unknown, opts: ValidateRuleOptions = {}): RuleValidationResult {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.error('', 'invalid_rule', 'rule must be an object');
    return { errors: issues.errors, warnings: issues.warnings };
  }

  const schemaVersionRaw = input['schemaVersion'] ?? 1;
  if (schemaVersionRaw !== 1) {
    issues.error('schemaVersion', 'unsupported_schema_version', 'only schemaVersion 1 is supported');
  }

  let id: string;
  const idRaw = input['id'];
  if (idRaw === undefined) {
    id = `rule-${randomUUID().slice(0, 8)}`;
  } else if (typeof idRaw === 'string' && ID_PATTERN.test(idRaw)) {
    id = idRaw;
  } else {
    issues.error('id', 'invalid_id', 'id must match ^[A-Za-z0-9_-]{1,128}$');
    id = '';
  }

  const name = typeof input['name'] === 'string' ? input['name'] : '';
  if (input['name'] !== undefined && typeof input['name'] !== 'string') {
    issues.error('name', 'invalid_name', 'name must be a string');
  }
  const description = typeof input['description'] === 'string' ? input['description'] : '';
  if (input['description'] !== undefined && typeof input['description'] !== 'string') {
    issues.error('description', 'invalid_description', 'description must be a string');
  }

  const enabledRaw = input['enabled'] ?? true;
  if (typeof enabledRaw !== 'boolean') {
    issues.error('enabled', 'invalid_enabled', 'enabled must be a boolean');
  }
  const enabled = enabledRaw === true;

  const priorityRaw = input['priority'] ?? 0;
  let priority = 0;
  if (typeof priorityRaw === 'number' && Number.isInteger(priorityRaw)) {
    priority = priorityRaw;
  } else {
    issues.error('priority', 'invalid_priority', 'priority must be an integer');
  }

  const protocolRaw = input['protocol'];
  if (protocolRaw !== 'http' && protocolRaw !== 'grpc') {
    issues.error('protocol', 'invalid_protocol', 'protocol must be "http" or "grpc"');
    return { errors: issues.errors, warnings: issues.warnings };
  }
  const protocol: Protocol = protocolRaw;

  const match = parseMatcher(input['match'], 'match', 'request', protocol, issues);

  let request: RequestStage | undefined;
  if (input['request'] !== undefined) {
    const raw = input['request'];
    if (!isPlainObject(raw)) {
      issues.error('request', 'invalid_stage', 'request must be an object');
    } else {
      const stage: RequestStage = {};
      if (raw['delay'] !== undefined) {
        const delay = parseDelay(raw['delay'], 'request.delay', 'request', issues);
        if (delay) stage.delay = delay;
      }
      if (raw['action'] !== undefined) {
        const action = parseRequestAction(raw['action'], 'request.action', protocol, issues);
        if (action) stage.action = action;
      }
      if (raw['delay'] === undefined && raw['action'] === undefined) {
        issues.error(
          'request',
          'empty_stage',
          'request must contain delay and/or action (spec 4.5)',
        );
      }
      request = stage;
    }
  }

  let response: ResponseStage | undefined;
  if (input['response'] !== undefined) {
    const raw = input['response'];
    if (!isPlainObject(raw)) {
      issues.error('response', 'invalid_stage', 'response must be an object');
    } else {
      const stage: ResponseStage = {};
      if (raw['match'] !== undefined) {
        const m = parseMatcher(raw['match'], 'response.match', 'response', protocol, issues);
        if (m) stage.match = m;
      }
      if (raw['delay'] !== undefined) {
        const delay = parseDelay(raw['delay'], 'response.delay', 'response', issues);
        if (delay) stage.delay = delay;
      }
      if (raw['action'] !== undefined) {
        const action = parseResponseAction(raw['action'], 'response.action', protocol, issues, opts);
        if (action) stage.action = action;
      }
      if (raw['delay'] === undefined && raw['action'] === undefined) {
        issues.error(
          'response',
          'empty_stage',
          'response must contain delay and/or action (spec 4.5)',
        );
      }
      response = stage;
    }
  }

  let consume: ConsumeSpec | undefined;
  if (input['consume'] !== undefined) {
    consume = parseConsume(input['consume'], issues);
  }

  let capture = false;
  const loggingRaw = input['logging'];
  if (loggingRaw !== undefined) {
    if (!isPlainObject(loggingRaw) || (loggingRaw['capture'] !== undefined && typeof loggingRaw['capture'] !== 'boolean')) {
      issues.error('logging', 'invalid_logging', 'logging.capture must be a boolean');
    } else {
      capture = loggingRaw['capture'] === true;
    }
  }

  // Cross-field rules (spec 4.3.1)
  if (input['request'] === undefined && input['response'] === undefined && !capture) {
    issues.error(
      '',
      'noop_rule',
      'a rule without request/response stages must set logging.capture: true (spec 4.3.1)',
    );
  }
  if (request?.action && isTerminalRequestAction(request.action) && response !== undefined) {
    issues.warning(
      'response',
      'unreachable_response_stage',
      'request.action is terminal (mock/fault), so the response stage never runs (spec 4.3.1)',
    );
  }
  if (
    request?.action?.type === 'mock_response' &&
    protocol === 'grpc' &&
    request.action.response.messages !== undefined &&
    opts.grpcBodyValidator === undefined
  ) {
    issues.error(
      'request.action.response.messages',
      'descriptor_required',
      'gRPC mock responses with message bodies require a registered descriptor (spec 4.7.3)',
    );
  }
  if (match && matcherUsesBody(match) && protocol === 'grpc' && opts.grpcBodyValidator === undefined) {
    issues.warning(
      'match',
      'descriptor_required',
      'gRPC body matchers only work when a descriptor for the method is registered (spec 4.4.1)',
    );
  }

  if (issues.errors.length > 0) {
    return { errors: issues.errors, warnings: issues.warnings };
  }

  const rule: Rule = {
    schemaVersion: 1,
    id,
    name,
    description,
    enabled,
    priority,
    protocol,
    match: match as Matcher,
    ...(request !== undefined ? { request } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(consume !== undefined ? { consume } : {}),
    logging: { capture },
    createdAt: isoOrUndefined(input['createdAt']) ?? '',
    updatedAt: isoOrUndefined(input['updatedAt']) ?? '',
  };

  if (opts.grpcBodyValidator && protocol === 'grpc') {
    const extra = opts.grpcBodyValidator(rule);
    for (const issue of extra) issues.errors.push(issue);
    if (issues.errors.length > 0) {
      return { errors: issues.errors, warnings: issues.warnings };
    }
  }

  return { rule, errors: issues.errors, warnings: issues.warnings };
}
