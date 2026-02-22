import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hasCopilotAvailable, resolveGithubToken } from '../../copilot-check.js';

// Mock child_process exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
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

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear relevant env vars
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
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
});
