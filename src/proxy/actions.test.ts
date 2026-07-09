import { describe, expect, it } from 'vitest';
import type { HeaderMap } from '../rules/matcher.js';
import { applyResponseReplace, applyRewriteOperations, computeDelay } from './actions.js';
import { fromNodeHeaders, stripHopByHop } from './headers.js';
import { applyHttpResponsePatch, InvalidPatchError } from './patch.js';

describe('applyRewriteOperations', () => {
  it('applies header, path, query, and body operations in order', () => {
    const request = {
      path: '/v1/users',
      query: 'a=1',
      headers: { 'x-old': '1' } as HeaderMap,
      body: Buffer.from('{"env":"prod","x":1}'),
    };
    const result = applyRewriteOperations(request, [
      { op: 'set_header', name: 'X-Test-Case', value: 'retry' },
      { op: 'remove_header', name: 'x-old' },
      { op: 'set_path', value: '/v2/users' },
      { op: 'set_query', value: 'debug=true' },
      { op: 'replace_body', from: '"env":"prod"', to: '"env":"test"' },
    ]);
    expect(result).toEqual({ modified: true, bodyModified: true });
    expect(request.path).toBe('/v2/users');
    expect(request.query).toBe('debug=true');
    expect(request.headers).toEqual({ 'x-test-case': 'retry' });
    expect(request.body.toString()).toBe('{"env":"test","x":1}');
  });

  it('replace_body supports capture groups and replaces globally', () => {
    const request = {
      path: '/',
      query: '',
      headers: {} as HeaderMap,
      body: Buffer.from('id=a1 id=b2'),
    };
    applyRewriteOperations(request, [{ op: 'replace_body', from: 'id=(\\w+)', to: 'ID:$1' }]);
    expect(request.body.toString()).toBe('ID:a1 ID:b2');
  });

  it('reports no modification when nothing changes', () => {
    const request = { path: '/x', query: '', headers: {} as HeaderMap };
    const result = applyRewriteOperations(request, [
      { op: 'remove_header', name: 'absent' },
      { op: 'set_path', value: '/x' },
    ]);
    expect(result.modified).toBe(false);
  });
});

describe('applyResponseReplace', () => {
  it('rewrites a header value with regex capture groups', () => {
    const headers: HeaderMap = { 'x-data-source': 'real-db-01' };
    const changed = applyResponseReplace(headers, {
      type: 'response_replace',
      target: 'header.x-data-source',
      from: '^real-(.*)$',
      to: 'mock-$1',
    });
    expect(changed).toBe(true);
    expect(headers['x-data-source']).toBe('mock-db-01');
  });

  it('applies to every value of a multi-value header', () => {
    const headers: HeaderMap = { 'x-tags': ['real-a', 'real-b'] };
    applyResponseReplace(headers, {
      type: 'response_replace',
      target: 'header.x-tags',
      from: 'real',
      to: 'mock',
    });
    expect(headers['x-tags']).toEqual(['mock-a', 'mock-b']);
  });

  it('is a no-op for missing headers', () => {
    const headers: HeaderMap = {};
    expect(
      applyResponseReplace(headers, {
        type: 'response_replace',
        target: 'header.absent',
        from: '.',
        to: 'x',
      }),
    ).toBe(false);
  });
});

describe('computeDelay', () => {
  it('fixed mode always waits the full duration', () => {
    expect(computeDelay({ durationMs: 500 }, 10_000)).toEqual({ waitMs: 500, skipped: false });
  });

  it('total mode subtracts elapsed time and skips when exceeded (spec 4.5.1)', () => {
    expect(computeDelay({ durationMs: 300, mode: 'total' }, 100)).toEqual({
      waitMs: 200,
      skipped: false,
    });
    expect(computeDelay({ durationMs: 300, mode: 'total' }, 300)).toEqual({
      waitMs: 0,
      skipped: true,
    });
    expect(computeDelay({ durationMs: 300, mode: 'total' }, 500)).toEqual({
      waitMs: 0,
      skipped: true,
    });
  });
});

describe('stripHopByHop', () => {
  it('removes RFC 9110 hop-by-hop headers and Connection-listed ones', () => {
    const headers = fromNodeHeaders({
      connection: 'keep-alive, x-custom-hop',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      upgrade: 'websocket',
      'x-custom-hop': 'remove-me',
      'x-keep': 'stay',
      host: 'example.test',
    });
    expect(stripHopByHop(headers)).toEqual({ 'x-keep': 'stay', host: 'example.test' });
  });
});

describe('applyHttpResponsePatch', () => {
  it('applies partial patches, keeping unspecified fields', () => {
    const response = {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'x-drop': '1' } as HeaderMap,
      body: Buffer.from('real'),
    };
    const outcome = applyHttpResponsePatch(response, {
      statusCode: 503,
      headers: { 'x-drop': null, 'x-added': 'yes' },
      body: 'mock',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.bodyChanged).toBe(true);
    expect(response.statusCode).toBe(503);
    expect(response.headers).toEqual({ 'content-type': 'application/json', 'x-added': 'yes' });
    expect(response.body.toString()).toBe('mock');
  });

  it('collects ignored gRPC fields for warnings', () => {
    const response = { statusCode: 200, headers: {} as HeaderMap };
    const outcome = applyHttpResponsePatch(response, { grpcStatus: 14, trailers: {} });
    expect(outcome.ignoredFields.sort()).toEqual(['grpcStatus', 'trailers']);
    expect(outcome.changed).toBe(false);
  });

  it('rejects body and rawBodyBase64 together', () => {
    const response = { statusCode: 200, headers: {} as HeaderMap };
    expect(() => applyHttpResponsePatch(response, { body: 'a', rawBodyBase64: 'Yg==' })).toThrow(
      InvalidPatchError,
    );
  });

  it('decodes rawBodyBase64 patches', () => {
    const response = { statusCode: 200, headers: {} as HeaderMap, body: Buffer.from('x') };
    applyHttpResponsePatch(response, { rawBodyBase64: Buffer.from('binary').toString('base64') });
    expect(response.body.toString()).toBe('binary');
  });
});
