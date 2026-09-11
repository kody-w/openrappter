import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows package smoke cleanup', () => {
  it('loads better-sqlite3 only in a child process', () => {
    const source = readFileSync(
      new URL('../../../scripts/package-smoke.mjs', import.meta.url),
      'utf8',
    );
    const marker = source.indexOf('const windowsFlightDir');
    const windowsBranch = source.slice(
      source.lastIndexOf('} else {', marker),
      source.indexOf('console.log(', marker),
    );

    expect(windowsBranch).toContain(
      '["--input-type=module", "--eval", windowsFlightScript]',
    );
    expect(windowsBranch).not.toMatch(/\bimport\s*\(/);
  });
});
