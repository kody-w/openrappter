/**
 * The config type must cover every section the schema validates.
 *
 * `OpenRappterConfig` was hand-written and listed **6** sections while
 * `openRappterConfigSchema` validated **21**. The loader parses with the
 * schema and returns this type, so fifteen sections were accepted, validated,
 * and then invisible to every consumer: reading `config.security` or
 * `config.network` was a compile error, and the only way to reach one was a
 * local cast — which `security/audit.ts` had to do to see `config.browser`.
 *
 * That is a structural reason `config.security` (#219) and `config.network`
 * (#235) are read by nothing. A section nothing can name without a cast is not
 * going to grow a consumer by accident.
 *
 * The type is now `z.infer<typeof openRappterConfigSchema>`, so the two cannot
 * diverge. This file exists because a derived type is easy to un-derive: it
 * pins the count against `contracts/config-sections.json`, the same file both
 * runtimes already test against (#312).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { openRappterConfigSchema } from '../../config/schema.js';

const CONTRACT = resolve(__dirname, '../../../../contracts/config-sections.json');

/** Section names the schema accepts, read from the schema itself. */
function schemaSections(): string[] {
  return Object.keys(openRappterConfigSchema.shape).sort();
}

function contractSections(): string[] {
  return [...(JSON.parse(readFileSync(CONTRACT, 'utf-8')).sections as string[])].sort();
}

describe('the config type covers every validated section', () => {
  it('the schema and the contract agree', () => {
    // Anti-vacuity: a schema that lost its shape would make everything below
    // trivially true.
    expect(schemaSections().length).toBeGreaterThanOrEqual(20);
    expect(schemaSections()).toEqual(contractSections());
  });

  it('the type is derived from the schema, not restated', () => {
    // The mechanism, pinned. A future hand-written interface would compile
    // fine and silently reintroduce the gap, so assert how it is defined.
    const source = readFileSync(resolve(__dirname, '../../config/types.ts'), 'utf-8');
    expect(source).toMatch(
      /export type OpenRappterConfig = z\.infer<typeof openRappterConfigSchema>/,
    );
    expect(source).not.toMatch(/export interface OpenRappterConfig\b/);
  });

  it('sections that were invisible are reachable without a cast', () => {
    // These are the ones the hand-written interface omitted. This is a
    // compile-time assertion: if the type stopped covering them, tsc fails
    // before the test runs.
    const sections: Array<keyof import('../../config/types.js').OpenRappterConfig> = [
      'security',
      'network',
      'browser',
      'voice',
      'plugins',
      'logging',
      'session',
      'tools',
      'ui',
      'hooks',
      'media',
      'experimental',
      'env',
      'auth',
    ];
    for (const name of sections) {
      expect(schemaSections()).toContain(name as string);
    }
  });
});
