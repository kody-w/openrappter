import { describe, expect, it, vi } from 'vitest';
import { CopilotCliDirectProvider } from './copilot-cli-direct.js';
import type { CopilotCliDirectRunner } from './copilot-cli-direct.js';

describe('CopilotCliDirectProvider', () => {
  it('never exposes private prompt content through runner failures', async () => {
    const privatePrompt = 'private-patient-fact-7421';
    const provider = new CopilotCliDirectProvider({
      cliPath: '/usr/local/bin/copilot',
      runner: vi.fn(async () => {
        const error = new Error(`command failed with ${privatePrompt}`) as Error & {
          stderr: string;
        };
        error.stderr = `private stderr ${privatePrompt}`;
        throw error;
      }),
    });

    const request = provider.chat([{ role: 'user', content: privatePrompt }]);
    await expect(request).rejects.toThrow('Copilot CLI request failed');
    await request.catch(error => {
      expect((error as Error).message).not.toContain(privatePrompt);
    });
  });

  it('classifies missing authentication without returning stderr', async () => {
    const provider = new CopilotCliDirectProvider({
      cliPath: '/usr/local/bin/copilot',
      runner: vi.fn(async () => {
        const error = new Error('private command') as Error & { stderr: string };
        error.stderr = 'No authentication information found. private-token';
        throw error;
      }),
    });

    await expect(provider.chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Copilot CLI is not authenticated');
  });

  it('disables tools and custom instructions for surgeon consultations', async () => {
    const runner = vi.fn<CopilotCliDirectRunner>(
      async () => ({
        stdout: '{"response":"ok"}',
        stderr: '',
      }),
    );
    const provider = new CopilotCliDirectProvider({
      cliPath: '/usr/local/bin/copilot',
      runner,
    });

    await provider.chat([{ role: 'user', content: 'hello' }]);
    const args = runner.mock.calls[0][1];

    expect(args).toContain('--available-tools=');
    expect(args).toContain('--no-custom-instructions');
    expect(args).toContain('--no-ask-user');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('honors an explicit per-call model without claiming unreported identity', async () => {
    const runner = vi.fn<CopilotCliDirectRunner>(
      async () => ({ stdout: "answer", stderr: "" }),
    );
    const provider = new CopilotCliDirectProvider({
      cliPath: "/usr/local/bin/copilot",
      model: "auto",
      runner,
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "gpt-5.6-sol" },
    );

    const args = runner.mock.calls[0][1];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    expect(response.model).toBeUndefined();
  });
});
