/**
 * Living Dashboard — Self-monitoring agent system
 *
 * Agent chain runs health checks while a tracer feeds spans
 * to the dashboard. An MCP tool queries the dashboard for traces.
 *
 * Run: npx tsx examples/living-dashboard.ts
 */

import { AgentChain } from '../src/agents/chain.js';
import { createTracer } from '../src/agents/tracer.js';
import { McpServer } from '../src/mcp/server.js';
import { DashboardHandler } from '../src/gateway/dashboard.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class HealthCheckAgent extends BasicAgent {
  constructor() {
    super('HealthCheck', {
      name: 'HealthCheck', description: 'Health check',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(): Promise<string> {
    console.log('  [HealthCheck] System healthy');
    return JSON.stringify({ status: 'success', healthy: true, data_slush: { source_agent: 'HealthCheck', healthy: true } });
  }
}

class MetricsAgent extends BasicAgent {
  constructor() {
    super('Metrics', {
      name: 'Metrics', description: 'System metrics',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(): Promise<string> {
    console.log('  [Metrics] CPU: 45%, Memory: 72%');
    return JSON.stringify({ status: 'success', cpu: 45, memory: 72, data_slush: { source_agent: 'Metrics', cpu: 45 } });
  }
}

class DashboardQueryAgent extends BasicAgent {
  private dashboard: DashboardHandler;
  constructor(dashboard: DashboardHandler) {
    super('DashboardQuery', {
      name: 'DashboardQuery', description: 'Queries trace data',
      parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Limit' } }, required: [] },
    });
    this.dashboard = dashboard;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const traces = this.dashboard.getTraces((kwargs.limit ?? 10) as number);
    console.log(`  [DashboardQuery] Found ${traces.length} traces`);
    return JSON.stringify({
      status: 'success', trace_count: traces.length,
      traces: traces.map(t => ({ agent: t.agentName, status: t.status })),
    });
  }
}

async function main() {
  console.log('=== Living Dashboard: Self-Monitoring System ===\n');

  const dashboard = new DashboardHandler({ prefix: '/api' });
  const tracer = createTracer({
    onSpanComplete: (span) => {
      dashboard.addTrace({
        id: span.id, agentName: span.agentName, operation: span.operation,
        status: span.status, durationMs: span.durationMs,
        startTime: span.startTime, endTime: span.endTime,
      });
    },
  });

  console.log('Step 1: Running monitored agent chain...');
  const agents = [new HealthCheckAgent(), new MetricsAgent()];
  for (const agent of agents) {
    const { span } = tracer.startSpan(agent.name, 'execute');
    await agent.execute({});
    tracer.endSpan(span.id, { status: 'success' });
  }

  console.log('\nStep 2: Querying dashboard via MCP...');
  const queryAgent = new DashboardQueryAgent(dashboard);
  const mcp = new McpServer({ name: 'openrappter', version: '1.7.0' });
  mcp.registerAgent(queryAgent);

  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'DashboardQuery', arguments: { limit: 10 } },
  });

  const content = ((response.result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0];
  console.log(`\nMCP Response: ${content.text}`);
}

main().catch(console.error);
