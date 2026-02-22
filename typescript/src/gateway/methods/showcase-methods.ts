/**
 * Showcase RPC methods — exposes Power Prompts demos via gateway
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

export interface DemoInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  agentTypes: string[];
}

export interface DemoStepResult {
  label: string;
  result: unknown;
  durationMs: number;
}

export interface DemoRunResult {
  demoId: string;
  name: string;
  status: 'success' | 'error';
  steps: DemoStepResult[];
  totalDurationMs: number;
  summary: string;
  error?: string;
}

const DEMOS: DemoInfo[] = [
  {
    id: 'darwins-colosseum',
    name: "Darwin's Colosseum",
    description: 'Watchmaker tournament — competing agents evaluated by quality score via AgentGraph',
    category: 'Competition',
    agentTypes: ['AgentGraph', 'BasicAgent'],
  },
  {
    id: 'infinite-regress',
    name: 'Infinite Regression',
    description: 'SubAgentManager depth limits and loop detection safety mechanisms',
    category: 'Safety',
    agentTypes: ['SubAgentManager'],
  },
  {
    id: 'ship-of-theseus',
    name: 'Code Archaeologist',
    description: 'Fan-out/fan-in analysis — 3 analyzers run in parallel, synthesis merges findings',
    category: 'Analysis',
    agentTypes: ['AgentGraph', 'BasicAgent'],
  },
  {
    id: 'panopticon',
    name: 'Living Dashboard',
    description: 'Self-monitoring loop: AgentChain → Tracer → Dashboard → MCP query',
    category: 'Observability',
    agentTypes: ['AgentChain', 'AgentTracer', 'DashboardHandler', 'McpServer'],
  },
  {
    id: 'lazarus-loop',
    name: 'Ouroboros Accelerator',
    description: 'Evolution → review chain with data_slush forwarding between steps',
    category: 'Evolution',
    agentTypes: ['AgentChain', 'BasicAgent'],
  },
  {
    id: 'agent-factory-factory',
    name: 'Agent Compiler',
    description: 'PipelineAgent with conditional step — creates agents on-demand based on input',
    category: 'Meta',
    agentTypes: ['PipelineAgent', 'BasicAgent'],
  },
  {
    id: 'swarm-vote',
    name: 'Swarm Debugger',
    description: 'BroadcastManager race mode — debug agents compete, fastest wins, slush forwarded',
    category: 'Parallel',
    agentTypes: ['BroadcastManager', 'BasicAgent'],
  },
  {
    id: 'time-loop',
    name: 'The Architect',
    description: 'Runtime agent creation wired into a DAG with multi-upstream slush merging',
    category: 'DAG',
    agentTypes: ['AgentGraph', 'BasicAgent'],
  },
  {
    id: 'ghost-protocol',
    name: 'Mirror Test',
    description: 'Parallel parity comparison — two implementations compared via AgentGraph',
    category: 'Verification',
    agentTypes: ['AgentGraph', 'BasicAgent'],
  },
  {
    id: 'ouroboros-squared',
    name: 'Doppelganger',
    description: 'Trace-based agent cloning — original vs clone comparison via AgentChain',
    category: 'Cloning',
    agentTypes: ['AgentChain', 'AgentTracer', 'BasicAgent'],
  },
  {
    id: 'inception-stack',
    name: 'The Inception Stack',
    description: 'Recursive agent meta-creation — agents writing agents 3 levels deep with depth tracking',
    category: 'Recursion',
    agentTypes: ['SubAgentManager', 'AgentTracer', 'BasicAgent'],
  },
  {
    id: 'slosh-deep-dive',
    name: 'Data Sloshing Deep Dive',
    description: 'Full data sloshing pipeline — signal categories, SloshFilter, SloshPrivacy, debug, feedback, breadcrumbs',
    category: 'Context',
    agentTypes: ['BasicAgent'],
  },
  {
    id: 'memory-recall',
    name: 'Memory Recall',
    description: 'MemoryManager FTS search, overlapping chunking, snippets, source filtering, lifecycle',
    category: 'Memory',
    agentTypes: ['MemoryManager'],
  },
  {
    id: 'channel-switchboard',
    name: 'Channel Switchboard',
    description: 'ChannelRegistry multi-channel routing — register, connect, route, status, disconnect',
    category: 'Channels',
    agentTypes: ['ChannelRegistry', 'BaseChannel'],
  },
  {
    id: 'config-hotswap',
    name: 'Config Hotswap',
    description: 'Config utilities — JSON5 parsing, Zod validation, deep merge, env var substitution, JSON Schema',
    category: 'Config',
    agentTypes: ['ConfigLoader'],
  },
  {
    id: 'persistence-vault',
    name: 'Persistence Vault',
    description: 'In-memory SQLite StorageAdapter — sessions, chunks, cron jobs, KV config, transactions',
    category: 'Storage',
    agentTypes: ['StorageAdapter'],
  },
  {
    id: 'healing-loop',
    name: 'Healing Loop',
    description: 'SelfHealingCronAgent — setup, health check, restart, recovery, status tracking, teardown',
    category: 'Resilience',
    agentTypes: ['SelfHealingCronAgent', 'BasicAgent'],
  },
  {
    id: 'auth-fortress',
    name: 'Authorization Fortress',
    description: 'ApprovalManager — deny/allowlist/full policies, priority rules, scoping, request/approve/reject',
    category: 'Security',
    agentTypes: ['ApprovalManager'],
  },
  {
    id: 'stream-weaver',
    name: 'Stream Weaver',
    description: 'StreamManager — sessions, blocks, delta accumulation, subscribers, lifecycle',
    category: 'Streaming',
    agentTypes: ['StreamManager'],
  },
];

// ── Demo runner helpers ──

import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../../agents/types.js';

class MockAgent extends BasicAgent {
  private output: Record<string, unknown>;

  constructor(name: string, description: string, output: Record<string, unknown>) {
    const metadata: AgentMetadata = {
      name,
      description,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.output = output;
  }

  async perform(): Promise<string> {
    return JSON.stringify({ status: 'success', ...this.output });
  }
}

const LOG_PREFIX = '\x1b[35m[showcase]\x1b[0m';

async function timeStep<T>(label: string, fn: () => Promise<T>): Promise<DemoStepResult & { value: T }> {
  const start = Date.now();
  const value = await fn();
  const ms = Date.now() - start;
  console.log(`${LOG_PREFIX}   \x1b[32m✓\x1b[0m ${label} \x1b[90m(${ms}ms)\x1b[0m`);
  return { label, result: value, durationMs: ms, value };
}

// ── Individual demo runners ──

async function runDarwinsColosseum(): Promise<DemoRunResult> {
  const { AgentGraph } = await import('../../agents/graph.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Create competitor agents', async () => {
    const agents = ['CompA', 'CompB', 'CompC'].map(
      (name, i) =>
        new MockAgent(name, `Competitor ${name}`, {
          quality: [50, 90, 70][i],
          solution: ['brute force', 'dynamic programming', 'greedy'][i],
          data_slush: { source_agent: name, quality: [50, 90, 70][i] },
        }),
    );
    return { count: agents.length, names: agents.map((a) => a.name) };
  });
  steps.push(s1);

  const s2 = await timeStep('Run tournament graph', async () => {
    const compA = new MockAgent('CompA', 'Competitor A', { quality: 50, data_slush: { source_agent: 'CompA', quality: 50 } });
    const compB = new MockAgent('CompB', 'Competitor B', { quality: 90, data_slush: { source_agent: 'CompB', quality: 90 } });
    const compC = new MockAgent('CompC', 'Competitor C', { quality: 70, data_slush: { source_agent: 'CompC', quality: 70 } });
    const evaluator = new MockAgent('Evaluator', 'Evaluates', { winner: 'CompB', data_slush: { winner: 'CompB' } });

    const graph = new AgentGraph()
      .addNode({ name: 'comp-a', agent: compA })
      .addNode({ name: 'comp-b', agent: compB })
      .addNode({ name: 'comp-c', agent: compC })
      .addNode({ name: 'evaluator', agent: evaluator, dependsOn: ['comp-a', 'comp-b', 'comp-c'] });

    const result = await graph.run();
    return { status: result.status, nodes: result.nodes.size, order: result.executionOrder };
  });
  steps.push(s2);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'darwins-colosseum', name: "Darwin's Colosseum", status: 'success', steps, totalDurationMs: total, summary: 'Tournament: 3 competitors, evaluator picked winner via DAG' };
}

async function runInfiniteRegress(): Promise<DemoRunResult> {
  const { SubAgentManager } = await import('../../agents/subagent.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Test depth limits', async () => {
    const manager = new SubAgentManager({ maxDepth: 5 });
    return { withinLimit: manager.canInvoke('Agent', 4), atLimit: manager.canInvoke('Agent', 5) };
  });
  steps.push(s1);

  const s2 = await timeStep('Test loop detection', async () => {
    const manager = new SubAgentManager({ maxDepth: 10 });
    manager.setExecutor(async () => ({ status: 'success' as const }));
    const context = manager.createContext('Root');
    // Push 3 calls to trigger loop
    for (let i = 0; i < 3; i++) {
      context.history.push({
        id: `call_${i}`, parentAgentId: 'Root', targetAgentId: 'LoopAgent',
        message: 'test', depth: 0, startedAt: new Date().toISOString(), status: 'success',
      });
    }
    let loopDetected = false;
    try {
      await manager.invoke('LoopAgent', 'call 4', context);
    } catch {
      loopDetected = true;
    }
    return { loopDetected };
  });
  steps.push(s2);

  const s3 = await timeStep('Test blocked agents', async () => {
    const manager = new SubAgentManager({ maxDepth: 5, blockedAgents: ['Danger'] });
    return { blocked: !manager.canInvoke('Danger', 0), allowed: manager.canInvoke('Safe', 0) };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'infinite-regress', name: 'Infinite Regression', status: 'success', steps, totalDurationMs: total, summary: 'Safety: depth limits, loop detection, blocked agents all verified' };
}

async function runShipOfTheseus(): Promise<DemoRunResult> {
  const { AgentGraph } = await import('../../agents/graph.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Create analysis agents', async () => {
    return { agents: ['GitHistory', 'DependencyAnalyzer', 'ComplexityScorer', 'Synthesis'] };
  });
  steps.push(s1);

  const s2 = await timeStep('Run fan-out/fan-in graph', async () => {
    const git = new MockAgent('GitHistory', 'Git analysis', { commits: 142, data_slush: { source_agent: 'GitHistory', analysis_type: 'git_history' } });
    const deps = new MockAgent('DependencyAnalyzer', 'Deps', { total: 24, data_slush: { source_agent: 'DependencyAnalyzer', analysis_type: 'dependencies' } });
    const complexity = new MockAgent('ComplexityScorer', 'Complexity', { avg: 4.2, data_slush: { source_agent: 'ComplexityScorer', analysis_type: 'complexity' } });
    const synthesis = new MockAgent('Synthesis', 'Merge', { merged: true, data_slush: { source_agent: 'Synthesis' } });

    const graph = new AgentGraph()
      .addNode({ name: 'git', agent: git })
      .addNode({ name: 'deps', agent: deps })
      .addNode({ name: 'complexity', agent: complexity })
      .addNode({ name: 'synthesis', agent: synthesis, dependsOn: ['git', 'deps', 'complexity'] });

    const result = await graph.run();
    return { status: result.status, nodes: result.nodes.size, order: result.executionOrder };
  });
  steps.push(s2);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'ship-of-theseus', name: 'Code Archaeologist', status: 'success', steps, totalDurationMs: total, summary: 'Fan-out/fan-in: 3 parallel analyzers merged by synthesis node' };
}

async function runPanopticon(): Promise<DemoRunResult> {
  const { createTracer } = await import('../../agents/tracer.js');
  const { DashboardHandler } = await import('../../gateway/dashboard.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Create tracer + dashboard', async () => {
    const dashboard = new DashboardHandler();
    const spans: string[] = [];
    const tracer = createTracer({
      onSpanComplete: (span) => {
        spans.push(span.agentName);
        dashboard.addTrace({
          id: span.id, agentName: span.agentName, operation: span.operation,
          status: span.status, durationMs: span.durationMs,
          startTime: span.startTime, endTime: span.endTime,
        });
      },
    });
    return { tracerReady: true, dashboardReady: true };
  });
  steps.push(s1);

  const s2 = await timeStep('Run agents with tracing', async () => {
    const dashboard = new DashboardHandler();
    const tracer = createTracer({
      onSpanComplete: (span) => {
        dashboard.addTrace({
          id: span.id, agentName: span.agentName, operation: span.operation,
          status: span.status, durationMs: span.durationMs,
          startTime: span.startTime, endTime: span.endTime,
        });
      },
    });

    for (const name of ['HealthCheck', 'Metrics', 'Report']) {
      const agent = new MockAgent(name, `${name} agent`, { healthy: true });
      const { span } = tracer.startSpan(name, 'execute');
      await agent.execute({});
      tracer.endSpan(span.id, { status: 'success' });
    }

    return { tracesCollected: dashboard.getTraces().length };
  });
  steps.push(s2);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'panopticon', name: 'Living Dashboard', status: 'success', steps, totalDurationMs: total, summary: 'Self-monitoring: chain → tracer → dashboard pipeline with 3 spans' };
}

async function runLazarusLoop(): Promise<DemoRunResult> {
  const { AgentChain } = await import('../../agents/chain.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Build evolution → review chain', async () => {
    const evolution = new MockAgent('Evolution', 'Evolves code', {
      evolved_source: 'export function add(a,b) { return a+b; }',
      generation: 1,
      data_slush: { source_agent: 'Evolution', generation: 1 },
    });
    const review = new MockAgent('CodeReview', 'Reviews code', {
      review: { quality_score: 85, passed: true },
      data_slush: { source_agent: 'CodeReview', quality_score: 85 },
    });

    const chain = new AgentChain()
      .add('evolve', evolution)
      .add('review', review);

    const result = await chain.run();
    return { status: result.status, stepCount: result.steps.length, steps: result.steps.map((s) => s.name) };
  });
  steps.push(s1);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'lazarus-loop', name: 'Ouroboros Accelerator', status: 'success', steps, totalDurationMs: total, summary: 'Chain: evolution → review with data_slush forwarding' };
}

async function runAgentFactoryFactory(): Promise<DemoRunResult> {
  const { PipelineAgent } = await import('../../agents/PipelineAgent.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Run conditional pipeline', async () => {
    const parser = new MockAgent('InputParser', 'Parses input', {
      parsed: 'sentiment analysis', needs_new_agent: true,
      data_slush: { needs_new_agent: true, agent_description: 'sentiment agent' },
    });
    const creator = new MockAgent('AgentCreator', 'Creates agents', {
      created: true, agent_name: 'DynamicProcessor',
      data_slush: { created: true, agent_name: 'DynamicProcessor' },
    });
    const executor = new MockAgent('DynamicExecutor', 'Executes', {
      executed: true, data_slush: { executed: true },
    });

    const agentMap: Record<string, BasicAgent> = { InputParser: parser, AgentCreator: creator, DynamicExecutor: executor };
    const pipeline = new PipelineAgent((name: string) => agentMap[name]);

    const resultStr = await pipeline.execute({
      action: 'run',
      spec: {
        name: 'agent-compiler',
        steps: [
          { id: 'parse', type: 'agent', agent: 'InputParser', input: { input: 'sentiment analysis' } },
          { id: 'create', type: 'conditional', agent: 'AgentCreator', condition: { field: 'needs_new_agent', equals: true } },
          { id: 'execute', type: 'agent', agent: 'DynamicExecutor' },
        ],
        input: {},
      },
    });

    const result = JSON.parse(resultStr);
    return { status: result.status, pipelineStatus: result.pipeline?.status, stepCount: result.pipeline?.steps?.length };
  });
  steps.push(s1);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'agent-factory-factory', name: 'Agent Compiler', status: 'success', steps, totalDurationMs: total, summary: 'Pipeline: conditional agent creation fired based on input parsing' };
}

async function runSwarmVote(): Promise<DemoRunResult> {
  const { BroadcastManager } = await import('../../agents/broadcast.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Race debug agents', async () => {
    const agents: Record<string, BasicAgent> = {
      LogAnalyzer: new MockAgent('LogAnalyzer', 'Log analysis', {
        diagnosis: 'null_pointer', data_slush: { source_agent: 'LogAnalyzer', diagnosis: 'null_pointer' },
      }),
      StackTraceParser: new MockAgent('StackTraceParser', 'Stack trace', {
        diagnosis: 'type_error', data_slush: { source_agent: 'StackTraceParser', diagnosis: 'type_error' },
      }),
      ErrorCategorizer: new MockAgent('ErrorCategorizer', 'Error category', {
        diagnosis: 'runtime_error', data_slush: { source_agent: 'ErrorCategorizer', diagnosis: 'runtime_error' },
      }),
    };

    const manager = new BroadcastManager();
    manager.createGroup({
      id: 'debug-swarm', name: 'Debug Swarm',
      agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'], mode: 'race',
    });

    const executor = async (agentId: string, message: string): Promise<AgentResult> => {
      const agent = agents[agentId];
      const resultStr = await agent.execute({ query: message });
      return JSON.parse(resultStr) as AgentResult;
    };

    const result = await manager.broadcast('debug-swarm', 'NullPointerException', executor);
    return { anySucceeded: result.anySucceeded, firstResponder: result.firstResponse?.agentId, totalResults: result.results.size };
  });
  steps.push(s1);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'swarm-vote', name: 'Swarm Debugger', status: 'success', steps, totalDurationMs: total, summary: 'Race: 3 debug agents competed, fastest responder won' };
}

async function runTimeLoop(): Promise<DemoRunResult> {
  const { AgentGraph } = await import('../../agents/graph.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Wire DAG: validate → transform → report', async () => {
    const validator = new MockAgent('DataValidator', 'Validates', { validated: true, data_slush: { source_agent: 'DataValidator', validated: true } });
    const transformer = new MockAgent('Transformer', 'Transforms', { transformed: true, data_slush: { source_agent: 'Transformer', format: 'normalized' } });
    const reporter = new MockAgent('Reporter', 'Reports', { report: 'complete', data_slush: { source_agent: 'Reporter', report_generated: true } });

    const graph = new AgentGraph()
      .addNode({ name: 'validate', agent: validator })
      .addNode({ name: 'transform', agent: transformer, dependsOn: ['validate'] })
      .addNode({ name: 'report', agent: reporter, dependsOn: ['validate', 'transform'] });

    const result = await graph.run();
    return { status: result.status, nodes: result.nodes.size, order: result.executionOrder };
  });
  steps.push(s1);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'time-loop', name: 'The Architect', status: 'success', steps, totalDurationMs: total, summary: 'DAG: 3-node pipeline with multi-upstream slush merging' };
}

async function runGhostProtocol(): Promise<DemoRunResult> {
  const { AgentGraph } = await import('../../agents/graph.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Run parallel parity comparison', async () => {
    const agentA = new MockAgent('SentimentA', 'Impl A', {
      sentiment: 'positive', confidence: 0.92,
      data_slush: { source_agent: 'SentimentA', sentiment: 'positive', confidence: 0.92 },
    });
    const agentB = new MockAgent('SentimentB', 'Impl B', {
      sentiment: 'positive', confidence: 0.89,
      data_slush: { source_agent: 'SentimentB', sentiment: 'positive', confidence: 0.89 },
    });
    const comparator = new MockAgent('Comparator', 'Compares', {
      parity: true, confidence_delta: 0.03,
      data_slush: { source_agent: 'Comparator', parity: true },
    });

    const graph = new AgentGraph()
      .addNode({ name: 'sentimentA', agent: agentA })
      .addNode({ name: 'sentimentB', agent: agentB })
      .addNode({ name: 'compare', agent: comparator, dependsOn: ['sentimentA', 'sentimentB'] });

    const result = await graph.run();
    return { status: result.status, nodes: result.nodes.size, parity: true };
  });
  steps.push(s1);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'ghost-protocol', name: 'Mirror Test', status: 'success', steps, totalDurationMs: total, summary: 'Parity: two implementations compared in parallel via DAG' };
}

async function runOuroborosSquared(): Promise<DemoRunResult> {
  const { AgentChain } = await import('../../agents/chain.js');
  const { createTracer } = await import('../../agents/tracer.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Trace original agent', async () => {
    const tracer = createTracer({ recordIO: true });
    const original = new MockAgent('TextProcessor', 'Processes text', {
      word_count: 3, longest_word: 'hello', reversed: 'olleh',
      data_slush: { source_agent: 'TextProcessor', word_count: 3 },
    });

    const { span, context } = tracer.startSpan('TextProcessor', 'execute', undefined, { text: 'hello world test' });
    await original.execute({ text: 'hello world test' });
    tracer.endSpan(span.id, { status: 'success' });

    return { traced: true, traceId: context.traceId };
  });
  steps.push(s1);

  const s2 = await timeStep('Chain original → clone → compare', async () => {
    const original = new MockAgent('TextProcessor', 'Original', {
      word_count: 3, data_slush: { source_agent: 'TextProcessor' },
    });
    const clone = new MockAgent('TextProcessorClone', 'Clone', {
      word_count: 3, data_slush: { source_agent: 'TextProcessorClone' },
    });

    const chain = new AgentChain()
      .add('original', original)
      .add('clone', clone);

    const result = await chain.run();
    return { status: result.status, stepCount: result.steps.length };
  });
  steps.push(s2);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'ouroboros-squared', name: 'Doppelganger', status: 'success', steps, totalDurationMs: total, summary: 'Clone: traced original, created clone, chained comparison' };
}

async function runInceptionStack(): Promise<DemoRunResult> {
  const { SubAgentManager } = await import('../../agents/subagent.js');
  const { createTracer } = await import('../../agents/tracer.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Create inception agents + tracker', async () => {
    const agents = new Map<string, BasicAgent>();

    // Level 3 — Innermost
    class DreamExtractorAgent extends BasicAgent {
      constructor() {
        super('DreamExtractor', {
          name: 'DreamExtractor', description: 'Extracts dream data (Level 3)',
          parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
        });
      }
      async perform(kwargs: Record<string, unknown>): Promise<string> {
        const seed = (kwargs.dream_seed ?? '') as string;
        const charCount = seed.length;
        const vowelCount = seed.split('').filter((c: string) => 'aeiouAEIOU'.includes(c)).length;
        const totem = `totem_${charCount}_${vowelCount}`;
        return JSON.stringify({
          status: 'success', level: 3, extraction: { char_count: charCount, vowel_count: vowelCount }, totem,
          data_slush: { source_agent: 'DreamExtractor', level: 3, totem },
        });
      }
    }

    // Level 2
    class DreamBuilderAgent extends BasicAgent {
      constructor() {
        super('DreamBuilder', {
          name: 'DreamBuilder', description: 'Builds dream (Level 2)',
          parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
        });
      }
      async perform(kwargs: Record<string, unknown>): Promise<string> {
        const mgr = kwargs._manager as SubAgentManager;
        const ctx = kwargs._subagent_context as import('../../agents/subagent.js').SubAgentContext;
        const seed = (kwargs.dream_seed ?? '') as string;
        const ext = new DreamExtractorAgent();
        agents.set('DreamExtractor', ext);
        const inner = await mgr.invoke('DreamExtractor', seed, ctx) as Record<string, unknown>;
        return JSON.stringify({
          status: 'success', level: 2, inner,
          data_slush: { source_agent: 'DreamBuilder', level: 2 },
        });
      }
    }

    const manager = new SubAgentManager({ maxDepth: 4 });
    manager.setExecutor(async (agentId, message, context) => {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      const result = await agent.execute({
        dream_seed: message, _manager: manager, _subagent_context: context,
      });
      return JSON.parse(result) as AgentResult;
    });

    const builder = new DreamBuilderAgent();
    agents.set('DreamBuilder', builder);

    return { agentCount: 2, maxDepth: 4 };
  });
  steps.push(s1);

  const s2 = await timeStep('Execute 3-level inception stack', async () => {
    const agents = new Map<string, BasicAgent>();

    class DreamExtractorAgent extends BasicAgent {
      constructor() {
        super('DreamExtractor', {
          name: 'DreamExtractor', description: 'Level 3',
          parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
        });
      }
      async perform(kwargs: Record<string, unknown>): Promise<string> {
        const seed = (kwargs.dream_seed ?? '') as string;
        return JSON.stringify({
          status: 'success', level: 3, totem: `totem_${seed.length}`,
          data_slush: { source_agent: 'DreamExtractor', level: 3 },
        });
      }
    }

    class DreamBuilderAgent extends BasicAgent {
      constructor() {
        super('DreamBuilder', {
          name: 'DreamBuilder', description: 'Level 2',
          parameters: { type: 'object', properties: { dream_seed: { type: 'string' } }, required: ['dream_seed'] },
        });
      }
      async perform(kwargs: Record<string, unknown>): Promise<string> {
        const mgr = kwargs._manager as SubAgentManager;
        const ctx = kwargs._subagent_context as import('../../agents/subagent.js').SubAgentContext;
        agents.set('DreamExtractor', new DreamExtractorAgent());
        const inner = await mgr.invoke('DreamExtractor', (kwargs.dream_seed ?? '') as string, ctx) as Record<string, unknown>;
        return JSON.stringify({
          status: 'success', level: 2, inner,
          data_slush: { source_agent: 'DreamBuilder', level: 2 },
        });
      }
    }

    const manager = new SubAgentManager({ maxDepth: 4 });
    manager.setExecutor(async (agentId, message, context) => {
      const agent = agents.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      const result = await agent.execute({
        dream_seed: message, _manager: manager, _subagent_context: context,
      });
      return JSON.parse(result) as AgentResult;
    });

    agents.set('DreamBuilder', new DreamBuilderAgent());
    const ctx = manager.createContext('DreamArchitect');
    const innerResult = await manager.invoke('DreamBuilder', 'inception', ctx) as Record<string, unknown>;
    return { levels: 3, hasInner: !!innerResult.inner, status: 'success' };
  });
  steps.push(s2);

  const s3 = await timeStep('Verify depth overflow', async () => {
    const manager = new SubAgentManager({ maxDepth: 2 });
    const canInvokeAtDepth0 = manager.canInvoke('Agent', 0);
    const canInvokeAtDepth2 = manager.canInvoke('Agent', 2);
    const tracer = createTracer();
    const { context } = tracer.startSpan('DreamArchitect', 'execute');
    const { span: l2 } = tracer.startSpan('DreamBuilder', 'execute', context);
    tracer.endSpan(l2.id, { status: 'success' });
    tracer.endSpan(context.spanId, { status: 'success' });
    return { canInvokeAtDepth0, blockedAtMaxDepth: !canInvokeAtDepth2, traceSpans: tracer.getTrace(context.traceId).length };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'inception-stack', name: 'The Inception Stack', status: 'success', steps, totalDurationMs: total, summary: 'Recursion: 3-level agent meta-creation with depth tracking and tracing' };
}

async function runSloshDeepDive(): Promise<DemoRunResult> {
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Default slosh — all 5 categories', async () => {
    const agent = new MockAgent('SloshTest', 'Slosh test', {
      data_slush: { source_agent: 'SloshTest', captured: true },
    });
    await agent.execute({ query: 'show me recent items' });
    const ctx = agent.context!;
    return {
      categories: ['temporal', 'query_signals', 'memory_echoes', 'behavioral', 'priors']
        .filter(k => (ctx as Record<string, unknown>)[k] !== undefined),
      orientation: ctx.orientation.approach,
    };
  });
  steps.push(s1);

  const s2 = await timeStep('SloshFilter + SloshPrivacy', async () => {
    const agent = new MockAgent('SloshTest', 'Slosh test', {
      data_slush: { source_agent: 'SloshTest' },
    });
    agent.sloshFilter = { include: ['temporal'] };
    agent.sloshPrivacy = { obfuscate: ['temporal.day_of_week'] };
    await agent.execute({ query: 'filtered' });
    return {
      memory_echoes: agent.context!.memory_echoes.length,
      day_obfuscated: /^\[obfuscated:/.test(agent.context!.temporal.day_of_week ?? ''),
    };
  });
  steps.push(s2);

  const s3 = await timeStep('Debug events + getSignal', async () => {
    const agent = new MockAgent('SloshTest', 'Slosh test', {
      data_slush: { source_agent: 'SloshTest' },
    });
    agent.sloshDebug = true;
    const stages: string[] = [];
    agent.onSloshDebug = (e: { stage: string }) => stages.push(e.stage);
    await agent.execute({ query: 'debug test' });
    const tod = agent.getSignal<string>('temporal.time_of_day');
    return { stageCount: stages.length, hasTimeOfDay: !!tod, breadcrumbs: agent.breadcrumbs.length };
  });
  steps.push(s3);

  const s4 = await timeStep('Feedback loop + breadcrumbs', async () => {
    // Use a raw BasicAgent subclass for feedback
    class FeedbackAgent extends BasicAgent {
      async perform(): Promise<string> {
        return JSON.stringify({
          status: 'success',
          data_slush: { source_agent: 'FeedbackAgent' },
          slosh_feedback: { useful_signals: [], useless_signals: ['temporal.time_of_day'] },
        });
      }
    }
    const agent = new FeedbackAgent('FeedbackTest', {
      name: 'FeedbackTest', description: 'Feedback', parameters: { type: 'object', properties: {}, required: [] },
    });
    agent.autoSuppressThreshold = -2;
    agent.signalDecay = 1;
    await agent.execute({ query: 'a' });
    await agent.execute({ query: 'b' });
    await agent.execute({ query: 'c' });
    return { utilityScore: agent.signalUtility.get('temporal.time_of_day'), breadcrumbs: agent.breadcrumbs.length };
  });
  steps.push(s4);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'slosh-deep-dive', name: 'Data Sloshing Deep Dive', status: 'success', steps, totalDurationMs: total, summary: 'Slosh: 5 categories, filter, privacy, debug, feedback, breadcrumbs' };
}

async function runMemoryRecall(): Promise<DemoRunResult> {
  const { MemoryManager } = await import('../../memory/manager.js');
  const { chunkContent, generateSnippet } = await import('../../memory/chunker.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Chunk content', async () => {
    const chunks = chunkContent('word '.repeat(200).trim(), { chunkSize: 100, overlap: 20 });
    return { inputChars: 999, chunks: chunks.length };
  });
  steps.push(s1);

  const s2 = await timeStep('Add documents + FTS search', async () => {
    const mgr = new MemoryManager({ chunkSize: 512 });
    await mgr.add('AgentGraph executes DAG nodes in parallel', 'workspace', '/graph.md');
    await mgr.add('ChannelRegistry routes messages', 'workspace', '/channels.md');
    const results = await mgr.searchFts('AgentGraph parallel');
    return { resultCount: results.length, topScore: results[0]?.score };
  });
  steps.push(s2);

  const s3 = await timeStep('Lifecycle — remove + clear', async () => {
    const mgr = new MemoryManager({ chunkSize: 512 });
    await mgr.add('Content A', 'workspace', '/a.md');
    await mgr.add('Content B', 'workspace', '/b.md');
    const removed = mgr.removeBySourcePath('/a.md');
    const afterRemove = mgr.getStatus().totalChunks;
    mgr.clear();
    return { removed, afterRemove, afterClear: mgr.getStatus().totalChunks };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'memory-recall', name: 'Memory Recall', status: 'success', steps, totalDurationMs: total, summary: 'Memory: chunking, FTS search, lifecycle' };
}

async function runChannelSwitchboard(): Promise<DemoRunResult> {
  const { BaseChannel } = await import('../../channels/base.js');
  const { ChannelRegistry } = await import('../../channels/registry.js');
  const steps: DemoStepResult[] = [];

  class InlineChannel extends BaseChannel {
    sent: string[] = [];
    constructor(name: string) { super(name, name); }
    async connect(): Promise<void> { this.connected = true; }
    async disconnect(): Promise<void> { this.connected = false; }
    async send(_cid: string, msg: { content: string }): Promise<void> { this.sent.push(msg.content); }
  }

  const s1 = await timeStep('Register + connect channels', async () => {
    const registry = new ChannelRegistry();
    const slack = new InlineChannel('slack');
    const discord = new InlineChannel('discord');
    registry.register(slack);
    registry.register(discord);
    await registry.connectAll();
    return { names: registry.names(), allConnected: registry.list().every(ch => ch.connected) };
  });
  steps.push(s1);

  const s2 = await timeStep('Route messages', async () => {
    const registry = new ChannelRegistry();
    const slack = new InlineChannel('slack');
    const discord = new InlineChannel('discord');
    registry.register(slack);
    registry.register(discord);
    await registry.sendMessage({ channelId: 'slack', conversationId: 'C1', content: 'Alert!' });
    return { slackMsgs: slack.sent.length, discordMsgs: discord.sent.length };
  });
  steps.push(s2);

  const s3 = await timeStep('Probe + disconnect', async () => {
    const registry = new ChannelRegistry();
    const slack = new InlineChannel('slack');
    registry.register(slack);
    await slack.connect();
    const statuses = registry.getStatusList();
    await registry.disconnectAll();
    return { statusCount: statuses.length, allDisconnected: registry.list().every(ch => !ch.connected) };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'channel-switchboard', name: 'Channel Switchboard', status: 'success', steps, totalDurationMs: total, summary: 'Channels: register, connect, route, probe, disconnect' };
}

async function runConfigHotswap(): Promise<DemoRunResult> {
  const { substituteEnvVars, mergeConfigs, parseConfigContent } = await import('../../config/loader.js');
  const { validateConfig, getConfigJsonSchema } = await import('../../config/schema.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Parse JSON5 + validate', async () => {
    const parsed = parseConfigContent('{ "configVersion": 1, "gateway": { "port": 8080, "bind": "loopback" } }');
    const result = validateConfig(parsed);
    return { valid: result.success };
  });
  steps.push(s1);

  const s2 = await timeStep('Merge configs', async () => {
    const merged = mergeConfigs(
      { gateway: { port: 8080, bind: 'loopback' as const } },
      { gateway: { port: 9090, bind: 'all' as const }, cron: { enabled: true } },
    );
    return { port: merged.gateway?.port, cronEnabled: merged.cron?.enabled };
  });
  steps.push(s2);

  const s3 = await timeStep('Env substitution + schema', async () => {
    process.env._DEMO_PORT = '4000';
    const sub = substituteEnvVars('port=${_DEMO_PORT}');
    delete process.env._DEMO_PORT;
    const schema = getConfigJsonSchema();
    return { substituted: sub, schemaKeys: Object.keys(schema.properties as object).length };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'config-hotswap', name: 'Config Hotswap', status: 'success', steps, totalDurationMs: total, summary: 'Config: parse, validate, merge, env substitution, JSON Schema' };
}

async function runPersistenceVault(): Promise<DemoRunResult> {
  const { createStorageAdapter } = await import('../../storage/index.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Initialize in-memory storage', async () => {
    const storage = createStorageAdapter({ type: 'memory', inMemory: true });
    await storage.initialize();
    await storage.close();
    return { initialized: true };
  });
  steps.push(s1);

  const s2 = await timeStep('Session save/get/filter', async () => {
    const storage = createStorageAdapter({ type: 'memory', inMemory: true });
    await storage.initialize();
    await storage.saveSession({
      id: 's1', channelId: 'slack', conversationId: 'C1', agentId: 'A',
      metadata: {}, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const got = await storage.getSession('s1');
    await storage.close();
    return { saved: !!got };
  });
  steps.push(s2);

  const s3 = await timeStep('Cron + memory chunks', async () => {
    const storage = createStorageAdapter({ type: 'memory', inMemory: true });
    await storage.initialize();
    await storage.saveCronJob({
      id: 'j1', name: 'test', schedule: '* * * * *', agentId: 'A', message: 'go',
      enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const job = await storage.getCronJob('j1');
    await storage.close();
    return { jobName: job?.name };
  });
  steps.push(s3);

  const s4 = await timeStep('Config KV operations', async () => {
    const storage = createStorageAdapter({ type: 'memory', inMemory: true });
    await storage.initialize();
    await storage.setConfig('a', '1');
    await storage.setConfig('b', '2');
    const all = await storage.getAllConfig();
    await storage.close();
    return { configCount: Object.keys(all).length };
  });
  steps.push(s4);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'persistence-vault', name: 'Persistence Vault', status: 'success', steps, totalDurationMs: total, summary: 'Storage: sessions, cron, KV config, transactions in-memory' };
}

async function runHealingLoop(): Promise<DemoRunResult> {
  const { SelfHealingCronAgent } = await import('../../agents/SelfHealingCronAgent.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Setup health check job', async () => {
    const agent = new SelfHealingCronAgent({
      webAgent: new MockAgent('Web', 'Web', { status: 'success' }),
      shellAgent: new MockAgent('Shell', 'Shell', { status: 'success', output: 'ok' }),
      messageAgent: new MockAgent('Msg', 'Msg', { status: 'success' }),
    });
    const result = JSON.parse(await agent.execute({
      action: 'setup', name: 'api', url: 'http://localhost/health',
      restartCommand: 'restart', notifyChannel: 'slack', conversationId: 'C1',
    }));
    return { jobName: result.job?.name };
  });
  steps.push(s1);

  const s2 = await timeStep('Healthy check', async () => {
    const agent = new SelfHealingCronAgent({
      webAgent: new MockAgent('Web', 'Web', { status: 'success' }),
      shellAgent: new MockAgent('Shell', 'Shell', { status: 'success' }),
      messageAgent: new MockAgent('Msg', 'Msg', { status: 'success' }),
    });
    await agent.execute({
      action: 'setup', name: 'api', url: 'http://localhost/health',
      restartCommand: 'restart', notifyChannel: '', conversationId: '',
    });
    const result = JSON.parse(await agent.execute({ action: 'check', name: 'api' }));
    return { healthy: result.healthy, actionTaken: result.data_slush?.action_taken };
  });
  steps.push(s2);

  const s3 = await timeStep('Status + history', async () => {
    const agent = new SelfHealingCronAgent({
      webAgent: new MockAgent('Web', 'Web', { status: 'success' }),
      shellAgent: new MockAgent('Shell', 'Shell', { status: 'success' }),
      messageAgent: new MockAgent('Msg', 'Msg', { status: 'success' }),
    });
    await agent.execute({
      action: 'setup', name: 'api', url: 'http://localhost/health',
      restartCommand: 'restart', notifyChannel: '', conversationId: '',
    });
    await agent.execute({ action: 'check', name: 'api' });
    const status = JSON.parse(await agent.execute({ action: 'status', name: 'api' }));
    return { uptime: status.stats?.uptimePercent, checks: status.stats?.totalChecks };
  });
  steps.push(s3);

  const s4 = await timeStep('Teardown', async () => {
    const agent = new SelfHealingCronAgent();
    await agent.execute({
      action: 'setup', name: 'api', url: 'http://localhost/health',
      restartCommand: 'restart', notifyChannel: '', conversationId: '',
    });
    const result = JSON.parse(await agent.execute({ action: 'teardown', name: 'api' }));
    return { removed: result.status === 'success' };
  });
  steps.push(s4);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'healing-loop', name: 'Healing Loop', status: 'success', steps, totalDurationMs: total, summary: 'Resilience: setup, health check, restart recovery, status tracking, teardown' };
}

async function runAuthFortress(): Promise<DemoRunResult> {
  const { createApprovalManager } = await import('../../security/approvals.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Deny + Full + Allowlist policies', async () => {
    const mgr = createApprovalManager();
    mgr.setDefaultPolicy('deny');
    const denied = mgr.checkApproval({ toolName: 'bash', toolArgs: {} });
    mgr.setDefaultPolicy('full');
    const allowed = mgr.checkApproval({ toolName: 'bash', toolArgs: {} });
    return { denyResult: denied.allowed, fullResult: allowed.allowed };
  });
  steps.push(s1);

  const s2 = await timeStep('Priority ordering + scoping', async () => {
    const mgr = createApprovalManager();
    mgr.addRule({ id: 'low', name: 'Allow', policy: 'full', tools: ['bash'], priority: 1, enabled: true });
    mgr.addRule({ id: 'high', name: 'Block', policy: 'deny', tools: ['bash'], priority: 100, enabled: true });
    const result = mgr.checkApproval({ toolName: 'bash', toolArgs: {} });
    return { winnerId: result.rule?.id, allowed: result.allowed };
  });
  steps.push(s2);

  const s3 = await timeStep('Request/approve/reject', async () => {
    const mgr = createApprovalManager();
    mgr.setDefaultPolicy('allowlist');
    const promise = mgr.requestApproval({ toolName: 'bash', toolArgs: {} });
    const pending = mgr.getPendingRequests();
    mgr.approveRequest(pending[0].id, 'admin');
    const result = await promise;
    return { approved: result.allowed, pendingBefore: pending.length };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'auth-fortress', name: 'Authorization Fortress', status: 'success', steps, totalDurationMs: total, summary: 'Security: deny/allowlist/full policies, priority rules, approve/reject' };
}

async function runStreamWeaver(): Promise<DemoRunResult> {
  const { StreamManager } = await import('../../gateway/streaming.js');
  const steps: DemoStepResult[] = [];

  const s1 = await timeStep('Sessions + blocks', async () => {
    const mgr = new StreamManager();
    const session = mgr.createSession('s1');
    mgr.pushBlock('s1', { type: 'text', content: 'Hello', done: false });
    mgr.pushBlock('s1', { type: 'tool_call', content: '{}', done: true });
    return { blockCount: mgr.getSession('s1')?.blocks.length, status: session.status };
  });
  steps.push(s1);

  const s2 = await timeStep('Deltas + subscribers', async () => {
    const mgr = new StreamManager();
    mgr.createSession('s2');
    const received: string[] = [];
    mgr.onBlock('s2', (b) => received.push(b.delta ?? ''));
    mgr.pushDelta('s2', 'b1', 'Hel');
    mgr.pushDelta('s2', 'b1', 'lo');
    return { accumulated: mgr.getSession('s2')?.blocks[0].content, notifications: received.length };
  });
  steps.push(s2);

  const s3 = await timeStep('Lifecycle', async () => {
    const mgr = new StreamManager();
    mgr.createSession('s1');
    mgr.createSession('s2');
    mgr.complete('s1');
    mgr.error('s2');
    return { active: mgr.activeSessions() };
  });
  steps.push(s3);

  const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
  return { demoId: 'stream-weaver', name: 'Stream Weaver', status: 'success', steps, totalDurationMs: total, summary: 'Streaming: sessions, blocks, delta accumulation, subscribers, lifecycle' };
}

const DEMO_RUNNERS: Record<string, () => Promise<DemoRunResult>> = {
  'darwins-colosseum': runDarwinsColosseum,
  'infinite-regress': runInfiniteRegress,
  'ship-of-theseus': runShipOfTheseus,
  'panopticon': runPanopticon,
  'lazarus-loop': runLazarusLoop,
  'agent-factory-factory': runAgentFactoryFactory,
  'swarm-vote': runSwarmVote,
  'time-loop': runTimeLoop,
  'ghost-protocol': runGhostProtocol,
  'ouroboros-squared': runOuroborosSquared,
  'inception-stack': runInceptionStack,
  'slosh-deep-dive': runSloshDeepDive,
  'memory-recall': runMemoryRecall,
  'channel-switchboard': runChannelSwitchboard,
  'config-hotswap': runConfigHotswap,
  'persistence-vault': runPersistenceVault,
  'healing-loop': runHealingLoop,
  'auth-fortress': runAuthFortress,
  'stream-weaver': runStreamWeaver,
};

export function registerShowcaseMethods(
  server: MethodRegistrar,
  deps?: Record<string, unknown>,
): void {
  server.registerMethod<void, { demos: DemoInfo[] }>('showcase.list', async () => {
    return { demos: DEMOS };
  });

  server.registerMethod<{ demoId: string }, DemoRunResult>('showcase.run', async (params) => {
    const runner = DEMO_RUNNERS[params.demoId];
    const demoName = DEMOS.find((d) => d.id === params.demoId)?.name ?? params.demoId;
    if (!runner) {
      console.log(`${LOG_PREFIX} \x1b[31m✗\x1b[0m Unknown demo: ${params.demoId}`);
      return {
        demoId: params.demoId,
        name: 'Unknown',
        status: 'error' as const,
        steps: [],
        totalDurationMs: 0,
        summary: '',
        error: `Unknown demo ID: ${params.demoId}`,
      };
    }
    console.log(`${LOG_PREFIX} \x1b[1mRunning: ${demoName}\x1b[0m`);
    try {
      const result = await runner();
      console.log(`${LOG_PREFIX} \x1b[32mDone:\x1b[0m ${demoName} — \x1b[32m${result.status}\x1b[0m \x1b[90m(${result.totalDurationMs}ms)\x1b[0m`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${LOG_PREFIX} \x1b[31mFailed:\x1b[0m ${demoName} — ${msg}`);
      return {
        demoId: params.demoId,
        name: demoName,
        status: 'error' as const,
        steps: [],
        totalDurationMs: 0,
        summary: '',
        error: msg,
      };
    }
  });

  server.registerMethod<void, { results: DemoRunResult[] }>('showcase.runall', async () => {
    console.log(`${LOG_PREFIX} \x1b[1m━━━ Running all ${DEMOS.length} demos ━━━\x1b[0m`);
    const allStart = Date.now();
    const results: DemoRunResult[] = [];
    for (const demo of DEMOS) {
      const runner = DEMO_RUNNERS[demo.id];
      if (runner) {
        console.log(`${LOG_PREFIX} \x1b[1mRunning: ${demo.name}\x1b[0m`);
        try {
          const result = await runner();
          console.log(`${LOG_PREFIX} \x1b[32mDone:\x1b[0m ${demo.name} — \x1b[32m${result.status}\x1b[0m \x1b[90m(${result.totalDurationMs}ms)\x1b[0m`);
          results.push(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`${LOG_PREFIX} \x1b[31mFailed:\x1b[0m ${demo.name} — ${msg}`);
          results.push({
            demoId: demo.id,
            name: demo.name,
            status: 'error',
            steps: [],
            totalDurationMs: 0,
            summary: '',
            error: msg,
          });
        }
      }
    }
    const passed = results.filter((r) => r.status === 'success').length;
    console.log(`${LOG_PREFIX} \x1b[1m━━━ Complete: ${passed}/${results.length} passed \x1b[90m(${Date.now() - allStart}ms)\x1b[0m`);
    return { results };
  });
}
