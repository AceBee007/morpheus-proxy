import { describe, expect, it } from 'vitest';
import { MASKED_VALUE, MaskRegistry } from './mask.js';

const preset = {
  headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  jsonPaths: ['$.password', '$.token', '$.credentials.*'],
};

describe('MaskRegistry', () => {
  it('masks configured headers case-insensitively, including multi-value', () => {
    const mask = new MaskRegistry(preset);
    const masked = mask.maskHeaders({
      Authorization: 'Bearer secret',
      'set-cookie': ['a=1', 'b=2'],
      accept: 'application/json',
    });
    expect(masked['Authorization']).toBe(MASKED_VALUE);
    expect(masked['set-cookie']).toEqual([MASKED_VALUE, MASKED_VALUE]);
    expect(masked['accept']).toBe('application/json');
  });

  it('masks top-level json paths', () => {
    const mask = new MaskRegistry(preset);
    const out = JSON.parse(mask.maskJsonText('{"password":"p","name":"n"}')) as Record<
      string,
      unknown
    >;
    expect(out['password']).toBe(MASKED_VALUE);
    expect(out['name']).toBe('n');
  });

  it('masks wildcard paths and nested objects', () => {
    const mask = new MaskRegistry(preset);
    const out = JSON.parse(
      mask.maskJsonText('{"credentials":{"user":"u","pass":"p"},"other":1}'),
    ) as Record<string, Record<string, unknown>>;
    expect(out['credentials']).toEqual({ user: MASKED_VALUE, pass: MASKED_VALUE });
  });

  it('applies paths through arrays transparently', () => {
    const mask = new MaskRegistry({ headers: [], jsonPaths: ['$.users.token'] });
    const out = JSON.parse(
      mask.maskJsonText('{"users":[{"token":"t1"},{"token":"t2","name":"n"}]}'),
    ) as { users: Array<Record<string, unknown>> };
    expect(out.users[0]?.['token']).toBe(MASKED_VALUE);
    expect(out.users[1]?.['token']).toBe(MASKED_VALUE);
    expect(out.users[1]?.['name']).toBe('n');
  });

  it('returns non-JSON bodies untouched', () => {
    const mask = new MaskRegistry(preset);
    expect(mask.maskJsonText('plain text password=x')).toBe('plain text password=x');
  });

  it('supports runtime updates via set/get (masking API)', () => {
    const mask = new MaskRegistry(preset);
    mask.set({ headers: ['x-secret'], jsonPaths: ['$.pin'] });
    expect(mask.get()).toEqual({ headers: ['x-secret'], jsonPaths: ['$.pin'] });
    expect(mask.maskHeaders({ authorization: 'keep' })['authorization']).toBe('keep');
    const out = JSON.parse(mask.maskJsonText('{"pin":"1234"}')) as Record<string, unknown>;
    expect(out['pin']).toBe(MASKED_VALUE);
  });

  it('ignores malformed json paths', () => {
    const mask = new MaskRegistry({ headers: [], jsonPaths: ['nope', '$.'] });
    expect(mask.get().jsonPaths).toEqual([]);
  });
});
