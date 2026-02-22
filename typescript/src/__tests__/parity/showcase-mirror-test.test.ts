/**
 * Showcase: Mirror Test — Parallel parity comparison via AgentGraph
 *
 * Two agents built from the same spec run in parallel as graph roots.
 * A comparator node receives both outputs via multi-upstream slush merge
 * and detects whether they produced equivalent results.
 */

import { describe, it, expect } from 'vitest';
import { AgentGraph } from '../../agents/graph.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Inline agents ──

class SentimentAgentA extends BasicAgent {
  private sentiment: string;

  constructor(sentiment = 'positive') {
    const metadata: AgentMetadata = {
      name: 'SentimentA',
      description: 'Sentiment analysis implementation A',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to analyze' } }, required: [] },
    };
    super('SentimentA', metadata);
    this.sentiment = sentiment;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    return JSON.stringify({
      status: 'success',
      sentiment: this.sentiment,
      confidence: 0.92,
      word_count: text.split(/\s+/).filter(Boolean).length,
      data_slush: {
        source_agent: 'SentimentA',
        sentiment: this.sentiment,
        confidence: 0.92,
        implementation: 'A',
      },
    });
  }
}

class SentimentAgentB extends BasicAgent {
  private sentiment: string;

  constructor(sentiment = 'positive') {
    const metadata: AgentMetadata = {
      name: 'SentimentB',
      description: 'Sentiment analysis implementation B',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to analyze' } }, required: [] },
    };
    super('SentimentB', metadata);
    this.sentiment = sentiment;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    return JSON.stringify({
      status: 'success',
      sentiment: this.sentiment,
      confidence: 0.89,
      word_count: text.split(/\s+/).filter(Boolean).length,
      data_slush: {
        source_agent: 'SentimentB',
        sentiment: this.sentiment,
        confidence: 0.89,
        implementation: 'B',
      },
    });
  }
}

class ComparatorAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Comparator',
      description: 'Compares outputs from two parallel implementations',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Comparator', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>> | undefined;

    if (!upstream) {
      return JSON.stringify({ status: 'error', message: 'No upstream data' });
    }

    const slushA = upstream.sentimentA as Record<string, unknown> | undefined;
    const slushB = upstream.sentimentB as Record<string, unknown> | undefined;

    const sentimentMatch = slushA?.sentiment === slushB?.sentiment;
    const confA = (slushA?.confidence ?? 0) as number;
    const confB = (slushB?.confidence ?? 0) as number;
    const confidenceDelta = Math.abs(confA - confB);

    return JSON.stringify({
      status: 'success',
      parity: sentimentMatch,
      confidence_delta: confidenceDelta,
      implementations_compared: Object.keys(upstream),
      data_slush: {
        source_agent: 'Comparator',
        parity: sentimentMatch,
        confidence_delta: confidenceDelta,
      },
    });
  }
}

describe('Showcase: Mirror Test', () => {
  describe('Parity detection', () => {
    it('should detect matching outputs (parity=true)', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'sentimentA', agent: new SentimentAgentA('positive'), kwargs: { text: 'great product' } })
        .addNode({ name: 'sentimentB', agent: new SentimentAgentB('positive'), kwargs: { text: 'great product' } })
        .addNode({ name: 'compare', agent: new ComparatorAgent(), dependsOn: ['sentimentA', 'sentimentB'] });

      const result = await graph.run();
      expect(result.status).toBe('success');

      const compareResult = result.nodes.get('compare')?.result;
      expect(compareResult?.parity).toBe(true);
      expect(compareResult?.implementations_compared).toContain('sentimentA');
      expect(compareResult?.implementations_compared).toContain('sentimentB');
    });

    it('should detect mismatched outputs (parity=false)', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'sentimentA', agent: new SentimentAgentA('positive'), kwargs: { text: 'test' } })
        .addNode({ name: 'sentimentB', agent: new SentimentAgentB('negative'), kwargs: { text: 'test' } })
        .addNode({ name: 'compare', agent: new ComparatorAgent(), dependsOn: ['sentimentA', 'sentimentB'] });

      const result = await graph.run();
      expect(result.status).toBe('success');

      const compareResult = result.nodes.get('compare')?.result;
      expect(compareResult?.parity).toBe(false);
    });
  });

  describe('Parallel execution', () => {
    it('should run both sentiment agents in parallel', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'sentimentA', agent: new SentimentAgentA(), kwargs: { text: 'hello world' } })
        .addNode({ name: 'sentimentB', agent: new SentimentAgentB(), kwargs: { text: 'hello world' } })
        .addNode({ name: 'compare', agent: new ComparatorAgent(), dependsOn: ['sentimentA', 'sentimentB'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(3);

      // Both sentiment agents must complete before comparator
      const order = result.executionOrder;
      expect(order.indexOf('compare')).toBe(2);
    });

    it('should receive multi-upstream slush in comparator', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'sentimentA', agent: new SentimentAgentA(), kwargs: { text: 'test' } })
        .addNode({ name: 'sentimentB', agent: new SentimentAgentB(), kwargs: { text: 'test' } })
        .addNode({ name: 'compare', agent: new ComparatorAgent(), dependsOn: ['sentimentA', 'sentimentB'] });

      const result = await graph.run();
      const compareResult = result.nodes.get('compare')?.result as Record<string, unknown>;
      expect((compareResult?.implementations_compared as string[])?.length).toBe(2);
    });
  });

  describe('Confidence delta', () => {
    it('should compute confidence delta between implementations', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'sentimentA', agent: new SentimentAgentA(), kwargs: { text: 'test' } })
        .addNode({ name: 'sentimentB', agent: new SentimentAgentB(), kwargs: { text: 'test' } })
        .addNode({ name: 'compare', agent: new ComparatorAgent(), dependsOn: ['sentimentA', 'sentimentB'] });

      const result = await graph.run();
      const compareResult = result.nodes.get('compare')?.result;
      // A=0.92, B=0.89, delta=0.03
      expect(compareResult?.confidence_delta).toBeCloseTo(0.03, 2);
    });
  });
});
