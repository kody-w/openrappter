#!/usr/bin/env node
/**
 * Expose this organism's agents to the Copilot CLI as MCP tools.
 *
 * The Copilot CLI is the backend the product falls back to when there is no
 * Copilot-entitled GitHub token — which is the default on a fresh machine. It
 * was being run with `--available-tools=` (empty), meaning it could not call a
 * single agent: not a dropped one, not a built-in one. Hot-loading an agent the
 * assistant then cannot use is a feature that does nothing.
 *
 * The CLI does support tools, but only through MCP. So the daemon points it at
 * this process, which serves the same `AgentRegistry` over stdio using the MCP
 * server the project already had. One registry, two consumers.
 *
 * stdout is the MCP protocol channel. Nothing may be printed to it that is not
 * a protocol message — logs go to stderr or they corrupt the transport.
 */

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { createMcpServer } from './server.js';
import { VERSION } from '../version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const registry = new AgentRegistry(
    path.join(HERE, '..', 'agents'),
    process.env.OPENRAPPTER_AGENTS_DIR ?? path.join(os.homedir(), '.openrappter', 'agents'),
  );

  const agents = await registry.getAllAgents();
  const server = createMcpServer({ name: 'openrappter', version: VERSION });
  server.registerAgents(Array.from(agents.values()));

  process.stderr.write(`[openrappter-mcp] serving ${agents.size} agents\n`);
  await server.serve();
}

main().catch((err) => {
  process.stderr.write(`[openrappter-mcp] ${String(err)}\n`);
  process.exit(1);
});
