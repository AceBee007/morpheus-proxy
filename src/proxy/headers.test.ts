import { describe, expect, it } from 'vitest';
import { fromHttp2Headers, fromNodeHeaders, fromRawHeaders } from './headers.js';

describe('fromRawHeaders (spec 4.1.1: repeated fields stay separate)', () => {
  it('keeps repeated header fields as arrays and drops pseudo-headers', () => {
    const raw = [
      ':method', 'POST',
      ':path', '/pkg.Svc/M',
      'Content-Type', 'application/grpc',
      'x-trace-bin', 'AAEC',
      'x-trace-bin', 'AwQF',
      'x-trace-bin', 'BgcI',
    ];
    expect(fromRawHeaders(raw)).toEqual({
      'content-type': 'application/grpc',
      'x-trace-bin': ['AAEC', 'AwQF', 'BgcI'],
    });
  });

  it('keeps single values as strings and preserves order of repeats', () => {
    expect(fromRawHeaders(['a', '1', 'b', 'x', 'a', '2'])).toEqual({ a: ['1', '2'], b: 'x' });
  });

  it('never invents values from a trailing name without a value', () => {
    expect(fromRawHeaders(['a', '1', 'dangling'])).toEqual({ a: '1' });
  });
});

describe('fromHttp2Headers', () => {
  it('prefers the raw list over the joined headers object', () => {
    const joined = { 'x-dup-bin': 'AAEC, AwQF', ':path': '/x' };
    expect(fromHttp2Headers(joined, ['x-dup-bin', 'AAEC', 'x-dup-bin', 'AwQF', ':path', '/x'])).toEqual({
      'x-dup-bin': ['AAEC', 'AwQF'],
    });
  });

  it('falls back to the headers object when no raw list is available', () => {
    const joined = { 'x-a': 'v', ':status': '200' };
    expect(fromHttp2Headers(joined, undefined)).toEqual(fromNodeHeaders(joined));
    expect(fromHttp2Headers(joined, [])).toEqual({ 'x-a': 'v' });
  });
});
