import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type AppLogLevel = 'info' | 'warn' | 'error';

export interface AppLogEntry {
  time: string;
  level: AppLogLevel;
  message: string;
  details?: unknown;
}

export interface AppLoggerOptions {
  /** Directory for JSONL app log files; null disables file output. */
  dir: string | null;
  /** Also mirror to stderr (default true). */
  stderr?: boolean;
  now?: () => Date;
}

/**
 * Structured application logger (spec 4.9). Writes JSON lines to
 * `<dir>/app-YYYY-MM-DD.log` asynchronously; file failures degrade to
 * stderr-only (best effort).
 */
export class AppLogger {
  private readonly dir: string | null;
  private readonly stderr: boolean;
  private readonly now: () => Date;
  private dirReady: Promise<boolean> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly recent: AppLogEntry[] = [];

  constructor(opts: AppLoggerOptions) {
    this.dir = opts.dir;
    this.stderr = opts.stderr ?? true;
    this.now = opts.now ?? (() => new Date());
  }

  info(message: string, details?: unknown): void {
    this.log('info', message, details);
  }

  warn(message: string, details?: unknown): void {
    this.log('warn', message, details);
  }

  error(message: string, details?: unknown): void {
    this.log('error', message, details);
  }

  log(level: AppLogLevel, message: string, details?: unknown): void {
    const entry: AppLogEntry = {
      time: this.now().toISOString(),
      level,
      message,
      ...(details !== undefined ? { details } : {}),
    };
    this.recent.push(entry);
    if (this.recent.length > 1000) this.recent.shift();
    if (this.stderr) {
      process.stderr.write(`[${entry.time}] ${level.toUpperCase()} ${message}\n`);
    }
    if (this.dir !== null) {
      const dir = this.dir;
      const file = join(dir, `app-${entry.time.slice(0, 10)}.log`);
      const line = `${JSON.stringify(entry)}\n`;
      this.pending = this.pending.then(async () => {
        try {
          if (!this.dirReady) {
            this.dirReady = mkdir(dir, { recursive: true }).then(
              () => true,
              () => false,
            );
          }
          if (await this.dirReady) await appendFile(file, line);
        } catch {
          // best effort: stderr already carries the message
        }
      });
    }
  }

  /** Recent in-memory entries, newest last (used by tests and status). */
  recentEntries(): AppLogEntry[] {
    return [...this.recent];
  }

  /** Waits for queued file writes (tests). */
  async flush(): Promise<void> {
    await this.pending;
  }
}

/** No-op logger for tests. */
export function nullLogger(): AppLogger {
  return new AppLogger({ dir: null, stderr: false });
}
