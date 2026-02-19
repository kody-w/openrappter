/**
 * Auth Profile Manager
 * Multi-profile auth with automatic failover and cooldown
 */

export interface FailoverProfile {
  id: string;
  provider: string; // 'anthropic' | 'openai' | 'copilot' | etc.
  type: 'api-key' | 'oauth';
  credentials: {
    apiKey?: string;
    token?: string;
    refreshToken?: string;
    /** Name of an environment variable whose value is the token */
    tokenEnv?: string;
  };
  priority: number;
  cooldownUntil?: Date;
  failCount: number;
  maxFailures: number; // before cooldown (default 3)
  cooldownMs: number; // cooldown duration (default 60000)
}

/** Input type for addProfile — maxFailures, cooldownMs, and failCount are optional */
export type FailoverProfileInput = Omit<FailoverProfile, 'failCount' | 'maxFailures' | 'cooldownMs'> & {
  failCount?: number;
  maxFailures?: number;
  cooldownMs?: number;
};

export interface CooldownStatus {
  profileId: string;
  provider: string;
  inCooldown: boolean;
  cooldownUntil?: Date;
  failCount: number;
}

export interface ActiveProfileResult {
  profile: FailoverProfile;
  /** Resolved credential value (env vars expanded) */
  resolvedToken?: string;
}

const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export class AuthProfileManager {
  private profiles = new Map<string, FailoverProfile>();

  /**
   * Register an auth profile.
   * Missing maxFailures/cooldownMs are defaulted.
   */
  addProfile(input: FailoverProfileInput): FailoverProfile {
    const profile: FailoverProfile = {
      failCount: input.failCount ?? 0,
      maxFailures: input.maxFailures ?? DEFAULT_MAX_FAILURES,
      cooldownMs: input.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      id: input.id,
      provider: input.provider,
      type: input.type,
      credentials: input.credentials,
      priority: input.priority,
      cooldownUntil: input.cooldownUntil,
    };
    this.profiles.set(profile.id, profile);
    return profile;
  }

  /**
   * Remove a profile by id.
   */
  removeProfile(profileId: string): boolean {
    return this.profiles.delete(profileId);
  }

  /**
   * Get highest-priority non-cooled-down profile for a provider.
   * Returns undefined if none available.
   */
  getActiveProfile(provider: string): ActiveProfileResult | undefined {
    const now = new Date();
    const candidates = Array.from(this.profiles.values())
      .filter((p) => p.provider === provider)
      .filter((p) => !p.cooldownUntil || p.cooldownUntil <= now)
      .sort((a, b) => b.priority - a.priority); // highest priority first

    if (candidates.length === 0) return undefined;

    const profile = candidates[0];
    return { profile, resolvedToken: this.resolveToken(profile) };
  }

  /**
   * Mark a failure for a profile.
   * Increments failCount; if >= maxFailures, enters cooldown.
   */
  markFailure(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) return;

    profile.failCount += 1;

    if (profile.failCount >= profile.maxFailures) {
      profile.cooldownUntil = new Date(Date.now() + profile.cooldownMs);
    }
  }

  /**
   * Mark success for a profile — resets failCount and clears cooldown.
   */
  markSuccess(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) return;

    profile.failCount = 0;
    profile.cooldownUntil = undefined;
  }

  /**
   * Return cooldown status for all profiles (or filtered by provider).
   */
  getCooldownStatus(provider?: string): CooldownStatus[] {
    const now = new Date();
    return Array.from(this.profiles.values())
      .filter((p) => !provider || p.provider === provider)
      .map((p) => ({
        profileId: p.id,
        provider: p.provider,
        inCooldown: !!p.cooldownUntil && p.cooldownUntil > now,
        cooldownUntil: p.cooldownUntil,
        failCount: p.failCount,
      }));
  }

  /**
   * Manually rotate to the next profile for a provider.
   * Puts the current active profile into cooldown temporarily.
   * Returns the new active profile, or undefined if none.
   */
  rotate(provider: string): ActiveProfileResult | undefined {
    const current = this.getActiveProfile(provider);
    if (current) {
      // Temporarily put current profile in a minimal cooldown so it's skipped
      current.profile.cooldownUntil = new Date(Date.now() + current.profile.cooldownMs);
    }
    return this.getActiveProfile(provider);
  }

  /**
   * Execute a function with automatic failover across profiles.
   * Tries each profile by priority; on failure marks it and tries the next.
   * On success marks success and returns the result.
   */
  async withFailover<T>(
    provider: string,
    fn: (result: ActiveProfileResult) => Promise<T>
  ): Promise<T> {
    const now = new Date();
    const candidates = Array.from(this.profiles.values())
      .filter((p) => p.provider === provider)
      .filter((p) => !p.cooldownUntil || p.cooldownUntil <= now)
      .sort((a, b) => b.priority - a.priority);

    if (candidates.length === 0) {
      throw new Error(`No active profiles available for provider: ${provider}`);
    }

    let lastError: unknown;
    for (const profile of candidates) {
      try {
        const result = await fn({ profile, resolvedToken: this.resolveToken(profile) });
        this.markSuccess(profile.id);
        return result;
      } catch (err) {
        this.markFailure(profile.id);
        lastError = err;
      }
    }

    throw lastError ?? new Error(`All profiles for provider '${provider}' failed`);
  }

  /**
   * List all profiles, optionally filtered by provider.
   */
  listProfiles(provider?: string): FailoverProfile[] {
    const all = Array.from(this.profiles.values());
    if (provider) return all.filter((p) => p.provider === provider);
    return all;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private resolveToken(profile: FailoverProfile): string | undefined {
    const { credentials } = profile;

    if (credentials.tokenEnv) {
      return process.env[credentials.tokenEnv];
    }

    return credentials.token ?? credentials.apiKey;
  }
}

export function createAuthProfileManager(): AuthProfileManager {
  return new AuthProfileManager();
}
