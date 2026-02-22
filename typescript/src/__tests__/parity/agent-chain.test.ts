/**
 * AgentChain Parity Tests
 *
 * Tests the sequential agent pipeline with automatic data_slush forwarding.
 */

import { describe, it, expect } from 'vitest';
import { AgentChain, createAgentChain } from '../../agents/chain.js';
import { ShellAgent } from '../../agents/ShellAgent.js';
import { MemoryAgent } from '../../agents/MemoryAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Test helper: a simple agent that echoes kwargs ──

class EchoAgent extends BasicAgent {
  constructor(name = 'Echo') {
    const metadata: AgentMetadata = {
      name,
      description: 'Echoes input for testing',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Input' } }, required: [] },
    };
    super(name, metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      echo: kwargs.query ?? 'no-query',
      received_upstream: !!(kwargs._context as Record<string, unknown>)?.upstream_slush,
      data_slush: this.slushOut({ signals: { echo: true } }),
    });
  }
}

class FailAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Fail',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Fail', metadata);
  }

  async perform(): Promise<string> {
    throw new Error('Intentional failure');
  }
}

describe('AgentChain', () => {
  // ── Construction ─────────────────────────────────────────────────

  describe('Construction', () => {
    it('should create an empty chain', () => {
      const chain = new AgentChain();
      expect(chain.length).toBe(0);
      expect(chain.getStepNames()).toEqual([]);
    });

    it('should create via factory function', () => {
      const chain = createAgentChain();
      expect(chain).toBeInstanceOf(AgentChain);
    });

    it('should support fluent add calls', () => {
      const chain = new AgentChain()
        .add('step1', new EchoAgent())
        .add('step2', new EchoAgent());
      expect(chain.length).toBe(2);
      expect(chain.getStepNames()).toEqual(['step1', 'step2']);
    });
  });

  // ── Single Step ──────────────────────────────────────────────────

  describe('Single Step', () => {
    it('should execute a single agent', async () => {
      const chain = new AgentChain().add('echo', new EchoAgent(), { query: 'hello' });
      const result = await chain.run();
      expect(result.status).toBe('success');
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].name).toBe('echo');
      expect(result.steps[0].result.status).toBe('success');
    });

    it('should report duration', async () => {
      const chain = new AgentChain().add('echo', new EchoAgent());
      const result = await chain.run();
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should pass initial kwargs to first step', async () => {
      const chain = new AgentChain().add('echo', new EchoAgent());
      const result = await chain.run({ query: 'from-initial' });
      expect(result.steps[0].result).toHaveProperty('echo', 'from-initial');
    });
  });

  // ── Multi-Step Chaining ──────────────────────────────────────────

  describe('Multi-Step Chaining', () => {
    it('should execute steps in order', async () => {
      const agent1 = new EchoAgent('Echo1');
      const agent2 = new EchoAgent('Echo2');
      const chain = new AgentChain()
        .add('first', agent1, { query: 'step1' })
        .add('second', agent2, { query: 'step2' });
      const result = await chain.run();

      expect(result.status).toBe('success');
      expect(result.steps.length).toBe(2);
      expect(result.steps[0].agentName).toBe('Echo1');
      expect(result.steps[1].agentName).toBe('Echo2');
    });

    it('should propagate data_slush between steps', async () => {
      const agent1 = new EchoAgent('Echo1');
      const agent2 = new EchoAgent('Echo2');
      const chain = new AgentChain()
        .add('first', agent1, { query: 'step1' })
        .add('second', agent2, { query: 'step2' });
      const result = await chain.run();

      // Second step should have received slush from first
      expect(result.steps[1].dataSlush).toBeTruthy();
      expect(result.finalSlush).toBeTruthy();
    });

    it('should produce a final result from the last step', async () => {
      const chain = new AgentChain()
        .add('first', new EchoAgent(), { query: 'a' })
        .add('second', new EchoAgent(), { query: 'b' });
      const result = await chain.run();
      expect(result.finalResult).toBeTruthy();
      expect(result.finalResult!.status).toBe('success');
    });

    it('should work with real ShellAgent', async () => {
      const chain = new AgentChain()
        .add('list', new ShellAgent(), { action: 'bash', command: 'echo hello-chain' });
      const result = await chain.run();
      expect(result.status).toBe('success');
      expect(result.steps[0].result).toHaveProperty('output');
      const output = (result.steps[0].result as Record<string, unknown>).output as string;
      expect(output).toContain('hello-chain');
    });
  });

  // ── Transform Functions ──────────────────────────────────────────

  describe('Transform Functions', () => {
    it('should apply transform between steps', async () => {
      const chain = new AgentChain()
        .add('first', new EchoAgent(), { query: 'original' })
        .add('second', new EchoAgent(), {}, (prevResult) => ({
          query: `transformed-${prevResult.status}`,
        }));
      const result = await chain.run();
      expect(result.steps[1].result).toHaveProperty('echo', 'transformed-success');
    });

    it('transform should receive previous slush', async () => {
      let receivedSlush = false;
      const chain = new AgentChain()
        .add('first', new EchoAgent(), { query: 'a' })
        .add('second', new EchoAgent(), {}, (_prev, slush) => {
          receivedSlush = slush !== null;
          return { query: 'b' };
        });
      await chain.run();
      expect(receivedSlush).toBe(true);
    });
  });

  // ── Error Handling ───────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should stop on error by default', async () => {
      const chain = new AgentChain()
        .add('good', new EchoAgent(), { query: 'ok' })
        .add('bad', new FailAgent())
        .add('unreachable', new EchoAgent(), { query: 'never' });
      const result = await chain.run();

      expect(result.status).toBe('error');
      expect(result.steps.length).toBe(2);
      expect(result.failedStep).toBe('bad');
      expect(result.error).toContain('Intentional failure');
    });

    it('should continue on error when stopOnError is false', async () => {
      const chain = new AgentChain({ stopOnError: false })
        .add('good', new EchoAgent(), { query: 'ok' })
        .add('bad', new FailAgent())
        .add('after', new EchoAgent(), { query: 'still-running' });
      const result = await chain.run();

      expect(result.status).toBe('partial');
      expect(result.steps.length).toBe(3);
      expect(result.steps[1].result.status).toBe('error');
      expect(result.steps[2].result.status).toBe('success');
    });
  });

  // ── Empty Chain ──────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle empty chain gracefully', async () => {
      const chain = new AgentChain();
      const result = await chain.run();
      expect(result.status).toBe('success');
      expect(result.steps).toEqual([]);
      expect(result.finalResult).toBeNull();
    });
  });
});
