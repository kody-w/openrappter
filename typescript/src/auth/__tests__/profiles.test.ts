/**
 * AuthProfileManager Tests
 * Covers: profile registration, active profile selection, failover,
 * cooldown timing, manual rotation, env-var credential resolution.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  AuthProfileManager,
  FailoverProfile,
  FailoverProfileInput,
  createAuthProfileManager,
} from '../profile-manager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProfile(
  overrides: Partial<FailoverProfileInput> = {}
): FailoverProfileInput {
  return {
    id: 'profile-1',
    provider: 'anthropic',
    type: 'api-key',
    credentials: { apiKey: 'sk-test' },
    priority: 1,
    failCount: 0,
    maxFailures: 3,
    cooldownMs: 60_000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthProfileManager', () => {
  let manager: AuthProfileManager;

  beforeEach(() => {
    manager = createAuthProfileManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Instantiation ──────────────────────────────────────────────────────────

  it('should instantiate via factory', () => {
    expect(manager).toBeDefined();
    expect(typeof manager.addProfile).toBe('function');
    expect(typeof manager.getActiveProfile).toBe('function');
    expect(typeof manager.markFailure).toBe('function');
    expect(typeof manager.markSuccess).toBe('function');
    expect(typeof manager.getCooldownStatus).toBe('function');
    expect(typeof manager.rotate).toBe('function');
  });

  // ── addProfile ─────────────────────────────────────────────────────────────

  it('should add a profile and return it with defaults', () => {
    const profile = manager.addProfile(makeProfile());
    expect(profile.id).toBe('profile-1');
    expect(profile.failCount).toBe(0);
    expect(profile.maxFailures).toBe(3);
    expect(profile.cooldownMs).toBe(60_000);
  });

  it('should default maxFailures to 3 if not supplied', () => {
    const p = manager.addProfile({
      id: 'p1',
      provider: 'openai',
      type: 'api-key',
      credentials: { apiKey: 'k' },
      priority: 1,
    });
    expect(p.maxFailures).toBe(3);
  });

  it('should default cooldownMs to 60000 if not supplied', () => {
    const p = manager.addProfile({
      id: 'p1',
      provider: 'openai',
      type: 'api-key',
      credentials: { apiKey: 'k' },
      priority: 1,
    });
    expect(p.cooldownMs).toBe(60_000);
  });

  it('should list profiles by provider', () => {
    manager.addProfile(makeProfile({ id: 'a', provider: 'anthropic' }));
    manager.addProfile(makeProfile({ id: 'b', provider: 'openai' }));
    const anthropic = manager.listProfiles('anthropic');
    expect(anthropic).toHaveLength(1);
    expect(anthropic[0].id).toBe('a');
  });

  it('should remove a profile', () => {
    manager.addProfile(makeProfile());
    expect(manager.listProfiles('anthropic')).toHaveLength(1);
    manager.removeProfile('profile-1');
    expect(manager.listProfiles('anthropic')).toHaveLength(0);
  });

  // ── getActiveProfile ───────────────────────────────────────────────────────

  it('should return undefined when no profiles exist', () => {
    expect(manager.getActiveProfile('anthropic')).toBeUndefined();
  });

  it('should return the only profile when one exists', () => {
    manager.addProfile(makeProfile());
    const result = manager.getActiveProfile('anthropic');
    expect(result).toBeDefined();
    expect(result?.profile.id).toBe('profile-1');
  });

  it('should return highest-priority profile', () => {
    manager.addProfile(makeProfile({ id: 'low', priority: 1 }));
    manager.addProfile(makeProfile({ id: 'high', priority: 10 }));
    const result = manager.getActiveProfile('anthropic');
    expect(result?.profile.id).toBe('high');
  });

  it('should skip profiles in cooldown', () => {
    manager.addProfile(makeProfile({ id: 'primary', priority: 10 }));
    manager.addProfile(makeProfile({ id: 'backup', priority: 5 }));

    // Put primary in cooldown
    const primary = manager.listProfiles('anthropic').find((p) => p.id === 'primary')!;
    primary.cooldownUntil = new Date(Date.now() + 10_000);

    const result = manager.getActiveProfile('anthropic');
    expect(result?.profile.id).toBe('backup');
  });

  it('should return undefined when all profiles are in cooldown', () => {
    manager.addProfile(makeProfile({ id: 'p1', priority: 10 }));
    // Manually set cooldown
    const profile = manager.listProfiles('anthropic')[0];
    profile.cooldownUntil = new Date(Date.now() + 10_000);

    expect(manager.getActiveProfile('anthropic')).toBeUndefined();
  });

  it('should use a cooled-down profile once cooldown expires', () => {
    manager.addProfile(makeProfile({ id: 'p1' }));
    const profile = manager.listProfiles('anthropic')[0];
    profile.cooldownUntil = new Date(Date.now() + 5_000);

    expect(manager.getActiveProfile('anthropic')).toBeUndefined();

    // Advance clock past cooldown
    vi.advanceTimersByTime(6_000);

    const result = manager.getActiveProfile('anthropic');
    expect(result?.profile.id).toBe('p1');
  });

  // ── markFailure / cooldown ─────────────────────────────────────────────────

  it('should increment failCount on markFailure', () => {
    manager.addProfile(makeProfile());
    manager.markFailure('profile-1');
    const profile = manager.listProfiles('anthropic')[0];
    expect(profile.failCount).toBe(1);
  });

  it('should not enter cooldown before maxFailures threshold', () => {
    manager.addProfile(makeProfile({ maxFailures: 3 }));
    manager.markFailure('profile-1');
    manager.markFailure('profile-1');
    const profile = manager.listProfiles('anthropic')[0];
    expect(profile.cooldownUntil).toBeUndefined();
  });

  it('should enter cooldown after maxFailures reached', () => {
    manager.addProfile(makeProfile({ maxFailures: 3, cooldownMs: 30_000 }));
    manager.markFailure('profile-1');
    manager.markFailure('profile-1');
    manager.markFailure('profile-1');
    const profile = manager.listProfiles('anthropic')[0];
    expect(profile.cooldownUntil).toBeDefined();
    expect(profile.cooldownUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('cooldown duration should equal cooldownMs', () => {
    const cooldownMs = 45_000;
    manager.addProfile(makeProfile({ maxFailures: 1, cooldownMs }));
    const before = Date.now();
    manager.markFailure('profile-1');
    const profile = manager.listProfiles('anthropic')[0];
    const diff = profile.cooldownUntil!.getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(cooldownMs - 50);
    expect(diff).toBeLessThanOrEqual(cooldownMs + 50);
  });

  it('markFailure on unknown id should not throw', () => {
    expect(() => manager.markFailure('nonexistent')).not.toThrow();
  });

  // ── markSuccess ────────────────────────────────────────────────────────────

  it('should reset failCount on markSuccess', () => {
    manager.addProfile(makeProfile());
    manager.markFailure('profile-1');
    manager.markFailure('profile-1');
    manager.markSuccess('profile-1');
    const profile = manager.listProfiles('anthropic')[0];
    expect(profile.failCount).toBe(0);
  });

  it('should clear cooldown on markSuccess', () => {
    manager.addProfile(makeProfile({ maxFailures: 1 }));
    manager.markFailure('profile-1'); // triggers cooldown
    manager.markSuccess('profile-1');
    const profile = manager.listProfiles('anthropic')[0];
    expect(profile.cooldownUntil).toBeUndefined();
    expect(manager.getActiveProfile('anthropic')).toBeDefined();
  });

  // ── getCooldownStatus ──────────────────────────────────────────────────────

  it('should return cooldown status for all profiles', () => {
    manager.addProfile(makeProfile({ id: 'a', provider: 'anthropic' }));
    manager.addProfile(makeProfile({ id: 'b', provider: 'openai' }));
    const statuses = manager.getCooldownStatus();
    expect(statuses).toHaveLength(2);
  });

  it('should filter getCooldownStatus by provider', () => {
    manager.addProfile(makeProfile({ id: 'a', provider: 'anthropic' }));
    manager.addProfile(makeProfile({ id: 'b', provider: 'openai' }));
    const statuses = manager.getCooldownStatus('anthropic');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].provider).toBe('anthropic');
  });

  it('inCooldown should be true for cooled-down profiles', () => {
    manager.addProfile(makeProfile({ maxFailures: 1 }));
    manager.markFailure('profile-1');
    const statuses = manager.getCooldownStatus();
    expect(statuses[0].inCooldown).toBe(true);
    expect(statuses[0].cooldownUntil).toBeDefined();
  });

  it('inCooldown should be false for healthy profiles', () => {
    manager.addProfile(makeProfile());
    const statuses = manager.getCooldownStatus();
    expect(statuses[0].inCooldown).toBe(false);
  });

  // ── rotate ─────────────────────────────────────────────────────────────────

  it('should rotate to the next profile', () => {
    manager.addProfile(makeProfile({ id: 'primary', priority: 10 }));
    manager.addProfile(makeProfile({ id: 'secondary', priority: 5 }));

    const first = manager.getActiveProfile('anthropic');
    expect(first?.profile.id).toBe('primary');

    const rotated = manager.rotate('anthropic');
    expect(rotated?.profile.id).toBe('secondary');
  });

  it('should return undefined on rotate when no alternatives exist', () => {
    manager.addProfile(makeProfile({ id: 'only' }));
    // rotate puts the only one in cooldown
    const result = manager.rotate('anthropic');
    expect(result).toBeUndefined();
  });

  // ── Credential resolution ──────────────────────────────────────────────────

  it('should resolve apiKey credential', () => {
    manager.addProfile(makeProfile({ credentials: { apiKey: 'sk-mykey' } }));
    const result = manager.getActiveProfile('anthropic');
    expect(result?.resolvedToken).toBe('sk-mykey');
  });

  it('should resolve token credential', () => {
    manager.addProfile(
      makeProfile({ credentials: { token: 'tok-abc' } })
    );
    const result = manager.getActiveProfile('anthropic');
    expect(result?.resolvedToken).toBe('tok-abc');
  });

  it('should resolve tokenEnv from environment', () => {
    process.env['TEST_API_KEY_XYZ'] = 'env-resolved-key';
    manager.addProfile(
      makeProfile({ credentials: { tokenEnv: 'TEST_API_KEY_XYZ' } })
    );
    const result = manager.getActiveProfile('anthropic');
    expect(result?.resolvedToken).toBe('env-resolved-key');
    delete process.env['TEST_API_KEY_XYZ'];
  });

  it('should return undefined when tokenEnv is not set', () => {
    manager.addProfile(
      makeProfile({ credentials: { tokenEnv: 'UNSET_VAR_RAPPTER_TEST' } })
    );
    const result = manager.getActiveProfile('anthropic');
    expect(result?.resolvedToken).toBeUndefined();
  });

  // ── withFailover ───────────────────────────────────────────────────────────

  it('should succeed with first profile when it works', async () => {
    manager.addProfile(makeProfile({ id: 'p1', priority: 10 }));
    manager.addProfile(makeProfile({ id: 'p2', priority: 5 }));

    const result = await manager.withFailover('anthropic', async ({ profile }) => {
      return `used:${profile.id}`;
    });
    expect(result).toBe('used:p1');
  });

  it('should fail over to next profile on error', async () => {
    manager.addProfile(makeProfile({ id: 'p1', priority: 10 }));
    manager.addProfile(makeProfile({ id: 'p2', priority: 5 }));

    let attempts = 0;
    const result = await manager.withFailover('anthropic', async ({ profile }) => {
      attempts++;
      if (profile.id === 'p1') throw new Error('Primary failed');
      return `used:${profile.id}`;
    });
    expect(result).toBe('used:p2');
    expect(attempts).toBe(2);
  });

  it('should mark failure on failed profile during withFailover', async () => {
    manager.addProfile(makeProfile({ id: 'p1', priority: 10, maxFailures: 5 }));
    manager.addProfile(makeProfile({ id: 'p2', priority: 5 }));

    await manager.withFailover('anthropic', async ({ profile }) => {
      if (profile.id === 'p1') throw new Error('fail');
      return 'ok';
    });

    const p1 = manager.listProfiles('anthropic').find((p) => p.id === 'p1')!;
    expect(p1.failCount).toBe(1);
  });

  it('should throw when all profiles are exhausted', async () => {
    manager.addProfile(makeProfile({ id: 'p1', priority: 10 }));

    await expect(
      manager.withFailover('anthropic', async () => {
        throw new Error('always fails');
      })
    ).rejects.toThrow('always fails');
  });

  it('should throw when no profiles are available', async () => {
    await expect(
      manager.withFailover('anthropic', async () => 'ok')
    ).rejects.toThrow(/no active profiles/i);
  });

  // ── Multiple providers ─────────────────────────────────────────────────────

  it('should manage profiles across multiple providers independently', () => {
    manager.addProfile(makeProfile({ id: 'ant-1', provider: 'anthropic', priority: 1 }));
    manager.addProfile(makeProfile({ id: 'oai-1', provider: 'openai', priority: 1 }));

    const ant = manager.getActiveProfile('anthropic');
    const oai = manager.getActiveProfile('openai');

    expect(ant?.profile.provider).toBe('anthropic');
    expect(oai?.profile.provider).toBe('openai');

    // Fail anthropic — should not affect openai
    manager.markFailure('ant-1');
    expect(manager.getActiveProfile('openai')).toBeDefined();
  });
});
