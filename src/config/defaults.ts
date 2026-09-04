import type { ListenerConfig, MorpheusConfig, ReflectionConfig } from './types.js';

export const DEFAULT_HTTP_LISTENER_PORT = 18080;
export const DEFAULT_GRPC_LISTENER_PORT = 15051;

export function defaultHttpListener(): ListenerConfig {
  return {
    name: 'http',
    protocol: 'http',
    host: '0.0.0.0',
    port: DEFAULT_HTTP_LISTENER_PORT,
    upstream: 'http://127.0.0.1:8080',
    decodeBody: false,
    descriptors: [],
    maxRequestBodyBufferBytes: 1_048_576,
    maxResponseBodyBufferBytes: 1_048_576,
  };
}

export function defaultGrpcListener(): ListenerConfig {
  return {
    name: 'grpc',
    protocol: 'grpc',
    host: '0.0.0.0',
    port: DEFAULT_GRPC_LISTENER_PORT,
    upstream: 'h2c://127.0.0.1:50051',
    decodeBody: false,
    descriptors: [],
    maxRequestBodyBufferBytes: 1_048_576,
    maxResponseBodyBufferBytes: 1_048_576,
  };
}

export function defaultReflection(): ReflectionConfig {
  return {
    auto: false,
    allow: ['*'],
    timeoutMs: 3_000,
    negativeTtlMs: 60_000,
    maxBytes: 16_777_216,
    metadata: {},
  };
}

/**
 * Hard coded defaults. Must stay identical to config/default.jsonc — that
 * invariant is enforced by a test (spec 4.13).
 */
export function defaultConfig(): MorpheusConfig {
  return {
    admin: {
      host: '127.0.0.1',
      port: 18081,
      basePath: '/_morpheus',
    },
    listeners: [defaultHttpListener(), defaultGrpcListener()],
    rules: {
      presets: [],
    },
    script: {
      sandbox: 'subprocess',
      defaultTimeoutMs: 3_000,
      maxTimeoutMs: 60_000,
    },
    limits: {
      maxConcurrentConnections: 1_024,
      maxActiveStreams: 1_024,
      upstreamTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
    },
    reflection: defaultReflection(),
    logging: {
      trafficLogDir: 'logs/morpheus-proxy/traffic',
      appLogDir: 'logs/morpheus-proxy/app',
      trafficMaxEntries: 1_000,
      trafficMaxBytes: 104_857_600,
      trafficRetentionMs: 86_400_000,
      appRetentionMs: 86_400_000,
      mask: {
        headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
        jsonPaths: ['$.password', '$.token', '$.credentials.*'],
      },
    },
  };
}
