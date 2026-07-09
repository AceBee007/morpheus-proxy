import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppLogger } from './logging/app-log.js';
import type { TrafficLogStore } from './logging/traffic-log.js';

export interface RetentionLoopOptions {
  trafficLog: TrafficLogStore;
  appLogDir: string | null;
  appRetentionMs: number;
  appLog: AppLogger;
  intervalMs?: number;
  now?: () => Date;
}

async function pruneAppLogs(opts: RetentionLoopOptions): Promise<void> {
  if (opts.appLogDir === null) return;
  const now = (opts.now ?? (() => new Date()))().getTime();
  let files: string[];
  try {
    files = await readdir(opts.appLogDir);
  } catch {
    return; // directory not created yet
  }
  for (const file of files) {
    if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
    const path = join(opts.appLogDir, file);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > opts.appRetentionMs) {
        await unlink(path);
        opts.appLog.info('app log pruned by retention', { file });
      }
    } catch (err) {
      opts.appLog.error('app log retention error', { file, error: String(err) });
    }
  }
}

/** Periodic retention sweep for traffic and app logs (spec 4.9.4). */
export function startRetentionLoop(opts: RetentionLoopOptions): { stop(): void; runOnce(): Promise<void> } {
  const runOnce = async (): Promise<void> => {
    try {
      const removed = opts.trafficLog.applyRetention();
      if (removed > 0) {
        opts.appLog.info('traffic logs pruned by retention', { removed });
      }
    } catch (err) {
      opts.appLog.error('traffic log retention error', { error: String(err) });
    }
    await pruneAppLogs(opts);
  };
  const timer = setInterval(() => {
    void runOnce();
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
