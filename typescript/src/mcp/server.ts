/**
 * MCP Server — Expose OpenRappter agents as MCP tools via stdio transport.
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0 over stdin/stdout)
 * so that MCP-capable clients can discover and invoke agents as tools.
 */

import { createInterface } from 'readline';
import { BasicAgent } from '../agents/BasicAgent.js';

// ── MCP Protocol Types ──────────────────────────────────────────────

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: Record<string, never>;
}

// JSON-RPC 2.0 types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerOptions {
  /** Server name (default: 'openrappter') */
  name?: string;
  /** Server version (default: '1.8.0') */
  version?: string;
}

export class McpServer {
  private agents = new Map<string, BasicAgent>();
  private serverInfo: McpServerInfo;
  private initialized = false;

  constructor(options?: McpServerOptions) {
    this.serverInfo = {
      name: options?.name ?? 'openrappter',
      version: options?.version ?? '1.8.0',
    };
  }

  /** Register an agent as an MCP tool */
  registerAgent(agent: BasicAgent): void {
    this.agents.set(agent.name, agent);
  }

  /** Register multiple agents */
  registerAgents(agents: BasicAgent[]): void {
    for (const agent of agents) {
      this.registerAgent(agent);
    }
  }

  /** Get all registered agents as MCP tool definitions */
  getToolDefinitions(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = [];
    for (const agent of this.agents.values()) {
      tools.push(this.agentToTool(agent));
    }
    return tools;
  }

  /** Convert agent metadata to MCP tool definition */
  private agentToTool(agent: BasicAgent): McpToolDefinition {
    const meta = agent.metadata;
    return {
      name: meta.name,
      description: meta.description,
      inputSchema: {
        type: 'object',
        properties: meta.parameters.properties as Record<string, unknown>,
        required: meta.parameters.required.length > 0 ? meta.parameters.required : undefined,
      },
    };
  }

  /** Handle a JSON-RPC request and return a response */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      case 'tools/list':
        return this.handleToolsList(request);
      case 'tools/call':
        return this.handleToolsCall(request);
      case 'ping':
        return { jsonrpc: '2.0', id: request.id, result: {} };
      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    this.initialized = true;
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: this.serverInfo,
      },
    };
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: this.getToolDefinitions() },
    };
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params ?? {};
    const toolName = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    const agent = this.agents.get(toolName);
    if (!agent) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` },
      };
    }

    try {
      const resultStr = await agent.execute(args);
      let content: unknown;
      try {
        content = JSON.parse(resultStr);
      } catch {
        content = resultStr;
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }],
        },
      };
    } catch (e) {
      const error = e as Error;
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        },
      };
    }
  }

  /** Start the stdio transport — reads JSON-RPC from stdin, writes to stdout */
  async serve(): Promise<void> {
    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(trimmed);
      } catch {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        };
        this.writeLine(JSON.stringify(errorResponse));
        return;
      }

      // Handle notifications (no id) — just ignore
      if (request.id === undefined || request.id === null) {
        // It's a notification, no response needed
        // But handle 'notifications/initialized' silently
        return;
      }

      const response = await this.handleRequest(request);
      this.writeLine(JSON.stringify(response));
    });

    // Wait until stdin closes
    await new Promise<void>((resolve) => rl.on('close', resolve));
  }

  private writeLine(data: string): void {
    process.stdout.write(data + '\n');
  }

  /** Get the number of registered agents/tools */
  get toolCount(): number {
    return this.agents.size;
  }

  /** Check if a tool is registered */
  hasTool(name: string): boolean {
    return this.agents.has(name);
  }
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  return new McpServer(options);
}
