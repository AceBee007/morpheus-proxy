export type ListenerProtocol = 'http' | 'grpc';

/** Import descriptors from `reflect` (host:port) via gRPC server reflection. */
export interface ReflectionDescriptorSource {
  reflect: string;
  /** Services to import; every listed service when omitted. */
  symbols?: string[];
}

export type DescriptorSourceConfig = string | ReflectionDescriptorSource;

/** Server reflection settings (spec 4.7.6). */
export interface ReflectionConfig {
  /** Import descriptors on demand when a gRPC method has no registered descriptor. */
  auto: boolean;
  /** Glob patterns (`*` wildcard) of authorities that may be queried. */
  allow: string[];
  /** Deadline per reflection RPC. */
  timeoutMs: number;
  /** How long a failed target is left alone before automatic imports retry. */
  negativeTtlMs: number;
  /** Upper bound on descriptor bytes accepted from one target. */
  maxBytes: number;
  /** Extra request metadata sent with reflection calls (e.g. credentials). */
  metadata: Record<string, string>;
}

export interface ListenerConfig {
  name: string;
  protocol: ListenerProtocol;
  host: string;
  port: number;
  /**
   * How the listener obtains its upstream target (spec 3.2).
   * - `reverse` (default, omitted): forward to the fixed `upstream` below.
   * - `connect`: accept an HTTP CONNECT tunnel and use the CONNECT authority
   *   as the per-connection upstream. Lets one listener intercept a client's
   *   outbound calls to many downstreams via a single client proxy setting
   *   (e.g. `GRPC_PROXY_ADDR` / `HTTPS_PROXY`); `upstream` is ignored (spec 4.14).
   */
  mode?: 'reverse' | 'connect';
  /**
   * Upstream URL for reverse mode. `http://` for HTTP/1.1, `h2c://` for HTTP/2
   * cleartext. Empty string for connect mode (upstream is the CONNECT authority).
   */
  upstream: string;
  decodeBody: boolean;
  /**
   * Descriptor sources loaded at startup, gRPC listeners only (spec 4.7.3 /
   * 4.7.6): a path to a `.proto` or descriptor set file, or an upstream to
   * import from via server reflection.
   */
  descriptors: DescriptorSourceConfig[];
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
  reflection: ReflectionConfig;
  logging: LoggingConfig;
}

export interface ConfigLoadResult {
  config: MorpheusConfig;
  /** Human-readable warnings emitted during load (missing file, invalid keys, ...). */
  warnings: string[];
  /** Path of the config file that was actually read, or null when defaults were used. */
  sourcePath: string | null;
}
