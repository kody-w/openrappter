/**
 * The Copilot CLI must be able to call this organism's agents.
 *
 * This was a real product hole, not a theoretical one: the CLI is the backend a
 * fresh machine falls back to, and it was being run with `--available-tools=`
 * (empty). It could not invoke a single agent — not a hot-loaded one, not a
 * built-in one — so dropping an agent onto the window taught it something it
 * could never use.
 *
 * Two halves have to hold, and each failed independently during the fix:
 *   1. the tools must be REACHABLE (the MCP bridge), and
 *   2. the model must be ALLOWED to reach for them — the prompt literally said
 *      "no tool use", which quietly suppressed every capability even once the
 *      bridge worked.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeMcpBridgeConfig, toolArgsFor, MCP_SERVER_NAME } from '../copilot-cli-mcp.js';
import { CopilotCliDirectProvider } from '../copilot-cli-direct.js';
import type { Message } from '../types.js';

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'openrappter-mcp-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the MCP bridge config', () => {
  it('points the CLI at the stdio entry that serves the registry', () => {
    const entry = path.join(home, 'stdio.js');
    fs.writeFileSync(entry, '// built entry');

    const bridge = writeMcpBridgeConfig(home, { entry });

    expect(bridge).not.toBeNull();
    const written = JSON.parse(fs.readFileSync(bridge!.path, 'utf-8'));
    expect(written.mcpServers[MCP_SERVER_NAME].args).toEqual([entry]);
  });

  it('returns null rather than pointing at an entry that does not exist', () => {
    // Naming a missing file would make every CLI request fail outright, which is
    // strictly worse than the request simply having no tools.
    expect(writeMcpBridgeConfig(home, { entry: path.join(home, 'nope.js') })).toBeNull();
  });

  it('writes the config private to the user', () => {
    const entry = path.join(home, 'stdio.js');
    fs.writeFileSync(entry, '// built entry');
    const bridge = writeMcpBridgeConfig(home, { entry })!;
    expect(fs.statSync(bridge.path).mode & 0o777).toBe(0o600);
  });
});

describe('the tool arguments', () => {
  it('keeps the empty allow-list when there is no bridge', () => {
    // The old behaviour is correct for a backend only asked for prose, and it
    // must survive: a CLI with tools it cannot fulfil narrates fake tool use.
    expect(toolArgsFor(null)).toEqual(['--available-tools=']);
  });

  it('enables ONLY our namespace when the bridge exists', () => {
    const args = toolArgsFor({ path: '/tmp/x.json', server: MCP_SERVER_NAME });

    expect(args).toContain('--additional-mcp-config');
    expect(args).toContain('@/tmp/x.json');

    // Scoped deliberately. The CLI ships its own shell and write tools; those
    // must not become reachable as a side effect of exposing agents.
    const available = args[args.indexOf('--available-tools') + 1];
    expect(available).toBe(MCP_SERVER_NAME);

    // And it must never re-add the empty allow-list, which would win and
    // silently disable everything the bridge just enabled.
    expect(args).not.toContain('--available-tools=');
  });

  it('allows the namespace without prompting, because there is no TTY', () => {
    const args = toolArgsFor({ path: '/tmp/x.json', server: MCP_SERVER_NAME });
    // A permission prompt in a daemon does not ask anyone anything; it hangs
    // until the request times out.
    expect(args[args.indexOf('--allow-tool') + 1]).toBe(MCP_SERVER_NAME);
  });
});

describe('the prompt must not forbid what the bridge just enabled', () => {
  /** Capture the prompt the provider would send, without running the CLI. */
  async function promptFor(exposeAgents: boolean): Promise<string> {
    let captured = '';
    const provider = new CopilotCliDirectProvider({
      cliPath: '/bin/echo',
      exposeAgents,
      runner: async (_exe, args) => {
        captured = args[args.indexOf('--prompt') + 1];
        return { stdout: 'ok', stderr: '' };
      },
    });
    const messages: Message[] = [{ role: 'user', content: 'what is the tide?' }];
    await provider.chat(messages);
    return captured;
  }

  it('tells the model NOT to use tools when none are exposed', async () => {
    expect(await promptFor(false)).toContain('no tool use');
  });

  it('tells the model to PREFER tools when they are exposed', async () => {
    const prompt = await promptFor(true);

    // The bug: the bridge worked, the tools were listed, and the model still
    // invented answers because the prompt told it not to call anything.
    expect(prompt).not.toContain('no tool use');
    expect(prompt.toLowerCase()).toContain('prefer calling');
    expect(prompt.toLowerCase()).toContain('never invent a value');
  });
});
