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

  const legacyBytes = fs.readFileSync(options.legacyPath);
  const envBytes = options.envPath && fs.existsSync(options.envPath)
    ? fs.readFileSync(options.envPath)
    : undefined;
  let envRetired = false;
  try {
    (options.unlink ?? fs.unlinkSync)(options.legacyPath);
    if (options.envPath && envBytes) {
      const original = envBytes.toString('utf8');
      const retained = original
        .split(/\r?\n/)
        .filter((line) => {
          const match = line.match(/^\s*(?:COPILOT_GITHUB_TOKEN|GITHUB_TOKEN)\s*=\s*(.*)\s*$/);
          if (!match) return true;
          const raw = match[1].trim();
          const value = (
            (raw.startsWith('"') && raw.endsWith('"'))
            || (raw.startsWith("'") && raw.endsWith("'"))
          ) ? raw.slice(1, -1) : raw;
          return value !== options.token;
        })
        .join('\n');
      if (retained !== original) {
        atomicPrivateReplace(options.envPath, retained);
        envRetired = true;
      }
    }
  } catch (error) {
    try {
      if (!fs.existsSync(options.legacyPath)) {
        fs.writeFileSync(options.legacyPath, legacyBytes, { mode: 0o600 });
        fs.chmodSync(options.legacyPath, 0o600);
      }
      if (envRetired && options.envPath && envBytes) {
        atomicPrivateReplace(options.envPath, envBytes);
      }
    } catch {
      // Profile rollback below still prevents the migrated copy becoming active.
    }
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
