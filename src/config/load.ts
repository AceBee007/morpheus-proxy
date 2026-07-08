import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import {
  DEFAULT_GRPC_LISTENER_PORT,
  DEFAULT_HTTP_LISTENER_PORT,
  defaultConfig,
  defaultGrpcListener,
  defaultHttpListener,
} from './defaults.js';
import type { ConfigLoadResult, ListenerConfig, MorpheusConfig } from './types.js';

export interface LoadConfigOptions {
  /** CLI arguments, typically process.argv.slice(2). */
  argv?: string[];
  /** Environment, typically process.env. */
  env?: Record<string, string | undefined>;
  /** Base directory for the implicit ./morpheus.jsonc lookup. */
  cwd?: string;
}

const DEFAULT_CONFIG_FILENAME = 'morpheus.jsonc';

interface ResolvedPath {
  path: string;
  explicit: boolean;
}

function resolveConfigPath(opts: LoadConfigOptions): ResolvedPath {
  const argv = opts.argv ?? [];
  const cwd = opts.cwd ?? process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const next = argv[i + 1];
      if (next !== undefined) return { path: resolve(cwd, next), explicit: true };
    } else if (arg !== undefined && arg.startsWith('--config=')) {
      return { path: resolve(cwd, arg.slice('--config='.length)), explicit: true };
    }
  }
  const fromEnv = opts.env?.['MORPHEUS_CONFIG'];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { path: resolve(cwd, fromEnv), explicit: true };
  }
  return { path: resolve(cwd, DEFAULT_CONFIG_FILENAME), explicit: false };
}

type Raw = Record<string, unknown>;

function isPlainObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class SectionReader {
  constructor(
    private readonly raw: Raw,
    private readonly path: string,
    private readonly warnings: string[],
  ) {}

  private warn(key: string, expected: string, actual: unknown): void {
    this.warnings.push(
      `config: ${this.path}${key} is ${describe(actual)}, expected ${expected}; using default`,
    );
  }

  string(key: string, fallback: string): string {
    if (!(key in this.raw)) return fallback;
    const value = this.raw[key];
    if (typeof value === 'string') return value;
    this.warn(key, 'a string', value);
    return fallback;
  }

  boolean(key: string, fallback: boolean): boolean {
    if (!(key in this.raw)) return fallback;
    const value = this.raw[key];
    if (typeof value === 'boolean') return value;
    this.warn(key, 'a boolean', value);
    return fallback;
  }

  positiveInt(key: string, fallback: number): number {
    if (!(key in this.raw)) return fallback;
    const value = this.raw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    this.warn(key, 'a positive integer', value);
    return fallback;
  }

  stringArray(key: string, fallback: string[]): string[] {
    if (!(key in this.raw)) return fallback;
    const value = this.raw[key];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
    this.warn(key, 'an array of strings', value);
    return fallback;
  }

  warnUnknownKeys(known: string[]): void {
    for (const key of Object.keys(this.raw)) {
      if (!known.includes(key)) {
        this.warnings.push(`config: unknown key ${this.path}${key} is ignored`);
      }
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `of type ${typeof value}`;
}

function section(raw: Raw, key: string, warnings: string[]): Raw | null {
  if (!(key in raw)) return null;
  const value = raw[key];
  if (isPlainObject(value)) return value;
  warnings.push(`config: ${key} is ${describe(value)}, expected an object; using defaults`);
  return null;
}

const UPSTREAM_PATTERN = /^(http|h2c):\/\/.+/;

function mergeListener(
  raw: unknown,
  index: number,
  warnings: string[],
): ListenerConfig | null {
  const path = `listeners[${index}].`;
  if (!isPlainObject(raw)) {
    warnings.push(`config: listeners[${index}] is ${describe(raw)}, expected an object; skipped`);
    return null;
  }
  const protocol = raw['protocol'];
  if (protocol !== 'http' && protocol !== 'grpc') {
    warnings.push(
      `config: ${path}protocol must be "http" or "grpc" (got ${JSON.stringify(protocol)}); listener skipped`,
    );
    return null;
  }
  const upstream = raw['upstream'];
  if (typeof upstream !== 'string' || !UPSTREAM_PATTERN.test(upstream)) {
    warnings.push(
      `config: ${path}upstream must be an http:// or h2c:// URL (got ${JSON.stringify(upstream)}); listener skipped`,
    );
    return null;
  }
  const base = protocol === 'http' ? defaultHttpListener() : defaultGrpcListener();
  const reader = new SectionReader(raw, path, warnings);
  const defaultPort =
    protocol === 'http' ? DEFAULT_HTTP_LISTENER_PORT : DEFAULT_GRPC_LISTENER_PORT;
  const listener: ListenerConfig = {
    name: reader.string('name', `${protocol}-${index}`),
    protocol,
    host: reader.string('host', base.host),
    port: reader.positiveInt('port', defaultPort),
    upstream,
    decodeBody: reader.boolean('decodeBody', base.decodeBody),
    descriptors: reader.stringArray('descriptors', base.descriptors),
    maxRequestBodyBufferBytes: reader.positiveInt(
      'maxRequestBodyBufferBytes',
      base.maxRequestBodyBufferBytes,
    ),
    maxResponseBodyBufferBytes: reader.positiveInt(
      'maxResponseBodyBufferBytes',
      base.maxResponseBodyBufferBytes,
    ),
  };
  reader.warnUnknownKeys([
    'name',
    'protocol',
    'host',
    'port',
    'upstream',
    'decodeBody',
    'descriptors',
    'maxRequestBodyBufferBytes',
    'maxResponseBodyBufferBytes',
  ]);
  return listener;
}

/**
 * Merges a raw parsed config into the hard coded defaults. Every invalid key
 * falls back to its default and produces a warning; valid keys are used as-is
 * (spec 4.13).
 */
export function mergeWithDefaults(raw: Raw, warnings: string[]): MorpheusConfig {
  const config = defaultConfig();

  const admin = section(raw, 'admin', warnings);
  if (admin) {
    const reader = new SectionReader(admin, 'admin.', warnings);
    config.admin.host = reader.string('host', config.admin.host);
    config.admin.port = reader.positiveInt('port', config.admin.port);
    let basePath = reader.string('basePath', config.admin.basePath);
    if (!basePath.startsWith('/')) {
      warnings.push(
        `config: admin.basePath must start with "/" (got ${JSON.stringify(basePath)}); using default`,
      );
      basePath = defaultConfig().admin.basePath;
    }
    config.admin.basePath = basePath.length > 1 ? basePath.replace(/\/+$/, '') : basePath;
    reader.warnUnknownKeys(['host', 'port', 'basePath']);
  }

  if ('listeners' in raw) {
    const rawListeners = raw['listeners'];
    if (Array.isArray(rawListeners)) {
      const merged: ListenerConfig[] = [];
      rawListeners.forEach((entry, index) => {
        const listener = mergeListener(entry, index, warnings);
        if (listener) merged.push(listener);
      });
      // Multiple listeners (inbound/outbound, per protocol, per downstream) are
      // valid; only name/port collisions are misconfigurations (spec 3.2).
      const seenNames = new Set<string>();
      const seenPorts = new Set<number>();
      for (const listener of merged) {
        if (seenNames.has(listener.name)) {
          warnings.push(`config: duplicate listener name "${listener.name}"`);
        }
        seenNames.add(listener.name);
        if (seenPorts.has(listener.port)) {
          warnings.push(
            `config: multiple listeners share port ${listener.port}; each listener needs a unique port`,
          );
        }
        seenPorts.add(listener.port);
      }
      config.listeners = merged;
    } else {
      warnings.push(
        `config: listeners is ${describe(rawListeners)}, expected an array; using defaults`,
      );
    }
  }

  const rules = section(raw, 'rules', warnings);
  if (rules) {
    const presets = rules['presets'];
    if (presets === undefined) {
      // keep default
    } else if (Array.isArray(presets)) {
      config.rules.presets = presets;
    } else {
      warnings.push(
        `config: rules.presets is ${describe(presets)}, expected an array; using default`,
      );
    }
    new SectionReader(rules, 'rules.', warnings).warnUnknownKeys(['presets']);
  }

  const script = section(raw, 'script', warnings);
  if (script) {
    const reader = new SectionReader(script, 'script.', warnings);
    const sandbox = script['sandbox'];
    if (sandbox !== undefined && sandbox !== 'subprocess') {
      warnings.push(
        `config: script.sandbox only supports "subprocess" (got ${JSON.stringify(sandbox)}); using default`,
      );
    }
    config.script.defaultTimeoutMs = reader.positiveInt(
      'defaultTimeoutMs',
      config.script.defaultTimeoutMs,
    );
    config.script.maxTimeoutMs = reader.positiveInt('maxTimeoutMs', config.script.maxTimeoutMs);
    if (config.script.defaultTimeoutMs > config.script.maxTimeoutMs) {
      warnings.push(
        'config: script.defaultTimeoutMs exceeds script.maxTimeoutMs; using defaults for both',
      );
      config.script.defaultTimeoutMs = defaultConfig().script.defaultTimeoutMs;
      config.script.maxTimeoutMs = defaultConfig().script.maxTimeoutMs;
    }
    reader.warnUnknownKeys(['sandbox', 'defaultTimeoutMs', 'maxTimeoutMs']);
  }

  const limits = section(raw, 'limits', warnings);
  if (limits) {
    const reader = new SectionReader(limits, 'limits.', warnings);
    config.limits.maxConcurrentConnections = reader.positiveInt(
      'maxConcurrentConnections',
      config.limits.maxConcurrentConnections,
    );
    config.limits.maxActiveStreams = reader.positiveInt(
      'maxActiveStreams',
      config.limits.maxActiveStreams,
    );
    config.limits.upstreamTimeoutMs = reader.positiveInt(
      'upstreamTimeoutMs',
      config.limits.upstreamTimeoutMs,
    );
    config.limits.idleTimeoutMs = reader.positiveInt('idleTimeoutMs', config.limits.idleTimeoutMs);
    reader.warnUnknownKeys([
      'maxConcurrentConnections',
      'maxActiveStreams',
      'upstreamTimeoutMs',
      'idleTimeoutMs',
    ]);
  }

  const logging = section(raw, 'logging', warnings);
  if (logging) {
    const reader = new SectionReader(logging, 'logging.', warnings);
    config.logging.trafficLogDir = reader.string('trafficLogDir', config.logging.trafficLogDir);
    config.logging.appLogDir = reader.string('appLogDir', config.logging.appLogDir);
    config.logging.trafficMaxEntries = reader.positiveInt(
      'trafficMaxEntries',
      config.logging.trafficMaxEntries,
    );
    config.logging.trafficMaxBytes = reader.positiveInt(
      'trafficMaxBytes',
      config.logging.trafficMaxBytes,
    );
    config.logging.trafficRetentionMs = reader.positiveInt(
      'trafficRetentionMs',
      config.logging.trafficRetentionMs,
    );
    config.logging.appRetentionMs = reader.positiveInt(
      'appRetentionMs',
      config.logging.appRetentionMs,
    );
    const mask = section(logging, 'mask', warnings);
    if (mask) {
      const maskReader = new SectionReader(mask, 'logging.mask.', warnings);
      config.logging.mask.headers = maskReader
        .stringArray('headers', config.logging.mask.headers)
        .map((h) => h.toLowerCase());
      config.logging.mask.jsonPaths = maskReader.stringArray(
        'jsonPaths',
        config.logging.mask.jsonPaths,
      );
      maskReader.warnUnknownKeys(['headers', 'jsonPaths']);
    }
    reader.warnUnknownKeys([
      'trafficLogDir',
      'appLogDir',
      'trafficMaxEntries',
      'trafficMaxBytes',
      'trafficRetentionMs',
      'appRetentionMs',
      'mask',
    ]);
  }

  new SectionReader(raw, '', warnings).warnUnknownKeys([
    'admin',
    'listeners',
    'rules',
    'script',
    'limits',
    'logging',
  ]);

  return config;
}

/**
 * Loads the JSONC config. Never throws: any failure (missing file, parse
 * error, invalid key) falls back to hard coded defaults with a warning
 * (spec 4.13 — the app must start without a config file).
 */
export function loadConfig(opts: LoadConfigOptions = {}): ConfigLoadResult {
  const warnings: string[] = [];
  const resolved = resolveConfigPath(opts);

  let text: string;
  try {
    text = readFileSync(resolved.path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (resolved.explicit) {
      warnings.push(`config: cannot read ${resolved.path} (${reason}); using built-in defaults`);
    } else {
      warnings.push(
        `config: no config file at ${resolved.path}; using built-in defaults`,
      );
    }
    return { config: defaultConfig(), warnings, sourcePath: null };
  }

  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    const detail = first ? `${printParseErrorCode(first.error)} at offset ${first.offset}` : 'unknown';
    warnings.push(
      `config: failed to parse ${resolved.path} as JSONC (${detail}); using built-in defaults`,
    );
    return { config: defaultConfig(), warnings, sourcePath: null };
  }
  if (!isPlainObject(raw)) {
    warnings.push(
      `config: ${resolved.path} must contain a JSON object; using built-in defaults`,
    );
    return { config: defaultConfig(), warnings, sourcePath: null };
  }

  const config = mergeWithDefaults(raw, warnings);
  return { config, warnings, sourcePath: resolved.path };
}
