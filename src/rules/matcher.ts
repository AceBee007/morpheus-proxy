import type { Matcher, Protocol, ScriptMatcher, Stage } from './types.js';

export type HeaderMap = Record<string, string | string[]>;

export interface RequestSnapshot {
  id: string;
  method?: string;
  host?: string;
  path?: string;
  query?: string;
  headers: HeaderMap;
  body?: string;
  rawBodyBase64?: string;
  grpc?: {
    service?: string;
    method?: string;
    metadata: HeaderMap;
    messages?: unknown[];
  };
}

export interface ResponseSnapshot {
  statusCode?: number;
  headers: HeaderMap;
  body?: string;
  rawBodyBase64?: string;
  grpc?: {
    status?: number;
    message?: string;
    trailers: HeaderMap;
    messages?: unknown[];
  };
}

export interface RuleStateView {
  hits: number;
  remaining?: number;
}

/** Mirrors the script `MatchContext` (spec 4.4.3). */
export interface MatchInput {
  protocol: Protocol;
  stage: Stage;
  request: RequestSnapshot;
  response?: ResponseSnapshot;
  ruleState: RuleStateView;
}

export type ScriptMatcherRunner = (matcher: ScriptMatcher, input: MatchInput) => Promise<boolean>;

export const REQUEST_FIELDS_HTTP = ['method', 'host', 'path', 'query'] as const;
export const REQUEST_FIELDS_GRPC = ['host', 'path', 'grpc.service', 'grpc.method'] as const;
export const RESPONSE_FIELDS_HTTP = ['status'] as const;
export const RESPONSE_FIELDS_GRPC = ['grpc.status'] as const;

function headerValues(headers: HeaderMap, name: string): string[] {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolves a matcher field to its candidate values. A regex matches when any
 * candidate value matches. Returns [] when the field has no value in this
 * context (which never matches).
 */
export function resolveField(field: string, input: MatchInput): string[] {
  const { request, response, stage } = input;
  if (stage === 'request') {
    switch (field) {
      case 'method':
        return request.method !== undefined ? [request.method] : [];
      case 'host':
        return request.host !== undefined ? [request.host] : [];
      case 'path':
        return request.path !== undefined ? [request.path] : [];
      case 'query':
        return request.query !== undefined ? [request.query] : [];
      case 'body':
        return request.body !== undefined ? [request.body] : [];
      case 'rawBodyBase64':
        return request.rawBodyBase64 !== undefined ? [request.rawBodyBase64] : [];
      case 'grpc.service':
        return request.grpc?.service !== undefined ? [request.grpc.service] : [];
      case 'grpc.method':
        return request.grpc?.method !== undefined ? [request.grpc.method] : [];
      default:
        if (field.startsWith('header.')) {
          const name = field.slice('header.'.length);
          const fromHeaders = headerValues(request.headers, name);
          if (fromHeaders.length > 0) return fromHeaders;
          return request.grpc ? headerValues(request.grpc.metadata, name) : [];
        }
        return [];
    }
  }
  // response stage
  if (response === undefined) return [];
  switch (field) {
    case 'status':
      return response.statusCode !== undefined ? [String(response.statusCode)] : [];
    case 'body':
      return response.body !== undefined ? [response.body] : [];
    case 'rawBodyBase64':
      return response.rawBodyBase64 !== undefined ? [response.rawBodyBase64] : [];
    case 'grpc.status':
      return response.grpc?.status !== undefined ? [String(response.grpc.status)] : [];
    default:
      if (field.startsWith('header.')) {
        return headerValues(response.headers, field.slice('header.'.length));
      }
      if (field.startsWith('grpc.trailer.')) {
        const name = field.slice('grpc.trailer.'.length);
        return response.grpc ? headerValues(response.grpc.trailers, name) : [];
      }
      return [];
  }
}

/**
 * Evaluates a matcher against a request or response snapshot. Script matchers
 * are delegated to the injected runner; without a runner they throw, and the
 * caller records a rule execution failure (spec 4.4.3).
 */
export async function evalMatcher(
  matcher: Matcher,
  input: MatchInput,
  scriptRunner?: ScriptMatcherRunner,
): Promise<boolean> {
  switch (matcher.type) {
    case 'regex': {
      const regex = new RegExp(matcher.pattern, matcher.flags ?? '');
      return resolveField(matcher.field, input).some((value) => regex.test(value));
    }
    case 'all': {
      for (const condition of matcher.conditions) {
        if (!(await evalMatcher(condition, input, scriptRunner))) return false;
      }
      return true;
    }
    case 'any': {
      for (const condition of matcher.conditions) {
        if (await evalMatcher(condition, input, scriptRunner)) return true;
      }
      return false;
    }
    case 'not':
      return !(await evalMatcher(matcher.condition, input, scriptRunner));
    case 'script': {
      if (!scriptRunner) {
        throw new Error('script matcher requires the script sandbox, which is not available');
      }
      return scriptRunner(matcher, input);
    }
  }
}

/** Collects the fields referenced by a matcher tree (script matchers excluded). */
export function collectMatcherFields(matcher: Matcher, into: string[] = []): string[] {
  switch (matcher.type) {
    case 'regex':
      into.push(matcher.field);
      break;
    case 'all':
    case 'any':
      for (const condition of matcher.conditions) collectMatcherFields(condition, into);
      break;
    case 'not':
      collectMatcherFields(matcher.condition, into);
      break;
    case 'script':
      break;
  }
  return into;
}

/** True when the matcher references body fields (unusable on streaming traffic). */
export function matcherUsesBody(matcher: Matcher): boolean {
  return collectMatcherFields(matcher).some(
    (field) => field === 'body' || field === 'rawBodyBase64',
  );
}

/** True when any part of the matcher tree is a script matcher. */
export function matcherHasScript(matcher: Matcher): boolean {
  switch (matcher.type) {
    case 'script':
      return true;
    case 'all':
    case 'any':
      return matcher.conditions.some(matcherHasScript);
    case 'not':
      return matcherHasScript(matcher.condition);
    default:
      return false;
  }
}

/** True when the matcher needs response trailers / final status (gRPC streaming). */
export function matcherUsesTrailers(matcher: Matcher): boolean {
  if (matcherHasScript(matcher)) return true; // scripts may inspect trailers
  return collectMatcherFields(matcher).some(
    (field) =>
      field === 'grpc.status' || field === 'status' || field.startsWith('grpc.trailer.'),
  );
}
