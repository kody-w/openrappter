/**
 * Power Prompts Showcase — 10 Agent Orchestration Demos
 *
 * Run: npx tsx examples/power-prompts-showcase.ts
 *
 * Zero API keys. All deterministic. Rich chalk console output.
 */

import chalk from 'chalk';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';
import { AgentChain } from '../src/agents/chain.js';
import { AgentGraph } from '../src/agents/graph.js';
import { createTracer } from '../src/agents/tracer.js';
import { BroadcastManager } from '../src/agents/broadcast.js';
import { PipelineAgent } from '../src/agents/PipelineAgent.js';
import { WatchmakerAgent } from '../src/agents/WatchmakerAgent.js';
import { CodeReviewAgent } from '../src/agents/CodeReviewAgent.js';
import { McpServer } from '../src/mcp/server.js';
import { assessEvolution } from '../src/agents/OuroborosAgent.js';

// ── Helpers ──────────────────────────────────────────────────────────

const dim = chalk.dim;
const bold = chalk.bold;
const cyan = chalk.cyan;
const green = chalk.green;
const yellow = chalk.yellow;
const red = chalk.red;
const magenta = chalk.magenta;
const blue = chalk.blue;
const gray = chalk.gray;

function box(title: string, lines: string[]) {
  const W = 64;
  const top = `╔${'═'.repeat(W)}╗`;
  const bot = `╚${'═'.repeat(W)}╝`;
  const sep = `╠${'═'.repeat(W)}╣`;
  const row = (s: string) => `║  ${s.padEnd(W - 2)}║`;

  console.log(cyan(top));
  console.log(cyan(row(bold(title))));
  console.log(cyan(sep));
  for (const line of lines) {
    console.log(cyan(row(line)));
  }
  console.log(cyan(bot));
}

function hr() {
  console.log(dim('─'.repeat(68)));
}

function header(n: number, title: string) {
  console.log();
  console.log(bold.magenta(`  [${ n}/10] ${title}`));
  hr();
}

function ok(msg: string) {
  console.log(green(`  ✓ ${msg}`));
}

function info(msg: string) {
  console.log(gray(`    ${msg}`));
}

function warn(msg: string) {
  console.log(yellow(`  ⚠ ${msg}`));
}

// ── Mock Agents ────────────────────────────────────────────────────

class ScoreAgent extends BasicAgent {
  private baseScore: number;
  constructor(name: string, baseScore: number) {
    const metadata: AgentMetadata = { name, description: `Score agent (base=${baseScore})`, parameters: { type: 'object', properties: {}, required: [] } };
    super(name, metadata);
    this.baseScore = baseScore;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = (kwargs.query ?? '') as string;
    const score = this.baseScore + (query.length % 16);
    return JSON.stringify({ status: 'success', score, agent: this.name, data_slush: this.slushOut({ score }) });
  }
}

class TransformAgent extends BasicAgent {
  private mode: 'uppercase' | 'reverse' | 'rot13' | 'prefix';
  constructor(name: string, mode: 'uppercase' | 'reverse' | 'rot13' | 'prefix') {
    const metadata: AgentMetadata = { name, description: `Transform: ${mode}`, parameters: { type: 'object', properties: {}, required: [] } };
    super(name, metadata);
    this.mode = mode;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.query ?? kwargs.text ?? '') as string;
    let transformed: string;
    switch (this.mode) {
      case 'uppercase': transformed = text.toUpperCase(); break;
      case 'reverse': transformed = text.split('').reverse().join(''); break;
      case 'rot13': transformed = text.replace(/[a-zA-Z]/g, (ch) => {
        const base = ch >= 'a' ? 97 : 65;
        return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
      }); break;
      case 'prefix': transformed = `[${this.name}] ${text}`; break;
    }
    return JSON.stringify({ status: 'success', transformed, mode: this.mode, data_slush: this.slushOut({ transformed, mode: this.mode }) });
  }
}

