import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HeaderMap } from '../rules/matcher.js';
import type { MatchedRuleInfo, RuleErrorInfo } from '../rules/evaluate.js';
import type { Protocol } from '../rules/types.js';
import type { AppLogger } from './app-log.js';
import type { MaskRegistry } from './mask.js';

export type Outcome =
  | 'captured'
  | 'mock'
  | 'fault'
  | 'modified'
  | 'delayed'
  | 'upstream_error'
  | 'rule_error'
  | 'client_aborted';

export type LoggingReason =
  | 'capture_rule'
  | 'matched_rule'
  | 'upstream_error'
  | 'rule_error'
  | 'client_aborted';

export const PREVIEW_BYTES = 4096;

export interface LoggedMessage {
  method?: string;
  path?: string;
  statusCode?: number;
  grpcStatus?: number;
  headers: HeaderMap;
  trailers?: HeaderMap;
  bodyLogged: boolean;
  bodySize?: number;
  bodyPreview?: string;
  bodyPreviewEncoding?: 'utf8' | 'base64';
  bodyLoggingSkippedReason?: string;
}

export interface TimingInfo {
  upstreamDurationMs?: number;
  delayMs?: number;
  delaySkipped?: boolean;
}

export interface TrafficLogEntry {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  protocol: Protocol;
  listener: string;
  client: string;
  target: string;
  request: LoggedMessage;
  forwardedRequest?: { modified: boolean } & Partial<LoggedMessage>;
  upstreamResponse?: { received: boolean } & Partial<LoggedMessage>;
  response: LoggedMessage;
  outcome: Outcome;
  loggingReason: LoggingReason;
  matchedRules: MatchedRuleInfo[];
  ruleErrors?: RuleErrorInfo[];
  timing?: TimingInfo;
}

export interface MessageDraft {
  method?: string;
  path?: string;
  statusCode?: number;
  grpcStatus?: number;
  headers: HeaderMap;
  trailers?: HeaderMap;
  /** Raw body to persist. Omit when the body is not logged. */
  body?: Buffer;
  bodySkippedReason?: string;
  /** Content-type hint for JSON masking of the preview. */
  contentType?: string;
}

export interface TrafficEventDraft {
  startedAt: Date;
  endedAt: Date;
  protocol: Protocol;
  listener: string;
  client: string;
  target: string;
  request: MessageDraft;
  forwardedRequest?: MessageDraft & { modified: boolean };
  upstreamResponse?: MessageDraft & { received: boolean };
  response: MessageDraft;
  outcome: Outcome;
  loggingReason: LoggingReason;
  matchedRules: MatchedRuleInfo[];
  ruleErrors?: RuleErrorInfo[];
  timing?: TimingInfo;
}

export type BodyKind = 'request' | 'forwarded-request' | 'upstream-response' | 'response';

export interface LogFilter {
  protocol?: Protocol;
  method?: string;
  path?: string;
  grpcService?: string;
  grpcMethod?: string;
  ruleId?: string;
  outcome?: Outcome;
  from?: string;
  to?: string;
  statusCode?: number;
  grpcStatus?: number;
  contains?: string;
}

export interface LogListResult {
  items: TrafficLogEntry[];
  nextCursor: string | null;
}

export interface TrafficLogStoreOptions {
  dir: string;
  maxEntries: number;
  maxBytes: number;
  retentionMs: number;
  mask: MaskRegistry;
  appLog?: AppLogger;
  now?: () => Date;
}

interface StoredEntry {
  entry: TrafficLogEntry;
  bodyBytes: number;
  bodyKinds: BodyKind[];
}

export function formatLogId(date: Date, seq: number): string {
  return `${date.toISOString().replaceAll(':', '-')}-${String(seq).padStart(6, '0')}`;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, PREVIEW_BYTES);
  if (sample.includes(0)) return true;
  return !sample.equals(Buffer.from(sample.toString('utf8'), 'utf8'));
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /(^|[/+])json\b/i.test(contentType);
}

function parseGrpcPath(path: string | undefined): { service?: string; method?: string } {
  if (!path) return {};
  const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return {};
  const result: { service?: string; method?: string } = {};
  if (match[1] !== undefined) result.service = match[1];
  if (match[2] !== undefined) result.method = match[2];
  return result;
}

/**
 * In-memory traffic log with raw bodies persisted to files (spec 4.9).
 * Metadata previews are masked; raw body files are stored as-is, exposure
 * being limited by the body log policy. Writes are asynchronous and never
 * block request handling.
 */
export class TrafficLogStore {
  private readonly entries: StoredEntry[] = [];
  private readonly byId = new Map<string, StoredEntry>();
  private readonly listeners = new Set<(entry: TrafficLogEntry) => void>();
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly mask: MaskRegistry;
  private readonly appLog: AppLogger | undefined;
  private readonly now: () => Date;
  private seq = 0;
  private totalBodyBytes = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private dirReady: Promise<boolean> | null = null;

