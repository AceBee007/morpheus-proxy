/**
 * Imports gRPC descriptors from upstreams via server reflection (spec 4.7.6):
 * explicitly through the admin API, at startup from config, and on demand when
 * a gRPC method without a registered descriptor is seen (`reflection.auto`).
 */
import type { ReflectionConfig } from '../config/types.js';
import type { AppLogger } from '../logging/app-log.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { DescriptorError, type DescriptorRegistry, type RegisteredDescriptor } from './descriptors.js';
import {
  fetchDescriptorsViaReflection,
  ReflectionError,
  type ReflectionFailureReason,
  type ReflectionFetchOptions,
  type ReflectionFetchResult,
} from './reflection.js';

export interface ReflectionFailure {
  target: string;
  reason: ReflectionFailureReason;
  message: string;
  at: string;
  /** Automatic imports of this target are paused until this time (negative cache). */
  retryAt: string;
}

export interface ReflectionImportRecord {
  target: string;
  descriptorId: string;
  protocol: string;
  services: string[];
  /** Listed by the server but unresolvable (skipped). */
  missing: string[];
  files: number;
  bytes: number;
  at: string;
}

export interface ReflectionStatus {
  auto: boolean;
  allow: string[];
  inFlight: string[];
  imports: ReflectionImportRecord[];
  failures: ReflectionFailure[];
  /** service full name -> authority it was last seen on (for diagnostics / rule hints). */
  lastSeen: Record<string, string>;
}

export type ReflectionFetcher = (opts: ReflectionFetchOptions) => Promise<ReflectionFetchResult>;

export interface ReflectionImporterOptions {
  registry: DescriptorRegistry;
  appLog: AppLogger;
  settings: ReflectionConfig;
  metrics?: MetricsRegistry;
  /** Injection point for tests. */
  fetcher?: ReflectionFetcher;
  now?: () => number;
}

/** Retry delays for descriptors declared in config whose upstream is not up yet. */
const STARTUP_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_STARTUP_ATTEMPTS = 10;

/** Converts an allow-list glob (`*` wildcard) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** `/pkg.Service/Method` -> `pkg.Service`, or null for a non-gRPC path. */
export function serviceOfPath(path: string): string | null {
  const match = /^\/([^/]+)\/[^/]+$/.exec(path);
  return match?.[1] ?? null;
}

export class ReflectionImporter {
  private readonly registry: DescriptorRegistry;
  private readonly appLog: AppLogger;
  private readonly metrics: MetricsRegistry | undefined;
  private readonly fetcher: ReflectionFetcher;
  private readonly now: () => number;
  private readonly allowPatterns: RegExp[];
  private readonly inFlight = new Map<string, Promise<RegisteredDescriptor>>();
  private readonly failures = new Map<string, ReflectionFailure>();
  private readonly imports = new Map<string, ReflectionImportRecord>();
  /** `target|service` pairs confirmed absent from that target, with expiry (epoch ms). */
  private readonly unknownServices = new Map<string, number>();
  private readonly lastSeen = new Map<string, string>();
  private readonly warnedDisallowed = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  readonly settings: ReflectionConfig;

  constructor(opts: ReflectionImporterOptions) {
    this.registry = opts.registry;
    this.appLog = opts.appLog;
    this.metrics = opts.metrics;
    this.settings = opts.settings;
    this.fetcher = opts.fetcher ?? fetchDescriptorsViaReflection;
    this.now = opts.now ?? Date.now;
    this.allowPatterns = opts.settings.allow.map(globToRegExp);
  }

  /** Whether `target` may be queried according to `reflection.allow`. */
  isAllowed(target: string): boolean {
    return this.allowPatterns.some((pattern) => pattern.test(target));
  }

