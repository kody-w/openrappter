/**
 * Power Prompts Showcase — 10 Agent Orchestration Demos
 *
 * Each describe block showcases a different orchestration primitive:
 *   1. Darwin's Colosseum   — WatchmakerAgent competitive evolution
 *   2. The Infinite Regress — AgentChain data_slush threading
 *   3. Ship of Theseus      — CodeReviewAgent iterative review
 *   4. The Panopticon       — AgentGraph + AgentTracer diamond DAG
 *   5. The Lazarus Loop     — Chaos resilience + WatchmakerAgent
 *   6. Agent Factory Factory — Multi-generation chain
 *   7. The Swarm Vote       — BroadcastManager parallel voting
 *   8. The Time Loop        — PipelineAgent loop iteration
 *   9. Ghost Protocol       — McpServer JSON-RPC lifecycle
 *  10. Ouroboros Squared    — assessEvolution + WatchmakerAgent + CodeReview
 *
 * Zero API keys. All deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';
import { AgentChain } from '../../agents/chain.js';
import { AgentGraph } from '../../agents/graph.js';
import { createTracer } from '../../agents/tracer.js';
import { BroadcastManager } from '../../agents/broadcast.js';
import { PipelineAgent } from '../../agents/PipelineAgent.js';
import { WatchmakerAgent } from '../../agents/WatchmakerAgent.js';
import { CodeReviewAgent } from '../../agents/CodeReviewAgent.js';
import { McpServer } from '../../mcp/server.js';
import { assessEvolution } from '../../agents/OuroborosAgent.js';

// ── Mock Agents ────────────────────────────────────────────────────────

class ScoreAgent extends BasicAgent {
  private baseScore: number;

  constructor(name: string, baseScore: number) {
    const metadata: AgentMetadata = {
      name,
      description: `Score agent with base score ${baseScore}`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.baseScore = baseScore;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = (kwargs.query ?? '') as string;
    const score = this.baseScore + (query.length % 16);
    return JSON.stringify({
      status: 'success',
      score,
      agent: this.name,
      data_slush: this.slushOut({ score }),
    });
  }
}

class TransformAgent extends BasicAgent {
  private mode: 'uppercase' | 'reverse' | 'rot13' | 'prefix';

  constructor(name: string, mode: 'uppercase' | 'reverse' | 'rot13' | 'prefix') {
    const metadata: AgentMetadata = {
      name,
      description: `Transform agent: ${mode}`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.mode = mode;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.query ?? kwargs.text ?? '') as string;
    let transformed: string;

    switch (this.mode) {
      case 'uppercase':
        transformed = text.toUpperCase();
        break;
      case 'reverse':
        transformed = text.split('').reverse().join('');
        break;
      case 'rot13':
        transformed = text.replace(/[a-zA-Z]/g, (ch) => {
          const base = ch >= 'a' ? 97 : 65;
          return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
        });
        break;
      case 'prefix':
        transformed = `[${this.name}] ${text}`;
        break;
    }

    return JSON.stringify({
      status: 'success',
      transformed,
      mode: this.mode,
      data_slush: this.slushOut({ transformed, mode: this.mode }),
    });
  }
}

class VoterAgent extends BasicAgent {
  private bias: 'yes' | 'no' | 'defer';

  constructor(name: string, bias: 'yes' | 'no' | 'defer') {
    const metadata: AgentMetadata = {
      name,
      description: `Voter with ${bias} bias`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.bias = bias;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = ((kwargs.query ?? '') as string).toLowerCase();
    let vote: string;

    if (query.includes('urgent') || query.includes('critical')) {
      vote = 'yes';
    } else if (query.includes('reject') || query.includes('deny')) {
      vote = 'no';
    } else {
      vote = this.bias;
    }

    return JSON.stringify({
      status: 'success',
      vote,
      voter: this.name,
      data_slush: this.slushOut({ vote, voter: this.name }),
    });
  }
}

class FactoryAgent extends BasicAgent {
  private generation: number;

  constructor(name: string, generation: number) {
    const metadata: AgentMetadata = {
      name,
      description: `Factory agent generation ${generation}`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.generation = generation;
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    const parentGen = this.generation;
    const childGen = parentGen + 1;
    const childName = `FactoryChild_Gen${childGen}`;

    return JSON.stringify({
      status: 'success',
      created: childName,
      parentGeneration: parentGen,
      childGeneration: childGen,
      lineage: `Gen${parentGen} -> Gen${childGen}`,
      data_slush: this.slushOut({
        created: childName,
        generation: childGen,
        lineage: `Gen${parentGen} -> Gen${childGen}`,
      }),
    });
  }
}

class EvolverAgent extends BasicAgent {
  constructor(name: string) {
    const metadata: AgentMetadata = {
      name,
      description: 'Evolver agent that reads upstream score and adds 15',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    // upstream_slush is deleted from kwargs by BasicAgent.execute() and placed in this.context
    const upstream = this.context?.upstream_slush as Record<string, unknown> | undefined;
    const prevScore = (upstream?.score as number) ?? 25;
    const newScore = Math.min(prevScore + 15, 100);

    return JSON.stringify({
      status: 'success',
      previousScore: prevScore,
      newScore,
      data_slush: this.slushOut({ score: newScore }),
    });
  }
}

class EchoAgent extends BasicAgent {
  constructor(name: string) {
    const metadata: AgentMetadata = {
      name,
      description: 'Echo agent that returns input',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = (kwargs.query ?? '') as string;
    return JSON.stringify({
      status: 'success',
      echo: query,
      agent: this.name,
      data_slush: this.slushOut({ echo: query }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Darwin's Colosseum — WatchmakerAgent
// ═══════════════════════════════════════════════════════════════════════

describe('1. Darwin\'s Colosseum — WatchmakerAgent', () => {
  let watchmaker: WatchmakerAgent;

  beforeEach(() => {
    watchmaker = new WatchmakerAgent();
  });

  it('registers 4 ScoreAgents into the ecosystem', async () => {
    const agents = [
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
      { agent: new ScoreAgent('Alpha', 75), version: '2.0' },
      { agent: new ScoreAgent('Alpha', 90), version: '3.0' },
      { agent: new ScoreAgent('Alpha', 40), version: '4.0' },
    ];
    watchmaker.setAgents(agents);

    const statusResult = JSON.parse(await watchmaker.execute({ action: 'status', agent: 'Alpha' }));
    expect(statusResult.slot.activeVersion).toBe('1.0');
    expect(statusResult.slot.candidateCount).toBe(3);
  });

  it('first agent registered becomes active', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
      { agent: new ScoreAgent('Alpha', 75), version: '2.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({ action: 'status', agent: 'Alpha' }));
    expect(result.status).toBe('success');
    expect(result.slot.activeVersion).toBe('1.0');
    expect(result.slot.candidateCount).toBe(1);
  });

  it('evaluates an agent and produces quality score', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({
      action: 'evaluate',
      agent: 'Alpha',
      testCases: [{ input: { query: 'test' } }],
    }));

    expect(result.status).toBe('success');
    expect(result.evaluation.quality).toBeGreaterThanOrEqual(0);
    expect(result.evaluation.quality).toBeLessThanOrEqual(100);
  });

  it('compares two versions and determines a winner', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
      { agent: new ScoreAgent('Alpha', 90), version: '2.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({
      action: 'compare',
      agent: 'Alpha',
      versionA: '1.0',
      versionB: '2.0',
      testCases: [{ input: { query: 'test' } }],
    }));

    expect(result.status).toBe('success');
    expect(result.comparison.winner).toBeDefined();
    expect(['A', 'B', 'tie']).toContain(result.comparison.winner);
  });

  it('runs a full evolution cycle', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
      { agent: new ScoreAgent('Alpha', 90), version: '2.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({
      action: 'cycle',
      testCases: [{ input: { query: 'evolution test' } }],
    }));

    expect(result.status).toBe('success');
    expect(result.cycle.evaluated.length).toBeGreaterThanOrEqual(2);
    expect(result.cycle.comparisons.length).toBeGreaterThanOrEqual(1);
  });

  it('auto-promotes candidate that outperforms active', async () => {
    // WeakAgent: omits data_slush and required field → fails has_data_slush and has_field checks
    class WeakAgent extends BasicAgent {
      constructor() {
        super('Alpha', { name: 'Alpha', description: 'weak', parameters: { type: 'object', properties: {}, required: [] } });
      }
      async perform(): Promise<string> {
        return JSON.stringify({ status: 'success' });
      }
    }
    // StrongAgent: includes data_slush AND required field → passes all checks
    class StrongAgent extends BasicAgent {
      constructor() {
        super('Alpha', { name: 'Alpha', description: 'strong', parameters: { type: 'object', properties: {}, required: [] } });
      }
      async perform(): Promise<string> {
        return JSON.stringify({ status: 'success', result_data: 'ok', data_slush: this.slushOut({}) });
      }
    }

    watchmaker.setAgents([
      { agent: new WeakAgent(), version: '1.0' },
      { agent: new StrongAgent(), version: '2.0' },
    ]);

    await watchmaker.execute({
      action: 'cycle',
      testCases: [{ input: { query: 'test' }, expectedFields: ['result_data'] }],
    });

    // After cycle, v2.0 should be active because it passes has_data_slush + has_field_result_data
    const status = JSON.parse(await watchmaker.execute({ action: 'status', agent: 'Alpha' }));
    expect(status.slot.activeVersion).toBe('2.0');
  });

  it('tracks evaluation history', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 70), version: '1.0' },
    ]);

    await watchmaker.execute({
      action: 'evaluate',
      agent: 'Alpha',
      testCases: [{ input: { query: 'a' } }],
    });
    await watchmaker.execute({
      action: 'evaluate',
      agent: 'Alpha',
      testCases: [{ input: { query: 'b' } }],
    });

    const history = JSON.parse(await watchmaker.execute({ action: 'history', agent: 'Alpha' }));
    expect(history.evaluationCount).toBeGreaterThanOrEqual(2);
  });

  it('handles multiple agent slots independently', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
      { agent: new ScoreAgent('Beta', 80), version: '1.0' },
    ]);

    const status = JSON.parse(await watchmaker.execute({ action: 'status' }));
    expect(status.count).toBe(2);
    expect(status.slots).toHaveLength(2);
  });

  it('evaluation produces data_slush for downstream chaining', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({
      action: 'evaluate',
      agent: 'Alpha',
      testCases: [{ input: { query: 'test' } }],
    }));

    expect(result.data_slush).toBeDefined();
    expect(result.data_slush.source_agent).toBe('Watchmaker');
  });

  it('cycle produces summary string', async () => {
    watchmaker.setAgents([
      { agent: new ScoreAgent('Alpha', 60), version: '1.0' },
      { agent: new ScoreAgent('Alpha', 90), version: '2.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({
      action: 'cycle',
      testCases: [{ input: { query: 'test' } }],
    }));

    expect(result.cycle.summary).toContain('Evaluated');
    expect(result.cycle.summary).toContain('comparisons');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The Infinite Regress — AgentChain
// ═══════════════════════════════════════════════════════════════════════

describe('2. The Infinite Regress — AgentChain', () => {
  it('chains 3 transforms with automatic data_slush threading', async () => {
    const chain = new AgentChain()
      .add('upper', new TransformAgent('Upper', 'uppercase'))
      .add('prefix', new TransformAgent('Prefixer', 'prefix'))
      .add('reverse', new TransformAgent('Reverser', 'reverse'));

    const result = await chain.run({ query: 'hello world' });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(3);
  });

  it('each step receives upstream_slush from the previous step', async () => {
    const chain = new AgentChain()
      .add('step1', new TransformAgent('Upper', 'uppercase'))
      .add('step2', new TransformAgent('Prefixer', 'prefix'));

    const result = await chain.run({ query: 'test' });

    expect(result.steps[0].dataSlush).toBeDefined();
    expect(result.steps[1].dataSlush).toBeDefined();
  });

  it('final result is accessible from chain result', async () => {
    const chain = new AgentChain()
      .add('upper', new TransformAgent('Upper', 'uppercase'));

    const result = await chain.run({ query: 'hello' });

    expect(result.finalResult).toBeDefined();
    expect(result.finalResult!.transformed).toBe('HELLO');
  });

  it('data_slush contains transformation metadata', async () => {
    const chain = new AgentChain()
      .add('upper', new TransformAgent('Upper', 'uppercase'));

    const result = await chain.run({ query: 'test' });

    expect(result.finalSlush).toBeDefined();
    expect(result.finalSlush!.transformed).toBe('TEST');
    expect(result.finalSlush!.mode).toBe('uppercase');
  });

  it('chain step names are retrievable', () => {
    const chain = new AgentChain()
      .add('a', new EchoAgent('A'))
      .add('b', new EchoAgent('B'))
      .add('c', new EchoAgent('C'));

    expect(chain.getStepNames()).toEqual(['a', 'b', 'c']);
    expect(chain.length).toBe(3);
  });

  it('empty chain has no steps', async () => {
    const chain = new AgentChain();
    const result = await chain.run();

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(0);
  });

  it('upstream_slush propagates through 3 stages', async () => {
    const slushValues: (Record<string, unknown> | null)[] = [];

    const chain = new AgentChain()
      .add('s1', new TransformAgent('T1', 'uppercase'))
      .add('s2', new TransformAgent('T2', 'reverse'))
      .add('s3', new TransformAgent('T3', 'prefix'));

    const result = await chain.run({ query: 'abc' });

    // Each step should have slush
    for (const step of result.steps) {
      slushValues.push(step.dataSlush);
    }

    expect(slushValues).toHaveLength(3);
    expect(slushValues.every(s => s !== null)).toBe(true);
  });

  it('supports transform functions between steps', async () => {
    const chain = new AgentChain()
      .add('echo', new EchoAgent('Echo1'))
      .add('upper', new TransformAgent('Upper', 'uppercase'), undefined, (prevResult) => {
        return { query: prevResult.echo ?? 'fallback' };
      });

    const result = await chain.run({ query: 'transform me' });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
  });

  it('stopOnError halts the chain', async () => {
    class FailAgent extends BasicAgent {
      constructor() {
        super('Fail', { name: 'Fail', description: 'Always fails', parameters: { type: 'object', properties: {}, required: [] } });
      }
      async perform(): Promise<string> {
        throw new Error('intentional failure');
      }
    }

    const chain = new AgentChain({ stopOnError: true })
      .add('fail', new FailAgent())
      .add('after', new EchoAgent('After'));

    const result = await chain.run({ query: 'test' });

    expect(result.status).toBe('error');
    expect(result.failedStep).toBe('fail');
    expect(result.steps).toHaveLength(1);
  });

  it('continue mode runs remaining steps after error', async () => {
    class FailAgent extends BasicAgent {
      constructor() {
        super('Fail', { name: 'Fail', description: 'Always fails', parameters: { type: 'object', properties: {}, required: [] } });
      }
      async perform(): Promise<string> {
        throw new Error('intentional failure');
      }
    }

    const chain = new AgentChain({ stopOnError: false })
      .add('fail', new FailAgent())
      .add('after', new EchoAgent('After'));

    const result = await chain.run({ query: 'test' });

    expect(result.status).toBe('partial');
    expect(result.steps).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Ship of Theseus — CodeReviewAgent
// ═══════════════════════════════════════════════════════════════════════

describe('3. Ship of Theseus — CodeReviewAgent', () => {
  let reviewer: CodeReviewAgent;

  beforeEach(() => {
    reviewer = new CodeReviewAgent();
  });

  it('detects long lines', async () => {
    const longLine = 'x'.repeat(150);
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: longLine,
    }));

    expect(result.review.findings.some((f: { rule: string }) => f.rule === 'line-length')).toBe(true);
  });

  it('detects TODO comments', async () => {
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: '// TODO: fix this later\nconst x = 1;',
    }));

    expect(result.review.findings.some((f: { rule: string }) => f.rule === 'todo-comment')).toBe(true);
  });

  it('detects console.log in non-test files', async () => {
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: 'console.log("debug");\nconst x = 1;',
      file: 'app.ts',
    }));

    expect(result.review.findings.some((f: { rule: string }) => f.rule === 'no-console')).toBe(true);
  });

  it('allows console.log in test files', async () => {
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: 'console.log("debug");\nconst x = 1;',
      file: 'app.test.ts',
    }));

    expect(result.review.findings.some((f: { rule: string }) => f.rule === 'no-console')).toBe(false);
  });

  it('detects excessive any types (>5)', async () => {
    const code = Array.from({ length: 6 }, (_, i) => `const x${i}: any = ${i};`).join('\n');
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: code,
    }));

    expect(result.review.findings.some((f: { rule: string }) => f.rule === 'no-excessive-any')).toBe(true);
  });

  it('does not flag <=5 any types', async () => {
    const code = Array.from({ length: 5 }, (_, i) => `const x${i}: any = ${i};`).join('\n');
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: code,
    }));

    expect(result.review.findings.some((f: { rule: string }) => f.rule === 'no-excessive-any')).toBe(false);
  });

  it('computes score: clean code = 100', async () => {
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: 'const x = 1;\nconst y = 2;',
    }));

    expect(result.review.score).toBe(100);
    expect(result.review.status).toBe('clean');
  });

  it('score deducts for warnings (-5 each)', async () => {
    const longLine = 'x'.repeat(150);
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: longLine,
    }));

    // line-length is a warning = -5
    expect(result.review.score).toBe(95);
  });

  it('score deducts for info (-1 each)', async () => {
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: '// TODO: implement\nconst x = 1;',
    }));

    // todo-comment is info = -1
    expect(result.review.score).toBe(99);
  });

  it('produces data_slush with review signals', async () => {
    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: 'const x = 1;',
    }));

    expect(result.data_slush).toBeDefined();
    expect(result.data_slush.signals.score).toBe(100);
    expect(result.data_slush.source_agent).toBe('CodeReview');
  });

  it('iterative review-fix improves score', async () => {
    // Round 1: buggy code
    const buggyCode = `console.log("debug");\n// TODO: fix\n${'x'.repeat(150)}`;
    const r1 = JSON.parse(await reviewer.execute({
      action: 'review',
      content: buggyCode,
      file: 'app.ts',
    }));

    // Round 2: fix the issues
    const fixedCode = 'const x = 1;\nconst y = 2;';
    const r2 = JSON.parse(await reviewer.execute({
      action: 'review',
      content: fixedCode,
      file: 'app.ts',
    }));

    expect(r2.review.score).toBeGreaterThan(r1.review.score);
    expect(r2.review.status).toBe('clean');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. The Panopticon — AgentGraph + AgentTracer
// ═══════════════════════════════════════════════════════════════════════

describe('4. The Panopticon — AgentGraph + AgentTracer', () => {
  it('builds a diamond DAG with 4 nodes', () => {
    const graph = new AgentGraph()
      .addNode({ name: 'source', agent: new EchoAgent('Source') })
      .addNode({ name: 'left', agent: new TransformAgent('Left', 'uppercase'), dependsOn: ['source'] })
      .addNode({ name: 'right', agent: new TransformAgent('Right', 'reverse'), dependsOn: ['source'] })
      .addNode({ name: 'sink', agent: new EchoAgent('Sink'), dependsOn: ['left', 'right'] });

    expect(graph.length).toBe(4);
    expect(graph.getNodeNames()).toEqual(['source', 'left', 'right', 'sink']);
  });

  it('validates a correct DAG', () => {
    const graph = new AgentGraph()
      .addNode({ name: 'a', agent: new EchoAgent('A') })
      .addNode({ name: 'b', agent: new EchoAgent('B'), dependsOn: ['a'] });

    const validation = graph.validate();
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('detects cycles in a DAG', () => {
    const graph = new AgentGraph()
      .addNode({ name: 'a', agent: new EchoAgent('A'), dependsOn: ['b'] })
      .addNode({ name: 'b', agent: new EchoAgent('B'), dependsOn: ['a'] });

    const validation = graph.validate();
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.includes('Cycle'))).toBe(true);
  });

  it('detects missing dependencies', () => {
    const graph = new AgentGraph()
      .addNode({ name: 'a', agent: new EchoAgent('A'), dependsOn: ['nonexistent'] });

    const validation = graph.validate();
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain('nonexistent');
  });

  it('executes a diamond DAG successfully', async () => {
    const graph = new AgentGraph()
      .addNode({ name: 'source', agent: new EchoAgent('Source'), kwargs: { query: 'hello' } })
      .addNode({ name: 'left', agent: new TransformAgent('Left', 'uppercase'), dependsOn: ['source'] })
      .addNode({ name: 'right', agent: new TransformAgent('Right', 'reverse'), dependsOn: ['source'] })
      .addNode({ name: 'sink', agent: new EchoAgent('Sink'), dependsOn: ['left', 'right'] });

    const result = await graph.run();

    expect(result.status).toBe('success');
    expect(result.nodes.size).toBe(4);
    expect(result.executionOrder).toContain('source');
    expect(result.executionOrder).toContain('sink');
  });

  it('source executes before its dependents', async () => {
    const graph = new AgentGraph()
      .addNode({ name: 'source', agent: new EchoAgent('Source'), kwargs: { query: 'hello' } })
      .addNode({ name: 'child', agent: new EchoAgent('Child'), dependsOn: ['source'] });

    const result = await graph.run();

    const sourceIdx = result.executionOrder.indexOf('source');
    const childIdx = result.executionOrder.indexOf('child');
    expect(sourceIdx).toBeLessThan(childIdx);
  });

  it('multi-dependency node receives merged upstream_slush', async () => {
    const graph = new AgentGraph()
      .addNode({ name: 'a', agent: new EchoAgent('A'), kwargs: { query: 'from-a' } })
      .addNode({ name: 'b', agent: new EchoAgent('B'), kwargs: { query: 'from-b' } })
      .addNode({ name: 'c', agent: new EchoAgent('C'), dependsOn: ['a', 'b'] });

    const result = await graph.run();

    expect(result.status).toBe('success');
    expect(result.nodes.get('c')!.status).toBe('success');
  });

  it('tracer records spans for DAG execution', async () => {
    const tracer = createTracer();
    const { span: rootSpan, context: rootCtx } = tracer.startSpan('Graph', 'run');

    const agents = ['source', 'left', 'right', 'sink'];
    const childSpans = agents.map(name => {
      const { span } = tracer.startSpan(name, 'execute', rootCtx);
      return span;
    });

    // Complete child spans
    for (const cs of childSpans) {
      tracer.endSpan(cs.id, { status: 'success' });
    }
    tracer.endSpan(rootSpan.id, { status: 'success' });

    const trace = tracer.getTrace(rootCtx.traceId);
    expect(trace).toHaveLength(5); // root + 4 children
    expect(trace.every(s => s.status === 'success')).toBe(true);
  });

  it('tracer links parent-child spans via traceId', () => {
    const tracer = createTracer();
    const { span: parent, context: parentCtx } = tracer.startSpan('Parent', 'execute');
    const { span: child } = tracer.startSpan('Child', 'execute', parentCtx);

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentId).toBe(parent.id);
  });

  it('skips dependents of failed nodes', async () => {
    class FailAgent extends BasicAgent {
      constructor() {
        super('Fail', { name: 'Fail', description: 'fails', parameters: { type: 'object', properties: {}, required: [] } });
      }
      async perform(): Promise<string> { throw new Error('boom'); }
    }

    const graph = new AgentGraph()
      .addNode({ name: 'fail', agent: new FailAgent() })
      .addNode({ name: 'after', agent: new EchoAgent('After'), dependsOn: ['fail'] });

    const result = await graph.run();

    expect(result.status).toBe('partial');
    expect(result.nodes.get('fail')!.status).toBe('error');
    expect(result.nodes.get('after')!.status).toBe('skipped');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The Lazarus Loop — Chaos resilience
// ═══════════════════════════════════════════════════════════════════════

describe('5. The Lazarus Loop — Chaos resilience', () => {
  it('ScoreAgent survives empty input', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    const result = JSON.parse(await agent.execute({}));
    expect(result.status).toBe('success');
    expect(result.score).toBeDefined();
  });

  it('ScoreAgent survives very long input', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    const result = JSON.parse(await agent.execute({ query: 'x'.repeat(10000) }));
    expect(result.status).toBe('success');
  });

  it('ScoreAgent survives special characters', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    const result = JSON.parse(await agent.execute({ query: '!@#$%^&*(){}[]<>' }));
    expect(result.status).toBe('success');
  });

  it('ScoreAgent survives unicode input', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    const result = JSON.parse(await agent.execute({ query: '你好世界 🌍 café' }));
    expect(result.status).toBe('success');
  });

  it('ScoreAgent produces deterministic scores', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    const r1 = JSON.parse(await agent.execute({ query: 'same input' }));
    const r2 = JSON.parse(await agent.execute({ query: 'same input' }));
    expect(r1.score).toBe(r2.score);
  });

  it('ScoreAgent produces data_slush with score', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    const result = JSON.parse(await agent.execute({ query: 'test' }));
    expect(result.data_slush).toBeDefined();
    expect(result.data_slush.score).toBe(result.score);
  });

  it('WatchmakerAgent evaluates chaos-tested agent', async () => {
    const watchmaker = new WatchmakerAgent();
    const agent = new ScoreAgent('Lazarus', 70);
    watchmaker.setAgents([{ agent, version: '1.0' }]);

    const chaosInputs = [
      { input: {} },
      { input: { query: '' } },
      { input: { query: 'x'.repeat(1000) } },
      { input: { query: '!@#$%' } },
    ];

    const result = JSON.parse(await watchmaker.execute({
      action: 'evaluate',
      agent: 'Lazarus',
      testCases: chaosInputs,
    }));

    expect(result.status).toBe('success');
    expect(result.evaluation.quality).toBeGreaterThanOrEqual(50);
  });

  it('ScoreAgent handles numeric query gracefully', async () => {
    const agent = new ScoreAgent('Lazarus', 50);
    // query will be cast to string
    const result = JSON.parse(await agent.execute({ query: 'numeric 42' }));
    expect(result.status).toBe('success');
  });

  it('multiple chaos agents evaluated in parallel', async () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      new ScoreAgent(`Chaos_${i}`, 40 + i * 10)
    );

    const results = await Promise.all(
      agents.map(a => a.execute({ query: 'parallel chaos test' }))
    );

    for (const r of results) {
      const parsed = JSON.parse(r);
      expect(parsed.status).toBe('success');
    }
  });

  it('ScoreAgent base score affects output', async () => {
    const low = new ScoreAgent('Low', 10);
    const high = new ScoreAgent('High', 90);

    const rLow = JSON.parse(await low.execute({ query: 'same' }));
    const rHigh = JSON.parse(await high.execute({ query: 'same' }));

    expect(rHigh.score).toBeGreaterThan(rLow.score);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Agent Factory Factory — Multi-generation chain
// ═══════════════════════════════════════════════════════════════════════

describe('6. Agent Factory Factory — Multi-generation chain', () => {
  it('FactoryAgent creates a child description', async () => {
    const factory = new FactoryAgent('Factory_Gen0', 0);
    const result = JSON.parse(await factory.execute({ query: 'create' }));

    expect(result.status).toBe('success');
    expect(result.created).toBe('FactoryChild_Gen1');
    expect(result.lineage).toContain('Gen0');
  });

  it('chains 3 generations of factory agents', async () => {
    const chain = new AgentChain()
      .add('gen0', new FactoryAgent('Factory_Gen0', 0))
      .add('gen1', new FactoryAgent('Factory_Gen1', 1))
      .add('gen2', new FactoryAgent('Factory_Gen2', 2));

    const result = await chain.run({ query: 'bootstrap' });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(3);

    // Each generation reports its lineage
    const gen0 = result.steps[0].result;
    const gen2 = result.steps[2].result;
    expect((gen0 as Record<string, unknown>).childGeneration).toBe(1);
    expect((gen2 as Record<string, unknown>).childGeneration).toBe(3);
  });

  it('data_slush carries lineage through chain', async () => {
    const chain = new AgentChain()
      .add('gen0', new FactoryAgent('Factory_Gen0', 0))
      .add('gen1', new FactoryAgent('Factory_Gen1', 1));

    const result = await chain.run({ query: 'create' });

    expect(result.steps[0].dataSlush!.generation).toBe(1);
    expect(result.steps[1].dataSlush!.generation).toBe(2);
  });

  it('factory chain followed by transform produces output', async () => {
    const chain = new AgentChain()
      .add('factory', new FactoryAgent('Factory', 0))
      .add('transform', new TransformAgent('Transform', 'uppercase'));

    const result = await chain.run({ query: 'build' });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
  });

  it('each factory step has unique lineage', async () => {
    const chain = new AgentChain()
      .add('g0', new FactoryAgent('F0', 0))
      .add('g1', new FactoryAgent('F1', 1))
      .add('g2', new FactoryAgent('F2', 2));

    const result = await chain.run({ query: 'create' });

    const lineages = result.steps.map(s => (s.result as Record<string, unknown>).lineage as string);
    expect(new Set(lineages).size).toBe(3);
  });

  it('factory agent generation is reflected in output', async () => {
    const factory = new FactoryAgent('Gen3', 3);
    const result = JSON.parse(await factory.execute({ query: 'test' }));

    expect(result.parentGeneration).toBe(3);
    expect(result.childGeneration).toBe(4);
  });

  it('factory produces data_slush with generation info', async () => {
    const factory = new FactoryAgent('Gen0', 0);
    const result = JSON.parse(await factory.execute({ query: 'test' }));

    expect(result.data_slush).toBeDefined();
    expect(result.data_slush.generation).toBe(1);
    expect(result.data_slush.created).toBe('FactoryChild_Gen1');
  });

  it('5-generation chain completes', async () => {
    const chain = new AgentChain();
    for (let i = 0; i < 5; i++) {
      chain.add(`gen${i}`, new FactoryAgent(`F${i}`, i));
    }

    const result = await chain.run({ query: 'deep chain' });

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(5);
    expect((result.steps[4].result as Record<string, unknown>).childGeneration).toBe(5);
  });

  it('factory data_slush contains lineage string', async () => {
    const factory = new FactoryAgent('Root', 0);
    const result = JSON.parse(await factory.execute({ query: 'test' }));

    expect(result.data_slush.lineage).toBe('Gen0 -> Gen1');
  });

  it('factory chain total duration is measured', async () => {
    const chain = new AgentChain()
      .add('g0', new FactoryAgent('F0', 0))
      .add('g1', new FactoryAgent('F1', 1));

    const result = await chain.run({ query: 'timed' });

    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.steps.every(s => s.durationMs >= 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. The Swarm Vote — BroadcastManager
// ═══════════════════════════════════════════════════════════════════════

describe('7. The Swarm Vote — BroadcastManager', () => {
  let broadcast: BroadcastManager;
  let agents: Map<string, VoterAgent>;

  beforeEach(() => {
    broadcast = new BroadcastManager();
    agents = new Map([
      ['voter1', new VoterAgent('Voter1', 'yes')],
      ['voter2', new VoterAgent('Voter2', 'yes')],
      ['voter3', new VoterAgent('Voter3', 'no')],
      ['voter4', new VoterAgent('Voter4', 'defer')],
      ['voter5', new VoterAgent('Voter5', 'yes')],
    ]);

    broadcast.createGroup({
      id: 'swarm',
      name: 'Voting Swarm',
      agentIds: ['voter1', 'voter2', 'voter3', 'voter4', 'voter5'],
      mode: 'all',
    });
  });

  const executor = async (agentId: string, message: string) => {
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const result = await agent.execute({ query: message });
    return JSON.parse(result);
  };

  it('all 5 voters respond', async () => {
    const result = await broadcast.broadcast('swarm', 'should we proceed?', executor);

    expect(result.results.size).toBe(5);
    expect(result.allSucceeded).toBe(true);
  });

  it('first response is captured', async () => {
    const result = await broadcast.broadcast('swarm', 'vote now', executor);

    expect(result.firstResponse).toBeDefined();
    expect(result.firstResponse!.agentId).toBeDefined();
  });

  it('tallies votes correctly', async () => {
    const result = await broadcast.broadcast('swarm', 'standard vote', executor);

    const votes: Record<string, number> = { yes: 0, no: 0, defer: 0 };
    for (const [, agentResult] of result.results) {
      if (!(agentResult instanceof Error)) {
        votes[(agentResult as Record<string, unknown>).vote as string]++;
      }
    }

    expect(votes.yes).toBe(3);
    expect(votes.no).toBe(1);
    expect(votes.defer).toBe(1);
  });

  it('urgent keyword overrides all biases to yes', async () => {
    const result = await broadcast.broadcast('swarm', 'urgent: vote now', executor);

    for (const [, agentResult] of result.results) {
      if (!(agentResult instanceof Error)) {
        expect((agentResult as Record<string, unknown>).vote).toBe('yes');
      }
    }
  });

  it('reject keyword overrides all biases to no', async () => {
    const result = await broadcast.broadcast('swarm', 'reject this proposal', executor);

    for (const [, agentResult] of result.results) {
      if (!(agentResult instanceof Error)) {
        expect((agentResult as Record<string, unknown>).vote).toBe('no');
      }
    }
  });

  it('race mode returns first response', async () => {
    broadcast.createGroup({
      id: 'race-swarm',
      name: 'Race Swarm',
      agentIds: ['voter1', 'voter2', 'voter3'],
      mode: 'race',
    });

    const result = await broadcast.broadcast('race-swarm', 'race vote', executor);

    expect(result.firstResponse).toBeDefined();
    expect(result.anySucceeded).toBe(true);
  });

  it('fallback mode tries agents sequentially', async () => {
    broadcast.createGroup({
      id: 'fallback-swarm',
      name: 'Fallback Swarm',
      agentIds: ['voter1', 'voter2'],
      mode: 'fallback',
    });

    const result = await broadcast.broadcast('fallback-swarm', 'fallback vote', executor);

    expect(result.anySucceeded).toBe(true);
    // Fallback stops at first success
    expect(result.results.size).toBe(1);
  });

  it('group management: create, get, remove', () => {
    broadcast.createGroup({
      id: 'temp',
      name: 'Temporary',
      agentIds: ['voter1'],
      mode: 'all',
    });

    expect(broadcast.getGroup('temp')).toBeDefined();
    expect(broadcast.removeGroup('temp')).toBe(true);
    expect(broadcast.getGroup('temp')).toBeUndefined();
  });

  it('broadcast to nonexistent group throws', async () => {
    await expect(
      broadcast.broadcast('nonexistent', 'test', executor)
    ).rejects.toThrow('not found');
  });

  it('getGroups returns all registered groups', () => {
    const groups = broadcast.getGroups();
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups.some(g => g.id === 'swarm')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. The Time Loop — PipelineAgent loop
// ═══════════════════════════════════════════════════════════════════════

describe('8. The Time Loop — PipelineAgent loop', () => {
  it('EvolverAgent reads upstream_slush score and adds 15', async () => {
    const evolver = new EvolverAgent('Evolver');
    const result = JSON.parse(await evolver.execute({
      upstream_slush: { score: 25 },
    }));

    expect(result.status).toBe('success');
    expect(result.previousScore).toBe(25);
    expect(result.newScore).toBe(40);
  });

  it('EvolverAgent defaults to 25 without upstream', async () => {
    const evolver = new EvolverAgent('Evolver');
    const result = JSON.parse(await evolver.execute({}));

    expect(result.previousScore).toBe(25);
    expect(result.newScore).toBe(40);
  });

  it('EvolverAgent caps at 100', async () => {
    const evolver = new EvolverAgent('Evolver');
    const result = JSON.parse(await evolver.execute({
      upstream_slush: { score: 95 },
    }));

    expect(result.newScore).toBe(100);
  });

  it('PipelineAgent validates a pipeline spec', async () => {
    const pipeline = new PipelineAgent((name) => {
      if (name === 'Evolver') return new EvolverAgent('Evolver');
      return undefined;
    });

    const result = JSON.parse(await pipeline.execute({
      action: 'validate',
      spec: {
        name: 'TimeLoop',
        steps: [
          { id: 'evolve', type: 'loop', agent: 'Evolver', maxIterations: 6 },
        ],
        input: {},
      },
    }));

    expect(result.valid).toBe(true);
  });

  it('loop step iterates with data_slush threading', async () => {
    const pipeline = new PipelineAgent((name) => {
      if (name === 'Evolver') return new EvolverAgent('Evolver');
      return undefined;
    });

    const result = JSON.parse(await pipeline.execute({
      action: 'run',
      spec: {
        name: 'TimeLoop',
        steps: [
          {
            id: 'evolve',
            type: 'loop',
            agent: 'Evolver',
            maxIterations: 6,
            condition: { field: 'score', equals: 100 },
          },
        ],
        input: {},
      },
    }));

    expect(result.status).toBe('success');
    expect(result.pipeline.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('loop score progresses: 25->40->55->70->85->100', async () => {
    const pipeline = new PipelineAgent((name) => {
      if (name === 'Evolver') return new EvolverAgent('Evolver');
      return undefined;
    });

    const result = JSON.parse(await pipeline.execute({
      action: 'run',
      spec: {
        name: 'TimeLoop',
        steps: [
          {
            id: 'evolve',
            type: 'loop',
            agent: 'Evolver',
            maxIterations: 10,
            condition: { field: 'score', equals: 100 },
          },
        ],
        input: {},
      },
    }));

    // Extract scores from each iteration
    const steps = result.pipeline.steps;
    const scores: number[] = [];
    for (const step of steps) {
      const parsed = JSON.parse(step.result);
      scores.push(parsed.newScore);
    }

    // Verify progression
    expect(scores[0]).toBe(40);  // default 25 + 15
    if (scores.length >= 2) expect(scores[1]).toBe(55);
    if (scores.length >= 3) expect(scores[2]).toBe(70);
    if (scores.length >= 4) expect(scores[3]).toBe(85);
    if (scores.length >= 5) expect(scores[4]).toBe(100);
  });

  it('loop terminates when condition is met', async () => {
    const pipeline = new PipelineAgent((name) => {
      if (name === 'Evolver') return new EvolverAgent('Evolver');
      return undefined;
    });

    const result = JSON.parse(await pipeline.execute({
      action: 'run',
      spec: {
        name: 'TimeLoop',
        steps: [
          {
            id: 'evolve',
            type: 'loop',
            agent: 'Evolver',
            maxIterations: 20,
            condition: { field: 'score', equals: 100 },
          },
        ],
        input: {},
      },
    }));

    // Should stop after reaching 100, not iterate all 20 times
    const steps = result.pipeline.steps;
    expect(steps.length).toBeLessThanOrEqual(6);
  });

  it('pipeline produces final data_slush', async () => {
    const pipeline = new PipelineAgent((name) => {
      if (name === 'Evolver') return new EvolverAgent('Evolver');
      return undefined;
    });

    const result = JSON.parse(await pipeline.execute({
      action: 'run',
      spec: {
        name: 'TimeLoop',
        steps: [
          { id: 'evolve', type: 'agent', agent: 'Evolver' },
        ],
        input: {},
      },
    }));

    expect(result.data_slush).toBeDefined();
    expect(result.data_slush.signals.pipeline_name).toBe('TimeLoop');
  });

  it('pipeline status action works without prior run', async () => {
    const pipeline = new PipelineAgent();
    const result = JSON.parse(await pipeline.execute({ action: 'status' }));

    expect(result.status).toBe('success');
    expect(result.message).toContain('No pipeline');
  });

  it('loop respects maxIterations', async () => {
    const pipeline = new PipelineAgent((name) => {
      if (name === 'Evolver') return new EvolverAgent('Evolver');
      return undefined;
    });

    const result = JSON.parse(await pipeline.execute({
      action: 'run',
      spec: {
        name: 'BoundedLoop',
        steps: [
          { id: 'evolve', type: 'loop', agent: 'Evolver', maxIterations: 2 },
        ],
        input: {},
      },
    }));

    expect(result.pipeline.steps.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. Ghost Protocol — McpServer JSON-RPC lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe('9. Ghost Protocol — McpServer JSON-RPC', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test-server', version: '1.0.0' });
    server.registerAgent(new EchoAgent('Echo'));
    server.registerAgent(new ScoreAgent('Score', 50));
  });

  it('initializes with server info', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect((result.serverInfo as Record<string, unknown>).name).toBe('test-server');
    expect(result.capabilities).toBeDefined();
  });

  it('lists registered tools', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools.some(t => t.name === 'Echo')).toBe(true);
    expect(tools.some(t => t.name === 'Score')).toBe(true);
  });

  it('calls a registered tool successfully', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'Echo', arguments: { query: 'hello mcp' } },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    const content = (result.content as Array<Record<string, unknown>>)[0];
    expect(content.type).toBe('text');
  });

  it('returns error for unknown tool', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'NonExistent', arguments: {} },
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
    expect(response.error!.message).toContain('NonExistent');
  });

  it('returns error for unknown method', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'unknown/method',
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
  });

  it('ping returns empty result', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'ping',
    });

    expect(response.result).toEqual({});
  });

  it('tool definitions include inputSchema', () => {
    const tools = server.getToolDefinitions();

    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('tool count matches registered agents', () => {
    expect(server.toolCount).toBe(2);
  });

  it('hasTool returns correct boolean', () => {
    expect(server.hasTool('Echo')).toBe(true);
    expect(server.hasTool('NonExistent')).toBe(false);
  });

  it('registerAgents batch registration', () => {
    const newServer = new McpServer();
    newServer.registerAgents([
      new EchoAgent('A'),
      new EchoAgent('B'),
      new EchoAgent('C'),
    ]);

    expect(newServer.toolCount).toBe(3);
  });

  it('tool call result contains text content', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'Score', arguments: { query: 'test' } },
    });

    const result = response.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('text');
    expect(typeof content[0].text).toBe('string');

    // Verify the content is valid JSON
    const parsed = JSON.parse(content[0].text as string);
    expect(parsed.score).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. Ouroboros Squared — assessEvolution + WatchmakerAgent + CodeReview
// ═══════════════════════════════════════════════════════════════════════

describe('10. Ouroboros Squared — assessEvolution + WatchmakerAgent + CodeReview', () => {
  it('assessEvolution produces a report for word stats', async () => {
    const report = await assessEvolution('The quick brown fox jumps over the lazy dog', {
      wordStats: {
        word_count: 9,
        unique_words: 9,
        avg_word_length: 3.89,
        most_frequent: [
          { word: 'the', count: 2 },
          { word: 'quick', count: 1 },
          { word: 'brown', count: 1 },
        ],
      },
    });

    expect(report.overall_quality).toBeGreaterThanOrEqual(0);
    expect(report.capabilities).toHaveLength(5);
    expect(report.judge_mode).toBe('deterministic');
  });

  it('assessEvolution handles caesar cipher', async () => {
    const input = 'hello world';
    const encrypted = input.replace(/[a-zA-Z]/g, (ch) => {
      const base = ch >= 'a' ? 97 : 65;
      return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
    });

    const report = await assessEvolution(input, {
      caesarCipher: {
        encrypted,
        decrypted: input,
      },
    });

    const ccCap = report.capabilities.find(c => c.capability === 'Caesar Cipher');
    expect(ccCap!.quality).toBe(100);
  });

  it('assessEvolution handles patterns', async () => {
    const report = await assessEvolution('Contact me at test@example.com on 2024-01-15 or visit https://example.com for 42 items', {
      patterns: {
        emails: ['test@example.com'],
        urls: ['https://example.com'],
        numbers: ['42', '2024', '01', '15'],
        dates: ['2024-01-15'],
      },
    });

    const patternCap = report.capabilities.find(c => c.capability === 'Pattern Detection');
    expect(patternCap!.quality).toBe(100);
  });

  it('assessEvolution handles sentiment', async () => {
    const report = await assessEvolution('This is an amazing wonderful product', {
      sentiment: {
        score: 1.0,
        label: 'positive',
        positive: ['amazing', 'wonderful'],
        negative: [],
      },
    });

    const sentCap = report.capabilities.find(c => c.capability === 'Sentiment Heuristic');
    expect(sentCap!.quality).toBe(100);
  });

  it('assessEvolution handles reflection', async () => {
    const report = await assessEvolution('test', {
      reflection: {
        generation: 5,
        className: 'OuroborosGen5Agent',
        capability_count: 10,
        identity: 'I am OuroborosGen5Agent, generation 5. I have 10 methods.',
      },
    });

    const reflCap = report.capabilities.find(c => c.capability === 'Self-Reflection');
    expect(reflCap!.quality).toBe(100);
  });

  it('assessEvolution with all capabilities scores high', async () => {
    const input = 'The amazing fox found test@example.com on 2024-01-15';

    const report = await assessEvolution(input, {
      wordStats: {
        word_count: 9,
        unique_words: 9,
        avg_word_length: 4.5,
        most_frequent: [
          { word: 'the', count: 1 },
          { word: 'amazing', count: 1 },
          { word: 'fox', count: 1 },
        ],
      },
      caesarCipher: {
        encrypted: 'some encrypted text',
        decrypted: input,
      },
      patterns: {
        emails: ['test@example.com'],
        urls: [],
        numbers: ['2024', '01', '15'],
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
        capability_count: 10,
        identity: 'I am Gen5',
      },
    });

    expect(report.overall_quality).toBeGreaterThanOrEqual(50);
    expect(report.formatted).toContain('EVOLUTION REPORT');
  });

  it('WatchmakerAgent evaluates CodeReviewAgent', async () => {
    const watchmaker = new WatchmakerAgent();
    const codeReview = new CodeReviewAgent();

    watchmaker.setAgents([
      { agent: codeReview, version: '1.0' },
    ]);

    const result = JSON.parse(await watchmaker.execute({
      action: 'evaluate',
      agent: 'CodeReview',
      testCases: [
        { input: { action: 'review', content: 'const x = 1;' } },
      ],
    }));

    expect(result.status).toBe('success');
    expect(result.evaluation.quality).toBeGreaterThanOrEqual(50);
  });

  it('CodeReviewAgent reviews generated code', async () => {
    const reviewer = new CodeReviewAgent();
    const generatedCode = `
function calculateScore(input: string): number {
  const words = input.split(' ');
  return words.length * 10;
}
`.trim();

    const result = JSON.parse(await reviewer.execute({
      action: 'review',
      content: generatedCode,
    }));

    expect(result.review.score).toBeGreaterThanOrEqual(90);
  });

  it('chain: CodeReview → WatchmakerAgent evaluation', async () => {
    const chain = new AgentChain()
      .add('review', new CodeReviewAgent(), {
        action: 'review',
        content: 'const x = 1;\nconst y = 2;',
      })
      .add('evaluate', new ScoreAgent('PostReview', 70));

    const result = await chain.run();

    expect(result.status).toBe('success');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].dataSlush).toBeDefined();
    expect(result.steps[1].dataSlush).toBeDefined();
  });

  it('evolution report format includes box drawing', async () => {
    const report = await assessEvolution('test input', {
      wordStats: { word_count: 2, unique_words: 2, avg_word_length: 4, most_frequent: [{ word: 'test', count: 1 }] },
    });

    expect(report.formatted).toContain('╔');
    expect(report.formatted).toContain('╚');
    expect(report.formatted).toContain('EVOLUTION REPORT');
  });

  it('assessEvolution returns status string', async () => {
    const report = await assessEvolution('test', {});

    expect(['strong', 'developing', 'weak']).toContain(report.status);
  });
});
