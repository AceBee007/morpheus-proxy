import { describe, expect, it } from 'vitest';
import type { HeaderMap } from '../rules/matcher.js';
import {
  applyGrpcResponsePatch,
  applyHttpResponsePatch,
  InvalidPatchError,
  type PatchableGrpcResponse,
} from './patch.js';

// Deeper coverage of the script-manipulator patch appliers (spec 4.5.6),
// which are bug-prone: partial semantics, null deletes, protocol-mismatch
// field handling, and validation of untrusted script output.

describe('applyHttpResponsePatch validation', () => {
  const fresh = (): { statusCode: number; headers: HeaderMap; body?: Buffer } => ({
    statusCode: 200,
    headers: {},
  });

  it('rejects an out-of-range statusCode', () => {
    expect(() => applyHttpResponsePatch(fresh(), { statusCode: 99 })).toThrow(InvalidPatchError);
    expect(() => applyHttpResponsePatch(fresh(), { statusCode: 600 })).toThrow(InvalidPatchError);
    expect(() => applyHttpResponsePatch(fresh(), { statusCode: 200.5 })).toThrow(InvalidPatchError);
  });

  it('rejects a non-string body', () => {
    expect(() => applyHttpResponsePatch(fresh(), { body: 123 })).toThrow(/body must be a string/);
  });

  it('rejects a non-string rawBodyBase64', () => {
    expect(() => applyHttpResponsePatch(fresh(), { rawBodyBase64: 5 })).toThrow(InvalidPatchError);
  });

  it('rejects headers that are not an object', () => {
    expect(() => applyHttpResponsePatch(fresh(), { headers: 'nope' })).toThrow(/must be an object/);
    expect(() => applyHttpResponsePatch(fresh(), { headers: ['a'] })).toThrow(/must be an object/);
  });

  it('rejects header values that are not string / string[] / null', () => {
    expect(() => applyHttpResponsePatch(fresh(), { headers: { x: 1 } })).toThrow(InvalidPatchError);
    expect(() => applyHttpResponsePatch(fresh(), { headers: { x: [1] } })).toThrow(InvalidPatchError);
  });

  it('reports changed=false when the patch is a no-op', () => {
    const res = { statusCode: 200, headers: { a: 'b' } as HeaderMap };
    const outcome = applyHttpResponsePatch(res, { statusCode: 200 });
    expect(outcome.changed).toBe(false);
    expect(outcome.bodyChanged).toBe(false);
  });

  it('sets a multi-value header from a string array', () => {
    const res = { statusCode: 200, headers: {} as HeaderMap };
    applyHttpResponsePatch(res, { headers: { 'x-tags': ['a', 'b'] } });
    expect(res.headers['x-tags']).toEqual(['a', 'b']);
  });

  it('empty patch leaves the response untouched', () => {
    const res = { statusCode: 201, headers: { a: 'b' } as HeaderMap, body: Buffer.from('x') };
    const outcome = applyHttpResponsePatch(res, {});
    expect(outcome.changed).toBe(false);
    expect(res.statusCode).toBe(201);
    expect(res.body.toString()).toBe('x');
  });
});

describe('applyGrpcResponsePatch', () => {
  const fresh = (over: Partial<PatchableGrpcResponse> = {}): PatchableGrpcResponse => ({
    metadata: {},
    grpcStatus: 0,
    trailers: {},
    ...over,
  });

  it('applies metadata, grpcStatus, grpcMessage and trailers', () => {
    const res = fresh({ metadata: { 'x-old': '1' } });
    const outcome = applyGrpcResponsePatch(res, {
      metadata: { 'x-old': null, 'x-new': 'yes' },
      grpcStatus: 14,
      grpcMessage: 'unavailable',
      trailers: { 'x-trailer': 'set' },
    });
    expect(outcome.changed).toBe(true);
    expect(res.metadata).toEqual({ 'x-new': 'yes' });
    expect(res.grpcStatus).toBe(14);
    expect(res.grpcMessage).toBe('unavailable');
    expect(res.trailers).toEqual({ 'x-trailer': 'set' });
  });

  it('replaces messages and flags messagesChanged', () => {
    const res = fresh({ messages: [{ a: 1 }] });
    const outcome = applyGrpcResponsePatch(res, { messages: [{ b: 2 }, { c: 3 }] });
    expect(outcome.messagesChanged).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(res.messages).toEqual([{ b: 2 }, { c: 3 }]);
  });

  it('collects HTTP-only fields as ignored', () => {
    const res = fresh();
    const outcome = applyGrpcResponsePatch(res, {
      statusCode: 200,
      body: 'x',
      rawBodyBase64: 'eA==',
      headers: { a: 'b' },
    });
    expect(outcome.ignoredFields.sort()).toEqual(['body', 'headers', 'rawBodyBase64', 'statusCode']);
    expect(outcome.changed).toBe(false);
  });

  it('ignores metadata when allowMetadata is false (headers already sent)', () => {
    const res = fresh({ metadata: { a: 'b' } });
    const outcome = applyGrpcResponsePatch(res, { metadata: { a: 'z' }, grpcStatus: 5 }, { allowMetadata: false });
    expect(outcome.ignoredFields).toContain('metadata');
    expect(res.metadata).toEqual({ a: 'b' }); // untouched
    expect(res.grpcStatus).toBe(5); // status still applied
    expect(outcome.changed).toBe(true);
  });

  it('ignores messages when allowMessages is false (streaming / no descriptor)', () => {
    const res = fresh({ messages: [{ a: 1 }] });
    const outcome = applyGrpcResponsePatch(res, { messages: [{ b: 2 }] }, { allowMessages: false });
    expect(outcome.ignoredFields).toContain('messages');
    expect(res.messages).toEqual([{ a: 1 }]);
    expect(outcome.messagesChanged).toBe(false);
  });

  it('rejects an out-of-range grpcStatus', () => {
    expect(() => applyGrpcResponsePatch(fresh(), { grpcStatus: -1 })).toThrow(InvalidPatchError);
    expect(() => applyGrpcResponsePatch(fresh(), { grpcStatus: 17 })).toThrow(InvalidPatchError);
    expect(() => applyGrpcResponsePatch(fresh(), { grpcStatus: 1.5 })).toThrow(InvalidPatchError);
  });

  it('rejects a non-string grpcMessage', () => {
    expect(() => applyGrpcResponsePatch(fresh(), { grpcMessage: 5 })).toThrow(InvalidPatchError);
  });

  it('rejects non-array messages', () => {
    expect(() => applyGrpcResponsePatch(fresh(), { messages: { not: 'array' } })).toThrow(
      /messages must be an array/,
    );
  });

  it('rejects metadata / trailers that are not string maps', () => {
    expect(() => applyGrpcResponsePatch(fresh(), { metadata: 'x' })).toThrow(/must be an object/);
    expect(() => applyGrpcResponsePatch(fresh(), { trailers: { x: 1 } })).toThrow(InvalidPatchError);
  });

  it('reports changed=false for a no-op status patch', () => {
    const res = fresh({ grpcStatus: 3 });
    const outcome = applyGrpcResponsePatch(res, { grpcStatus: 3 });
    expect(outcome.changed).toBe(false);
  });
});
