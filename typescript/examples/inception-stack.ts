/**
 * The Inception Stack — Agents writing agents writing agents, 3 levels deep
 *
 * Each generated agent's perform() body creates and invokes the next level.
 * The innermost agent's output bubbles up through nested data_slush.
 * SubAgentManager provides depth safety rails. AgentTracer captures the span tree.
 *
 * Run: npx tsx examples/inception-stack.ts
 */

import { BasicAgent } from '../src/agents/BasicAgent.js';
import { SubAgentManager } from '../src/agents/subagent.js';
import { createTracer } from '../src/agents/tracer.js';
import type { AgentResult } from '../src/agents/types.js';
import type { SubAgentContext } from '../src/agents/subagent.js';

// Shared agent registry — each level registers the next before invoking it
const agents = new Map<string, BasicAgent>();

/** Level 3 (Limbo) — Innermost agent. Deterministic text extraction. */
class DreamExtractorAgent extends BasicAgent {
  constructor() {
    super('DreamExtractor', {
      name: 'DreamExtractor',
      description: 'Extracts dream data from a seed (Level 3 — Limbo)',
      parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const seed = (kwargs.dream_seed ?? '') as string;
    const charCount = seed.length;
    const vowelCount = seed.split('').filter((c) => 'aeiouAEIOU'.includes(c)).length;
    const totem = `totem_${charCount}_${vowelCount}`;

    console.log(`  [Level 3 - Limbo] Extracted: chars=${charCount}, vowels=${vowelCount}, totem="${totem}"`);
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
      parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const manager = kwargs._manager as SubAgentManager;
    const parentCtx = kwargs._subagent_context as SubAgentContext;
    const dreamSeed = (kwargs.dream_seed ?? '') as string;

    console.log(`  [Level 2 - Dream] Creating Level 3 agent inside perform()...`);

    // Create Level 3 agent inside perform() — true recursive meta-creation
    const extractor = new DreamExtractorAgent();
    agents.set('DreamExtractor', extractor);

    // Invoke Level 3 via SubAgentManager (tracks depth)
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
      description: 'Designs the inception stack — creates Level 2 agent (Level 1)',
      parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
    });
    this.maxDepth = maxDepth;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const dreamSeed = (kwargs.dream_seed ?? '') as string;

    console.log(`  [Level 1 - Reality] Setting up SubAgentManager (maxDepth=${this.maxDepth})...`);

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

    // Create Level 2 inside perform() — true recursive meta-creation
    console.log(`  [Level 1 - Reality] Creating Level 2 agent inside perform()...`);
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

async function main() {
  console.log('=== The Inception Stack: Agents Creating Agents Creating Agents ===\n');

  // Demo 1: Full 3-level stack
  console.log('--- Demo 1: Full 3-Level Inception Stack ---');
  const architect = new DreamArchitectAgent(4);
  const result = JSON.parse(await architect.execute({ dream_seed: 'lucid dreaming' }));
  console.log(`  Result: level=${result.level}, nested levels present=${!!result.inner?.inner}`);
  console.log(`  Innermost totem: "${result.inner?.inner?.totem}"\n`);

  // Demo 2: Trace the nested spans
  console.log('--- Demo 2: Tracing Nested Spans ---');
  const tracer = createTracer({ recordIO: true });
  const { span: rootSpan, context: rootCtx } = tracer.startSpan('DreamArchitect', 'execute');
  const { span: l2Span, context: l2Ctx } = tracer.startSpan('DreamBuilder', 'execute', rootCtx);
  const { span: l3Span } = tracer.startSpan('DreamExtractor', 'execute', l2Ctx);
  tracer.endSpan(l3Span.id, { status: 'success' });
  tracer.endSpan(l2Span.id, { status: 'success' });
  tracer.endSpan(rootSpan.id, { status: 'success' });
  const trace = tracer.getTrace(rootCtx.traceId);
  console.log(`  Trace has ${trace.length} spans:`);
  for (const s of trace) {
    console.log(`    ${s.agentName} (parent: ${s.parentId ? 'yes' : 'root'})`);
  }

  // Demo 3: Depth overflow
  console.log('\n--- Demo 3: Depth Overflow (maxDepth=3) ---');
  agents.clear();
  const shallowArchitect = new DreamArchitectAgent(3);
  try {
    await shallowArchitect.execute({ dream_seed: 'too deep' });
    console.log('  ERROR: Should have thrown!');
  } catch (e) {
    console.log(`  Depth limit caught: ${(e as Error).message}`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
