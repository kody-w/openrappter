/**
 * Showcase UI — RPC method tests for showcase.list, showcase.run, showcase.runall
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerShowcaseMethods } from '../../gateway/methods/showcase-methods.js';
import type { DemoInfo, DemoRunResult } from '../../gateway/methods/showcase-methods.js';

// ── Mock server ──

type Handler = (params: unknown, connection: unknown) => Promise<unknown>;

class MockServer {
  methods: Map<string, Handler> = new Map();

  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
  ): void {
    this.methods.set(name, handler as Handler);
  }

  async call<P, R>(name: string, params?: P): Promise<R> {
    const handler = this.methods.get(name);
    if (!handler) throw new Error(`Method not found: ${name}`);
    return handler(params, null) as Promise<R>;
  }
}

describe('Showcase RPC Methods', () => {
  let server: MockServer;

  beforeEach(() => {
    server = new MockServer();
    registerShowcaseMethods(server);
  });

  describe('showcase.list', () => {
    it('returns array of 11 demos', async () => {
      const result = await server.call<void, { demos: DemoInfo[] }>('showcase.list');
      expect(result.demos).toHaveLength(11);
    });

    it('each demo has id, name, description, category, agentTypes', async () => {
      const result = await server.call<void, { demos: DemoInfo[] }>('showcase.list');
      for (const demo of result.demos) {
        expect(demo.id).toBeTruthy();
        expect(typeof demo.id).toBe('string');
        expect(demo.name).toBeTruthy();
        expect(typeof demo.name).toBe('string');
        expect(demo.description).toBeTruthy();
        expect(typeof demo.description).toBe('string');
        expect(demo.category).toBeTruthy();
        expect(typeof demo.category).toBe('string');
        expect(Array.isArray(demo.agentTypes)).toBe(true);
        expect(demo.agentTypes.length).toBeGreaterThan(0);
      }
    });

    it('all demo IDs are unique', async () => {
      const result = await server.call<void, { demos: DemoInfo[] }>('showcase.list');
      const ids = result.demos.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all categories are valid strings', async () => {
      const result = await server.call<void, { demos: DemoInfo[] }>('showcase.list');
      const validCategories = [
        'Competition', 'Safety', 'Analysis', 'Observability',
        'Evolution', 'Meta', 'Parallel', 'DAG', 'Verification', 'Cloning',
        'Recursion',
      ];
      for (const demo of result.demos) {
        expect(validCategories).toContain(demo.category);
      }
    });
  });

  describe('showcase.run', () => {
    const demoIds = [
      'darwins-colosseum',
      'infinite-regress',
      'ship-of-theseus',
      'panopticon',
      'lazarus-loop',
      'agent-factory-factory',
      'swarm-vote',
      'time-loop',
      'ghost-protocol',
      'ouroboros-squared',
      'inception-stack',
    ];

    for (const demoId of demoIds) {
      it(`runs ${demoId} successfully`, async () => {
        const result = await server.call<{ demoId: string }, DemoRunResult>(
          'showcase.run',
          { demoId },
        );
        expect(result.demoId).toBe(demoId);
        expect(result.status).toBe('success');
        expect(result.name).toBeTruthy();
        expect(result.summary).toBeTruthy();
        expect(result.steps.length).toBeGreaterThan(0);
        expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      });
    }

    it('returns error for unknown demo ID', async () => {
      const result = await server.call<{ demoId: string }, DemoRunResult>(
        'showcase.run',
        { demoId: 'nonexistent-demo' },
      );
      expect(result.status).toBe('error');
      expect(result.error).toContain('nonexistent-demo');
    });

    it('result includes steps array with labels and durations', async () => {
      const result = await server.call<{ demoId: string }, DemoRunResult>(
        'showcase.run',
        { demoId: 'darwins-colosseum' },
      );
      for (const step of result.steps) {
        expect(step.label).toBeTruthy();
        expect(typeof step.label).toBe('string');
        expect(typeof step.durationMs).toBe('number');
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('total duration is sum of step durations', async () => {
      const result = await server.call<{ demoId: string }, DemoRunResult>(
        'showcase.run',
        { demoId: 'infinite-regress' },
      );
      const stepSum = result.steps.reduce((sum, s) => sum + s.durationMs, 0);
      expect(result.totalDurationMs).toBe(stepSum);
    });
  });

  describe('showcase.runall', () => {
    it('runs all 11 demos', async () => {
      const result = await server.call<void, { results: DemoRunResult[] }>('showcase.runall');
      expect(result.results).toHaveLength(11);
    });

    it('returns results in order', async () => {
      const listResult = await server.call<void, { demos: DemoInfo[] }>('showcase.list');
      const runResult = await server.call<void, { results: DemoRunResult[] }>('showcase.runall');
      for (let i = 0; i < listResult.demos.length; i++) {
        expect(runResult.results[i].demoId).toBe(listResult.demos[i].id);
      }
    });

    it('each result has correct demoId', async () => {
      const listResult = await server.call<void, { demos: DemoInfo[] }>('showcase.list');
      const runResult = await server.call<void, { results: DemoRunResult[] }>('showcase.runall');
      const expectedIds = listResult.demos.map((d) => d.id);
      const actualIds = runResult.results.map((r) => r.demoId);
      expect(actualIds).toEqual(expectedIds);
    });

    it('all demos succeed', async () => {
      const result = await server.call<void, { results: DemoRunResult[] }>('showcase.runall');
      for (const r of result.results) {
        expect(r.status).toBe('success');
      }
    });
  });
});
