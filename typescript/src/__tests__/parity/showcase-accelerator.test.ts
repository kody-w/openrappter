/**
 * Showcase: Ouroboros Accelerator — OuroborosAgent + CodeReviewAgent + AgentChain
 *
 * Chains an evolution agent with a review agent. The evolution step produces
 * improved code, then the review step analyzes it for quality.
 */

import { describe, it, expect } from 'vitest';
import { AgentChain } from '../../agents/chain.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../../agents/types.js';

// ── Inline agents ──

class EvolutionAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Evolution',
      description: 'Evolves code through iterative improvement',
      parameters: { type: 'object', properties: { source: { type: 'string', description: 'Source code' } }, required: [] },
    };
    super('Evolution', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const source = (kwargs.source ?? 'function add(a,b) { return a+b; }') as string;
    const evolved = source.replace('function', 'export function');
    return JSON.stringify({
      status: 'success',
      evolved_source: evolved,
      generation: 1,
      improvements: ['added export', 'maintained purity'],
      data_slush: {
        source_agent: 'Evolution',
        generation: 1,
        evolved_source: evolved,
        improvement_count: 2,
      },
    });
  }
}

class ReviewAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'CodeReview',
      description: 'Reviews code for quality and best practices',
      parameters: { type: 'object', properties: { content: { type: 'string', description: 'Code to review' } }, required: [] },
    };
    super('CodeReview', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const content = (kwargs.content ?? '') as string;
    const hasExport = content.includes('export');
    const hasTypes = content.includes(':');

    return JSON.stringify({
      status: 'success',
      review: {
        quality_score: hasExport ? 85 : 60,
        issues: hasTypes ? [] : ['Missing type annotations'],
        passed: hasExport,
      },
      data_slush: {
        source_agent: 'CodeReview',
        quality_score: hasExport ? 85 : 60,
        passed: hasExport,
      },
    });
  }
}

describe('Showcase: Ouroboros Accelerator', () => {
  describe('Chain flow', () => {
    it('should chain evolution → review', async () => {
      const chain = new AgentChain()
        .add('evolve', new EvolutionAgent(), { source: 'function add(a,b) { return a+b; }' })
        .add('review', new ReviewAgent(), {}, (prevResult: AgentResult, _slush) => {
          return { content: (prevResult as Record<string, unknown>).evolved_source as string ?? '' };
        });

      const result = await chain.run();
      expect(result.status).toBe('success');
      expect(result.steps.length).toBe(2);
      expect(result.steps[0].name).toBe('evolve');
      expect(result.steps[1].name).toBe('review');
    });

    it('should pass evolved source to review via transform', async () => {
      const chain = new AgentChain()
        .add('evolve', new EvolutionAgent(), { source: 'function greet() { return "hi"; }' })
        .add('review', new ReviewAgent(), {}, (prevResult: AgentResult) => {
          return { content: (prevResult as Record<string, unknown>).evolved_source as string ?? '' };
        });

      const result = await chain.run();
      const reviewResult = result.steps[1].result as Record<string, unknown>;
      const review = reviewResult?.review as Record<string, unknown>;
      // Evolved source has 'export', so review should pass
      expect(review?.passed).toBe(true);
      expect(review?.quality_score).toBe(85);
    });

    it('should propagate data_slush through chain steps', async () => {
      const chain = new AgentChain()
        .add('evolve', new EvolutionAgent())
        .add('review', new ReviewAgent(), {}, (prevResult: AgentResult) => {
          return { content: (prevResult as Record<string, unknown>).evolved_source as string ?? '' };
        });

      const result = await chain.run();

      // Evolution step should have slush
      expect(result.steps[0].dataSlush).toBeTruthy();
      expect(result.steps[0].dataSlush?.source_agent).toBe('Evolution');

      // Review step should have slush
      expect(result.steps[1].dataSlush).toBeTruthy();
      expect(result.steps[1].dataSlush?.source_agent).toBe('CodeReview');
    });
  });

  describe('Evolution quality', () => {
    it('should produce improved code', async () => {
      const chain = new AgentChain()
        .add('evolve', new EvolutionAgent(), { source: 'function hello() {}' });

      const result = await chain.run();
      const evolveResult = result.steps[0].result;
      expect(evolveResult?.evolved_source).toContain('export');
      expect(evolveResult?.generation).toBe(1);
    });
  });

  describe('Review feedback', () => {
    it('should identify missing type annotations', async () => {
      const chain = new AgentChain()
        .add('evolve', new EvolutionAgent())
        .add('review', new ReviewAgent(), {}, (prevResult: AgentResult) => {
          return { content: (prevResult as Record<string, unknown>).evolved_source as string ?? '' };
        });

      const result = await chain.run();
      const reviewResult = result.steps[1].result as Record<string, unknown>;
      const review = reviewResult?.review as Record<string, unknown>;
      expect(review?.issues).toContain('Missing type annotations');
    });
  });

  describe('Chain error handling', () => {
    it('should stop on error by default', async () => {
      class FailingEvolution extends BasicAgent {
        constructor() {
          super('FailingEvolution', {
            name: 'FailingEvolution', description: 'Fails',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(): Promise<string> { throw new Error('Evolution crashed'); }
      }

      const chain = new AgentChain()
        .add('evolve', new FailingEvolution())
        .add('review', new ReviewAgent());

      const result = await chain.run();
      expect(result.status).toBe('error');
      expect(result.failedStep).toBe('evolve');
      expect(result.steps.length).toBe(1);
    });
  });

  describe('Final result', () => {
    it('should return review as final result', async () => {
      const chain = new AgentChain()
        .add('evolve', new EvolutionAgent())
        .add('review', new ReviewAgent(), {}, (prevResult: AgentResult) => {
          return { content: (prevResult as Record<string, unknown>).evolved_source as string ?? '' };
        });

      const result = await chain.run();
      expect(result.finalResult?.status).toBe('success');
      expect(result.finalResult?.review).toBeDefined();
      expect(result.finalSlush?.source_agent).toBe('CodeReview');
    });
  });
});
