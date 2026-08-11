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
import { writeMcpBridgeConfig, toolArgsFor, copilotHomeDir, type McpBridgeConfig } from './copilot-cli-mcp.js';
import { resolveLocalCopilotCliPath } from './copilot-cli-local.js';
import { invocationsSince } from '../agents/invocation-journal.js';

const execFileAsync = promisify(execFile);

/**
 * A PATH that still finds the CLI when the daemon was not started from a shell.
 *
 * A menu-bar app launched from Finder inherits launchd's session environment,
 * whose PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew — and the daemon
 * it spawns inherits that too. `/opt/homebrew/bin/copilot` then becomes
 * unreachable even though it is installed, which is what "Copilot CLI failed"
 * actually was on this machine: the daemon's PATH contained no `copilot` at all.
 *
 * It matters twice over, because both entrypoints need PATH:
 *   · the real binary is `#!/usr/bin/env node`, so it needs `node`;
 *   · the VS Code wrapper shells `copilot --version` to find the real one.
 *
 * Mirrors `ProcessManager.nodeSearchPath()` on the Swift side.
 */
export function resolveSpawnPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  const dirs = [
    join(home, '.local/bin'),
    join(home, '.volta/bin'),
    join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const existing = (env.PATH || '').split(':').filter(Boolean);
  const seen = new Set<string>();
  // Existing entries first: an operator's explicit PATH still wins, and these
  // known locations act as a floor rather than an override.
  return [...existing, ...dirs].filter((d) => (d && !seen.has(d) ? (seen.add(d), true) : false)).join(':');
}

export interface CopilotCliDirectOptions {
  cliPath?: string;
  model?: string;
  timeoutMs?: number;
  runner?: CopilotCliDirectRunner;
  /**
   * Expose the agent registry to the CLI over MCP.
   *
   * The CLI takes tools only through MCP, so without this it is run with an
   * empty allow-list and cannot invoke a single agent — which makes hot-loading
   * an agent the assistant then cannot call a feature that does nothing.
   */
  exposeAgents?: boolean;
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
  private readonly exposeAgents: boolean;
  private mcpBridge: McpBridgeConfig | null = null;
  private mcpBridgeResolved = false;

  constructor(config?: CopilotCliDirectOptions) {
    this.exposeAgents = config?.exposeAgents ?? false;
    this.cliPath = config?.cliPath || CopilotCliDirectProvider.findCLI() || 'copilot';
    this.model = config?.model?.trim() || 'auto';
    this.timeoutMs = config?.timeoutMs ?? 120_000;
    this.runner = config?.runner ?? (
      async (executable, args, options) => execFileAsync(
        executable,
        args,
        // Without an enriched PATH the CLI cannot find `node` (it is a
        // `#!/usr/bin/env node` script), so a daemon started outside a shell
        // fails before it ever reaches Copilot.
        { ...options, env: { ...process.env, PATH: resolveSpawnPath() } },
      )
    );
  }

  /**
   * Tool arguments for a run: the MCP bridge when agents are exposed, the
   * original empty allow-list when they are not.
   *
   * Resolved lazily and once — the built entry point does not exist in every
   * context this provider is constructed in.
   */
  private toolArgs(): string[] {
    if (!this.exposeAgents) return ['--available-tools='];
    if (!this.mcpBridgeResolved) {
      this.mcpBridge = writeMcpBridgeConfig(copilotHomeDir());
      this.mcpBridgeResolved = true;
    }
    return toolArgsFor(this.mcpBridge);
  }

  setGithubToken(_token: string): void { /* CLI owns its own credential */ }

  /**
   * Where to look for the CLI, best first.
   *
   * Exposed so the ORDER is testable — the ordering is what carries the fix,
   * and an ordering that only exists inside a loop over the real filesystem
   * cannot be asserted on.
   *
   * The FIRST entry is this repository's own lockfile-pinned copy. It leads
   * because it is the binary that shipped with this commit, at a version the
   * lockfile records, from its publisher — whereas everything below it is an
   * ambient global whose version is decided by someone else's `copilot update`.
   * Preferring the pin is what stops two machines on the same openrappter
   * commit from silently running different CLIs. It is a preference and not a
   * requirement: a checkout that never ran `npm ci` simply falls through.
   *
   * The VS Code entry is not the CLI. It is a 300-byte shim that runs VS Code's
   * Electron helper, which then shells `copilot --version` to locate the real
   * binary — so preferring it takes a hard dependency on VS Code being installed
   * AND the real CLI being on PATH. Real installs first; the shim is a last
   * resort for machines where Copilot CLI only ever arrived through VS Code.
   */
  static candidatePaths(home: string = homedir()): string[] {
    const pinned = resolveLocalCopilotCliPath();
    return [
      ...(pinned ? [pinned] : []),
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      join(home, '.local/bin/copilot'),
      join(home, '.copilot/bin/copilot'),
      join(home, 'Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot'),
    ];
  }

  static findCLI(): string | null {
    const envPath = process.env.OPENRAPPTER_COPILOT_CLI || process.env.COPILOT_CLI_PATH;
    if (envPath && existsSync(envPath)) return envPath;
    for (const c of CopilotCliDirectProvider.candidatePaths()) if (existsSync(c)) return c;
    try {
      const p = execSync('command -v copilot', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PATH: resolveSpawnPath() },
      }).trim();
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
    const startedAt = Date.now();
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
          ...this.toolArgs(),
        ],
        { timeout: this.timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      );
      const content = this.cleanOutput(stdout);
      // Tools ran inside the CLI, so there are no tool_calls to hand back — but
      // they reached the agents through our MCP server, which journalled them.
      // Reporting them is what makes `agent_logs` true for this backend.
      const ranAgents = this.exposeAgents ? invocationsSince(startedAt) : [];
      return { content: content || null, tool_calls: null, agent_logs: ranAgents };
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
    // "no tool use" was correct while the CLI ran with an empty allow-list —
    // it stopped the model narrating tools it could not call. Now that the agent
    // registry is exposed over MCP, that same sentence actively suppresses the
    // organism's own capabilities: the model would invent an answer rather than
    // call the agent that knows it. Instruct the opposite when tools are live.
    prompt += this.exposeAgents
      ? 'Continue the conversation below as the assistant. You have tools available that are this '
        + 'assistant\'s own capabilities — prefer calling one over answering from memory whenever a '
        + 'tool covers the question, and never invent a value a tool could return. '
        + 'Reply with only your next message, no preamble.\n\n'
      : 'Continue the conversation below as the assistant. Reply with only your next message — no tool use, no preamble.\n\n';
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