  constructor(opts: TrafficLogStoreOptions) {
    this.dir = opts.dir;
    this.maxEntries = opts.maxEntries;
    this.maxBytes = opts.maxBytes;
    this.retentionMs = opts.retentionMs;
    this.mask = opts.mask;
    this.appLog = opts.appLog;
    this.now = opts.now ?? (() => new Date());
  }

  onEvent(listener: (entry: TrafficLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private buildMessage(draft: MessageDraft, id: string, kind: BodyKind): LoggedMessage {
    const message: LoggedMessage = {
      ...(draft.method !== undefined ? { method: draft.method } : {}),
      ...(draft.path !== undefined ? { path: draft.path } : {}),
      ...(draft.statusCode !== undefined ? { statusCode: draft.statusCode } : {}),
      ...(draft.grpcStatus !== undefined ? { grpcStatus: draft.grpcStatus } : {}),
      headers: this.mask.maskHeaders(draft.headers),
      ...(draft.trailers !== undefined ? { trailers: this.mask.maskHeaders(draft.trailers) } : {}),
      bodyLogged: draft.body !== undefined,
    };
    if (draft.bodySkippedReason !== undefined) {
      message.bodyLoggingSkippedReason = draft.bodySkippedReason;
    }
    if (draft.body !== undefined) {
      message.bodySize = draft.body.byteLength;
      if (looksBinary(draft.body)) {
        message.bodyPreview = draft.body.subarray(0, PREVIEW_BYTES).toString('base64');
        message.bodyPreviewEncoding = 'base64';
      } else {
        let text = draft.body.toString('utf8');
        if (isJsonContentType(draft.contentType)) {
          text = this.mask.maskJsonText(text);
        }
        message.bodyPreview = text.slice(0, PREVIEW_BYTES);
        message.bodyPreviewEncoding = 'utf8';
      }
      this.persistBody(id, kind, draft.body);
    }
    return message;
  }

  private persistBody(id: string, kind: BodyKind, body: Buffer): void {
    const file = this.bodyPath(id, kind);
    this.pending = this.pending.then(async () => {
      try {
        if (!this.dirReady) {
          this.dirReady = mkdir(this.dir, { recursive: true }).then(
            () => true,
            (err: unknown) => {
              this.appLog?.error('traffic log: cannot create body dir', {
                dir: this.dir,
                error: String(err),
              });
              return false;
            },
          );
        }
        if (await this.dirReady) await writeFile(file, body);
      } catch (err) {
        this.appLog?.error('traffic log: body write failed', { file, error: String(err) });
      }
    });
  }

  private bodyPath(id: string, kind: BodyKind): string {
    return join(this.dir, `${id}.${kind}.bin`);
  }

  add(draft: TrafficEventDraft): TrafficLogEntry {
    this.seq += 1;
    const id = formatLogId(draft.startedAt, this.seq);
    const bodyKinds: BodyKind[] = [];
    let bodyBytes = 0;
    const track = (message: MessageDraft | undefined, kind: BodyKind): void => {
      if (message?.body !== undefined) {
        bodyKinds.push(kind);
        bodyBytes += message.body.byteLength;
      }
    };
    track(draft.request, 'request');
    track(draft.forwardedRequest, 'forwarded-request');
    track(draft.upstreamResponse, 'upstream-response');
    track(draft.response, 'response');

    const entry: TrafficLogEntry = {
      id,
      startedAt: draft.startedAt.toISOString(),
      endedAt: draft.endedAt.toISOString(),
      durationMs: Math.max(0, draft.endedAt.getTime() - draft.startedAt.getTime()),
      protocol: draft.protocol,
      listener: draft.listener,
      client: draft.client,
      target: draft.target,
      request: this.buildMessage(draft.request, id, 'request'),
      ...(draft.forwardedRequest !== undefined
        ? {
            forwardedRequest: {
              ...this.buildMessage(draft.forwardedRequest, id, 'forwarded-request'),
              modified: draft.forwardedRequest.modified,
            },
          }
        : {}),
      ...(draft.upstreamResponse !== undefined
        ? {
            upstreamResponse: {
              ...this.buildMessage(draft.upstreamResponse, id, 'upstream-response'),
              received: draft.upstreamResponse.received,
            },
          }
        : {}),
      response: this.buildMessage(draft.response, id, 'response'),
      outcome: draft.outcome,
      loggingReason: draft.loggingReason,
      matchedRules: draft.matchedRules,
      ...(draft.ruleErrors !== undefined && draft.ruleErrors.length > 0
        ? { ruleErrors: draft.ruleErrors }
        : {}),
      ...(draft.timing !== undefined ? { timing: draft.timing } : {}),
    };

    const stored: StoredEntry = { entry, bodyBytes, bodyKinds };
    this.entries.push(stored);
    this.byId.set(id, stored);
    this.totalBodyBytes += bodyBytes;
    this.enforceCaps();

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // subscriber errors must not affect logging
      }
    }
    return entry;
  }

