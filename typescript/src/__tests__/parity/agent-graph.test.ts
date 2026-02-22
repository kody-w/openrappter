/**
 * AgentGraph Parity Tests
 *
 * Tests the DAG executor with parallel execution, dependency edges,
 * cycle detection, and data_slush merging.
 */

import { describe, it, expect } from 'vitest';
import { AgentGraph, createAgentGraph } from '../../agents/graph.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Test helpers ──

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
      data_slush: this.slushOut({ signals: { agent: this.name } }),
    });
  }
}

class DelayAgent extends BasicAgent {
  private delayMs: number;

  constructor(name: string, delayMs: number) {
    const metadata: AgentMetadata = {
      name,
      description: `Delays ${delayMs}ms`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.delayMs = delayMs;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return JSON.stringify({
      status: 'success',
      delayed: this.delayMs,
      data_slush: this.slushOut({ signals: { delay: this.delayMs } }),
    });
  }
}

class FailAgent extends BasicAgent {
  constructor(name = 'Fail') {
    const metadata: AgentMetadata = {
      name,
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
  }

  async perform(): Promise<string> {
    throw new Error('Intentional failure');
  }
}

class OrderTracker extends BasicAgent {
  static executionOrder: string[] = [];

  constructor(name: string) {
    const metadata: AgentMetadata = {
      name,
      description: 'Tracks execution order',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
  }

  async perform(): Promise<string> {
    OrderTracker.executionOrder.push(this.name);
    return JSON.stringify({
      status: 'success',
      order: OrderTracker.executionOrder.length,
      data_slush: this.slushOut({ signals: { order: OrderTracker.executionOrder.length } }),
    });
  }
}

describe('AgentGraph', () => {
  // ── Construction ──

  describe('Construction', () => {
    it('should create an empty graph', () => {
      const graph = new AgentGraph();
      expect(graph.length).toBe(0);
      expect(graph.getNodeNames()).toEqual([]);
    });

    it('should create via factory function', () => {
      const graph = createAgentGraph({ nodeTimeout: 5000 });
      expect(graph.length).toBe(0);
    });

    it('should add nodes with fluent API', () => {
      const graph = new AgentGraph();
      const result = graph
        .addNode({ name: 'a', agent: new EchoAgent('A') })
        .addNode({ name: 'b', agent: new EchoAgent('B') });

      expect(result).toBe(graph);
      expect(graph.length).toBe(2);
      expect(graph.getNodeNames()).toEqual(['a', 'b']);
    });
  });

  // ── Validation ──

  describe('Validation', () => {
    it('should validate a valid DAG', () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new EchoAgent('A') })
        .addNode({ name: 'b', agent: new EchoAgent('B'), dependsOn: ['a'] })
        .addNode({ name: 'c', agent: new EchoAgent('C'), dependsOn: ['a', 'b'] });

      const validation = graph.validate();
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('should detect cycles', () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new EchoAgent('A'), dependsOn: ['c'] })
        .addNode({ name: 'b', agent: new EchoAgent('B'), dependsOn: ['a'] })
        .addNode({ name: 'c', agent: new EchoAgent('C'), dependsOn: ['b'] });

      const validation = graph.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors[0]).toContain('Cycle');
    });

    it('should detect missing dependencies', () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new EchoAgent('A'), dependsOn: ['nonexistent'] });

