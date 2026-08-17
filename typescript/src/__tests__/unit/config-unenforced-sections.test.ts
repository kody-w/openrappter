import { describe, it, expect } from 'vitest';
import {
  UNENFORCED_CONFIG_SECTIONS,
  unenforcedConfigSections,
} from '../../cli/config.js';
import { openRappterConfigSchema } from '../../config/schema.js';

/**
 * A config section that validates and does nothing must say so.
 *
 * `openrappter config validate` prints "Configuration is valid." A user who
 * writes
 *
 *     security:
 *       approvalPolicy: deny
 *       allowlists:
 *         commands: ["git status"]
 *
 * is told exactly that, and — because `security` really is in the schema — the
 * ignored-key report from #211 says nothing either. Every signal the tool gives
 * says the lockdown is on. Nothing reads `config.security` (#219).
 *
 * This is the opposite failure to an ignored key and a worse one: an ignored
 * key is discarded, which at least means nobody could think it took effect.
 */
describe('unenforced config sections', () => {
  it('reports a section that is set but enforced by nothing', () => {
    expect(unenforcedConfigSections({ security: { approvalPolicy: 'deny' } }))
      .toEqual(['security']);
  });

  it('says nothing about a config that does not set one', () => {
    expect(unenforcedConfigSections({ agents: { list: [] } })).toEqual([]);
    expect(unenforcedConfigSections({})).toEqual([]);
  });

  it('reports every unenforced section a config sets, sorted', () => {
    expect(
      unenforcedConfigSections({ network: {}, security: {}, agents: {} }),
    ).toEqual(['network', 'security']);
  });

  it('survives input that is not an object', () => {
    for (const value of [null, undefined, 'security', 42, []]) {
      expect(unenforcedConfigSections(value)).toEqual([]);
    }
  });

  it('every listed section really is in the schema', () => {
    // A section that is *not* in the schema is already covered by the
    // ignored-key report, so listing it here would double-report it and hide
    // that the entry has gone stale.
    const shape = (openRappterConfigSchema as unknown as {
      shape: Record<string, unknown>;
    }).shape;
    const notInSchema = [...UNENFORCED_CONFIG_SECTIONS.keys()]
      .filter((section) => !(section in shape))
      .sort();
    expect(notInSchema).toEqual([]);
  });

  it('carries a reason for every entry', () => {
    // The message is the whole value of the report — "security is not enforced"
    // without saying what does enforce it sends the reader nowhere.
    for (const [section, reason] of UNENFORCED_CONFIG_SECTIONS) {
      expect(reason, `${section} has no reason`).toBeTruthy();
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('names the security section, which is the one with consequences', () => {
    expect(UNENFORCED_CONFIG_SECTIONS.has('security')).toBe(true);
  });
});
