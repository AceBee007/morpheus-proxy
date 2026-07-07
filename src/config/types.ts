export type ListenerProtocol = 'http' | 'grpc';

export interface ListenerConfig {
  name: string;
  protocol: ListenerProtocol;
  host: string;
  port: number;
  /** Upstream URL. `http://` for HTTP/1.1 upstreams, `h2c://` for HTTP/2 cleartext. */
  upstream: string;
  decodeBody: boolean;
  /** Paths to protobuf descriptor set files, gRPC listeners only. */
  descriptors: string[];
  maxRequestBodyBufferBytes: number;
  maxResponseBodyBufferBytes: number;
}

export interface MaskConfig {
  headers: string[];
  jsonPaths: string[];
}

export interface AdminConfig {
  host: string;
  port: number;
  basePath: string;
}

export interface ScriptConfig {
  sandbox: 'subprocess';
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

export interface LimitsConfig {
  maxConcurrentConnections: number;
  maxActiveStreams: number;
  upstreamTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface LoggingConfig {
  trafficLogDir: string;
  appLogDir: string;
  trafficMaxEntries: number;
  trafficMaxBytes: number;
  trafficRetentionMs: number;
  appRetentionMs: number;
  mask: MaskConfig;
}

export interface RulesConfig {
  /** Rule definitions loaded at startup. Validated by the rule engine, not here. */
  presets: unknown[];
}

export interface MorpheusConfig {
  admin: AdminConfig;
  listeners: ListenerConfig[];
  rules: RulesConfig;
  script: ScriptConfig;
  limits: LimitsConfig;
  logging: LoggingConfig;
}

export interface ConfigLoadResult {
  config: MorpheusConfig;
  /** Human-readable warnings emitted during load (missing file, invalid keys, ...). */
  warnings: string[];
  /** Path of the config file that was actually read, or null when defaults were used. */
  sourcePath: string | null;
}
