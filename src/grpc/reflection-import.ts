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

/** An upstream the proxy has forwarded gRPC calls to (or a configured reverse upstream). */
export interface ObservedTarget {
  target: string;
  /** Declared as a reverse listener upstream in config (may have no traffic yet). */
  configured: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  requests: number;
  /** Services seen on this target that have a descriptor. */
  services: string[];
  /** Services seen on this target that still have no descriptor. */
  unknownServices: string[];
  /** Descriptors were imported from this target via reflection. */
  imported: boolean;
  /** Every observed service has a descriptor (nothing left to fetch). */
  covered: boolean;
}

export interface ReflectAllTargetResult {
  target: string;
  status: 'imported' | 'failed' | 'skipped';
  descriptorId?: string;
  services?: string[];
  missing?: string[];
  reason?: ReflectionFailureReason;
  message?: string;
  skippedBecause?: 'covered' | 'not_allowed';
}

export interface ReflectAllResult {
  targets: ReflectAllTargetResult[];
  imported: number;
  failed: number;
  skipped: number;
}

export interface ReflectionStatus {
  auto: boolean;
  allow: string[];
  inFlight: string[];
  imports: ReflectionImportRecord[];
  failures: ReflectionFailure[];
  /** Upstreams seen in traffic / configured, most recently seen first. */
  observed: ObservedTarget[];
  /** service full name -> authority it was last seen on (for diagnostics / rule hints). */
  lastSeen: Record<string, string>;
}

interface ObservedEntry {
  configured: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  requests: number;
  services: Set<string>;
  unknownServices: Set<string>;
}

/** Bounds on what is remembered about observed upstreams (spec 4.11 style limits). */
const MAX_OBSERVED_TARGETS = 200;
const MAX_SERVICES_PER_TARGET = 500;

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

/**
 * Retry schedule for descriptors declared in config whose upstream is not up
 * yet: 1s, 2s, 4s, 8s, 16s, then 30s between attempts, at most 10 attempts in
 * total (about 2.5 minutes). The limit is fixed by spec 4.7.6, not configurable;
 * after giving up, auto / one-shot / explicit imports remain available.
 */
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
  private readonly observed = new Map<string, ObservedEntry>();
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

  /**
   * Records that a gRPC call for `service` was forwarded to `target`, whether
   * or not a descriptor covered it. This is independent of `reflection.auto`
   * and feeds the one-shot import of observed upstreams (spec 4.7.6).
   */
  observe(target: string, service: string | null, known: boolean): void {
    const entry = this.entryFor(target, false);
    if (entry === null) return;
    const now = this.now();
    entry.lastSeenAt = now;
    entry.requests += 1;
    if (service === null || service === '') return;
    if (known) {
      entry.unknownServices.delete(service);
      if (entry.services.size < MAX_SERVICES_PER_TARGET) entry.services.add(service);
      this.lastSeen.set(service, target);
    } else if (entry.unknownServices.size < MAX_SERVICES_PER_TARGET) {
      entry.unknownServices.add(service);
    }
  }

  /** Registers a reverse listener's fixed upstream so it can be imported before any traffic. */
  noteConfiguredUpstream(target: string): void {
    const entry = this.entryFor(target, true);
    if (entry !== null) entry.configured = true;
  }

  private entryFor(target: string, configured: boolean): ObservedEntry | null {
    const existing = this.observed.get(target);
    if (existing) return existing;
    if (this.observed.size >= MAX_OBSERVED_TARGETS) {
      // Evict the least recently seen target rather than growing without bound.
      let oldest: [string, ObservedEntry] | undefined;
      for (const candidate of this.observed) {
        if (oldest === undefined || candidate[1].lastSeenAt < oldest[1].lastSeenAt) oldest = candidate;
      }
      if (oldest !== undefined) this.observed.delete(oldest[0]);
    }
    const now = this.now();
    const entry: ObservedEntry = {
      configured,
      firstSeenAt: now,
      lastSeenAt: now,
      requests: 0,
      services: new Set(),
      unknownServices: new Set(),
    };
    this.observed.set(target, entry);
    return entry;
  }

  private observedTargets(): ObservedTarget[] {
    return [...this.observed.entries()]
      .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
      .map(([target, entry]) => {
        // Coverage is evaluated against the registry as it is now, so descriptors
        // deleted (or added by hand) after the traffic was seen are reflected.
        const seen = [...new Set([...entry.services, ...entry.unknownServices])];
        const services = seen.filter((s) => this.registry.hasService(s));
        const unknownServices = seen.filter((s) => !this.registry.hasService(s));
        const imported = this.registry
          .list()
          .some((d) => d.source.type === 'reflection' && d.source.target === target);
        return {
          target,
          configured: entry.configured,
          firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
          lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
          requests: entry.requests,
          services,
          unknownServices,
          imported,
          covered: unknownServices.length === 0 && (services.length > 0 || imported),
        };
      });
  }

  /**
   * One-shot import from every observed / configured upstream (admin UI button,
   * `POST /grpc/descriptors:reflect-all`). With `onlyMissing` (default) targets
   * whose observed services all have descriptors are skipped; targets outside
   * `reflection.allow` are always skipped. Never throws: each target reports
   * its own outcome.
   */
  async importObserved(opts: { onlyMissing?: boolean } = {}): Promise<ReflectAllResult> {
    const onlyMissing = opts.onlyMissing ?? true;
    const targets = await Promise.all(
      this.observedTargets().map(async (observed): Promise<ReflectAllTargetResult> => {
        if (onlyMissing && observed.covered) {
          return { target: observed.target, status: 'skipped', skippedBecause: 'covered' };
        }
        if (!this.isAllowed(observed.target)) {
          return { target: observed.target, status: 'skipped', skippedBecause: 'not_allowed' };
        }
        try {
          const info = await this.import(observed.target);
          const record = this.imports.get(observed.target);
          return {
            target: observed.target,
            status: 'imported',
            descriptorId: info.id,
            services: record?.services ?? [],
            missing: record?.missing ?? [],
          };
        } catch (err) {
          return {
            target: observed.target,
            status: 'failed',
            reason: err instanceof ReflectionError ? err.reason : 'invalid',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    const count = (status: ReflectAllTargetResult['status']): number =>
      targets.filter((t) => t.status === status).length;
    return { targets, imported: count('imported'), failed: count('failed'), skipped: count('skipped') };
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
      observed: this.observedTargets(),
      lastSeen: Object.fromEntries(this.lastSeen),
    };
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
