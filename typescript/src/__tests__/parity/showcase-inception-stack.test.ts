/**
 * Showcase: The Inception Stack — Recursive agent meta-creation
 *
 * Agents writing agents writing agents, 3 levels deep. Each level's perform()
 * creates and invokes the next level. SubAgentManager tracks depth.
 * AgentTracer captures the nested span tree.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BasicAgent } from '../../agents/BasicAgent.js';
import { SubAgentManager, type SubAgentContext } from '../../agents/subagent.js';
import { createTracer } from '../../agents/tracer.js';
import type { AgentResult } from '../../agents/types.js';

// ── Inline agent definitions (same pattern as example) ──

function createAgents() {
  const agents = new Map<string, BasicAgent>();

  /** Level 3 (Limbo) — Innermost agent. Deterministic text extraction. */
  class DreamExtractorAgent extends BasicAgent {
    constructor() {
      super('DreamExtractor', {
        name: 'DreamExtractor',
        description: 'Extracts dream data from a seed (Level 3)',
        parameters: { type: 'object', properties: { dream_seed: { type: 'string', description: 'Dream seed text' } }, required: ['dream_seed'] },
      });
    }

    async perform(kwargs: Record<string, unknown>): Promise<string> {
      const seed = (kwargs.dream_seed ?? '') as string;
      const charCount = seed.length;
      const vowelCount = seed.split('').filter((c) => 'aeiouAEIOU'.includes(c)).length;
      const totem = `totem_${charCount}_${vowelCount}`;

      return JSON.stringify({
        status: 'success',
        level: 3,
        extraction: { char_count: charCount, vowel_count: vowelCount },
        totem,
        data_slush: { source_agent: 'DreamExtractor', level: 3, totem, char_count: charCount },
      });
    }
  }

  /** Level 2 — Creates and invokes Level 3 inside perform(). */
  class DreamBuilderAgent extends BasicAgent {
    constructor() {
      super('DreamBuilder', {
        name: 'DreamBuilder',
        description: 'Builds dream structure by creating Level 3 agent (Level 2)',
        parameters: { type: 'object', properties: { dream_seed: { type: 'string', description: 'Dream seed text' } }, required: ['dream_seed'] },
      });
    }

    async perform(kwargs: Record<string, unknown>): Promise<string> {
      const manager = kwargs._manager as SubAgentManager;
      const parentCtx = kwargs._subagent_context as SubAgentContext;
      const dreamSeed = (kwargs.dream_seed ?? '') as string;

      // Create Level 3 inside perform() — true recursive meta-creation
      const extractor = new DreamExtractorAgent();
      agents.set('DreamExtractor', extractor);

      const innerResult = await manager.invoke('DreamExtractor', dreamSeed, parentCtx);
      const inner = typeof innerResult === 'string' ? JSON.parse(innerResult) : innerResult;

      return JSON.stringify({
        status: 'success',
        level: 2,
        inner,
        data_slush: { source_agent: 'DreamBuilder', level: 2, inner_totem: inner.totem },
      });
    }
  }

  /** Level 1 — Sets up SubAgentManager, creates Level 2, invokes it. */
  class DreamArchitectAgent extends BasicAgent {
    private maxDepth: number;

    constructor(maxDepth = 4) {
      super('DreamArchitect', {
        name: 'DreamArchitect',
        description: 'Designs the inception stack (Level 1)',
        parameters: { type: 'object', properties: { dream_seed: { type: 'string', description: 'Dream seed text' } }, required: ['dream_seed'] },
      });
      this.maxDepth = maxDepth;
    }

    async perform(kwargs: Record<string, unknown>): Promise<string> {
      const dreamSeed = (kwargs.dream_seed ?? '') as string;

      const manager = new SubAgentManager({ maxDepth: this.maxDepth });
      manager.setExecutor(async (agentId: string, message: string, context?: SubAgentContext) => {
        const agent = agents.get(agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        const result = await agent.execute({
          dream_seed: message,
          _manager: manager,
          _subagent_context: context,
        });
        return JSON.parse(result) as AgentResult;
      });

      const builder = new DreamBuilderAgent();
      agents.set('DreamBuilder', builder);

      const ctx = manager.createContext('DreamArchitect');
      const innerResult = await manager.invoke('DreamBuilder', dreamSeed, ctx);
      const inner = typeof innerResult === 'string' ? JSON.parse(innerResult) : innerResult;

      return JSON.stringify({
        status: 'success',
        level: 1,
        inner,
        data_slush: { source_agent: 'DreamArchitect', level: 1, stack_depth: 3 },
      });
    }
  }

  return { agents, DreamExtractorAgent, DreamBuilderAgent, DreamArchitectAgent };
}

