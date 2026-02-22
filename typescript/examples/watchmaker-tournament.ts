/**
 * Watchmaker's Tournament — Competing agents evaluated by quality
 *
 * Three agents compete by solving the same challenge in parallel.
 * An evaluator picks the winner based on quality score.
 *
 * Run: npx tsx examples/watchmaker-tournament.ts
 */

import { AgentGraph } from '../src/agents/graph.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class CompetitorAgent extends BasicAgent {
  private quality: number;
  private solution: string;
  constructor(name: string, quality: number, solution: string) {
    super(name, {
      name, description: `Competitor (quality: ${quality})`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
    this.quality = quality;
    this.solution = solution;
  }
  async perform(): Promise<string> {
    console.log(`  [${this.name}] Solution: "${this.solution}" (quality: ${this.quality})`);
    return JSON.stringify({
      status: 'success', quality: this.quality, solution: this.solution,
      data_slush: { source_agent: this.name, quality: this.quality, solution: this.solution },
    });
  }
}

class EvaluatorAgent extends BasicAgent {
  constructor() {
    super('Evaluator', {
      name: 'Evaluator', description: 'Picks tournament winner',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>>;
    const ranked = Object.entries(upstream)
      .map(([name, s]) => ({ name, quality: s.quality as number }))
      .sort((a, b) => b.quality - a.quality);
    console.log(`  [Evaluator] Winner: ${ranked[0].name} (quality: ${ranked[0].quality})`);
    return JSON.stringify({ status: 'success', winner: ranked[0].name, rankings: ranked });
  }
}

async function main() {
  console.log('=== Watchmaker Tournament: Competing Agents ===\n');
  const graph = new AgentGraph()
    .addNode({ name: 'brute', agent: new CompetitorAgent('BruteForce', 50, 'O(n^3) nested loops') })
    .addNode({ name: 'dp', agent: new CompetitorAgent('DynamicProg', 90, 'O(n log n) memoized') })
    .addNode({ name: 'greedy', agent: new CompetitorAgent('Greedy', 70, 'O(n) greedy scan') })
    .addNode({ name: 'eval', agent: new EvaluatorAgent(), dependsOn: ['brute', 'dp', 'greedy'] });

  const result = await graph.run();
  console.log(`\nStatus: ${result.status}, Order: ${result.executionOrder.join(' → ')}`);
}

main().catch(console.error);
