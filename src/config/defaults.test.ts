import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('config/default.jsonc', () => {
  it('matches the hard coded defaults exactly (spec 4.13)', () => {
    const text = readFileSync(join(repoRoot, 'config', 'default.jsonc'), 'utf8');
    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(parsed).toEqual(defaultConfig());
  });
});