  private removeStored(stored: StoredEntry): void {
    this.byId.delete(stored.entry.id);
    this.totalBodyBytes -= stored.bodyBytes;
    for (const kind of stored.bodyKinds) {
      const file = this.bodyPath(stored.entry.id, kind);
      this.pending = this.pending.then(() =>
        unlink(file).catch(() => {
          /* already gone or never written */
        }),
      );
    }
  }

  private enforceCaps(): void {
    while (this.entries.length > this.maxEntries) {
      const oldest = this.entries.shift();
      if (oldest) this.removeStored(oldest);
    }
    while (this.totalBodyBytes > this.maxBytes && this.entries.length > 0) {
      const oldest = this.entries.shift();
      if (oldest) this.removeStored(oldest);
    }
  }

  /** Drops entries older than retentionMs. Returns the number removed. */
  applyRetention(): number {
    const cutoff = this.now().getTime() - this.retentionMs;
    let removed = 0;
    while (this.entries.length > 0) {
      const oldest = this.entries[0] as StoredEntry;
      if (Date.parse(oldest.entry.startedAt) >= cutoff) break;
      this.entries.shift();
      this.removeStored(oldest);
      removed += 1;
    }
    return removed;
  }

  get(id: string): TrafficLogEntry | undefined {
    return this.byId.get(id)?.entry;
  }

  size(): number {
    return this.entries.length;
  }

  list(filter: LogFilter = {}, limit = 50, cursor?: string): LogListResult {
    const matches: TrafficLogEntry[] = [];
    let nextCursor: string | null = null;
    let passedCursor = cursor === undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = (this.entries[i] as StoredEntry).entry;
      if (!passedCursor) {
        if (entry.id === cursor) passedCursor = true;
        continue;
      }
      if (!this.matchesFilter(entry, filter)) continue;
      if (matches.length === limit) {
        nextCursor = matches[matches.length - 1]?.id ?? null;
        break;
      }
      matches.push(entry);
    }
    return { items: matches, nextCursor };
  }

  private matchesFilter(entry: TrafficLogEntry, filter: LogFilter): boolean {
    if (filter.protocol !== undefined && entry.protocol !== filter.protocol) return false;
    if (filter.method !== undefined && entry.request.method !== filter.method) return false;
    if (filter.path !== undefined && !(entry.request.path ?? '').includes(filter.path)) {
      return false;
    }
    if (filter.grpcService !== undefined || filter.grpcMethod !== undefined) {
      if (entry.protocol !== 'grpc') return false;
      const parsed = parseGrpcPath(entry.request.path);
      if (filter.grpcService !== undefined && parsed.service !== filter.grpcService) return false;
      if (filter.grpcMethod !== undefined && parsed.method !== filter.grpcMethod) return false;
    }
    if (
      filter.ruleId !== undefined &&
      !entry.matchedRules.some((rule) => rule.id === filter.ruleId)
    ) {
      return false;
    }
    if (filter.outcome !== undefined && entry.outcome !== filter.outcome) return false;
    if (filter.from !== undefined && entry.startedAt < filter.from) return false;
    if (filter.to !== undefined && entry.startedAt > filter.to) return false;
    if (filter.statusCode !== undefined && entry.response.statusCode !== filter.statusCode) {
      return false;
    }
    if (filter.grpcStatus !== undefined && entry.response.grpcStatus !== filter.grpcStatus) {
      return false;
    }
    if (filter.contains !== undefined) {
      const haystack = [
        entry.id,
        entry.request.path ?? '',
        entry.request.bodyPreview ?? '',
        entry.response.bodyPreview ?? '',
        JSON.stringify(entry.request.headers),
        JSON.stringify(entry.response.headers),
      ].join('\n');
      if (!haystack.includes(filter.contains)) return false;
    }
    return true;
  }

  async readBody(id: string, kind: BodyKind): Promise<Buffer | null> {
    const stored = this.byId.get(id);
    if (!stored || !stored.bodyKinds.includes(kind)) return null;
    await this.flush();
    try {
      return await readFile(this.bodyPath(id, kind));
    } catch {
      return null;
    }
  }

  bodyKindsOf(id: string): BodyKind[] {
    return this.byId.get(id)?.bodyKinds ?? [];
  }

  clear(): number {
    const removed = this.entries.length;
    for (const stored of this.entries) this.removeStored(stored);
    this.entries.length = 0;
    return removed;
  }

  /** Waits for queued body writes/deletes (tests). */
  async flush(): Promise<void> {
    await this.pending;
  }
}
