/**
 * Direct GitHub Copilot CLI provider — zero token configuration.
 *
 * Shells the already-authenticated `copilot -p` CLI, which owns its own
 * credential and refresh. Unlike a token-based provider, this needs nothing
 * configured: if `copilot` runs on this machine, openrappter can think — no
 * device-code flow, no expiring GitHub token, no 401s.
 *
 * Runs as a plain responder with no tools, so an inbound message can never
 * make the CLI run a shell command or edit files.
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { LLMProvider, Message, ChatOptions, ProviderResponse } from './types.js';

const execFileAsync = promisify(execFile);

export interface CopilotCliDirectOptions {
  cliPath?: string;
  model?: string;
  timeoutMs?: number;
  runner?: CopilotCliDirectRunner;
}

export type CopilotCliDirectRunner = (
  executable: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export class CopilotCliDirectProvider implements LLMProvider {
  readonly id = 'copilot-cli-direct';
  readonly name = 'GitHub Copilot CLI (direct)';

  private cliPath: string;
  private model: string;
  private timeoutMs: number;
  private runner: CopilotCliDirectRunner;

  constructor(config?: CopilotCliDirectOptions) {
    this.cliPath = config?.cliPath || CopilotCliDirectProvider.findCLI() || 'copilot';
    this.model = config?.model?.trim() || 'auto';
    this.timeoutMs = config?.timeoutMs ?? 120_000;
    this.runner = config?.runner ?? (
      async (executable, args, options) => execFileAsync(
        executable,
        args,
        options,
      )
    );
  }

  setGithubToken(_token: string): void { /* CLI owns its own credential */ }

  static findCLI(): string | null {
    const envPath = process.env.OPENRAPPTER_COPILOT_CLI || process.env.COPILOT_CLI_PATH;
    if (envPath && existsSync(envPath)) return envPath;
    const candidates = [
      join(homedir(), 'Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'),
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      join(homedir(), '.copilot/bin/copilot'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    try {
      const p = execSync('command -v copilot', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p && existsSync(p)) return p;
    } catch { /* not on PATH */ }
    return null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.cliPath, ['--version'], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }

  async chat(messages: Message[], _options?: ChatOptions): Promise<ProviderResponse> {
    const prompt = this.buildPrompt(messages);
    try {
      const { stdout } = await this.runner(
        this.cliPath,
        [
          '--prompt',
          prompt,
          '--silent',
          '--no-color',
          '--no-remote',
          '--no-remote-export',
          '--no-auto-update',
          '--no-custom-instructions',
          '--no-ask-user',
          '--model',
          this.model,
          '--available-tools=',
        ],
        { timeout: this.timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      );
      const content = this.cleanOutput(stdout);
      return { content: content || null, tool_calls: null };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      if (err.stderr?.includes('No authentication information found')) {
        throw new Error('Copilot CLI is not authenticated');
      }
      throw new Error('Copilot CLI request failed');
    }
  }

  private buildPrompt(messages: Message[]): string {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n').trim();
    const convo = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    let prompt = '';
    if (system) prompt += system + '\n\n';
    prompt += 'Continue the conversation below as the assistant. Reply with only your next message — no tool use, no preamble.\n\n';
    for (const m of convo) {
      prompt += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n`;
    }
    prompt += 'Assistant:';
    return prompt;
  }

  private cleanOutput(raw: string): string {
    // eslint-disable-next-line no-control-regex
    const noAnsi = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = noAnsi.split('\n');
    const footer = /^(Changes|AI Credits|Tokens|Resume|Total|Session|Model|Usage)\b/;
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (last === '' || footer.test(last) || /^[↑↓●•]/.test(last)) lines.pop();
      else break;
    }
    return lines.join('\n').trim();
  }
}
