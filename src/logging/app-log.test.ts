import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppLogger } from './app-log.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'morpheus-applog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AppLogger', () => {
  it('writes JSONL entries to a dated file', async () => {
    const logger = new AppLogger({
      dir,
      stderr: false,
      now: () => new Date('2026-06-10T12:00:00.000Z'),
    });
    logger.warn('config fallback', { key: 'admin.port' });
    logger.error('boom');
    await logger.flush();

    const files = readdirSync(dir);
    expect(files).toEqual(['app-2026-06-10.log']);
    const lines = readFileSync(join(dir, files[0] as string), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(first['level']).toBe('warn');
    expect(first['message']).toBe('config fallback');
    expect(first['details']).toEqual({ key: 'admin.port' });
  });

  it('keeps recent entries in memory and works without a directory', async () => {
    const logger = new AppLogger({ dir: null, stderr: false });
    logger.info('hello');
    await logger.flush();
    expect(logger.recentEntries().map((e) => e.message)).toEqual(['hello']);
  });
});
