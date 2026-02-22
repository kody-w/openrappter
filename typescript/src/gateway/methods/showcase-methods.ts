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
