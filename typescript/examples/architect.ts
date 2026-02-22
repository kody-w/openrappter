/**
 * The Architect — LearnNewAgent + AgentGraph DAG
 *
 * Demonstrates creating agents at runtime and wiring them
 * into a directed acyclic graph for parallel execution.
 *
 * Run: npx tsx examples/architect.ts
 */

import { AgentGraph } from '../src/agents/graph.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

// ── Runtime-created agents (what LearnNewAgent would generate) ──

class DataValidatorAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'DataValidator',
      description: 'Validates incoming data records for schema compliance',
      parameters: { type: 'object', properties: { records: { type: 'array', description: 'Data records to validate' } }, required: [] },
    };
    super('DataValidator', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const records = (kwargs.records ?? []) as unknown[];
    console.log(`  [DataValidator] Validating ${records.length} records...`);
    return JSON.stringify({
      status: 'success',
      validCount: records.length,
      data_slush: { source_agent: 'DataValidator', validated: true, record_count: records.length },
    });
  }
}

class TransformerAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Transformer',
      description: 'Normalizes and transforms validated data',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Transformer', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    console.log('  [Transformer] Normalizing data...');
    return JSON.stringify({
      status: 'success',
      transformed: true,
      data_slush: { source_agent: 'Transformer', format: 'normalized' },
    });
  }
}

class ReporterAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Reporter',
      description: 'Generates final report from pipeline results',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Reporter', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown> | undefined;
    const sources = upstream ? Object.keys(upstream) : [];
    console.log(`  [Reporter] Generating report from ${sources.length} sources: ${sources.join(', ')}`);
    return JSON.stringify({
      status: 'success',
      report: 'Pipeline complete',
      upstream_sources: sources,
      data_slush: { source_agent: 'Reporter', report_generated: true },
    });
  }
}

// ── Build and execute the DAG ──

async function main() {
  console.log('=== The Architect: LearnNewAgent + AgentGraph DAG ===\n');

  // Step 1: Create agents (simulating LearnNewAgent)
  console.log('Step 1: Creating agents at runtime...');
  const validator = new DataValidatorAgent();
  const transformer = new TransformerAgent();
  const reporter = new ReporterAgent();

  // Step 2: Wire into DAG
  console.log('Step 2: Wiring agents into DAG...');
  const graph = new AgentGraph()
    .addNode({ name: 'validate', agent: validator, kwargs: { records: ['user1', 'user2', 'user3'] } })
    .addNode({ name: 'transform', agent: transformer, dependsOn: ['validate'] })
    .addNode({ name: 'report', agent: reporter, dependsOn: ['validate', 'transform'] });

  console.log(`  DAG has ${graph.length} nodes: ${graph.getNodeNames().join(' → ')}`);
  console.log(`  Validation: ${JSON.stringify(graph.validate())}\n`);

  // Step 3: Execute
  console.log('Step 3: Executing DAG...');
  const result = await graph.run();

  console.log(`\nResult: ${result.status}`);
  console.log(`Execution order: ${result.executionOrder.join(' → ')}`);
  console.log(`Total duration: ${result.totalDurationMs}ms`);

  for (const [name, nodeResult] of result.nodes) {
    console.log(`  ${name}: ${nodeResult.status} (${nodeResult.durationMs}ms)`);
  }
}

main().catch(console.error);
