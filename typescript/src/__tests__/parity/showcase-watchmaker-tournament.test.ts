/**
 * Showcase: Watchmaker's Tournament — AgentGraph competing agents + evaluator
 *
 * Three competitor agents run in parallel with no dependencies.
 * An evaluator node depends on all three, receiving merged upstream_slush
 * to pick the winner by quality score.
 */

import { describe, it, expect } from 'vitest';
import { AgentGraph } from '../../agents/graph.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Inline competitor agents ──

class CompetitorAgent extends BasicAgent {
  private quality: number;
  private solution: string;

  constructor(name: string, quality: number, solution: string) {
    const metadata: AgentMetadata = {
      name,
      description: `Competitor with quality ${quality}`,
      parameters: { type: 'object', properties: { challenge: { type: 'string', description: 'The challenge' } }, required: [] },
    };
    super(name, metadata);
    this.quality = quality;
    this.solution = solution;
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      solution: this.solution,
      quality: this.quality,
      data_slush: {
        source_agent: this.name,
        quality: this.quality,
        solution: this.solution,
        approach: `${this.name}-approach`,
      },
    });
  }
}

class TournamentEvaluatorAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Evaluator',
      description: 'Evaluates tournament competitors and picks a winner',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Evaluator', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>> | undefined;

    if (!upstream) {
      return JSON.stringify({ status: 'error', message: 'No competitors found' });
    }

    const competitors = Object.entries(upstream).map(([name, slush]) => ({
      name,
      quality: (slush.quality ?? 0) as number,
      solution: slush.solution as string,
      approach: slush.approach as string,
    }));

    competitors.sort((a, b) => b.quality - a.quality);
    const winner = competitors[0];

    return JSON.stringify({
      status: 'success',
      winner: winner.name,
      winner_quality: winner.quality,
      winner_solution: winner.solution,
      rankings: competitors.map(c => ({ name: c.name, quality: c.quality })),
      competitors_count: competitors.length,
      data_slush: {
        source_agent: 'Evaluator',
        winner: winner.name,
        winner_quality: winner.quality,
      },
    });
  }
}

describe('Showcase: Watchmaker Tournament', () => {
  describe('Tournament execution', () => {
    it('should run 3 competitors in parallel then evaluate', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 50, 'brute force') })
        .addNode({ name: 'comp-b', agent: new CompetitorAgent('CompB', 90, 'dynamic programming') })
        .addNode({ name: 'comp-c', agent: new CompetitorAgent('CompC', 70, 'greedy algorithm') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b', 'comp-c'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(4);

      // Evaluator runs last
      const order = result.executionOrder;
      expect(order.indexOf('evaluator')).toBe(3);
    });

    it('should pick the highest quality competitor as winner', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 50, 'brute force') })
        .addNode({ name: 'comp-b', agent: new CompetitorAgent('CompB', 90, 'dynamic programming') })
        .addNode({ name: 'comp-c', agent: new CompetitorAgent('CompC', 70, 'greedy algorithm') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b', 'comp-c'] });

      const result = await graph.run();
      const evalResult = result.nodes.get('evaluator')?.result;

      expect(evalResult?.winner).toBe('comp-b');
      expect(evalResult?.winner_quality).toBe(90);
      expect(evalResult?.winner_solution).toBe('dynamic programming');
    });
  });

  describe('Rankings', () => {
    it('should rank competitors by quality score', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 50, 'sol-a') })
        .addNode({ name: 'comp-b', agent: new CompetitorAgent('CompB', 90, 'sol-b') })
        .addNode({ name: 'comp-c', agent: new CompetitorAgent('CompC', 70, 'sol-c') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b', 'comp-c'] });

      const result = await graph.run();
      const evalResult = result.nodes.get('evaluator')?.result as Record<string, unknown>;
      const rankings = evalResult?.rankings as Array<{ name: string; quality: number }>;

      expect(rankings).toHaveLength(3);
      expect(rankings[0].quality).toBe(90);
      expect(rankings[1].quality).toBe(70);
      expect(rankings[2].quality).toBe(50);
    });

    it('should count all competitors', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 50, 'a') })
        .addNode({ name: 'comp-b', agent: new CompetitorAgent('CompB', 90, 'b') })
        .addNode({ name: 'comp-c', agent: new CompetitorAgent('CompC', 70, 'c') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b', 'comp-c'] });

      const result = await graph.run();
      expect(result.nodes.get('evaluator')?.result?.competitors_count).toBe(3);
    });
  });

  describe('Two competitor tournament', () => {
    it('should work with just 2 competitors', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 60, 'sol-a') })
        .addNode({ name: 'comp-b', agent: new CompetitorAgent('CompB', 80, 'sol-b') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b'] });

      const result = await graph.run();
      const evalResult = result.nodes.get('evaluator')?.result;

      expect(evalResult?.winner).toBe('comp-b');
      expect(evalResult?.competitors_count).toBe(2);
    });
  });

  describe('Tie breaking', () => {
    it('should handle tied scores (first in slush order wins)', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 80, 'sol-a') })
        .addNode({ name: 'comp-b', agent: new CompetitorAgent('CompB', 80, 'sol-b') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b'] });

      const result = await graph.run();
      const evalResult = result.nodes.get('evaluator')?.result;
      expect(evalResult?.winner_quality).toBe(80);
      // Both have same quality, winner depends on sort stability
      expect(['comp-a', 'comp-b']).toContain(evalResult?.winner);
    });
  });

  describe('Competitor failure', () => {
    it('should skip evaluator if a competitor fails', async () => {
      class FailComp extends BasicAgent {
        constructor() {
          super('FailComp', {
            name: 'FailComp', description: 'Fails',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(): Promise<string> { throw new Error('Competitor crashed'); }
      }

      const graph = new AgentGraph()
        .addNode({ name: 'comp-a', agent: new CompetitorAgent('CompA', 50, 'sol-a') })
        .addNode({ name: 'comp-b', agent: new FailComp() })
        .addNode({ name: 'comp-c', agent: new CompetitorAgent('CompC', 70, 'sol-c') })
        .addNode({ name: 'evaluator', agent: new TournamentEvaluatorAgent(), dependsOn: ['comp-a', 'comp-b', 'comp-c'] });

      const result = await graph.run();
      expect(result.status).toBe('partial');
      expect(result.nodes.get('comp-b')?.status).toBe('error');
      expect(result.nodes.get('evaluator')?.status).toBe('skipped');
    });
  });
});
