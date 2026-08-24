import fs from 'fs';
import path from 'path';
import { AuthProfileStore } from './profiles.js';
import {
  resolveVerifiedGitHubIdentity,
  type VerifiedGitHubIdentity,
} from './github-identity.js';

export async function migrateLegacyDesktopCredential(options: {
  token: string;
  dataDir: string;
  legacyPath: string;
  envPath?: string;
  validateToken: (token: string) => Promise<unknown>;
  resolveIdentity?: (token: string) => Promise<VerifiedGitHubIdentity>;
  unlink?: (target: string) => void;
}): Promise<{ token: string; username: string }> {
  await options.validateToken(options.token);
  const identity = await (
    options.resolveIdentity ?? resolveVerifiedGitHubIdentity
  )(options.token);
  const store = new AuthProfileStore(options.dataDir);
  if (store.hasPersistedState()) {
    throw new Error('Desktop profile authority already exists.');
  }

  store.add({
    id: identity.login,
    provider: 'copilot',
    type: 'device-code',
    token: options.token,
    default: true,
  });
  const profilePath = path.join(options.dataDir, 'auth-profiles.json');
  try {
    const persisted = JSON.parse(
      fs.readFileSync(profilePath, 'utf8'),
    ) as Array<{ id?: unknown; token?: unknown; default?: unknown }>;
    if (!persisted.some((profile) =>
      profile.id === identity.login
      && profile.token === options.token
      && profile.default === true
    )) {
      throw new Error('Migrated desktop profile was not persisted.');
    }
  } catch (error) {
    try {
      fs.unlinkSync(profilePath);
    } catch {
      // No profile was committed, so the legacy copy remains authoritative.
    }
    throw error;
  }

  try {
    retireMatchingLegacyCredentialCopies({
      token: options.token,
      legacyPath: options.legacyPath,
      envPath: options.envPath,
      unlink: options.unlink,
    });
  } catch (error) {
    store.remove('copilot', identity.login, { promoteReplacement: false });
    try {
      fs.unlinkSync(profilePath);
    } catch {
      // The rollback write may already have removed the only token copy.
    }
    throw error;
  }
  return { token: options.token, username: identity.login };
}

export function retireMatchingLegacyCredentialCopies(options: {
  token: string;
  legacyPath: string;
  envPath?: string;
  unlink?: (target: string) => void;
}): { retired: string[] } {
  const legacyBytes = fs.existsSync(options.legacyPath)
    ? fs.readFileSync(options.legacyPath)
    : undefined;
  if (legacyBytes) {
    let legacyToken: unknown;
    try {
      legacyToken = (
        JSON.parse(legacyBytes.toString('utf8')) as { token?: unknown }
      ).token;
    } catch {
      throw new Error('Legacy GitHub credential cleanup failed.');
    }
    if (legacyToken !== options.token) {
      throw new Error('Legacy GitHub credential does not match the active profile.');
    }
  }

  const envBytes = options.envPath && fs.existsSync(options.envPath)
    ? fs.readFileSync(options.envPath)
    : undefined;
  let retainedEnv: string | undefined;
  if (envBytes) {
    const original = envBytes.toString('utf8');
    const retained: string[] = [];
    for (const line of original.split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:COPILOT_GITHUB_TOKEN|GITHUB_TOKEN)\s*=\s*(.*)\s*$/,
      );
      if (!match) {
        retained.push(line);
        continue;
      }
      const raw = match[1].trim();
      const value = (
        (raw.startsWith('"') && raw.endsWith('"'))
        || (raw.startsWith("'") && raw.endsWith("'"))
      ) ? raw.slice(1, -1) : raw;
      if (value !== options.token) {
        throw new Error(
          'Legacy environment credential does not match the active profile.',
        );
      }
    }
    const next = retained.join('\n');
    if (next !== original) retainedEnv = next;
  }

  const retired: string[] = [];
  try {
    if (legacyBytes) {
      (options.unlink ?? fs.unlinkSync)(options.legacyPath);
      retired.push(options.legacyPath);
    }
    if (options.envPath && envBytes && retainedEnv !== undefined) {
      atomicPrivateReplace(options.envPath, retainedEnv);
      retired.push(options.envPath);
    }
  } catch (cause) {
    try {
      if (legacyBytes && !fs.existsSync(options.legacyPath)) {
        fs.writeFileSync(options.legacyPath, legacyBytes, { mode: 0o600 });
        fs.chmodSync(options.legacyPath, 0o600);
      }
      if (options.envPath && envBytes && retired.includes(options.envPath)) {
        atomicPrivateReplace(options.envPath, envBytes);
      }
    } catch {
      // Cleanup remains failed and is surfaced without credential material.
    }
    throw new Error('Legacy GitHub credential cleanup failed.', { cause });
  }
  return { retired };
}

function atomicPrivateReplace(
  target: string,
  content: string | Uint8Array,
): void {
  const temporary = `${target}.${process.pid}.migration.tmp`;
  const backup = `${target}.${process.pid}.migration.bak`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(target, backup);
  try {
    fs.renameSync(temporary, target);
    fs.unlinkSync(backup);
  } catch (error) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(backup, target);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // The caller will roll back profile activation and surface the failure.
    }
    throw error;
  }
}
