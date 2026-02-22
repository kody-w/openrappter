/**
 * Code Archaeologist — AgentGraph fan-out/fan-in
 *
 * Multiple analysis agents run in parallel, then a synthesis
 * agent combines all findings into a unified report.
 *
 * Run: npx tsx examples/code-archaeologist.ts
 */

import { AgentGraph } from '../src/agents/graph.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class GitHistoryAgent extends BasicAgent {
  constructor() {
    super('GitHistory', {
      name: 'GitHistory', description: 'Git history analysis',
      parameters: { type: 'object', properties: { repo: { type: 'string', description: 'Repo path' } }, required: [] },
    });
  }
  async perform(): Promise<string> {
    console.log('  [GitHistory] Scanning commit history...');
    return JSON.stringify({
      status: 'success', commits: 142, hotspots: ['src/auth.ts', 'src/api/routes.ts'],
      data_slush: { source_agent: 'GitHistory', analysis_type: 'git_history', hotspot_files: ['src/auth.ts', 'src/api/routes.ts'] },
    });
  }
}

class DependencyAnalyzerAgent extends BasicAgent {
  constructor() {
    super('DependencyAnalyzer', {
      name: 'DependencyAnalyzer', description: 'Dependency analysis',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(): Promise<string> {
    console.log('  [DependencyAnalyzer] Scanning dependencies...');
    return JSON.stringify({
      status: 'success', totalDeps: 24, outdated: 3,
      data_slush: { source_agent: 'DependencyAnalyzer', analysis_type: 'dependencies', outdated: ['lodash@3.x'] },
    });
  }
}

class ComplexityScorerAgent extends BasicAgent {
  constructor() {
    super('ComplexityScorer', {
      name: 'ComplexityScorer', description: 'Complexity metrics',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(): Promise<string> {
    console.log('  [ComplexityScorer] Measuring cyclomatic complexity...');
    return JSON.stringify({
      status: 'success', avgComplexity: 4.2, maxComplexity: 18,
      data_slush: { source_agent: 'ComplexityScorer', analysis_type: 'complexity', risky_files: ['src/auth.ts', 'src/parser.ts'] },
    });
  }
}

class SynthesisAgent extends BasicAgent {
  constructor() {
    super('Synthesis', {
      name: 'Synthesis', description: 'Cross-reference all findings',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>>;
    const sources = upstream ? Object.keys(upstream) : [];
    console.log(`  [Synthesis] Merging ${sources.length} analysis sources...`);
    return JSON.stringify({ status: 'success', sources_merged: sources.length });
  }
}

async function main() {
  console.log('=== Code Archaeologist: Fan-out / Fan-in ===\n');

  const graph = new AgentGraph()
    .addNode({ name: 'git', agent: new GitHistoryAgent() })
    .addNode({ name: 'deps', agent: new DependencyAnalyzerAgent() })
    .addNode({ name: 'complexity', agent: new ComplexityScorerAgent() })
    .addNode({ name: 'synthesis', agent: new SynthesisAgent(), dependsOn: ['git', 'deps', 'complexity'] });

  console.log(`DAG: ${graph.getNodeNames().join(', ')} (${graph.length} nodes)\n`);
  const result = await graph.run();
  console.log(`\nStatus: ${result.status}, Duration: ${result.totalDurationMs}ms`);
  console.log(`Execution order: ${result.executionOrder.join(' → ')}`);
}

main().catch(console.error);
