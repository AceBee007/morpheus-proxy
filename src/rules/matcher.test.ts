import { describe, expect, it } from 'vitest';
import { evalMatcher, matcherUsesBody, type MatchInput } from './matcher.js';
import type { Matcher } from './types.js';

function httpInput(overrides: Partial<MatchInput['request']> = {}): MatchInput {
  return {
    protocol: 'http',
    stage: 'request',
    request: {
      id: 'req-1',
      method: 'GET',
      host: 'example.test',
      path: '/users/42',
      query: 'debug=true',
      headers: { 'x-test-case': 'retry-1', accept: ['application/json', 'text/html'] },
      body: '{"name":"real-user"}',
      ...overrides,
    },
    ruleState: { hits: 0 },
  };
}

function grpcResponseInput(): MatchInput {
  return {
    protocol: 'grpc',
    stage: 'response',
    request: {
      id: 'req-2',
      path: '/demo.TimeService/Now',
      headers: {},
      grpc: { service: 'demo.TimeService', method: 'Now', metadata: { 'x-team': 'core' } },
    },
    response: {
      statusCode: 200,
      headers: { 'content-type': 'application/grpc' },
      grpc: { status: 14, message: 'unavailable', trailers: { 'x-debug': 'yes' } },
    },
    ruleState: { hits: 1, remaining: 2 },
  };
}

const regex = (field: string, pattern: string, flags?: string): Matcher =>
  flags !== undefined ? { type: 'regex', field, pattern, flags } : { type: 'regex', field, pattern };

describe('evalMatcher', () => {
  it('matches request path with a regex', async () => {
    expect(await evalMatcher(regex('path', '^/users/\\d+$'), httpInput())).toBe(true);
    expect(await evalMatcher(regex('path', '^/orders'), httpInput())).toBe(false);
  });

  it('matches headers case-insensitively by name and supports multi-value headers', async () => {
    expect(await evalMatcher(regex('header.X-Test-Case', '^retry-'), httpInput())).toBe(true);
    expect(await evalMatcher(regex('header.accept', 'text/html'), httpInput())).toBe(true);
    expect(await evalMatcher(regex('header.missing', '.'), httpInput())).toBe(false);
  });

  it('supports regex flags', async () => {
    expect(await evalMatcher(regex('method', 'get', 'i'), httpInput())).toBe(true);
  });

  it('matches request body', async () => {
    expect(await evalMatcher(regex('body', 'real-user'), httpInput())).toBe(true);
  });

  it('returns false for absent fields', async () => {
    const input = httpInput();
    delete input.request.body;
    expect(await evalMatcher(regex('body', '.'), input)).toBe(false);
  });

  it('resolves header.<name> from gRPC metadata', async () => {
    const input = grpcResponseInput();
    const requestStage: MatchInput = { ...input, stage: 'request' };
    expect(await evalMatcher(regex('header.x-team', '^core$'), requestStage)).toBe(true);
    expect(await evalMatcher(regex('grpc.service', '^demo\\.TimeService$'), requestStage)).toBe(true);
    expect(await evalMatcher(regex('grpc.method', '^Now$'), requestStage)).toBe(true);
  });

  it('matches response fields on the response stage', async () => {
    const input = grpcResponseInput();
    expect(await evalMatcher(regex('grpc.status', '^14$'), input)).toBe(true);
    expect(await evalMatcher(regex('grpc.trailer.x-debug', '^yes$'), input)).toBe(true);
    expect(await evalMatcher(regex('status', '^200$'), input)).toBe(true);
  });

  it('combines matchers with all / any / not', async () => {
    const m: Matcher = {
      type: 'all',
      conditions: [
        regex('path', '^/users'),
        { type: 'any', conditions: [regex('method', '^POST$'), regex('method', '^GET$')] },
        { type: 'not', condition: regex('header.x-skip', '1') },
      ],
    };
    expect(await evalMatcher(m, httpInput())).toBe(true);
    expect(
      await evalMatcher(m, httpInput({ headers: { 'x-skip': '1' } })),
    ).toBe(false);
  });

  it('delegates script matchers to the injected runner', async () => {
    const m: Matcher = { type: 'script', language: 'javascript', source: 'return true;' };
    const result = await evalMatcher(m, httpInput(), async (matcher, input) => {
      expect(matcher.source).toBe('return true;');
      expect(input.request.path).toBe('/users/42');
      return input.request.method === 'GET';
    });
    expect(result).toBe(true);
  });

  it('throws for script matchers without a runner', async () => {
    const m: Matcher = { type: 'script', language: 'javascript', source: 'return true;' };
    await expect(evalMatcher(m, httpInput())).rejects.toThrow(/script matcher/);
  });

  it('passes the runner to scripts nested inside composite matchers (complex matcher)', async () => {
    const seen: string[] = [];
    const runner = async (matcher: { source: string }): Promise<boolean> => {
      seen.push(matcher.source);
      return matcher.source.includes('yes');
    };
    // script deep inside all(any(not(script)))
    const nested: Matcher = {
      type: 'all',
      conditions: [
        regex('path', '^/users'),
        {
          type: 'any',
          conditions: [
            { type: 'script', language: 'javascript', source: 'return no' },
            { type: 'not', condition: { type: 'script', language: 'javascript', source: 'return yes-inverted' } },
          ],
        },
      ],
    };
    // any() short-circuits: first script 'no' -> false, then not(script 'yes') -> not(true) -> false => any false => all false
    expect(await evalMatcher(nested, httpInput(), runner)).toBe(false);
    expect(seen).toEqual(['return no', 'return yes-inverted']);
  });

  it('short-circuits all() before reaching a nested script when an earlier condition fails', async () => {
    let called = false;
    const runner = async (): Promise<boolean> => {
      called = true;
      return true;
    };
    const m: Matcher = {
      type: 'all',
      conditions: [
        regex('path', '^/nope'), // fails first
        { type: 'script', language: 'javascript', source: 'return true' },
      ],
    };
    expect(await evalMatcher(m, httpInput(), runner)).toBe(false);
    expect(called).toBe(false); // script never runs
  });

  it('not() inverts a nested script result', async () => {
    const runner = async (): Promise<boolean> => true;
    const m: Matcher = {
      type: 'not',
      condition: { type: 'script', language: 'javascript', source: 'return true' },
    };
    expect(await evalMatcher(m, httpInput(), runner)).toBe(false);
  });
});

describe('matcherUsesBody', () => {
  it('detects body fields anywhere in the matcher tree', () => {
    expect(matcherUsesBody(regex('body', '.'))).toBe(true);
    expect(
      matcherUsesBody({
        type: 'all',
        conditions: [regex('path', '.'), { type: 'not', condition: regex('rawBodyBase64', '.') }],
      }),
    ).toBe(true);
    expect(matcherUsesBody(regex('path', '.'))).toBe(false);
  });
});
