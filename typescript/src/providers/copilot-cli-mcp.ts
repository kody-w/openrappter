/**
 * Let the Copilot CLI backend call this organism's agents.
 *
 * The CLI cannot be handed OpenAI-style tool definitions — it takes tools only
 * through MCP. It was therefore being run with `--available-tools=` (empty),
 * which meant the default backend on a fresh machine could not invoke a single
 * agent: not a hot-loaded one, not a built-in one. Hot-loading an agent the
 * assistant then cannot use is a feature that does nothing.
 *
 * This writes a small MCP config pointing the CLI at `mcp/stdio.js`, which
 * serves the same `AgentRegistry` over stdio. The CLI spawns it per run, so a
 * file dropped a second ago is present the next time the assistant is asked
 * anything — the registry is re-read on each spawn rather than cached.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The MCP server name. Also the tool namespace the CLI is told to allow. */
export const MCP_SERVER_NAME = 'openrappter';

/** The Copilot CLI's private home, where its config and our bridge file live. */
export function copilotHomeDir(): string {
  return process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
}

/** Absolute path to the stdio MCP entry point that serves the agent registry. */
export function mcpStdioEntry(): string {
  return path.join(HERE, '..', 'mcp', 'stdio.js');
}

export interface McpBridgeConfig {
  /** Path to the JSON config file handed to `--additional-mcp-config @<path>`. */
  path: string;
  /** The server name, for `--allow-tool` / `--available-tools`. */
  server: string;
}

/**
 * Write the MCP config the CLI needs, into the CLI's own private home.
 *
 * Written to disk rather than passed inline because the CLI's `@<path>` form is
 * unambiguous, while a JSON string on argv has to survive shell quoting in every
 * environment this runs in.
 */
export function writeMcpBridgeConfig(
  copilotHome: string,
  opts: { entry?: string; nodeExecutable?: string } = {},
): McpBridgeConfig | null {
  const entry = opts.entry ?? mcpStdioEntry();
  // If the built entry point is missing there is nothing to expose, and
  // pointing the CLI at a file that does not exist would make every request
  // fail rather than merely lack tools.
  if (!fs.existsSync(entry)) return null;

  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: opts.nodeExecutable ?? process.execPath,
        args: [entry],
        tools: ['*'],
      },
    },
  };

  const target = path.join(copilotHome, 'openrappter-mcp.json');
  try {
    fs.mkdirSync(copilotHome, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch {
    return null;
  }
  return { path: target, server: MCP_SERVER_NAME };
}

/**
 * The tool arguments for one CLI run.
 *
 * With no bridge the old behaviour is preserved exactly — `--available-tools=`
 * disables everything, which is the right default for a backend that is only
 * being asked to write prose. The moment agents exist, they become reachable.
 */
export function toolArgsFor(bridge: McpBridgeConfig | null): string[] {
  if (!bridge) return ['--available-tools='];
  return [
    '--additional-mcp-config',
    `@${bridge.path}`,
    // Allow without prompting: there is no TTY here, so a permission prompt
    // would hang the request until it timed out rather than ask anyone.
    '--allow-tool',
    bridge.server,
    // Restrict to our namespace. The CLI's own shell/write tools are not part
    // of this contract and must not become reachable as a side effect.
    '--available-tools',
    bridge.server,
  ];
}