// ── Tests ──

describe('Showcase: Inception Stack', () => {
  let agents: Map<string, BasicAgent>;
  let DreamExtractorAgent: ReturnType<typeof createAgents>['DreamExtractorAgent'];
  let DreamBuilderAgent: ReturnType<typeof createAgents>['DreamBuilderAgent'];
  let DreamArchitectAgent: ReturnType<typeof createAgents>['DreamArchitectAgent'];

  beforeEach(() => {
    const created = createAgents();
    agents = created.agents;
    DreamExtractorAgent = created.DreamExtractorAgent;
    DreamBuilderAgent = created.DreamBuilderAgent;
    DreamArchitectAgent = created.DreamArchitectAgent;
  });

  describe('Recursive agent creation', () => {
    it('Level 3 (Limbo) agent produces correct extraction', async () => {
      const extractor = new DreamExtractorAgent();
      const result = JSON.parse(await extractor.execute({ dream_seed: 'lucid dreaming' }));

      expect(result.status).toBe('success');
      expect(result.level).toBe(3);
      expect(result.extraction.char_count).toBe(14);
      // 'lucid dreaming' vowels: u, i, e, a, i = 5
      expect(result.extraction.vowel_count).toBe(5);
      expect(result.totem).toBe('totem_14_5');
    });

    it('Level 2 creates and invokes Level 3 inside perform()', async () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      manager.setExecutor(async (agentId: string, message: string, context?: SubAgentContext) => {
        const agent = agents.get(agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        const result = await agent.execute({
          dream_seed: message,
          _manager: manager,
          _subagent_context: context,
        });
        return JSON.parse(result) as AgentResult;
      });

      const builder = new DreamBuilderAgent();
      agents.set('DreamBuilder', builder);

      const ctx = manager.createContext('TestRoot');
      const resultStr = await builder.execute({
        dream_seed: 'hello',
        _manager: manager,
        _subagent_context: ctx,
      });
      const result = JSON.parse(resultStr);

      expect(result.level).toBe(2);
      expect(result.inner).toBeDefined();
      expect(result.inner.level).toBe(3);
      expect(result.inner.totem).toBe('totem_5_2'); // 'hello' = 5 chars, 2 vowels (e, o)
    });

    it('Full 3-level inception stack executes successfully', async () => {
      const architect = new DreamArchitectAgent(4);
      const result = JSON.parse(await architect.execute({ dream_seed: 'inception' }));

      expect(result.status).toBe('success');
      expect(result.level).toBe(1);
      expect(result.inner.level).toBe(2);
      expect(result.inner.inner.level).toBe(3);
      expect(result.inner.inner.totem).toBeDefined();
    });
  });

  describe('Data slush bubbling', () => {
    it('Nested data_slush has all 3 levels', async () => {
      const architect = new DreamArchitectAgent(4);
      const result = JSON.parse(await architect.execute({ dream_seed: 'dream' }));

      // Level 1 slush
      expect(result.data_slush.source_agent).toBe('DreamArchitect');
      expect(result.data_slush.level).toBe(1);

      // Level 2 slush (nested in inner)
      expect(result.inner.data_slush.source_agent).toBe('DreamBuilder');
      expect(result.inner.data_slush.level).toBe(2);

      // Level 3 slush (nested in inner.inner)
      expect(result.inner.inner.data_slush.source_agent).toBe('DreamExtractor');
      expect(result.inner.inner.data_slush.level).toBe(3);
    });

    it('Each level preserves source_agent identity', async () => {
      const architect = new DreamArchitectAgent(4);
      const result = JSON.parse(await architect.execute({ dream_seed: 'test' }));

      const agents = [
        result.data_slush.source_agent,
        result.inner.data_slush.source_agent,
        result.inner.inner.data_slush.source_agent,
      ];
      expect(agents).toEqual(['DreamArchitect', 'DreamBuilder', 'DreamExtractor']);
    });
  });

  describe('SubAgentManager depth tracking', () => {
    it('Tracks depth 0->1->2 across inception levels', async () => {
      const depths: number[] = [];
      const manager = new SubAgentManager({ maxDepth: 5 });
      manager.setExecutor(async (agentId: string, message: string, context?: SubAgentContext) => {
        depths.push(context?.depth ?? -1);
        const agent = agents.get(agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        const result = await agent.execute({
          dream_seed: message,
          _manager: manager,
          _subagent_context: context,
        });
        return JSON.parse(result) as AgentResult;
      });

      const builder = new DreamBuilderAgent();
      agents.set('DreamBuilder', builder);

      const ctx = manager.createContext('TestRoot');
      await manager.invoke('DreamBuilder', 'test', ctx);

      // Level 2 executes at depth 1, Level 3 at depth 2
      expect(depths).toEqual([1, 2]);
    });

    it('Blocks creation when maxDepth exceeded', async () => {
      // Test directly with SubAgentManager since execute() catches errors internally.
      // maxDepth=1 allows depth 0 invoke but blocks depth 1 invoke.
      const manager = new SubAgentManager({ maxDepth: 1 });
      manager.setExecutor(async () => ({ status: 'success' }));

      const ctx = manager.createContext('DreamArchitect');
      // First invoke at depth 0 → allowed (0 < 1)
      await manager.invoke('DreamBuilder', 'test', ctx);

      // Simulate depth 1 context (as Level 2 would receive)
      const deepCtx = { ...ctx, depth: 1, callId: 'deep', parentAgentId: 'DreamBuilder', history: [...ctx.history] };
      // Invoke at depth 1 → blocked (1 >= 1)
      await expect(
        manager.invoke('DreamExtractor', 'test', deepCtx),
      ).rejects.toThrow(/Cannot invoke agent DreamExtractor/);
    });

    it('Allows all 3 levels with sufficient maxDepth', async () => {
      // maxDepth=4 allows depths 0, 1, 2, 3
      const architect = new DreamArchitectAgent(4);
      const result = JSON.parse(await architect.execute({ dream_seed: 'deep enough' }));

      expect(result.level).toBe(1);
      expect(result.inner.level).toBe(2);
      expect(result.inner.inner.level).toBe(3);
    });
  });

  describe('Agent tracing', () => {
    it('Creates nested parent-child trace spans across 3 levels', () => {
      const tracer = createTracer({ recordIO: true });

      // Simulate 3-level span tree
      const { span: l1, context: ctx1 } = tracer.startSpan('DreamArchitect', 'execute');
      const { span: l2, context: ctx2 } = tracer.startSpan('DreamBuilder', 'execute', ctx1);
      const { span: l3 } = tracer.startSpan('DreamExtractor', 'execute', ctx2);

      tracer.endSpan(l3.id, { status: 'success' });
      tracer.endSpan(l2.id, { status: 'success' });
      tracer.endSpan(l1.id, { status: 'success' });

      const trace = tracer.getTrace(ctx1.traceId);
      expect(trace).toHaveLength(3);

      // Find spans by agent name (order depends on same-ms startTime resolution)
      const spanMap = new Map(trace.map((s) => [s.agentName, s]));
      const root = spanMap.get('DreamArchitect')!;
      const mid = spanMap.get('DreamBuilder')!;
      const leaf = spanMap.get('DreamExtractor')!;

      // Verify parent-child relationships
      expect(root.parentId).toBeNull(); // root
      expect(mid.parentId).toBe(l1.id); // Level 2 -> Level 1
      expect(leaf.parentId).toBe(l2.id); // Level 3 -> Level 2

      // All share the same traceId
      const traceIds = new Set(trace.map((s) => s.traceId));
      expect(traceIds.size).toBe(1);
    });

    it('Records correct agent names in trace spans', () => {
      const tracer = createTracer();

      const { context: ctx1 } = tracer.startSpan('DreamArchitect', 'execute');
      const { context: ctx2 } = tracer.startSpan('DreamBuilder', 'execute', ctx1);
      const { span: l3 } = tracer.startSpan('DreamExtractor', 'execute', ctx2);

      tracer.endSpan(l3.id, { status: 'success' });
      tracer.endSpan(ctx2.spanId, { status: 'success' });
      tracer.endSpan(ctx1.spanId, { status: 'success' });

      const trace = tracer.getTrace(ctx1.traceId);
      const names = new Set(trace.map((s) => s.agentName));
      expect(names).toEqual(new Set(['DreamArchitect', 'DreamBuilder', 'DreamExtractor']));
    });
  });
});
