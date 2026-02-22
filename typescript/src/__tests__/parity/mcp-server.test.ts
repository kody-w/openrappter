/**
 * MCP Server Parity Tests
 *
 * Tests the MCP (Model Context Protocol) server that exposes agents as tools.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer, createMcpServer } from '../../mcp/server.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Test helpers ──

class EchoAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Echo',
      description: 'Echoes input back',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Input to echo' },
        },
        required: ['query'],
      },
    };
    super('Echo', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      echo: kwargs.query ?? 'no-query',
    });
  }
}

class MathAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Math',
      description: 'Performs basic math',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'add, subtract, multiply' },
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['operation', 'a', 'b'],
      },
    };
    super('Math', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const a = kwargs.a as number;
    const b = kwargs.b as number;
    const op = kwargs.operation as string;
    let result: number;
    switch (op) {
      case 'add': result = a + b; break;
      case 'subtract': result = a - b; break;
      case 'multiply': result = a * b; break;
      default: throw new Error(`Unknown operation: ${op}`);
    }
    return JSON.stringify({ status: 'success', result });
  }
}

class FailAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Fail',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Fail', metadata);
  }

  async perform(): Promise<string> {
    throw new Error('Intentional failure');
  }
}

describe('McpServer', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer();
  });

  // ── Construction ──

  describe('Construction', () => {
    it('should create a server with defaults', () => {
      const s = new McpServer();
      expect(s.toolCount).toBe(0);
    });

    it('should create via factory function', () => {
      const s = createMcpServer({ name: 'test', version: '1.0.0' });
      expect(s.toolCount).toBe(0);
    });

    it('should accept custom name and version', () => {
      const s = new McpServer({ name: 'myserver', version: '2.0.0' });
      expect(s.toolCount).toBe(0);
    });
  });

  // ── Agent Registration ──

  describe('Agent Registration', () => {
    it('should register a single agent', () => {
      server.registerAgent(new EchoAgent());
      expect(server.toolCount).toBe(1);
      expect(server.hasTool('Echo')).toBe(true);
    });

    it('should register multiple agents', () => {
      server.registerAgents([new EchoAgent(), new MathAgent()]);
      expect(server.toolCount).toBe(2);
      expect(server.hasTool('Echo')).toBe(true);
      expect(server.hasTool('Math')).toBe(true);
    });

    it('should not have unregistered tools', () => {
      expect(server.hasTool('NonExistent')).toBe(false);
    });
  });

  // ── Tool Definitions ──

  describe('Tool Definitions', () => {
    it('should convert agent metadata to MCP tool format', () => {
      server.registerAgent(new EchoAgent());
      const tools = server.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('Echo');
      expect(tools[0].description).toBe('Echoes input back');
      expect(tools[0].inputSchema.type).toBe('object');
      expect(tools[0].inputSchema.properties).toHaveProperty('query');
      expect(tools[0].inputSchema.required).toEqual(['query']);
    });

    it('should omit required when empty', () => {
      server.registerAgent(new FailAgent());
      const tools = server.getToolDefinitions();
      expect(tools[0].inputSchema.required).toBeUndefined();
    });

    it('should return all registered tools', () => {
      server.registerAgents([new EchoAgent(), new MathAgent()]);
      const tools = server.getToolDefinitions();
      expect(tools).toHaveLength(2);
      const names = tools.map(t => t.name);
      expect(names).toContain('Echo');
      expect(names).toContain('Math');
    });
  });

  // ── JSON-RPC: initialize ──

  describe('initialize', () => {
    it('should respond to initialize request', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      });

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('1');
      expect(response.error).toBeUndefined();
      const result = response.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe('2024-11-05');
      expect(result.capabilities).toHaveProperty('tools');
      const serverInfo = result.serverInfo as Record<string, string>;
      expect(serverInfo.name).toBe('openrappter');
    });
  });

  // ── JSON-RPC: tools/list ──

  describe('tools/list', () => {
    it('should list registered tools', async () => {
      server.registerAgents([new EchoAgent(), new MathAgent()]);

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/list',
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { tools: unknown[] };
      expect(result.tools).toHaveLength(2);
    });

    it('should return empty tools when none registered', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '3',
        method: 'tools/list',
      });

      const result = response.result as { tools: unknown[] };
      expect(result.tools).toHaveLength(0);
    });
  });

  // ── JSON-RPC: tools/call ──

  describe('tools/call', () => {
    it('should call a registered tool successfully', async () => {
      server.registerAgent(new EchoAgent());

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '4',
        method: 'tools/call',
        params: { name: 'Echo', arguments: { query: 'hello world' } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: { type: string; text: string }[] };
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.echo).toBe('hello world');
    });

    it('should return error for unknown tool', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '5',
        method: 'tools/call',
        params: { name: 'NonExistent', arguments: {} },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain('NonExistent');
    });

    it('should handle tool execution errors gracefully', async () => {
      server.registerAgent(new FailAgent());

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '6',
        method: 'tools/call',
        params: { name: 'Fail', arguments: {} },
      });

      // MCP returns errors as content with isError flag
      expect(response.error).toBeUndefined();
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Intentional failure');
    });

    it('should call tool with complex arguments', async () => {
      server.registerAgent(new MathAgent());

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '7',
        method: 'tools/call',
        params: { name: 'Math', arguments: { operation: 'add', a: 5, b: 3 } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: { text: string }[] };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.result).toBe(8);
    });
  });

  // ── JSON-RPC: ping ──

  describe('ping', () => {
    it('should respond to ping', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '8',
        method: 'ping',
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({});
    });
  });

  // ── JSON-RPC: unknown method ──

  describe('unknown method', () => {
    it('should return method not found error', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '9',
        method: 'nonexistent/method',
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });
  });
});
