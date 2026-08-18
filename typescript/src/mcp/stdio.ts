#!/usr/bin/env node
import { openrappterPath } from '../infra/openrappter-home.js';
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
import { fileURLToPath } from 'url';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { createMcpServer } from './server.js';
import { VERSION } from '../version.js';
import { ensureFlightRecorderFromEnv } from '../flight-recorder/index.js';
import { agentResultIsError } from '../agents/result-status.js';
import { sanitizeFlightValue } from '../flight-recorder/redaction.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const recorder = await ensureFlightRecorderFromEnv();
  const registry = new AgentRegistry(
    path.join(HERE, '..', 'agents'),
    process.env.OPENRAPPTER_AGENTS_DIR ?? openrappterPath('agents'),
  );

  const agents = await registry.getAllAgents();
  const traceId = process.env.OPENRAPPTER_FLIGHT_TRACE_ID;
  const executeAgent = async (
    name: string,
    args: Record<string, unknown>,
    operation: () => Promise<string>,
  ): Promise<string> => {
    const runTool = async (): Promise<string> => {
      const startedAt = performance.now();
      const started = await recorder.record({
        kind: 'tool.call.started',
        source: 'mcp-stdio',
        status: 'started',
        toolName: name,
        metadata: {
          route: 'copilot-cli-mcp',
          argumentKeys: Object.keys(args).sort(),
        },
        payload: { arguments: args },
      });
      return recorder.withParent(started?.id ?? null, async () => {
        try {
          const result = await operation();
          const failed = agentResultIsError(result);
          let structuredResult: unknown = sanitizeFlightValue(result);
          try {
            structuredResult = sanitizeFlightValue(JSON.parse(result));
          } catch {
            // Non-JSON output remains a sanitized string.
          }
          await recorder.record({
            kind: failed ? 'tool.call.failed' : 'tool.call.completed',
            source: 'mcp-stdio',
            status: failed ? 'error' : 'success',
            toolName: name,
            durationMs: performance.now() - startedAt,
            metadata: {
              route: 'copilot-cli-mcp',
              ...(failed ? { resultStatus: 'error' } : {}),
            },
            payload: { result: structuredResult },
            parentId: started?.id,
          });
          return result;
        } catch (error) {
          await recorder.record({
            kind: 'tool.call.failed',
            source: 'mcp-stdio',
            status: 'error',
            toolName: name,
            durationMs: performance.now() - startedAt,
            metadata: { route: 'copilot-cli-mcp' },
            payload: { error },
            parentId: started?.id,
          });
          throw error;
        }
      });
    };
    if (traceId) {
      return recorder.runTrace(
        {
          traceId,
          parentId: process.env.OPENRAPPTER_FLIGHT_PARENT_ID ?? null,
          sessionId: process.env.OPENRAPPTER_FLIGHT_SESSION_ID,
          workspaceId: process.env.OPENRAPPTER_FLIGHT_WORKSPACE_ID,
        },
        runTool,
      );
    }
    return recorder.runTrace(
      {
        sessionId: process.env.OPENRAPPTER_FLIGHT_SESSION_ID,
        workspaceId: process.env.OPENRAPPTER_FLIGHT_WORKSPACE_ID,
      },
      runTool,
    );
  };
  const server = createMcpServer({
    name: 'openrappter',
    version: VERSION,
    executeAgent,
  });
  server.registerAgents(Array.from(agents.values()));

  process.stderr.write(`[openrappter-mcp] serving ${agents.size} agents\n`);
  try {
    await server.serve();
  } finally {
    await recorder.close();
  }
}

main().catch((err) => {
  process.stderr.write(`[openrappter-mcp] ${String(err)}\n`);
  process.exit(1);
});
