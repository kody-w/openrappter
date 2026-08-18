import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openRappterConfigSchema } from '../../config/schema.js';

/**
 * The config vocabulary both runtimes have to share.
 *
 * This schema declares 21 top-level sections. Python's validator required one
 * of six and rejected everything else outright, so a file holding only
 * `logging` or only `security` was valid here and refused there with "Config
 * must contain at least one recognized section". Nothing compared the two.
 *
 * The validators still differ in kind, and that is deliberate: Zod strips
 * unknown keys, Python returns the data untouched. What has to agree is which
 * sections are real.
 *
 * The Python half of this pin is python/tests/test_config_section_parity.py.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(here, '..', '..', '..', '..', 'contracts', 'config-sections.json');

function contractSections(): string[] {
  const parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as { sections: string[] };
  return [...parsed.sections].sort();
}

describe('config sections agree with the cross-runtime contract', () => {
  it('reads a populated contract', () => {
    // Guards the loader: an empty contract would make the comparison below pass
    // against nothing.
    const sections = contractSections();
    expect(sections.length).toBeGreaterThanOrEqual(20);
    expect(sections).toContain('gateway');
  });

  it('declares exactly the sections the contract lists', () => {
    const declared = Object.keys(openRappterConfigSchema.shape).sort();
    expect(declared).toEqual(contractSections());
  });
});
