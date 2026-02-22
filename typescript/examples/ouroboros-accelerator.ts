/**
 * Ouroboros Accelerator — Evolution + Code Review Chain
 *
 * Chains code evolution with quality review. The evolution agent improves
 * source code, then the review agent validates the improvements.
 *
 * Run: npx tsx examples/ouroboros-accelerator.ts
 */

import { AgentChain } from '../src/agents/chain.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../src/agents/types.js';

class EvolutionAgent extends BasicAgent {
  constructor() {
    super('Evolution', {
      name: 'Evolution', description: 'Evolves code iteratively',
      parameters: { type: 'object', properties: { source: { type: 'string', description: 'Source' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const source = (kwargs.source ?? '') as string;
    const evolved = source.replace('function', 'export function');
    console.log(`  [Evolution] Evolved: "${evolved.slice(0, 50)}..."`);
    return JSON.stringify({
      status: 'success', evolved_source: evolved, generation: 1,
      data_slush: { source_agent: 'Evolution', generation: 1, evolved_source: evolved },
    });
  }
}

class ReviewAgent extends BasicAgent {
  constructor() {
    super('CodeReview', {
      name: 'CodeReview', description: 'Reviews code quality',
      parameters: { type: 'object', properties: { content: { type: 'string', description: 'Code' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const content = (kwargs.content ?? '') as string;
    const score = content.includes('export') ? 85 : 60;
    console.log(`  [CodeReview] Quality: ${score}/100, passed: ${score >= 70}`);
    return JSON.stringify({
      status: 'success', review: { quality_score: score, passed: score >= 70 },
      data_slush: { source_agent: 'CodeReview', quality_score: score },
    });
  }
}

async function main() {
  console.log('=== Ouroboros Accelerator: Evolution + Code Review ===\n');

  const chain = new AgentChain()
    .add('evolve', new EvolutionAgent(), { source: 'function calculateTax(income) { return income * 0.3; }' })
    .add('review', new ReviewAgent(), {}, (prevResult: AgentResult) => ({
      content: (prevResult as Record<string, unknown>).evolved_source as string ?? '',
    }));

  const result = await chain.run();
  console.log(`\nChain status: ${result.status}`);
  console.log(`Steps: ${result.steps.map(s => `${s.name}(${s.durationMs}ms)`).join(' → ')}`);
  console.log(`Final review: ${JSON.stringify(result.finalResult?.review)}`);
}

main().catch(console.error);