class VoterAgent extends BasicAgent {
  private bias: 'yes' | 'no' | 'defer';
  constructor(name: string, bias: 'yes' | 'no' | 'defer') {
    const metadata: AgentMetadata = { name, description: `Voter: ${bias}`, parameters: { type: 'object', properties: {}, required: [] } };
    super(name, metadata);
    this.bias = bias;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = ((kwargs.query ?? '') as string).toLowerCase();
    let vote = this.bias;
    if (query.includes('urgent') || query.includes('critical')) vote = 'yes';
    else if (query.includes('reject') || query.includes('deny')) vote = 'no';
    return JSON.stringify({ status: 'success', vote, voter: this.name, data_slush: this.slushOut({ vote, voter: this.name }) });
  }
}

class FactoryAgent extends BasicAgent {
  private generation: number;
  constructor(name: string, generation: number) {
    const metadata: AgentMetadata = { name, description: `Factory gen ${generation}`, parameters: { type: 'object', properties: {}, required: [] } };
    super(name, metadata);
    this.generation = generation;
  }
  async perform(): Promise<string> {
    const childGen = this.generation + 1;
    const childName = `FactoryChild_Gen${childGen}`;
    return JSON.stringify({ status: 'success', created: childName, lineage: `Gen${this.generation} -> Gen${childGen}`, data_slush: this.slushOut({ created: childName, generation: childGen, lineage: `Gen${this.generation} -> Gen${childGen}` }) });
  }
}

class EvolverAgent extends BasicAgent {
  constructor(name: string) {
    const metadata: AgentMetadata = { name, description: 'Evolves score +15', parameters: { type: 'object', properties: {}, required: [] } };
    super(name, metadata);
  }
  async perform(): Promise<string> {
    const upstream = this.context?.upstream_slush as Record<string, unknown> | undefined;
    const prevScore = (upstream?.score as number) ?? 25;
    const newScore = Math.min(prevScore + 15, 100);
    return JSON.stringify({ status: 'success', previousScore: prevScore, newScore, data_slush: this.slushOut({ score: newScore }) });
  }
}

