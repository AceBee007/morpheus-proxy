import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults.js';
import { loadConfig } from './load.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'morpheus-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('loadConfig', () => {
  it('starts with built-in defaults when no config file exists', () => {
    const result = loadConfig({ cwd: dir });
    expect(result.config).toEqual(defaultConfig());
    expect(result.sourcePath).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('no config file');
  });

  it('reads the implicit ./morpheus.jsonc from cwd', () => {
    writeConfig('morpheus.jsonc', '{ "admin": { "port": 19999 } }');
    const result = loadConfig({ cwd: dir });
    expect(result.config.admin.port).toBe(19999);
    expect(result.sourcePath).toContain('morpheus.jsonc');
  });

  it('prefers --config over MORPHEUS_CONFIG over the implicit path', () => {
    const cli = writeConfig('cli.jsonc', '{ "admin": { "port": 11111 } }');
    writeConfig('env.jsonc', '{ "admin": { "port": 22222 } }');
    writeConfig('morpheus.jsonc', '{ "admin": { "port": 33333 } }');

    const withCli = loadConfig({
      cwd: dir,
      argv: ['--config', cli],
      env: { MORPHEUS_CONFIG: join(dir, 'env.jsonc') },
    });
    expect(withCli.config.admin.port).toBe(11111);

    const withEnv = loadConfig({ cwd: dir, env: { MORPHEUS_CONFIG: join(dir, 'env.jsonc') } });
    expect(withEnv.config.admin.port).toBe(22222);
  });

  it('supports --config=path form', () => {
    const path = writeConfig('eq.jsonc', '{ "admin": { "port": 12345 } }');
    const result = loadConfig({ cwd: dir, argv: [`--config=${path}`] });
    expect(result.config.admin.port).toBe(12345);
  });

  it('parses JSONC comments and trailing commas', () => {
    writeConfig(
      'morpheus.jsonc',
      `{
        // comment
        "admin": { "port": 18082, },
      }`,
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.admin.port).toBe(18082);
  });

  it('falls back to all defaults with a warning when an explicit config is unreadable', () => {
    const result = loadConfig({ cwd: dir, argv: ['--config', join(dir, 'missing.jsonc')] });
    expect(result.config).toEqual(defaultConfig());
    expect(result.warnings[0]).toContain('cannot read');
  });

  it('falls back to all defaults with a warning on parse errors', () => {
    writeConfig('morpheus.jsonc', '{ this is not jsonc');
    const result = loadConfig({ cwd: dir });
    expect(result.config).toEqual(defaultConfig());
    expect(result.warnings[0]).toContain('failed to parse');
  });

  it('falls back per key when a single key is invalid, keeping valid keys', () => {
    writeConfig(
      'morpheus.jsonc',
      `{
        "admin": { "host": "0.0.0.0", "port": "not-a-number" },
        "script": { "defaultTimeoutMs": 5000 }
      }`,
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.admin.host).toBe('0.0.0.0');
    expect(result.config.admin.port).toBe(defaultConfig().admin.port);
    expect(result.config.script.defaultTimeoutMs).toBe(5000);
    expect(result.warnings.some((w) => w.includes('admin.port'))).toBe(true);
  });

  it('uses default listeners when listeners is not an array', () => {
    writeConfig('morpheus.jsonc', '{ "listeners": "nope" }');
    const result = loadConfig({ cwd: dir });
    expect(result.config.listeners).toEqual(defaultConfig().listeners);
    expect(result.warnings.some((w) => w.includes('listeners is'))).toBe(true);
  });

  it('skips a listener entry with an invalid protocol but keeps valid entries', () => {
    writeConfig(
      'morpheus.jsonc',
      `{
        "listeners": [
          { "name": "bad", "protocol": "tcp", "upstream": "http://127.0.0.1:1" },
          { "name": "ok", "protocol": "http", "port": 28080, "upstream": "http://127.0.0.1:8080" }
        ]
      }`,
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.listeners).toHaveLength(1);
    expect(result.config.listeners[0]?.name).toBe('ok');
    expect(result.config.listeners[0]?.port).toBe(28080);
    expect(result.warnings.some((w) => w.includes('protocol'))).toBe(true);
  });

  it('skips a listener entry with an invalid upstream URL', () => {
    writeConfig(
      'morpheus.jsonc',
      '{ "listeners": [ { "protocol": "grpc", "upstream": "grpc://nope" } ] }',
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.listeners).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('upstream'))).toBe(true);
  });

  it('falls back per key inside a listener entry', () => {
    writeConfig(
      'morpheus.jsonc',
      `{
        "listeners": [
          { "protocol": "http", "upstream": "http://127.0.0.1:8080", "port": -1 }
        ]
      }`,
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.listeners[0]?.port).toBe(18080);
    expect(result.warnings.some((w) => w.includes('port'))).toBe(true);
  });

  it('warns about duplicate listener protocols', () => {
    writeConfig(
      'morpheus.jsonc',
      `{
        "listeners": [
          { "protocol": "http", "port": 1001, "upstream": "http://127.0.0.1:1" },
          { "protocol": "http", "port": 1002, "upstream": "http://127.0.0.1:2" }
        ]
      }`,
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.listeners).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('multiple listeners'))).toBe(true);
  });

  it('warns about unknown keys but keeps going', () => {
    writeConfig('morpheus.jsonc', '{ "adminn": {}, "admin": { "port": 18085 } }');
    const result = loadConfig({ cwd: dir });
    expect(result.config.admin.port).toBe(18085);
    expect(result.warnings.some((w) => w.includes('unknown key adminn'))).toBe(true);
  });

  it('rejects basePath not starting with a slash', () => {
    writeConfig('morpheus.jsonc', '{ "admin": { "basePath": "morpheus" } }');
    const result = loadConfig({ cwd: dir });
    expect(result.config.admin.basePath).toBe('/_morpheus');
    expect(result.warnings.some((w) => w.includes('basePath'))).toBe(true);
  });

  it('normalizes a trailing slash on basePath', () => {
    writeConfig('morpheus.jsonc', '{ "admin": { "basePath": "/mp/" } }');
    const result = loadConfig({ cwd: dir });
    expect(result.config.admin.basePath).toBe('/mp');
  });

  it('lowercases mask header names', () => {
    writeConfig(
      'morpheus.jsonc',
      '{ "logging": { "mask": { "headers": ["Authorization", "X-Api-Key"] } } }',
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.logging.mask.headers).toEqual(['authorization', 'x-api-key']);
  });

  it('accepts rules.presets as an array and passes entries through untouched', () => {
    writeConfig('morpheus.jsonc', '{ "rules": { "presets": [ { "id": "r1" } ] } }');
    const result = loadConfig({ cwd: dir });
    expect(result.config.rules.presets).toEqual([{ id: 'r1' }]);
  });

  it('resets both script timeouts when defaultTimeoutMs exceeds maxTimeoutMs', () => {
    writeConfig(
      'morpheus.jsonc',
      '{ "script": { "defaultTimeoutMs": 120000, "maxTimeoutMs": 60000 } }',
    );
    const result = loadConfig({ cwd: dir });
    expect(result.config.script.defaultTimeoutMs).toBe(3000);
    expect(result.config.script.maxTimeoutMs).toBe(60000);
    expect(result.warnings.some((w) => w.includes('defaultTimeoutMs exceeds'))).toBe(true);
  });
});
