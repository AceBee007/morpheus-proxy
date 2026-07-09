import { describe, expect, it } from 'vitest';
import { validateRule } from './validate.js';

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'http',
    match: { type: 'regex', field: 'path', pattern: '^/users' },
    logging: { capture: true },
    ...overrides,
  };
}

describe('validateRule', () => {
  it('accepts a minimal capture rule and generates an id', () => {
    const result = validateRule(base());
    expect(result.errors).toEqual([]);
    expect(result.rule).toBeDefined();
    expect(result.rule?.id).toMatch(/^rule-[0-9a-f]{8}$/);
    expect(result.rule?.enabled).toBe(true);
    expect(result.rule?.priority).toBe(0);
    expect(result.rule?.schemaVersion).toBe(1);
  });

  it('keeps a client-provided id and validates its pattern', () => {
    expect(validateRule(base({ id: 'my-rule_01' })).rule?.id).toBe('my-rule_01');
    const bad = validateRule(base({ id: 'no spaces!' }));
    expect(bad.errors.some((e) => e.reason === 'invalid_id')).toBe(true);
  });

  it('rejects unsupported schemaVersion', () => {
    const result = validateRule(base({ schemaVersion: 2 }));
    expect(result.errors.some((e) => e.reason === 'unsupported_schema_version')).toBe(true);
  });

  it('rejects unknown protocol', () => {
    const result = validateRule(base({ protocol: 'tcp' }));
    expect(result.errors.some((e) => e.reason === 'invalid_protocol')).toBe(true);
  });

  it('rejects invalid regex patterns', () => {
    const result = validateRule(base({ match: { type: 'regex', field: 'path', pattern: '(' } }));
    expect(result.errors.some((e) => e.reason === 'invalid_regex')).toBe(true);
  });

  it('rejects response-only fields in the request matcher', () => {
    const result = validateRule(base({ match: { type: 'regex', field: 'status', pattern: '5..' } }));
    expect(result.errors.some((e) => e.reason === 'invalid_field')).toBe(true);
  });

  it('rejects protocol-mismatched matcher fields', () => {
    const grpcMethodOnHttp = validateRule(
      base({ match: { type: 'regex', field: 'grpc.method', pattern: '.' } }),
    );
    expect(grpcMethodOnHttp.errors.some((e) => e.reason === 'field_protocol_mismatch')).toBe(true);

    const httpMethodOnGrpc = validateRule(
      base({ protocol: 'grpc', match: { type: 'regex', field: 'method', pattern: 'POST' } }),
    );
    expect(httpMethodOnGrpc.errors.some((e) => e.reason === 'field_protocol_mismatch')).toBe(true);
  });

  it('validates composite matchers recursively', () => {
    const result = validateRule(
      base({
        match: {
          type: 'all',
          conditions: [
            { type: 'regex', field: 'path', pattern: '^/orders' },
            { type: 'not', condition: { type: 'regex', field: 'header.x-skip', pattern: '1' } },
          ],
        },
      }),
    );
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty request stage', () => {
    const result = validateRule(base({ request: {} }));
    expect(result.errors.some((e) => e.reason === 'empty_stage')).toBe(true);
  });

  it('rejects delay mode total on the request stage but allows it on response', () => {
    const onRequest = validateRule(
      base({ request: { delay: { durationMs: 100, mode: 'total' } } }),
    );
    expect(onRequest.errors.some((e) => e.reason === 'total_delay_on_request')).toBe(true);

    const onResponse = validateRule(
      base({ response: { delay: { durationMs: 100, mode: 'total' } } }),
    );
    expect(onResponse.errors).toEqual([]);
  });

  it('warns when a terminal request action is combined with a response stage', () => {
    const result = validateRule(
      base({
        request: { action: { type: 'mock_response', response: { statusCode: 200 } } },
        response: { delay: { durationMs: 10 } },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.reason === 'unreachable_response_stage')).toBe(true);
  });

  it('rejects a rule with no stages and no capture', () => {
    const result = validateRule(base({ logging: { capture: false } }));
    expect(result.errors.some((e) => e.reason === 'noop_rule')).toBe(true);
  });

  it('validates consume', () => {
    expect(
      validateRule(base({ consume: { times: 3, resetAfterMs: 1000 } })).errors,
    ).toEqual([]);
    expect(
      validateRule(base({ consume: { times: 0 } })).errors.some((e) => e.reason === 'invalid_times'),
    ).toBe(true);
  });

  it('rejects response_replace targets other than header.<name>', () => {
    const result = validateRule(
      base({
        response: { action: { type: 'response_replace', target: 'body', from: 'a', to: 'b' } },
      }),
    );
    expect(result.errors.some((e) => e.reason === 'invalid_target')).toBe(true);

    const ok = validateRule(
      base({
        response: {
          action: { type: 'response_replace', target: 'header.x-source', from: '^real-(.*)$', to: 'mock-$1' },
        },
      }),
    );
    expect(ok.errors).toEqual([]);
  });

  it('rejects grpc fields in an http mock response', () => {
    const result = validateRule(
      base({
        request: { action: { type: 'mock_response', response: { statusCode: 200, grpcStatus: 0 } } },
      }),
    );
    expect(result.errors.some((e) => e.reason === 'protocol_mismatch')).toBe(true);
  });

  it('rejects grpc mock message bodies without a descriptor validator (spec 4.7.3)', () => {
    const result = validateRule(
      base({
        protocol: 'grpc',
        match: { type: 'regex', field: 'path', pattern: '^/demo\\.Svc/Get$' },
        request: { action: { type: 'mock_response', response: { messages: [{ a: 1 }] } } },
      }),
    );
    expect(result.errors.some((e) => e.reason === 'descriptor_required')).toBe(true);
  });

  it('allows grpc status-only mocks without a descriptor', () => {
    const result = validateRule(
      base({
        protocol: 'grpc',
        match: { type: 'regex', field: 'grpc.service', pattern: '^demo\\.Svc$' },
        request: { action: { type: 'fault', fault: { kind: 'grpc_status', status: 14 } } },
      }),
    );
    expect(result.errors).toEqual([]);
  });

  it('rejects protocol-mismatched fault kinds', () => {
    const grpcFaultOnHttp = validateRule(
      base({ request: { action: { type: 'fault', fault: { kind: 'grpc_status', status: 14 } } } }),
    );
    expect(grpcFaultOnHttp.errors.some((e) => e.reason === 'fault_protocol_mismatch')).toBe(true);
  });

  it('accepts connection and timeout faults on both protocols', () => {
    expect(
      validateRule(
        base({ request: { action: { type: 'fault', fault: { kind: 'connection', mode: 'reset' } } } }),
      ).errors,
    ).toEqual([]);
    expect(
      validateRule(
        base({
          protocol: 'grpc',
          match: { type: 'regex', field: 'path', pattern: '.' },
          request: { action: { type: 'fault', fault: { kind: 'timeout', durationMs: 100 } } },
        }),
      ).errors,
    ).toEqual([]);
  });

  it('enforces the configured script timeout maximum', () => {
    const result = validateRule(
      base({
        response: {
          action: {
            type: 'script_manipulator',
            language: 'javascript',
            source: 'return {};',
            timeoutMs: 120_000,
          },
        },
      }),
      { scriptMaxTimeoutMs: 60_000 },
    );
    expect(result.errors.some((e) => e.reason === 'timeout_exceeds_max')).toBe(true);
  });

  it('validates request_rewrite operations', () => {
    const ok = validateRule(
      base({
        request: {
          action: {
            type: 'request_rewrite',
            operations: [
              { op: 'set_header', name: 'x-test', value: '1' },
              { op: 'replace_body', from: 'a(b)', to: 'x$1' },
            ],
          },
        },
      }),
    );
    expect(ok.errors).toEqual([]);

    const bad = validateRule(
      base({
        request: { action: { type: 'request_rewrite', operations: [{ op: 'nope' }] } },
      }),
    );
    expect(bad.errors.some((e) => e.reason === 'invalid_operation')).toBe(true);
  });

  it('preserves valid createdAt from input (import path) and clears invalid ones', () => {
    const withDate = validateRule(base({ createdAt: '2026-01-01T00:00:00.000Z' }));
    expect(withDate.rule?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    const withBadDate = validateRule(base({ createdAt: 'yesterday' }));
    expect(withBadDate.rule?.createdAt).toBe('');
  });
});
