/**
 * Mirror Test — Parallel parity comparison via AgentGraph
 *
 * Two implementations of the same analysis run in parallel,
 * then a comparator checks whether they agree.
 *
 * Run: npx tsx examples/mirror-test.ts
 */

import { AgentGraph } from '../src/agents/graph.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class SentimentAgentA extends BasicAgent {
  constructor() {
    super('SentimentA', {
      name: 'SentimentA', description: 'Sentiment analysis v1',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Input text' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    console.log(`  [SentimentA] Analyzing: "${text.slice(0, 40)}..."`);
    return JSON.stringify({
      status: 'success', sentiment: 'positive', confidence: 0.92,
      data_slush: { source_agent: 'SentimentA', sentiment: 'positive', confidence: 0.92, implementation: 'A' },
    });
  }
}

class SentimentAgentB extends BasicAgent {
  constructor() {
    super('SentimentB', {
      name: 'SentimentB', description: 'Sentiment analysis v2',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Input text' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    console.log(`  [SentimentB] Analyzing: "${text.slice(0, 40)}..."`);
    return JSON.stringify({
      status: 'success', sentiment: 'positive', confidence: 0.89,
      data_slush: { source_agent: 'SentimentB', sentiment: 'positive', confidence: 0.89, implementation: 'B' },
    });
  }
}

class ComparatorAgent extends BasicAgent {
  constructor() {
    super('Comparator', {
      name: 'Comparator', description: 'Compares parallel outputs',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>>;
    const slushA = upstream?.sentimentA;
    const slushB = upstream?.sentimentB;
    const match = slushA?.sentiment === slushB?.sentiment;
    const delta = Math.abs(((slushA?.confidence ?? 0) as number) - ((slushB?.confidence ?? 0) as number));
    console.log(`  [Comparator] Parity: ${match}, Confidence delta: ${delta.toFixed(3)}`);
    return JSON.stringify({ status: 'success', parity: match, confidence_delta: delta });
  }
}

async function main() {
  console.log('=== Mirror Test: Parallel Parity Comparison ===\n');

  const graph = new AgentGraph()
    .addNode({ name: 'sentimentA', agent: new SentimentAgentA(), kwargs: { text: 'This product is amazing and well crafted' } })
    .addNode({ name: 'sentimentB', agent: new SentimentAgentB(), kwargs: { text: 'This product is amazing and well crafted' } })
    .addNode({ name: 'compare', agent: new ComparatorAgent(), dependsOn: ['sentimentA', 'sentimentB'] });

  const result = await graph.run();
  console.log(`\nGraph status: ${result.status}`);
  console.log(`Execution order: ${result.executionOrder.join(' → ')}`);
}

main().catch(console.error);
