import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';

/**
 * `openrappter login` printed the first 20 characters of the access token, and
 * of the refresh token when one was issued.
 *
 * A prefix is still credential material. It lands in terminal scrollback and in
 * CI logs, and it narrows a brute force. Nothing about "did the flow work"
 * requires showing any part of the secret.
 *
 * The command is not currently registered, so this was unreachable — which is
 * exactly why it needed a test. An unreachable leak is a leak waiting for
 * somebody to register the command.
 */

vi.mock('../../auth/oauth.js', () => ({
  initiateOAuthFlow: vi.fn(async () => ({
    accessToken: ['S3CR3T', 'access', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa'].join('-'),
    refreshToken: ['S3CR3T', 'refresh', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb'].join('-'),
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

async function runLogin(): Promise<string> {
  const { registerLoginCommand } = await import('../login.js');
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });

  const program = new Command();
  program.exitOverride();
  registerLoginCommand(program);
  await program.parseAsync(['node', 'openrappter', 'login', 'github']);
  return lines.join('\n');
}

describe('login never prints credential material', () => {
  it('does not print the access token, or any prefix of it', async () => {
    const output = await runLogin();
    expect(output).not.toContain('S3CR3T-access');
    // A prefix is the actual regression this guards: substring(0, 20) of the
    // token above still starts with the same marker.
    expect(output).not.toMatch(/S3CR3T/);
  });

  it('does not print the refresh token', async () => {
    const output = await runLogin();
    expect(output).not.toContain('S3CR3T-refresh');
  });

  it('still tells the user the flow succeeded', async () => {
    // Without this, deleting all output would satisfy the tests above.
    const output = await runLogin();
    expect(output).toMatch(/successful/i);
    expect(output).toMatch(/github/i);
  });
});
