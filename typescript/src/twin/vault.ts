/**
 * The twin vault — where the person lives, and why it cannot escape.
 *
 * The whole promise is "the engine is public, the consciousness is local", and
 * a promise that is only documented is a promise that gets broken. So this file
 * enforces it:
 *
 *   1. The vault refuses to be created inside a git working tree. `~/.openrappter`
 *      is BOTH a checkout of the public repo AND the runtime home — that trap
 *      already nearly leaked credentials once — so the default lives at
 *      `~/.rapp/twin/`, outside any repo.
 *   2. It is written 0600 in a 0700 directory. A twin is as sensitive as a
 *      password file and should look like one on disk.
 *   3. The only export path produces counts, never values, so "share your twin"
 *      cannot silently become "share yourself".
 *
 * Everything here is device-local. Nothing in this module makes a network call.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { TWIN_SCHEMA_VERSION, emptyProfile } from './types.js';
import type { TwinProfile, TwinShape } from './types.js';

/** Outside every repo, on purpose. See rule 1 above. */
export const DEFAULT_VAULT = join(homedir(), '.rapp', 'twin');

export class TwinVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwinVaultError';
  }
}

/**
 * Walk up looking for a `.git`. A vault inside a working tree is one
 * `git add -A` away from being public, so this is a hard failure, not a warning.
 */
export function findEnclosingRepo(startPath: string): string | null {
  let current = resolve(startPath);

  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface VaultOptions {
  dir?: string;
  /**
   * Escape hatch for tests only. Production code must never set this: a vault
   * in a working tree is exactly the leak this module exists to prevent.
   */
  allowInsideRepo?: boolean;
}

export class TwinVault {
  readonly dir: string;
  readonly profilePath: string;
  private readonly allowInsideRepo: boolean;

  constructor(options: VaultOptions = {}) {
    this.dir = resolve(options.dir ?? process.env.RAPP_TWIN_HOME ?? DEFAULT_VAULT);
    this.profilePath = join(this.dir, 'profile.json');
    this.allowInsideRepo = options.allowInsideRepo ?? false;
  }

  /** Throws if this location would put the twin inside a repo. */
  assertSafeLocation(): void {
    if (this.allowInsideRepo) return;

    const repo = findEnclosingRepo(this.dir);
    if (repo) {
      throw new TwinVaultError(
        `refusing to put the twin inside a git repository.\n` +
          `  vault: ${this.dir}\n` +
          `  repo:  ${repo}\n\n` +
          `Your twin is personal; a repository is one command away from being public.\n` +
          `Use the default (${DEFAULT_VAULT}) or set RAPP_TWIN_HOME somewhere outside a repo.`,
      );
    }
  }

  exists(): boolean {
    return existsSync(this.profilePath);
  }

  init(name: string, id?: string): TwinProfile {
    this.assertSafeLocation();

    if (this.exists()) return this.load();

    const now = new Date().toISOString();
    const profile = emptyProfile(id ?? `twin_${createHash('sha256').update(`${name}${now}`).digest('hex').slice(0, 12)}`, name, now);
    this.save(profile);
    return profile;
  }

  load(): TwinProfile {
    if (!this.exists()) {
      throw new TwinVaultError(`no twin at ${this.dir} — run \`openrappter twin init\` first`);
    }

    let parsed: TwinProfile;
    try {
      parsed = JSON.parse(readFileSync(this.profilePath, 'utf8')) as TwinProfile;
    } catch (error) {
      throw new TwinVaultError(`twin profile is unreadable: ${(error as Error).message}`);
    }

    return this.migrate(parsed);
  }

  /** Forward-only migration, so an older vault keeps working. */
  private migrate(profile: TwinProfile): TwinProfile {
    const migrated: TwinProfile = {
      ...emptyProfile(profile.id ?? 'twin', profile.identity?.name ?? 'Owner', profile.createdAt ?? new Date().toISOString()),
      ...profile,
      version: TWIN_SCHEMA_VERSION,
    };

    // Defend against a hand-edited file with missing sections.
    migrated.identity ??= { name: 'Owner' };
    migrated.roles ??= [];
    migrated.voice ??= { tone: [], avoid: [], signatures: [] };
    migrated.context ??= { projects: [], people: [], tools: [], facts: [] };
    migrated.boundaries ??= { mayDo: [], mustAsk: [], neverDo: [] };
    migrated.accounts ??= {};

    return migrated;
  }

  save(profile: TwinProfile): void {
    this.assertSafeLocation();

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best effort — some filesystems (and Windows) do not support this.
    }

    const next: TwinProfile = { ...profile, version: TWIN_SCHEMA_VERSION, updatedAt: new Date().toISOString() };

    // Write-then-rename, so an interrupted save cannot truncate the twin.
    const temporary = `${this.profilePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.profilePath);

    try {
      chmodSync(this.profilePath, 0o600);
    } catch {
      /* best effort */
    }
  }

  /** True when the file is not readable by anyone else. */
  isPrivate(): boolean {
    if (!this.exists()) return true;
    try {
      return (statSync(this.profilePath).mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
}

/**
 * A stable id for a twin that reveals nothing about it.
 *
 * Salted with the id so the same name on two machines does not produce the
 * same fingerprint — otherwise the "safe" export would leak set membership.
 */
export function fingerprint(profile: TwinProfile): string {
  const material = [
    profile.id,
    profile.identity.name,
    profile.roles.length,
    profile.context.projects.length,
    profile.context.people.length,
    profile.voice.tone.length,
  ].join('|');

  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * The ONLY sanctioned way a twin leaves the device.
 *
 * Counts and field names, never a value. Deliberately built by listing the
 * fields to include rather than the ones to strip: a redaction list forgets
 * about the field someone adds next month, an allowlist cannot.
 */
export function toShape(profile: TwinProfile): TwinShape {
  return {
    schema: 'rapp-twin-shape/1.0',
    version: profile.version,
    present: {
      identity: Object.entries(profile.identity)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key]) => key)
        .sort(),
      roles: profile.roles.length,
      voice: {
        tone: profile.voice.tone.length,
        avoid: profile.voice.avoid.length,
        signatures: profile.voice.signatures.length,
      },
      context: {
        projects: profile.context.projects.length,
        people: profile.context.people.length,
        tools: profile.context.tools.length,
        facts: profile.context.facts.length,
      },
      boundaries: {
        mayDo: profile.boundaries.mayDo.length,
        mustAsk: profile.boundaries.mustAsk.length,
        neverDo: profile.boundaries.neverDo.length,
      },
      accounts: Object.keys(profile.accounts).length,
    },
    fingerprint: fingerprint(profile),
  };
}
