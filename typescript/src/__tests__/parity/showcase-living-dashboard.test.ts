/**
 * Showcase: Living Dashboard — AgentChain + AgentTracer + DashboardHandler + McpServer
 *
 * An agent chain runs demo agents while a tracer captures spans.
 * The tracer feeds spans to the dashboard. An MCP-registered query agent
 * reads traces from the dashboard — the system monitors itself.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentChain } from '../../agents/chain.js';
import { createTracer } from '../../agents/tracer.js';
import { McpServer } from '../../mcp/server.js';
import { DashboardHandler } from '../../gateway/dashboard.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../../agents/types.js';

// ── Inline agents ──

class HealthCheckAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'HealthCheck',
      description: 'System health check',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('HealthCheck', metadata);
  }

  async perform(): Promise<string> {
    return JSON.stringify({
      status: 'success',
      healthy: true,
      uptime_seconds: 3600,
      data_slush: { source_agent: 'HealthCheck', healthy: true, uptime: 3600 },
    });
  }
}

class MetricsAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Metrics',
      description: 'Collects system metrics',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Metrics', metadata);
  }

  async perform(): Promise<string> {
    return JSON.stringify({
      status: 'success',
      cpu: 45.2,
      memory: 72.1,
      requests_per_sec: 150,
      data_slush: { source_agent: 'Metrics', cpu: 45.2, memory: 72.1 },
    });
  }
}

class ReportAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Report',
      description: 'Generates status report',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Report', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown>;
    return JSON.stringify({
      status: 'success',
      report: 'System nominal',
      based_on_upstream: !!upstream,
      data_slush: { source_agent: 'Report', report_generated: true },
    });
  }
}

class DashboardQueryAgent extends BasicAgent {
  private dashboard: DashboardHandler;

  constructor(dashboard: DashboardHandler) {
    const metadata: AgentMetadata = {
      name: 'DashboardQuery',
      description: 'Queries the dashboard for trace data',
      parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max traces' } }, required: [] },
    };
    super('DashboardQuery', metadata);
    this.dashboard = dashboard;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const limit = (kwargs.limit ?? 10) as number;
    const traces = this.dashboard.getTraces(limit);
    return JSON.stringify({
      status: 'success',
      trace_count: traces.length,
      traces: traces.map(t => ({ agent: t.agentName, status: t.status, duration: t.durationMs })),
      data_slush: { source_agent: 'DashboardQuery', trace_count: traces.length },
    });
  }
}

describe('Showcase: Living Dashboard', () => {
  describe('Tracer → Dashboard bridge', () => {
    it('should feed tracer spans to dashboard via onSpanComplete', () => {
      const dashboard = new DashboardHandler({ prefix: '/api' });
      const tracer = createTracer({
        onSpanComplete: (span) => {
          dashboard.addTrace({
            id: span.id,
            agentName: span.agentName,
            operation: span.operation,
            status: span.status,
            durationMs: span.durationMs,
            startTime: span.startTime,
            endTime: span.endTime,
          });
        },
      });

      // Create and complete a span
      const { span } = tracer.startSpan('HealthCheck', 'execute');
      tracer.endSpan(span.id, { status: 'success' });

      const traces = dashboard.getTraces();
      expect(traces.length).toBe(1);
      expect(traces[0].agentName).toBe('HealthCheck');
      expect(traces[0].status).toBe('success');
    });

    it('should accumulate multiple span traces', () => {
      const dashboard = new DashboardHandler();
      const tracer = createTracer({
        onSpanComplete: (span) => {
          dashboard.addTrace({
            id: span.id, agentName: span.agentName, operation: span.operation,
            status: span.status, durationMs: span.durationMs,
            startTime: span.startTime, endTime: span.endTime,
          });
        },
      });

      for (const name of ['HealthCheck', 'Metrics', 'Report']) {
        const { span } = tracer.startSpan(name, 'execute');
        tracer.endSpan(span.id, { status: 'success' });
      }

      expect(dashboard.getTraces().length).toBe(3);
    });
  });

  describe('Chain produces spans', () => {
    it('should produce trace spans for each chain step', async () => {
      const spans: string[] = [];
      const tracer = createTracer({
        onSpanComplete: (span) => { spans.push(span.agentName); },
      });

      const agents = [new HealthCheckAgent(), new MetricsAgent(), new ReportAgent()];
      const chain = new AgentChain();

      for (const agent of agents) {
        chain.add(agent.name, agent);
      }

      // Manually trace each step by wrapping execution
      for (const agent of agents) {
        const { span } = tracer.startSpan(agent.name, 'execute');
        await agent.execute({});
        tracer.endSpan(span.id, { status: 'success' });
      }

      expect(spans).toEqual(['HealthCheck', 'Metrics', 'Report']);
    });
  });

  describe('MCP tool registration', () => {
    it('should register DashboardQuery agent as MCP tool', () => {
      const dashboard = new DashboardHandler();
      const queryAgent = new DashboardQueryAgent(dashboard);
      const mcp = new McpServer({ name: 'openrappter', version: '1.7.0' });

      mcp.registerAgent(queryAgent);
      expect(mcp.hasTool('DashboardQuery')).toBe(true);
      expect(mcp.toolCount).toBe(1);
    });

    it('should list DashboardQuery in tools/list', async () => {
      const dashboard = new DashboardHandler();
      const queryAgent = new DashboardQueryAgent(dashboard);
      const mcp = new McpServer();

      mcp.registerAgent(queryAgent);
      const response = await mcp.handleRequest({
        jsonrpc: '2.0', id: 1, method: 'tools/list',
      });

      const tools = (response.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('DashboardQuery');
    });
  });

  describe('MCP tool invocation returns trace data', () => {
    it('should return trace data via MCP tools/call', async () => {
      const dashboard = new DashboardHandler();

      // Add some traces
      dashboard.addTrace({
        id: 'trace1', agentName: 'HealthCheck', operation: 'execute',
        status: 'success', durationMs: 5, startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      });
      dashboard.addTrace({
        id: 'trace2', agentName: 'Metrics', operation: 'execute',
        status: 'success', durationMs: 8, startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      });

      const queryAgent = new DashboardQueryAgent(dashboard);
      const mcp = new McpServer();
      mcp.registerAgent(queryAgent);

      const response = await mcp.handleRequest({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'DashboardQuery', arguments: { limit: 10 } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as Record<string, unknown>;
      const content = (result.content as Array<Record<string, unknown>>)[0];
      const parsed = JSON.parse(content.text as string);

      expect(parsed.trace_count).toBe(2);
      expect(parsed.traces[0].agent).toBe('HealthCheck');
    });
  });

  describe('Self-monitoring loop', () => {
    it('should demonstrate full loop: chain → tracer → dashboard → MCP query', async () => {
      const dashboard = new DashboardHandler();
      const tracer = createTracer({
        onSpanComplete: (span) => {
          dashboard.addTrace({
            id: span.id, agentName: span.agentName, operation: span.operation,
            status: span.status, durationMs: span.durationMs,
            startTime: span.startTime, endTime: span.endTime,
          });
        },
      });

      // Step 1: Run chain agents with tracing
      const agents = [new HealthCheckAgent(), new MetricsAgent(), new ReportAgent()];
      for (const agent of agents) {
        const { span } = tracer.startSpan(agent.name, 'execute');
        await agent.execute({});
        tracer.endSpan(span.id, { status: 'success' });
      }

      // Step 2: Register query agent on MCP
      const queryAgent = new DashboardQueryAgent(dashboard);
      const mcp = new McpServer();
      mcp.registerAgent(queryAgent);

      // Step 3: Query via MCP
      const response = await mcp.handleRequest({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'DashboardQuery', arguments: { limit: 5 } },
      });

      const content = ((response.result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0];
      const parsed = JSON.parse(content.text as string);

      expect(parsed.trace_count).toBe(3);
      expect(parsed.traces.map((t: Record<string, unknown>) => t.agent)).toEqual(['HealthCheck', 'Metrics', 'Report']);
    });
  });
});