class EchoAgent extends BasicAgent {
  constructor(name: string) {
    const metadata: AgentMetadata = { name, description: 'Echo input', parameters: { type: 'object', properties: {}, required: [] } };
    super(name, metadata);
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = (kwargs.query ?? '') as string;
    return JSON.stringify({ status: 'success', echo: query, agent: this.name, data_slush: this.slushOut({ echo: query }) });
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function demo1_DarwinsColosseum() {
  header(1, "Darwin's Colosseum — WatchmakerAgent");

  const watchmaker = new WatchmakerAgent();
  watchmaker.setAgents([
    { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
    { agent: new ScoreAgent('Alpha', 75), version: '2.0' },
    { agent: new ScoreAgent('Alpha', 90), version: '3.0' },
  ]);
  ok('Registered 3 versions of Alpha (v1.0 active, v2.0 + v3.0 candidates)');

  const cycleResult = JSON.parse(await watchmaker.execute({
    action: 'cycle',
    testCases: [{ input: { query: 'evolution test' } }],
  }));

  info(`Evaluated ${cycleResult.cycle.evaluated.length} versions`);
  info(`${cycleResult.cycle.comparisons.length} head-to-head comparisons`);
  info(`${cycleResult.cycle.promotions.length} promotions`);

  const status = JSON.parse(await watchmaker.execute({ action: 'status', agent: 'Alpha' }));
  ok(`Active version after cycle: v${status.slot.activeVersion}`);
}

async function demo2_InfiniteRegress() {
  header(2, 'The Infinite Regress — AgentChain');

  const chain = new AgentChain()
    .add('uppercase', new TransformAgent('Upper', 'uppercase'))
    .add('rot13', new TransformAgent('Rot13', 'rot13'))
    .add('reverse', new TransformAgent('Reverser', 'reverse'));

  const result = await chain.run({ query: 'hello world' });

  for (const step of result.steps) {
    const r = step.result as Record<string, unknown>;
    info(`${step.name}: "${r.transformed}"`);
  }

  ok(`Chain completed: ${result.status} (${result.steps.length} steps, ${result.totalDurationMs}ms)`);
  ok(`data_slush threaded through all ${result.steps.length} stages`);
}

async function demo3_ShipOfTheseus() {
  header(3, 'Ship of Theseus — CodeReviewAgent');

  const reviewer = new CodeReviewAgent();

  // Round 1: buggy code
  const buggyCode = `console.log("debug");\n// TODO: fix this\n${'x'.repeat(150)}`;
  const r1 = JSON.parse(await reviewer.execute({ action: 'review', content: buggyCode, file: 'app.ts' }));
  warn(`Round 1 score: ${r1.review.score}/100 (${r1.review.findings.length} issues)`);
  for (const f of r1.review.findings) {
    info(`  ${f.severity}: ${f.rule} — ${f.message}`);
  }

  // Round 2: fixed
  const fixedCode = 'const x = 1;\nconst y = 2;';
  const r2 = JSON.parse(await reviewer.execute({ action: 'review', content: fixedCode, file: 'app.ts' }));
  ok(`Round 2 score: ${r2.review.score}/100 — ${r2.review.status}`);
  ok(`Score improved by ${r2.review.score - r1.review.score} points`);
}

async function demo4_Panopticon() {
  header(4, 'The Panopticon — AgentGraph + AgentTracer');

  const tracer = createTracer();
  const { span: rootSpan, context: rootCtx } = tracer.startSpan('Graph', 'diamond-dag');

  const graph = new AgentGraph()
    .addNode({ name: 'source', agent: new EchoAgent('Source'), kwargs: { query: 'panopticon' } })
    .addNode({ name: 'left', agent: new TransformAgent('Left', 'uppercase'), dependsOn: ['source'] })
    .addNode({ name: 'right', agent: new TransformAgent('Right', 'reverse'), dependsOn: ['source'] })
    .addNode({ name: 'sink', agent: new EchoAgent('Sink'), dependsOn: ['left', 'right'] });

  const agents = ['source', 'left', 'right', 'sink'];
  const childSpans = agents.map(name => tracer.startSpan(name, 'execute', rootCtx));

  const result = await graph.run();

  for (const cs of childSpans) {
    tracer.endSpan(cs.span.id, { status: 'success' });
  }
  tracer.endSpan(rootSpan.id, { status: 'success' });

  info(`DAG: ${graph.length} nodes, diamond topology`);
  info(`Execution order: ${result.executionOrder.join(' → ')}`);
  ok(`Graph status: ${result.status} (${result.totalDurationMs}ms)`);

  const trace = tracer.getTrace(rootCtx.traceId);
  ok(`Tracer: ${trace.length} spans recorded, all linked to trace ${rootCtx.traceId.slice(0, 8)}...`);
}

async function demo5_LazarusLoop() {
  header(5, 'The Lazarus Loop — Chaos Resilience');

  const agent = new ScoreAgent('Lazarus', 50);
  const chaosInputs = [
    { name: 'empty', query: '' },
    { name: 'long (10k)', query: 'x'.repeat(10000) },
    { name: 'special chars', query: '!@#$%^&*(){}[]<>' },
    { name: 'unicode', query: '你好世界 🌍 café' },
    { name: 'numbers', query: '42 3.14 -1 0' },
  ];

  for (const ci of chaosInputs) {
    const result = JSON.parse(await agent.execute({ query: ci.query }));
    ok(`${ci.name.padEnd(16)} → score: ${result.score}, status: ${result.status}`);
  }

  // Watchmaker evaluation
  const watchmaker = new WatchmakerAgent();
  watchmaker.setAgents([{ agent, version: '1.0' }]);
  const evalResult = JSON.parse(await watchmaker.execute({
    action: 'evaluate',
    agent: 'Lazarus',
    testCases: chaosInputs.map(ci => ({ input: { query: ci.query } })),
  }));
  ok(`Watchmaker quality: ${evalResult.evaluation.quality}/100 (${evalResult.evaluation.status})`);
}

async function demo6_AgentFactoryFactory() {
  header(6, 'Agent Factory Factory — Multi-Generation Chain');

  const chain = new AgentChain();
  for (let i = 0; i < 5; i++) {
    chain.add(`gen${i}`, new FactoryAgent(`Factory_Gen${i}`, i));
  }

  const result = await chain.run({ query: 'bootstrap' });

  for (const step of result.steps) {
    const r = step.result as Record<string, unknown>;
    info(`${step.name}: created ${r.created} (${r.lineage})`);
  }
  ok(`5-generation factory chain: ${result.status} (${result.totalDurationMs}ms)`);
}

async function demo7_SwarmVote() {
  header(7, 'The Swarm Vote — BroadcastManager');

  const broadcast = new BroadcastManager();
  const agents = new Map([
    ['v1', new VoterAgent('Voter1', 'yes')],
    ['v2', new VoterAgent('Voter2', 'yes')],
    ['v3', new VoterAgent('Voter3', 'no')],
    ['v4', new VoterAgent('Voter4', 'defer')],
    ['v5', new VoterAgent('Voter5', 'yes')],
  ]);

  broadcast.createGroup({ id: 'swarm', name: 'Voting Swarm', agentIds: Array.from(agents.keys()), mode: 'all' });

  const executor = async (agentId: string, message: string) => {
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return JSON.parse(await agent.execute({ query: message }));
  };

  const result = await broadcast.broadcast('swarm', 'should we deploy?', executor);

  const tally: Record<string, number> = { yes: 0, no: 0, defer: 0 };
  for (const [agentId, agentResult] of result.results) {
    if (!(agentResult instanceof Error)) {
      const vote = (agentResult as Record<string, unknown>).vote as string;
      tally[vote]++;
      info(`${agentId}: ${vote === 'yes' ? green(vote) : vote === 'no' ? red(vote) : yellow(vote)}`);
    }
  }

  ok(`Tally: YES=${tally.yes} NO=${tally.no} DEFER=${tally.defer}`);
  ok(`Decision: ${tally.yes > tally.no ? green('APPROVED') : red('REJECTED')} (${tally.yes}/${Object.values(tally).reduce((a, b) => a + b)})`);
}

async function demo8_TimeLoop() {
  header(8, 'The Time Loop — PipelineAgent Loop');

  const pipeline = new PipelineAgent((name) => {
    if (name === 'Evolver') return new EvolverAgent('Evolver');
    return undefined;
  });

  const result = JSON.parse(await pipeline.execute({
    action: 'run',
    spec: {
      name: 'TimeLoop',
      steps: [{
        id: 'evolve',
        type: 'loop',
        agent: 'Evolver',
        maxIterations: 10,
        condition: { field: 'score', equals: 100 },
      }],
      input: {},
    },
  }));

  const steps = result.pipeline.steps;
  const scores: number[] = [];
  for (const step of steps) {
    const parsed = JSON.parse(step.result);
    scores.push(parsed.newScore);
  }

  info(`Score progression: ${scores.join(' → ')}`);
  ok(`Reached ${scores[scores.length - 1]}/100 in ${scores.length} iterations`);
  ok(`Pipeline status: ${result.pipeline.status}`);
}

async function demo9_GhostProtocol() {
  header(9, 'Ghost Protocol — McpServer JSON-RPC');

  const server = new McpServer({ name: 'ghost-server', version: '1.0.0' });
  server.registerAgent(new EchoAgent('Echo'));
  server.registerAgent(new ScoreAgent('Score', 50));

  // Initialize
  const init = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  const serverInfo = (init.result as Record<string, unknown>).serverInfo as Record<string, unknown>;
  ok(`Server initialized: ${serverInfo.name} v${serverInfo.version}`);

  // List tools
  const list = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = ((list.result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
  info(`Tools registered: ${tools.map(t => t.name).join(', ')}`);

  // Call a tool
  const call = await server.handleRequest({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'Echo', arguments: { query: 'ghost protocol active' } },
  });
  const content = ((call.result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0];
  ok(`Tool call result: ${(content.text as string).slice(0, 60)}...`);

  // Ping
  const ping = await server.handleRequest({ jsonrpc: '2.0', id: 4, method: 'ping' });
  ok(`Ping: ${JSON.stringify(ping.result)}`);

  // Unknown method
  const unknown = await server.handleRequest({ jsonrpc: '2.0', id: 5, method: 'mystery' });
  ok(`Unknown method handled: code=${unknown.error?.code}`);
}

async function demo10_OuroborosSquared() {
  header(10, 'Ouroboros Squared — assessEvolution + WatchmakerAgent + CodeReview');

  const input = 'The amazing fox found test@example.com on 2024-01-15 at https://example.com for 42 items';

  const report = await assessEvolution(input, {
    wordStats: {
      word_count: 14,
      unique_words: 14,
      avg_word_length: 4.5,
      most_frequent: [
        { word: 'the', count: 1 },
        { word: 'amazing', count: 1 },
        { word: 'fox', count: 1 },
        { word: 'found', count: 1 },
      ],
    },
    caesarCipher: {
      encrypted: 'uryyb',
      decrypted: input,
    },
    patterns: {
      emails: ['test@example.com'],
      urls: ['https://example.com'],
      numbers: ['42', '2024', '01', '15'],
      dates: ['2024-01-15'],
    },
    sentiment: {
      score: 0.5,
      label: 'positive',
      positive: ['amazing'],
      negative: [],
    },
    reflection: {
      generation: 5,
      className: 'OuroborosGen5Agent',
      capability_count: 12,
      identity: 'I am OuroborosGen5Agent, generation 5. I have 12 methods.',
    },
  });

  console.log();
  console.log(report.formatted);
  console.log();

  ok(`Overall: ${report.overall_quality}/100 (${report.status})`);
  ok(`Judge mode: ${report.judge_mode}`);

  for (const cap of report.capabilities) {
    const icon = cap.status === 'strong' ? green('●') : cap.status === 'developing' ? yellow('●') : red('●');
    info(`${icon} ${cap.capability.padEnd(20)} ${String(cap.quality).padStart(3)}/100  ${cap.status}`);
  }

  // Chain it with CodeReview + WatchmakerAgent
  info('');
  const reviewer = new CodeReviewAgent();
  const reviewResult = JSON.parse(await reviewer.execute({
    action: 'review',
    content: 'function analyze(data: string): number {\n  return data.length * 10;\n}',
  }));
  ok(`CodeReview score: ${reviewResult.review.score}/100 (${reviewResult.review.status})`);

  const watchmaker = new WatchmakerAgent();
  watchmaker.setAgents([{ agent: reviewer, version: '1.0' }]);
  const evalResult = JSON.parse(await watchmaker.execute({
    action: 'evaluate',
    agent: 'CodeReview',
    testCases: [{ input: { action: 'review', content: 'const x = 1;' } }],
  }));
  ok(`WatchmakerAgent evaluates CodeReview: quality=${evalResult.evaluation.quality}/100`);
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log();
  box('POWER PROMPTS SHOWCASE', [
    '10 Agent Orchestration Demos',
    'Zero API keys. All deterministic.',
    '',
    ' 1. Darwin\'s Colosseum    6. Agent Factory Factory',
    ' 2. The Infinite Regress   7. The Swarm Vote',
    ' 3. Ship of Theseus        8. The Time Loop',
    ' 4. The Panopticon         9. Ghost Protocol',
    ' 5. The Lazarus Loop      10. Ouroboros Squared',
  ]);

  await demo1_DarwinsColosseum();
  await demo2_InfiniteRegress();
  await demo3_ShipOfTheseus();
  await demo4_Panopticon();
  await demo5_LazarusLoop();
  await demo6_AgentFactoryFactory();
  await demo7_SwarmVote();
  await demo8_TimeLoop();
  await demo9_GhostProtocol();
  await demo10_OuroborosSquared();

  console.log();
  hr();
  console.log(bold.green('  All 10 demos completed successfully.'));
  hr();
  console.log();
}

main().catch(console.error);