  /**
   * Imports descriptors from `target` now (admin API / config). Concurrent
   * imports of the same target share one in-flight request. A successful
   * import replaces the descriptors previously imported from that target.
   */
  import(
    target: string,
    symbols?: string[],
    overrides: { timeoutMs?: number } = {},
  ): Promise<RegisteredDescriptor> {
    const key = target.trim();
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.run(key, symbols, overrides).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async run(
    target: string,
    symbols: string[] | undefined,
    overrides: { timeoutMs?: number },
  ): Promise<RegisteredDescriptor> {
    const wanted = (symbols ?? []).filter((s) => s.trim() !== '');
    try {
      const result = await this.fetcher({
        target,
        ...(wanted.length > 0 ? { symbols: wanted } : {}),
        timeoutMs: overrides.timeoutMs ?? this.settings.timeoutMs,
        maxBytes: this.settings.maxBytes,
        metadata: this.settings.metadata,
      });
      const fetchedAt = new Date(this.now()).toISOString();
      this.registry.removeWhere(
        (info) => info.source.type === 'reflection' && info.source.target === target,
      );
      const info = this.registry.add({
        name: `reflection:${target}`,
        format: 'descriptor_set',
        content: result.descriptorSet.toString('base64'),
        source: {
          type: 'reflection',
          target,
          protocol: result.protocol,
          symbols: result.services,
          fetchedAt,
        },
      });
      this.failures.delete(target);
      this.imports.set(target, {
        target,
        descriptorId: info.id,
        protocol: result.protocol,
        services: result.services,
        missing: result.missing,
        files: result.files.length,
        bytes: result.descriptorSet.byteLength,
        at: fetchedAt,
      });
      this.metrics?.recordReflectionImport('success');
      this.appLog.info('grpc descriptors imported via reflection', {
        target,
        protocol: result.protocol,
        services: result.services,
        files: result.files.length,
        bytes: result.descriptorSet.byteLength,
        id: info.id,
      });
      if (result.missing.length > 0) {
        this.appLog.warn('reflection listed services it could not resolve; they were skipped', {
          target,
          missing: result.missing,
        });
      }
      return info;
    } catch (err) {
      const reason: ReflectionFailureReason =
        err instanceof ReflectionError ? err.reason : 'invalid';
      const message =
        err instanceof ReflectionError || err instanceof DescriptorError
          ? err.message
          : String(err);
      if (reason === 'invalid_target') {
        // A malformed target is a caller error, not upstream state: nothing to
        // back off from or to report as a failing upstream.
        this.metrics?.recordReflectionImport(reason);
        throw err;
      }
      const at = this.now();
      const failure: ReflectionFailure = {
        target,
        reason,
        message,
        at: new Date(at).toISOString(),
        retryAt: new Date(at + this.settings.negativeTtlMs).toISOString(),
      };
      const previous = this.failures.get(target);
      this.failures.set(target, failure);
      this.metrics?.recordReflectionImport(reason);
      // One warning per distinct failure, not one per request that hit it.
      if (previous === undefined || previous.reason !== reason || previous.message !== message) {
        this.appLog.warn('grpc descriptor import via reflection failed', {
          target,
          reason,
          message,
          retryAt: failure.retryAt,
        });
      }
      if (err instanceof ReflectionError || err instanceof DescriptorError) {
        throw new ReflectionError(reason, target, message);
      }
      throw err;
    }
  }

  /**
   * On-demand import (spec 4.7.6): called by the gRPC listeners for every
   * request whose method has no descriptor. Never blocks the request — the
   * current call is relayed as before; later calls benefit from the import.
   */
  ensure(target: string, path: string): void {
    if (!this.settings.auto || this.closed) return;
    const service = serviceOfPath(path);
    if (service === null || service === '' || this.registry.hasService(service)) return;
    if (!this.isAllowed(target)) {
      if (!this.warnedDisallowed.has(target)) {
        this.warnedDisallowed.add(target);
        this.appLog.warn('reflection import skipped: target not in reflection.allow', { target });
      }
      return;
    }
    const now = this.now();
    const unknownKey = `${target}|${service}`;
    const unknownUntil = this.unknownServices.get(unknownKey);
    if (unknownUntil !== undefined && unknownUntil > now) return;
    const failure = this.failures.get(target);
    if (failure !== undefined && Date.parse(failure.retryAt) > now) return;

    this.import(target)
      .then(() => {
        if (!this.registry.hasService(service)) {
          // The target answered but does not serve this service: do not ask again for a while.
          this.unknownServices.set(unknownKey, this.now() + this.settings.negativeTtlMs);
          this.appLog.warn('reflection import did not cover the requested service', {
            target,
            service,
          });
        }
      })
      .catch(() => {
        /* recorded in failures / metrics by run() */
      });
  }

  /** Remembers which authority served a known service (diagnostics, rule hints). */
  noteAuthority(service: string, target: string): void {
    this.lastSeen.set(service, target);
  }

  authorityFor(service: string): string | undefined {
    return this.lastSeen.get(service);
  }

  /**
   * Startup import of a descriptor source declared in config. The upstream
   * may not be reachable yet, so failures retry with backoff without ever
   * blocking startup (spec 4.13: descriptor problems never prevent boot).
   */
  scheduleStartupImport(
    target: string,
    symbols?: string[],
    maxAttempts = DEFAULT_STARTUP_ATTEMPTS,
  ): void {
    const attempt = (n: number): void => {
      if (this.closed) return;
      this.import(target, symbols).then(
        () => undefined,
        (err: unknown) => {
          if (this.closed) return;
          if (n >= maxAttempts) {
            this.appLog.error('config: reflection descriptor import gave up', {
              target,
              attempts: n,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          const delay = STARTUP_BACKOFF_MS[Math.min(n - 1, STARTUP_BACKOFF_MS.length - 1)] ?? 30_000;
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            attempt(n + 1);
          }, delay);
          timer.unref();
          this.timers.add(timer);
        },
      );
    };
    attempt(1);
  }

  status(): ReflectionStatus {
    return {
      auto: this.settings.auto,
      allow: [...this.settings.allow],
      inFlight: [...this.inFlight.keys()],
      imports: [...this.imports.values()],
      failures: [...this.failures.values()],
      lastSeen: Object.fromEntries(this.lastSeen),
    };
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