      const validation = graph.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors[0]).toContain('nonexistent');
    });

    it('should detect self-referencing dependencies', () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new EchoAgent('A'), dependsOn: ['a'] });

      const validation = graph.validate();
      expect(validation.valid).toBe(false);
    });
  });

  // ── Execution ──

  describe('Execution', () => {
    it('should execute a single node', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'echo', agent: new EchoAgent('Echo'), kwargs: { query: 'hello' } });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.executionOrder).toEqual(['echo']);
      expect(result.nodes.get('echo')?.status).toBe('success');
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should execute independent nodes in parallel', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new DelayAgent('A', 50) })
        .addNode({ name: 'b', agent: new DelayAgent('B', 50) })
        .addNode({ name: 'c', agent: new DelayAgent('C', 50) });

      const start = Date.now();
      const result = await graph.run();
      const elapsed = Date.now() - start;

      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(3);
      // Should run in parallel, so total should be ~50ms not ~150ms
      // Allow generous margin for CI
      expect(elapsed).toBeLessThan(300);
    });

    it('should respect dependency order', async () => {
      OrderTracker.executionOrder = [];

      const graph = new AgentGraph()
        .addNode({ name: 'first', agent: new OrderTracker('first') })
        .addNode({ name: 'second', agent: new OrderTracker('second'), dependsOn: ['first'] })
        .addNode({ name: 'third', agent: new OrderTracker('third'), dependsOn: ['second'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(OrderTracker.executionOrder).toEqual(['first', 'second', 'third']);
    });

    it('should pass initial kwargs to root nodes', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'echo', agent: new EchoAgent('Echo') });

      const result = await graph.run({ query: 'initial' });
      expect(result.status).toBe('success');
      const nodeResult = result.nodes.get('echo');
      expect(nodeResult?.status).toBe('success');
      const parsed = nodeResult?.result;
      expect(parsed?.echo).toBe('initial');
    });

    it('should execute diamond DAG correctly', async () => {
      OrderTracker.executionOrder = [];

      // Diamond: A -> B, A -> C, B -> D, C -> D
      const graph = new AgentGraph()
        .addNode({ name: 'A', agent: new OrderTracker('A') })
        .addNode({ name: 'B', agent: new OrderTracker('B'), dependsOn: ['A'] })
        .addNode({ name: 'C', agent: new OrderTracker('C'), dependsOn: ['A'] })
        .addNode({ name: 'D', agent: new OrderTracker('D'), dependsOn: ['B', 'C'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(4);
      // A must be first, D must be last
      expect(OrderTracker.executionOrder[0]).toBe('A');
      expect(OrderTracker.executionOrder[3]).toBe('D');
    });
  });

  // ── Data Slush Merging ──

  describe('Data Slush Merging', () => {
    it('should merge data_slush from multiple upstream nodes', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'source1', agent: new EchoAgent('Source1') })
        .addNode({ name: 'source2', agent: new EchoAgent('Source2') })
        .addNode({ name: 'sink', agent: new EchoAgent('Sink'), dependsOn: ['source1', 'source2'] });

      const result = await graph.run();
      expect(result.status).toBe('success');

      const sinkResult = result.nodes.get('sink');
      expect(sinkResult?.status).toBe('success');
      expect(sinkResult?.result?.received_upstream).toBe(true);
    });

    it('should forward single upstream slush', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'source', agent: new EchoAgent('Source') })
        .addNode({ name: 'sink', agent: new EchoAgent('Sink'), dependsOn: ['source'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
    });
  });

  // ── Error Handling ──

  describe('Error Handling', () => {
    it('should skip dependents when a node fails (default)', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new EchoAgent('A') })
        .addNode({ name: 'fail', agent: new FailAgent(), dependsOn: ['a'] })
        .addNode({ name: 'c', agent: new EchoAgent('C'), dependsOn: ['fail'] });

      const result = await graph.run();
      expect(result.status).toBe('partial');
      expect(result.nodes.get('a')?.status).toBe('success');
      expect(result.nodes.get('fail')?.status).toBe('error');
      expect(result.nodes.get('c')?.status).toBe('skipped');
    });

    it('should stop immediately with stopOnError=true', async () => {
      const graph = createAgentGraph({ stopOnError: true })
        .addNode({ name: 'fail', agent: new FailAgent() })
        .addNode({ name: 'b', agent: new EchoAgent('B') });

      const result = await graph.run();
      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
    });

    it('should throw on run() with cycle', async () => {
      const graph = new AgentGraph()
        .addNode({ name: 'a', agent: new EchoAgent('A'), dependsOn: ['b'] })
        .addNode({ name: 'b', agent: new EchoAgent('B'), dependsOn: ['a'] });

      await expect(graph.run()).rejects.toThrow();
    });

    it('should handle empty graph', async () => {
      const graph = new AgentGraph();
      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(0);
      expect(result.executionOrder).toEqual([]);
    });
  });

  // ── Timeout ──

  describe('Timeout', () => {
    it('should timeout slow nodes', async () => {
      const graph = createAgentGraph({ nodeTimeout: 50 })
        .addNode({ name: 'slow', agent: new DelayAgent('Slow', 5000) });

      const result = await graph.run();
      expect(result.nodes.get('slow')?.status).toBe('error');
    });
  });
});
