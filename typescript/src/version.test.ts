import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

describe('package version', () => {
  it('drives runtime version reporting from package.json', () => {
    const metadata = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string };

    expect(metadata.version).toBe('1.10.0');
    expect(VERSION).toBe(metadata.version);
  });
});
