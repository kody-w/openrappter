/**
 * GitHub Copilot CLI provider.
 *
 * Instead of managing its own GitHub OAuth (device-code flow, token refresh,
 * the `copilot_internal/v2/token` exchange) — the process users described as
 * "never works" — this provider shells out to the already-authenticated
 * GitHub Copilot CLI (`copilot -p`). The CLI owns its own credential and
 * refreshes it, so openrappter never has to re-authenticate and the
 * "paste this code at github.com/login/device" prompt goes away entirely.
 *
 * It runs as a plain responder with no tools enabled, so a message from a
 * contact can never make the CLI run a shell command or edit files.
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { LLMProvider, Message, ChatOptions, ProviderResponse } from './types.js';

const execFileAsync = promisify(execFile);

export interface CopilotCLIConfig {
  /** Absolute path to the `copilot` binary. Falls back to CLI discovery. */
  cliPath?: string;
  /** Optional model hint (passed to the CLI when it supports one). */
  model?: string;
  /** Per-call timeout in ms (default 120s). */
  timeoutMs?: number;
}

export class CopilotCLIProvider implements LLMProvider {
  readonly id = 'copilot-cli';
  readonly name = 'GitHub Copilot CLI';

  private cliPath: string;
  private timeoutMs: number;

  constructor(config?: CopilotCLIConfig) {
    this.cliPath = config?.cliPath || CopilotCLIProvider.findCLI() || 'copilot';
    this.timeoutMs = config?.timeoutMs ?? 120_000;
  }

  /** No-op: the CLI owns its own auth. Kept for interface parity. */
  setGithubToken(_token: string): void { /* CLI manages its own credential */ }

  /** Locate the Copilot CLI binary synchronously (for startup provider choice). */
  static findCLI(): string | null {
    const envPath = process.env.OPENRAPPTER_COPILOT_CLI;
    if (envPath && existsSync(envPath)) return envPath;

    const candidates = [
      join(homedir(), 'Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'),
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      join(homedir(), '.copilot/bin/copilot'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
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
    } catch {
      return false;
    }
  }

  async chat(messages: Message[], _options?: ChatOptions): Promise<ProviderResponse> {
    const prompt = this.buildPrompt(messages);
    try {
      const { stdout } = await execFileAsync(
        this.cliPath,
        ['-p', prompt, '--no-color'],
        { timeout: this.timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      );
      const content = this.cleanOutput(stdout);
      return { content: content || null, tool_calls: null };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };
      // A timeout still often produced a partial, usable answer on stdout.
      if (err.stdout) {
        const partial = this.cleanOutput(err.stdout);
        if (partial) return { content: partial, tool_calls: null };
      }
      throw new Error(`Copilot CLI failed: ${err.message}`);
    }
  }

  /** Flatten the message history into a single prompt for `copilot -p`. */
  private buildPrompt(messages: Message[]): string {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n').trim();
    const convo = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    let prompt = '';
    if (system) prompt += system + '\n\n';
    prompt += 'Continue the conversation below as the assistant. Reply with only your next message — no tool use, no preamble, no code fences unless asked.\n\n';
    for (const m of convo) {
      const who = m.role === 'user' ? 'User' : 'Assistant';
      prompt += `${who}: ${m.content}\n`;
    }
    prompt += 'Assistant:';
    return prompt;
  }

  /** Strip ANSI and the CLI's trailing usage footer (Changes/Tokens/Resume…). */
  private cleanOutput(raw: string): string {
    // eslint-disable-next-line no-control-regex
    const noAnsi = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = noAnsi.split('\n');
    const footer = /^(Changes|AI Credits|Tokens|Resume|Total|Session|Model|Usage)\b/;
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (last === '' || footer.test(last) || /^[↑↓●•]/.test(last)) {
        lines.pop();
      } else {
        break;
      }
    }
    return lines.join('\n').trim();
  }
}

export function createCopilotCLIProvider(config?: CopilotCLIConfig): CopilotCLIProvider {
  return new CopilotCLIProvider(config);
}
