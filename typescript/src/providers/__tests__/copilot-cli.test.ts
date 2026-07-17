import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COPILOT_CLI_MAX_PROMPT_BYTES,
  COPILOT_CLI_MAX_TIMEOUT_MS,
  CopilotCliProvider,
  type CopilotCliHomePreparer,
  type CopilotCliPromptAttachmentPreparer,
  type CopilotCliRunner,
  type CopilotCliRunOptions,
  type CopilotCliRunResult,
} from '../copilot-cli.js';

interface RunnerCall {
  executable: string;
  args: readonly string[];
  options: CopilotCliRunOptions;
}

function captureRunner(
  result: CopilotCliRunResult = {
    stdout: '  next assistant message \n',
    exitCode: 0,
  },
): { calls: RunnerCall[]; runner: CopilotCliRunner } {
  const calls: RunnerCall[] = [];
  return {
    calls,
    runner: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return result;
    },
  };
}

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: '/Users/mobile',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    COPILOT_GITHUB_TOKEN: 'copilot-token',
    ...overrides,
  };
}

describe('CopilotCliProvider', () => {
  it('uses isolated argv with no tools and parses plain output', async () => {
    const { calls, runner } = captureRunner();
    const homePreparer = vi.fn<CopilotCliHomePreparer>(async () => {});
    const copilotHome = '/Users/mobile/.openrappter/copilot-imessage-home';
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      copilotHome,
      env: testEnv({ COPILOT_CLI_PATH: '/opt/homebrew/bin/copilot' }),
      runner,
      homePreparer,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });
    const hostileText = `hello'; touch should-not-run; echo "$HOME"`;

    const response = await provider.chat(
      [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: hostileText },
      ],
      {
        tools: [{
          type: 'function',
          function: {
            name: 'dangerous_tool',
            description: 'Must never be exposed',
            parameters: {},
          },
        }],
      },
    );

    expect(response).toEqual({
      content: 'next assistant message',
      tool_calls: null,
    });
    expect(homePreparer).toHaveBeenCalledWith(copilotHome, 0o700);
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call.executable).toBe('/opt/homebrew/bin/copilot');
    expect(call.options).toMatchObject({
      cwd: copilotHome,
      shell: false,
      timeoutMs: COPILOT_CLI_MAX_TIMEOUT_MS,
    });
    expect(call.args).toEqual([
      '--prompt',
      expect.any(String),
      '--silent',
      '--no-remote',
      '--no-remote-export',
      '--no-auto-update',
      '--no-custom-instructions',
      '--no-ask-user',
      '--model',
      'gpt-5.6-sol',
      '--effort',
      'max',
      '--available-tools=',
    ]);
    const transcript = JSON.parse(
      call.args[1].split('Transcript JSON:\n')[1],
    ) as Array<{ content: string }>;
    expect(transcript.at(-1)?.content).toBe(hostileText);
    expect(call.args).not.toContain('dangerous_tool');
  });

  it('keeps valid bounded transcript JSON with the system and newest turns', async () => {
    const { calls, runner } = captureRunner();
    const messages = [
      { role: 'system' as const, content: 'System says "stay concise".' },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `turn-${index}: ${'x'.repeat(120)}`,
      })),
      {
        role: 'user' as const,
        content: 'newest "quoted" turn\nwith a newline and 🦖',
      },
    ];
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: testEnv(),
      runner,
      homePreparer: async () => {},
      maxPromptBytes: 1_400,
    });

    await provider.chat(messages);

    const prompt = calls[0].args[1];
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(1_400);
    expect(prompt).toContain('Return only the next assistant message');
    const serialized = prompt.split('Transcript JSON:\n')[1];
    const transcript = JSON.parse(serialized) as Array<{
      role: string;
      content: string;
    }>;
    expect(transcript[0]).toEqual(messages[0]);
    expect(transcript.at(-1)).toEqual(messages.at(-1));
    expect(transcript.length).toBeLessThan(messages.length);
    expect(transcript.length).toBeGreaterThan(2);
  });

  it('keeps private transcripts out of argv with attachment transport', async () => {
    const { calls, runner } = captureRunner();
    const cleanup = vi.fn(async () => {});
    let attachedPrompt = '';
    const promptAttachmentPreparer: CopilotCliPromptAttachmentPreparer =
      vi.fn(async prompt => {
        attachedPrompt = prompt;
        return {
          path: '/private/prompt.docx',
          cleanup,
        };
      });
    const provider = new CopilotCliProvider({
      env: testEnv(),
      runner,
      homePreparer: async () => {},
      promptAttachmentPreparer,
    });
    const privateMessage = 'private message 7421';

    await provider.chat([{ role: 'user', content: privateMessage }]);

    expect(attachedPrompt).toContain(privateMessage);
    expect(calls[0].args.join(' ')).not.toContain(privateMessage);
    expect(calls[0].args).toContain('--attachment');
    expect(calls[0].args).toContain('/private/prompt.docx');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('aborts an active private prompt and still cleans its attachment', async () => {
    const cleanup = vi.fn(async () => {});
    const controller = new AbortController();
    const provider = new CopilotCliProvider({
      env: testEnv(),
      homePreparer: async () => {},
      promptTransport: 'attachment',
      promptAttachmentPreparer: async () => ({
        path: '/private/prompt.docx',
        cleanup,
      }),
      runner: async (_executable, _args, options) =>
        new Promise(resolve => {
          options.signal?.addEventListener('abort', () => {
            resolve({ stdout: '', exitCode: null });
          }, { once: true });
        }),
    });

    const request = provider.chat(
      [{ role: 'user', content: 'private' }],
      { signal: controller.signal },
    );
    controller.abort();

    await expect(request).rejects.toThrow('request aborted');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('allows only base process fields, the isolated home, and the first token', async () => {
    const { calls, runner } = captureRunner();
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      copilotHome: '/isolated/copilot-home',
      env: testEnv({
        TMPDIR: '/private/var/folders/mobile',
        LANG: 'en_US.UTF-8',
        GH_TOKEN: 'second-token',
        GITHUB_TOKEN: 'third-token',
        OPENAI_API_KEY: 'unrelated-secret',
        AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
        NODE_OPTIONS: '--require=untrusted.js',
      }),
      runner,
      homePreparer: async () => {},
    });

    await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(calls[0].options.env).toEqual({
      HOME: '/Users/mobile',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      TMPDIR: '/private/var/folders/mobile',
      LANG: 'en_US.UTF-8',
      COPILOT_HOME: '/isolated/copilot-home',
      COPILOT_GITHUB_TOKEN: 'copilot-token',
    });
  });

  it('uses supported token fallbacks and its private default home', async () => {
    const { calls, runner } = captureRunner();
    const homePreparer = vi.fn<CopilotCliHomePreparer>(async () => {});
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: {
        HOME: '/Users/mobile',
        PATH: '/usr/bin:/bin',
        GH_TOKEN: 'fallback-token',
      },
      runner,
      homePreparer,
    });

    await provider.chat([{ role: 'user', content: 'hello' }]);

    const expectedHome = path.join(
      homedir(),
      '.openrappter',
      'copilot-imessage-home',
    );
    expect(homePreparer).toHaveBeenCalledWith(expectedHome, 0o700);
    expect(calls[0].options.env).toMatchObject({
      COPILOT_HOME: expectedHome,
      GH_TOKEN: 'fallback-token',
    });
    expect(calls[0].options.env).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
  });

  it('switches the isolated token without retaining the previous account', async () => {
    const { calls, runner } = captureRunner();
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: testEnv({
        COPILOT_GITHUB_TOKEN: 'old-token',
        GH_TOKEN: 'older-fallback',
      }),
      runner,
      homePreparer: async () => {},
    });

    provider.updateToken('new-token');
    await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(calls[0].options.env).toMatchObject({
      COPILOT_GITHUB_TOKEN: 'new-token',
    });
    expect(calls[0].options.env).not.toHaveProperty('GH_TOKEN');
    expect(JSON.stringify(calls[0].options.env)).not.toContain('old-token');
  });

  it('caps configurable prompt and timeout bounds', async () => {
    const { calls, runner } = captureRunner();
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: testEnv(),
      runner,
      homePreparer: async () => {},
      maxPromptBytes: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    await provider.chat([{
      role: 'user',
      content: 'x'.repeat(COPILOT_CLI_MAX_PROMPT_BYTES * 2),
    }]);

    expect(Buffer.byteLength(calls[0].args[1], 'utf8'))
      .toBeLessThanOrEqual(COPILOT_CLI_MAX_PROMPT_BYTES);
    expect(calls[0].options.timeoutMs).toBe(COPILOT_CLI_MAX_TIMEOUT_MS);
    const transcript = JSON.parse(
      calls[0].args[1].split('Transcript JSON:\n')[1],
    ) as Array<{ content: string }>;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].content).toContain('[truncated]');
  });

  it('reports availability without invoking the command', async () => {
    const runner = vi.fn<CopilotCliRunner>();
    const available = new CopilotCliProvider({
      env: testEnv(),
      runner,
    });
    const unavailable = new CopilotCliProvider({
      env: { HOME: '/Users/mobile', PATH: '/usr/bin:/bin' },
      runner,
    });

    await expect(available.isAvailable()).resolves.toBe(true);
    await expect(unavailable.isAvailable()).resolves.toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('falls back to the CLI default model without exposing the failed model', async () => {
    const calls: RunnerCall[] = [];
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: testEnv(),
      homePreparer: async () => {},
      fallbackModels: [''],
      runner: async (executable, args, options) => {
        calls.push({ executable, args, options });
        return calls.length === 1
          ? { stdout: '', stderr: 'private model error', exitCode: 2 }
          : { stdout: 'fallback response', exitCode: 0 };
      },
    });

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }]),
    ).resolves.toEqual({
      content: 'fallback response',
      tool_calls: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('gpt-5.6-sol');
    expect(calls[1].args).not.toContain('--model');
  });

  it('rejects a missing token before preparing the home or running', async () => {
    const runner = vi.fn<CopilotCliRunner>();
    const homePreparer = vi.fn<CopilotCliHomePreparer>();
    const provider = new CopilotCliProvider({
      env: { HOME: '/Users/mobile', PATH: '/usr/bin:/bin' },
      runner,
      homePreparer,
    });

    await expect(provider.chat([{ role: 'user', content: 'private prompt' }]))
      .rejects.toThrow('Copilot CLI token is not configured');
    expect(homePreparer).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'nonzero exit',
      result: {
        stdout: '',
        stderr: 'private-stderr',
        exitCode: 2,
      } satisfies CopilotCliRunResult,
      error: 'Copilot CLI request failed',
    },
    {
      name: 'timeout',
      result: {
        stdout: '',
        stderr: 'private-stderr',
        exitCode: null,
        timedOut: true,
      } satisfies CopilotCliRunResult,
      error: 'Copilot CLI request timed out',
    },
    {
      name: 'empty output',
      result: {
        stdout: ' \n ',
        exitCode: 0,
      } satisfies CopilotCliRunResult,
      error: 'Copilot CLI returned an empty response',
    },
  ])('returns a content-free error for $name', async ({ result, error }) => {
    const { runner } = captureRunner(result);
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: testEnv(),
      runner,
      homePreparer: async () => {},
    });

    const rejection = provider.chat([{
      role: 'user',
      content: 'private-prompt',
    }]);
    await expect(rejection).rejects.toThrow(error);
    await rejection.catch(caught => {
      expect((caught as Error).message).not.toContain('private-prompt');
      expect((caught as Error).message).not.toContain('private-stderr');
      expect((caught as Error).message).not.toContain('copilot-token');
    });
  });

  it('does not expose runner errors', async () => {
    const provider = new CopilotCliProvider({
      promptTransport: 'argv',
      env: testEnv(),
      runner: async () => {
        throw new Error('private-prompt private-stderr copilot-token');
      },
      homePreparer: async () => {},
    });

    await expect(provider.chat([{ role: 'user', content: 'private-prompt' }]))
      .rejects.toThrow('Copilot CLI request failed');
  });
});
