import type { Matcher, Rule } from '../rules/types.js';
import type { RuleValidationIssue } from '../rules/validate.js';
import { DescriptorError, type DescriptorRegistry } from './descriptors.js';

const REGEX_META = /[[\](){}*+?|^$]/;

/** Extracts a literal string from an anchored regex like ^/demo\.Svc/Now$. */
function literalFromPattern(pattern: string): string | null {
  let inner = pattern;
  if (inner.startsWith('^')) inner = inner.slice(1);
  if (inner.endsWith('$')) inner = inner.slice(0, -1);
  const unescaped = inner.replace(/\\([.\\/])/g, '$1');
  if (REGEX_META.test(unescaped) || unescaped.includes('\\')) return null;
  return unescaped;
}

/**
 * Tries to determine the single gRPC method a matcher targets. Returns the
 * :path when the matcher pins it down, otherwise null (validation is then
 * deferred to runtime encoding).
 */
export function literalGrpcTarget(matcher: Matcher): string | null {
  if (matcher.type === 'regex') {
    if (matcher.field !== 'path') return null;
    const literal = literalFromPattern(matcher.pattern);
    return literal !== null && /^\/[^/]+\/[^/]+$/.test(literal) ? literal : null;
  }
  if (matcher.type === 'all') {
    let service: string | null = null;
    let method: string | null = null;
    for (const condition of matcher.conditions) {
      if (condition.type === 'regex' && condition.field === 'grpc.service') {
        service = literalFromPattern(condition.pattern);
      } else if (condition.type === 'regex' && condition.field === 'grpc.method') {
        method = literalFromPattern(condition.pattern);
      } else if (condition.type === 'regex' && condition.field === 'path') {
        const fromPath = literalGrpcTarget(condition);
        if (fromPath !== null) return fromPath;
      }
    }
    if (service !== null && method !== null) return `/${service}/${method}`;
    return null;
  }
  return null;
}

/**
 * Descriptor-backed validation hook for gRPC message bodies (spec 4.7.3).
 * Mock responses with message bodies require a descriptor; when the matcher
 * pins down the target method, the messages are verified against its
 * response schema and streaming methods are rejected.
 */
export function grpcBodyValidatorFor(
  registry: DescriptorRegistry,
): (rule: Rule) => RuleValidationIssue[] {
  return (rule) => {
    const issues: RuleValidationIssue[] = [];
    const action = rule.request?.action;
    if (action?.type !== 'mock_response') return issues;
    const messages = action.response.messages;
    if (messages === undefined) return issues;

    if (!registry.hasAny()) {
      issues.push({
        path: 'request.action.response.messages',
        reason: 'descriptor_required',
        message:
          'gRPC mock responses with message bodies require a registered descriptor (spec 4.7.3)',
      });
      return issues;
    }
    const target = literalGrpcTarget(rule.match);
    if (target === null) return issues; // cannot pin the method; runtime encoding will validate
    const method = registry.lookupMethod(target);
    if (method === null) {
      issues.push({
        path: 'match',
        reason: 'method_not_found',
        message: `no registered descriptor covers ${target}`,
      });
      return issues;
    }
    if (method.requestStream || method.responseStream) {
      issues.push({
        path: 'request.action',
        reason: 'streaming_mock_unsupported',
        message: 'gRPC mock responses only support unary methods (spec 4.5.3)',
      });
      return issues;
    }
    messages.forEach((message, index) => {
      try {
        registry.encodeMessage(method.responseType, message);
      } catch (err) {
        issues.push({
          path: `request.action.response.messages[${index}]`,
          reason: 'invalid_message',
          message: err instanceof DescriptorError ? err.message : String(err),
        });
      }
    });
    return issues;
  };
}
