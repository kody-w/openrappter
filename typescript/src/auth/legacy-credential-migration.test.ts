import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  migrateLegacyDesktopCredential,
  retireMatchingLegacyCredentialCopies,
} from './legacy-credential-migration.js';
import { AuthProfileStore } from './profiles.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(process.cwd(), '.auth-migration-test-'));
  roots.push(value);
  return value;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('legacy desktop credential migration', () => {
  it('leaves one private raw-token copy in the profile authority', async () => {
    const dataDir = root();
    const credentialsDir = path.join(dataDir, 'credentials');
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const legacyPath = path.join(credentialsDir, 'github-token.json');
    const envPath = path.join(dataDir, '.env');
    const token = 'mock-legacy-token-one-copy';
    writeFileSync(legacyPath, JSON.stringify({ token }), { mode: 0o600 });
    writeFileSync(
      envPath,
      `OTHER=value\nGITHUB_TOKEN=${token}\n`,
      { mode: 0o600 },
    );

    await migrateLegacyDesktopCredential({
      token,
      dataDir,
      legacyPath,
      envPath,
      validateToken: vi.fn(async () => undefined),
      resolveIdentity: vi.fn(async () => ({ id: 7, login: 'octocat' })),
    });

    expect(existsSync(legacyPath)).toBe(false);
    const tokenFiles = filesUnder(dataDir).filter((file) =>
      readFileSync(file, 'utf8').includes(token)
    );
    expect(tokenFiles).toEqual([path.join(dataDir, 'auth-profiles.json')]);
    expect(readFileSync(envPath, 'utf8')).toContain('OTHER=value');
    expect(statSync(tokenFiles[0]).mode & 0o777).toBe(0o600);
    expect(filesUnder(dataDir).some((file) => file.endsWith('.tmp'))).toBe(false);
    expect(new AuthProfileStore(dataDir).get('copilot')?.id).toBe('octocat');
  });

  it('rolls back the profile when retiring the legacy copy fails', async () => {
    const dataDir = root();
    const credentialsDir = path.join(dataDir, 'credentials');
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const legacyPath = path.join(credentialsDir, 'github-token.json');
    const token = 'mock-legacy-token-rollback';
    writeFileSync(legacyPath, JSON.stringify({ token }), { mode: 0o600 });
    chmodSync(legacyPath, 0o600);

    await expect(migrateLegacyDesktopCredential({
      token,
      dataDir,
      legacyPath,
      validateToken: vi.fn(async () => undefined),
      resolveIdentity: vi.fn(async () => ({ id: 7, login: 'octocat' })),
      unlink: (target) => {
        rmSync(target);
        throw new Error('retire failed');
      },
    })).rejects.toThrow('Legacy GitHub credential cleanup failed.');

    const tokenFiles = filesUnder(dataDir).filter((file) =>
      readFileSync(file, 'utf8').includes(token)
    );
    expect(tokenFiles).toEqual([legacyPath]);
    expect(existsSync(path.join(dataDir, 'auth-profiles.json'))).toBe(false);
  });

  it('refuses nonmatching legacy credentials without deleting either copy', () => {
    const dataDir = root();
    const credentialsDir = path.join(dataDir, 'credentials');
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const legacyPath = path.join(credentialsDir, 'github-token.json');
    const envPath = path.join(dataDir, '.env');
    writeFileSync(
      legacyPath,
      JSON.stringify({ token: 'different-legacy-token' }),
      { mode: 0o600 },
    );
    writeFileSync(envPath, 'GITHUB_TOKEN=active-profile-token\n', {
      mode: 0o600,
    });

    expect(() => retireMatchingLegacyCredentialCopies({
      token: 'active-profile-token',
      legacyPath,
      envPath,
    })).toThrow('does not match the active profile');
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('active-profile-token');
  });
});
