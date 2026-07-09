import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nullLogger } from './logging/app-log.js';
import { MaskRegistry } from './logging/mask.js';
import { TrafficLogStore } from './logging/traffic-log.js';
import { startRetentionLoop } from './retention.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'morpheus-retention-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startRetentionLoop', () => {
  it('prunes old traffic log entries and stale app log files', async () => {
    let now = Date.parse('2026-06-10T00:00:00.000Z');
    const trafficLog = new TrafficLogStore({
      dir: join(dir, 'traffic'),
      maxEntries: 100,
      maxBytes: 1_000_000,
      retentionMs: 60_000,
      mask: new MaskRegistry({ headers: [], jsonPaths: [] }),
      now: () => new Date(now),
    });
    trafficLog.add({
      startedAt: new Date(now),
      endedAt: new Date(now),
      protocol: 'http',
      listener: 'l',
      client: 'c',
      target: 't',
      request: { method: 'GET', path: '/', headers: {} },
      response: { statusCode: 200, headers: {} },
      outcome: 'captured',
      loggingReason: 'capture_rule',
      matchedRules: [],
    });

    const appLogDir = join(dir, 'app');
    rmSync(appLogDir, { force: true, recursive: true });
    writeFileSync(join(dir, 'placeholder'), ''); // ensure dir exists trick not needed
    const { mkdirSync } = await import('node:fs');
    mkdirSync(appLogDir, { recursive: true });
    const oldFile = join(appLogDir, 'app-2026-06-01.log');
    const newFile = join(appLogDir, 'app-2026-06-10.log');
    writeFileSync(oldFile, 'old');
    writeFileSync(newFile, 'new');
    const oldTime = new Date(now - 10 * 86_400_000);
    utimesSync(oldFile, oldTime, oldTime);

    const loop = startRetentionLoop({
      trafficLog,
      appLogDir,
      appRetentionMs: 86_400_000,
      appLog: nullLogger(),
      intervalMs: 3_600_000,
      now: () => new Date(now),
    });

    now += 120_000; // 2 minutes later: traffic retention (60s) exceeded
    await loop.runOnce();
    loop.stop();

    expect(trafficLog.size()).toBe(0);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });
});
