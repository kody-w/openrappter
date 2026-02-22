/**
 * Dashboard REST API — HTTP endpoints for the web dashboard.
 *
 * Provides REST endpoints for agent management, execution, tracing,
 * and chain/graph status. Designed to be mounted on the existing
 * GatewayServer's HTTP handler.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { BasicAgent } from '../agents/BasicAgent.js';
import type { AgentResult } from '../agents/types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DashboardAgent {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DashboardExecuteRequest {
  agentName: string;
  kwargs: Record<string, unknown>;
}

export interface DashboardExecuteResponse {
  status: 'success' | 'error';
  agentName: string;
  result: AgentResult | null;
  durationMs: number;
  error?: string;
}

export interface DashboardTraceEntry {
  id: string;
  agentName: string;
  operation: string;
  status: string;
  durationMs: number | null;
  startTime: string;
  endTime: string | null;
}

export interface DashboardOptions {
  /** URL prefix for all dashboard routes (default: '/api') */
  prefix?: string;
  /** Enable CORS headers (default: true) */
  cors?: boolean;
}

export class DashboardHandler {
  private agents = new Map<string, BasicAgent>();
  private traceStore: DashboardTraceEntry[] = [];
  private maxTraceEntries: number = 500;
  private prefix: string;
  private corsEnabled: boolean;

  constructor(options?: DashboardOptions) {
    this.prefix = options?.prefix ?? '/api';
    this.corsEnabled = options?.cors ?? true;
  }

  /** Register an agent for the dashboard */
  registerAgent(agent: BasicAgent): void {
    this.agents.set(agent.name, agent);
  }

  /** Register multiple agents */
  registerAgents(agents: BasicAgent[]): void {
    for (const agent of agents) {
      this.registerAgent(agent);
    }
  }

  /** Add a trace entry */
  addTrace(entry: DashboardTraceEntry): void {
    this.traceStore.push(entry);
    if (this.traceStore.length > this.maxTraceEntries) {
      this.traceStore = this.traceStore.slice(-this.maxTraceEntries);
    }
  }

  /** Get all trace entries */
  getTraces(limit?: number): DashboardTraceEntry[] {
    if (limit) {
      return this.traceStore.slice(-limit);
    }
    return [...this.traceStore];
  }

  /** Clear trace entries */
  clearTraces(): void {
    this.traceStore = [];
  }

  /**
   * Handle an HTTP request. Returns true if the request was handled,
   * false if it should be passed to the next handler.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Only handle requests under our prefix
    if (!pathname.startsWith(this.prefix)) {
      return false;
    }

    // CORS headers
    if (this.corsEnabled) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    const route = pathname.slice(this.prefix.length);

    try {
      switch (true) {
        case route === '/agents' && req.method === 'GET':
          return this.handleAgentList(res);

        case route === '/agents/execute' && req.method === 'POST':
          return await this.handleAgentExecute(req, res);

        case route === '/traces' && req.method === 'GET': {
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam ? parseInt(limitParam, 10) : undefined;
          return this.handleTraceList(res, limit);
        }

        case route === '/traces' && req.method === 'DELETE':
          return this.handleTraceClear(res);

        case route === '/status' && req.method === 'GET':
          return this.handleStatus(res);

        default:
          this.sendJson(res, 404, { error: 'Not found', path: route });
          return true;
      }
    } catch (e) {
      const error = e as Error;
      this.sendJson(res, 500, { error: error.message });
      return true;
    }
  }

  private handleAgentList(res: ServerResponse): boolean {
    const agents: DashboardAgent[] = [];
    for (const agent of this.agents.values()) {
      agents.push({
        name: agent.metadata.name,
        description: agent.metadata.description,
        parameters: agent.metadata.parameters as unknown as Record<string, unknown>,
      });
    }
    this.sendJson(res, 200, { agents, count: agents.length });
    return true;
  }

  private async handleAgentExecute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await this.readBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Request body required' });
      return true;
    }

    let parsed: DashboardExecuteRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    if (!parsed.agentName) {
      this.sendJson(res, 400, { error: 'agentName is required' });
      return true;
    }

    const agent = this.agents.get(parsed.agentName);
    if (!agent) {
      this.sendJson(res, 404, { error: `Agent not found: ${parsed.agentName}` });
      return true;
    }

    const startTime = Date.now();
    const traceId = `trace_${Date.now().toString(36)}`;

    try {
      const resultStr = await agent.execute(parsed.kwargs ?? {});
      const durationMs = Date.now() - startTime;
      let result: AgentResult;
      try {
        result = JSON.parse(resultStr);
      } catch {
        result = { status: 'success', raw: resultStr } as unknown as AgentResult;
      }

      // Record trace
      this.addTrace({
        id: traceId,
        agentName: parsed.agentName,
        operation: 'execute',
        status: 'success',
        durationMs,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
      });

      const response: DashboardExecuteResponse = {
        status: 'success',
        agentName: parsed.agentName,
        result,
        durationMs,
      };
      this.sendJson(res, 200, response);
    } catch (e) {
      const error = e as Error;
      const durationMs = Date.now() - startTime;

      this.addTrace({
        id: traceId,
        agentName: parsed.agentName,
        operation: 'execute',
        status: 'error',
        durationMs,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
      });

      const response: DashboardExecuteResponse = {
        status: 'error',
        agentName: parsed.agentName,
        result: null,
        durationMs,
        error: error.message,
      };
      this.sendJson(res, 200, response);
    }

    return true;
  }

  private handleTraceList(res: ServerResponse, limit?: number): boolean {
    const traces = this.getTraces(limit);
    this.sendJson(res, 200, { traces, count: traces.length });
    return true;
  }

  private handleTraceClear(res: ServerResponse): boolean {
    this.clearTraces();
    this.sendJson(res, 200, { cleared: true });
    return true;
  }

  private handleStatus(res: ServerResponse): boolean {
    this.sendJson(res, 200, {
      agentCount: this.agents.size,
      traceCount: this.traceStore.length,
      agents: Array.from(this.agents.keys()),
    });
    return true;
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      req.on('error', () => resolve(null));
    });
  }

  /** Get agent count */
  get agentCount(): number {
    return this.agents.size;
  }

  /** Check if an agent is registered */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }
}

export function createDashboardHandler(options?: DashboardOptions): DashboardHandler {
  return new DashboardHandler(options);
}
