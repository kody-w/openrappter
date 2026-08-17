import { describe, it, expect } from 'vitest';
import { ignoredConfigKeys } from '../../cli/config.js';

/**
 * `config validate` used to call a mostly-inert file valid.
 *
 * Zod strips unknown keys instead of rejecting them, so a config can parse
 * cleanly while almost nothing in it is read. `openrappter config validate`
 * printed "Configuration is valid." for a file whose `memory`, `shell` and
 * `skills` sections did nothing at all.
 *
 * That is how the published documentation came to describe a config format
 * that no longer exists: the tool whose entire job is to check the file agreed
 * with it. The only guard was `unsupportedConfigErrors`, a hand-written list
 * naming exactly three keys — `agent`, `gateway.host`, `memory.chunkSize` —
 * and missing everything else.
 *
 * These tests pin the derived replacement, including the two ways it could go
 * wrong: staying silent when it should speak, and flagging keys that are
 * legitimately free-form.
 */

describe('ignoredConfigKeys', () => {
  it('reports keys the schema will silently discard', () => {
    const documented = {
      gateway: { enabled: true, port: 8765, rate_limit: 100 },
      memory: { backend: 'sqlite', chunk_size: 512 },
      shell: { require_approval: false },
      skills: { auto_load: true },
    };

    expect(ignoredConfigKeys(documented).sort()).toEqual([
      'gateway.enabled',
      'gateway.rate_limit',
      'memory.backend',
      'memory.chunk_size',
      'shell',
      'skills',
    ]);
  });

  it('says nothing about a config the schema fully understands', () => {
    const real = {
      gateway: { port: 18790, bind: 'loopback' },
      memory: { provider: 'local', chunkTokens: 512 },
      cron: { enabled: true },
    };

    expect(ignoredConfigKeys(real)).toEqual([]);
  });

  it('does not flag arbitrary keys inside a record', () => {
    // `channels` is a z.record, so any channel name is legal. Treating those
    // as unknown keys would make the warning useless noise for anyone who
    // actually configures a channel.
    const withChannels = {
      channels: { 'my-slack': { enabled: true }, another: { enabled: false } },
    };

    expect(ignoredConfigKeys(withChannels)).toEqual([]);
  });

  it('descends more than one level', () => {
    expect(ignoredConfigKeys({ gateway: { auth: { mode: 'password', nope: 1 } } }))
      .toEqual(['gateway.auth.nope']);
  });

  it('reports a whole unknown section once, not each leaf inside it', () => {
    const result = ignoredConfigKeys({ totallyMadeUp: { a: 1, b: { c: 2 } } });
    expect(result).toEqual(['totallyMadeUp']);
  });

  it('is quiet on empty and non-object input', () => {
    expect(ignoredConfigKeys({})).toEqual([]);
    expect(ignoredConfigKeys(null)).toEqual([]);
    expect(ignoredConfigKeys('not a config')).toEqual([]);
  });

  it('reads a real shape rather than defaulting to silence', () => {
    // Anti-vacuity. If the Zod internals move again and the shape reader
    // returns null for everything, every assertion above would pass by
    // reporting nothing. This one fails instead.
    expect(ignoredConfigKeys({ definitelyNotAKey: 1 })).toEqual(['definitelyNotAKey']);
  });
});
