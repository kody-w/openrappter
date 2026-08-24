import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { hasCopilotAvailable, resolveGithubToken } from '../../copilot-check.js';

// Mock child_process exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));
vi.mock('../../providers/copilot-token.js', () => ({
  resolveCopilotApiToken: vi.fn(async ({ githubToken }: { githubToken: string }) => {
    if (githubToken.startsWith('bad_')) throw new Error('invalid token');
    return { token: 'copilot-token', expiresAt: Date.now() + 60_000 };
  }),
}));
vi.mock('../../auth/github-identity.js', () => ({
  resolveVerifiedGitHubIdentity: vi.fn(async (token: string) => ({
    id: 1,
    login: token === 'mismatched-token' ? 'different-user' : 'verified-user',
  })),
}));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (_fn: unknown) => {
      // Return a function that calls the mocked exec and wraps in promise
      return async (...args: unknown[]) => {
        const { exec } = await import('child_process');
        return new Promise((resolve, reject) => {
          (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            (_cmd: string, cb: (err: Error | null, result?: { stdout: string }) => void) => {
              // This will be controlled by individual test setups
              cb(new Error('gh not available'));
            }
          );
          (exec as unknown as Function)(args[0], (err: Error | null, result?: { stdout: string }) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    },
  };
});

// Mock fs.readFileSync to prevent reading cached tokens from disk during tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('auth-profiles.json')) return false;
        return actual.existsSync(filePath);
      }),
      readFileSync: vi.fn().mockImplementation((...args: unknown[]) => {
        const filePath = args[0] as string;
        // Block reads to credentials and .env files — let other fs reads through
        if (filePath.includes('github-token.json') || filePath.includes('.openrappter/.env')) {
          throw new Error('ENOENT: no such file');
        }
        return actual.readFileSync(...(args as Parameters<typeof actual.readFileSync>));
      }),
    },
    existsSync: vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes('auth-profiles.json')) return false;
      return actual.existsSync(filePath);
    }),
    readFileSync: vi.fn().mockImplementation((...args: unknown[]) => {
      const filePath = args[0] as string;
      if (filePath.includes('github-token.json') || filePath.includes('.openrappter/.env')) {
        throw new Error('ENOENT: no such file');
      }
      return actual.readFileSync(...(args as Parameters<typeof actual.readFileSync>));
    }),
  };
});

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear relevant env vars
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.OPENRAPPTER_DESKTOP_OWNER_PID;
});

afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
});

describe('hasCopilotAvailable', () => {
  it('should return true when COPILOT_GITHUB_TOKEN is set', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'gho_test123';
    expect(await hasCopilotAvailable()).toBe(true);
  });

  it('should return true when GH_TOKEN is set', async () => {
    process.env.GH_TOKEN = 'ghp_test123';
    expect(await hasCopilotAvailable()).toBe(true);
  });

  it('should return true when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test123';
    expect(await hasCopilotAvailable()).toBe(true);
  });

  it('should return false when no token and gh CLI unavailable', async () => {
    expect(await hasCopilotAvailable()).toBe(false);
  });
});

describe('resolveGithubToken', () => {
  it('should prefer COPILOT_GITHUB_TOKEN', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'copilot_token';
    process.env.GH_TOKEN = 'gh_token';
    process.env.GITHUB_TOKEN = 'github_token';
    expect(await resolveGithubToken()).toBe('copilot_token');
  });

  it('should fallback to GH_TOKEN', async () => {
    process.env.GH_TOKEN = 'gh_token';
    process.env.GITHUB_TOKEN = 'github_token';
    expect(await resolveGithubToken()).toBe('gh_token');
  });

  it('should fallback to GITHUB_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'github_token';
    expect(await resolveGithubToken()).toBe('github_token');
  });

  it('should return null when no token available', async () => {
    expect(await resolveGithubToken()).toBeNull();
  });

  it('should return null when every discovered token fails validation', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'bad_stale_token';
    process.env.GH_TOKEN = 'bad_other_token';
    expect(await resolveGithubToken()).toBeNull();
  });

  it('treats an explicit empty profile store as signed out', async () => {
    process.env.GITHUB_TOKEN = 'ambient-token';
    process.env.OPENRAPPTER_DESKTOP_OWNER_PID = '1234';
    vi.mocked(fs.existsSync).mockImplementation((filePath) =>
      String(filePath).includes('auth-profiles.json')
    );
    vi.mocked(fs.readFileSync).mockImplementation((filePath, ...args) => {
      if (String(filePath).includes('auth-profiles.json')) return '[]';
      throw new Error(`Unexpected read: ${String(filePath)} ${String(args)}`);
    });

    expect(await resolveGithubToken()).toBeNull();
  });

  it('does not resurrect an unverified non-default desktop profile', async () => {
    process.env.OPENRAPPTER_DESKTOP_OWNER_PID = '1234';
    vi.mocked(fs.existsSync).mockImplementation((filePath) =>
      String(filePath).includes('auth-profiles.json')
    );
    vi.mocked(fs.readFileSync).mockImplementation((filePath, ...args) => {
      if (String(filePath).includes('auth-profiles.json')) {
        return JSON.stringify([{
          id: 'failed-replacement',
          provider: 'copilot',
          token: 'must-not-be-reactivated',
          default: false,
        }]);
      }
      throw new Error(`Unexpected read: ${String(filePath)} ${String(args)}`);
    });

    expect(await resolveGithubToken()).toBeNull();
  });

  it('requires the stored desktop profile id to match verified GitHub identity', async () => {
    process.env.OPENRAPPTER_DESKTOP_OWNER_PID = '1234';
    vi.mocked(fs.existsSync).mockImplementation((filePath) =>
      String(filePath).includes('auth-profiles.json')
    );
    vi.mocked(fs.readFileSync).mockImplementation((filePath, ...args) => {
      if (String(filePath).includes('auth-profiles.json')) {
        return JSON.stringify([{
          id: 'verified-user',
          provider: 'copilot',
          token: 'verified-token',
          default: true,
        }]);
      }
      throw new Error(`Unexpected read: ${String(filePath)} ${String(args)}`);
    });
    expect(await resolveGithubToken()).toBe('verified-token');

    vi.mocked(fs.readFileSync).mockImplementation((filePath, ...args) => {
      if (String(filePath).includes('auth-profiles.json')) {
        return JSON.stringify([{
          id: 'verified-user',
          provider: 'copilot',
          token: 'mismatched-token',
          default: true,
        }]);
      }
      throw new Error(`Unexpected read: ${String(filePath)} ${String(args)}`);
    });
    expect(await resolveGithubToken()).toBeNull();
  });
});
