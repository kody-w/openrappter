/**
 * Composite error-status parity tests.
 *
 * A sub-agent that *resolves* with a structured `{status: 'error'}` envelope
 * has failed just as surely as one that throws. These tests pin that contract
 * for the composition layers (AgentGraph, BroadcastManager, AgentChain,
 * PipelineAgent, SubAgentManager) and pin the shared classifier and failure-
 * reason extractor against the cross-runtime vector file in `contracts/`.
 *
 * Mirrors python/tests/test_composite_error_status.py
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AgentGraph } from '../../agents/graph.js';
import { BroadcastManager } from '../../agents/broadcast.js';
import { AgentChain } from '../../agents/chain.js';
import { PipelineAgent } from '../../agents/PipelineAgent.js';
import { SubAgentManager } from '../../agents/subagent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import { agentResultIsError, agentResultErrorMessage } from '../../agents/result-status.js';
import type { AgentMetadata, AgentResult } from '../../agents/types.js';

// ── Test helpers ──

function meta(name: string, description: string): AgentMetadata {
  return { name, description, parameters: { type: 'object', properties: {}, required: [] } };
}

class OkAgent extends BasicAgent {
  constructor(name = 'Ok') {
    super(name, meta(name, 'returns a success envelope'));
  }
  async perform(): Promise<string> {
    return JSON.stringify({ status: 'success', ok: true, data_slush: { from: this.name } });
  }
}

/** Reports failure the structured way: resolves, never throws. */
class SoftFailAgent extends BasicAgent {
  constructor(name = 'SoftFail') {
    super(name, meta(name, 'returns a resolved error envelope'));
  }
  async perform(): Promise<string> {
    return JSON.stringify({
      status: 'error',
      message: 'exit code 1',
      data_slush: { failed_by: this.name },
    });
  }
}

class ThrowAgent extends BasicAgent {
  constructor(name = 'Throw') {
    super(name, meta(name, 'throws'));
  }
  async perform(): Promise<string> {
    throw new Error('hard failure');
  }
}

class SlowOkAgent extends BasicAgent {
  constructor(name = 'SlowOk', private readonly delayMs = 40) {
    super(name, meta(name, 'succeeds slowly'));
  }
  async perform(): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return JSON.stringify({ status: 'success', slow: true });
  }
}

/** Records that it ran, so "never reached" can be asserted directly. */
class TrackingAgent extends BasicAgent {
  constructor(name: string, private readonly log: string[]) {
    super(name, meta(name, 'records that it ran'));
  }
  async perform(): Promise<string> {
    this.log.push(this.name);
    return JSON.stringify({ status: 'success' });
  }
}

/** Reports failure with an uppercase status, which the classifier folds. */
class ShoutFailAgent extends BasicAgent {
  constructor(name = 'ShoutFail') {
    super(name, meta(name, 'returns an uppercase error envelope'));
  }
  async perform(): Promise<string> {
    return JSON.stringify({ status: 'ERROR', message: 'loud failure' });
  }
}

const asExecutor = (agents: Record<string, BasicAgent>) =>
  async (agentId: string, message: string): Promise<AgentResult> =>
    JSON.parse(await agents[agentId]!.execute({ query: message })) as AgentResult;

// ── Shared classifier vectors ──

interface Vector {
  name: string;
  kind: 'string' | 'value';
  value: unknown;
  isError: boolean;
}

interface MessageVector {
  name: string;
  kind: 'string' | 'value';
  value: unknown;
  /** null means "the runtime's fallback string" */
  message: string | null;
}

const contract = (
  JSON.parse(
    readFileSync(
      new URL('../../../../contracts/agent-result-status-vectors.json', import.meta.url),
      'utf8',
    ),
  ) as { vectors: Vector[]; messageVectors: MessageVector[] }
);
const vectors = contract.vectors;
const messageVectors = contract.messageVectors;

describe('agentResultIsError — cross-runtime vectors', () => {
  it('loads the shared contract vectors', () => {
    expect(vectors.length).toBeGreaterThan(20);
  });

  for (const vector of vectors) {
    it(`classifies "${vector.name}" as ${vector.isError ? 'error' : 'not error'}`, () => {
      expect(agentResultIsError(vector.value)).toBe(vector.isError);
    });
  }
});

describe('agentResultErrorMessage — cross-runtime vectors', () => {
  const FALLBACK = 'agent returned an error envelope';

  it('loads the shared message vectors', () => {
    expect(messageVectors.length).toBeGreaterThan(5);
  });

  for (const vector of messageVectors) {
    it(`extracts the reason for "${vector.name}"`, () => {
      expect(agentResultErrorMessage(vector.value)).toBe(vector.message ?? FALLBACK);
    });
  }
});

// ── AgentGraph ──

describe('AgentGraph — resolved error envelopes are failures', () => {
  it('marks a node that returned {status:error} as errored', async () => {
    const graph = new AgentGraph().addNode({ name: 'root', agent: new SoftFailAgent() });
    const result = await graph.run();

    expect(result.nodes.get('root')!.status).toBe('error');
    expect(result.status).toBe('partial');
  });

  it('skips dependents of a node that returned {status:error}', async () => {
    const graph = new AgentGraph()
      .addNode({ name: 'root', agent: new SoftFailAgent() })
      .addNode({ name: 'child', agent: new OkAgent(), dependsOn: ['root'] })
      .addNode({ name: 'grandchild', agent: new OkAgent('Ok2'), dependsOn: ['child'] });
    const result = await graph.run();

    expect(result.nodes.get('child')!.status).toBe('skipped');
    expect(result.nodes.get('grandchild')!.status).toBe('skipped');
    expect(result.status).toBe('partial');
  });

  it('stops the graph on a resolved error envelope when stopOnError is set', async () => {
    const graph = new AgentGraph({ stopOnError: true })
      .addNode({ name: 'root', agent: new SoftFailAgent() })
      .addNode({ name: 'child', agent: new OkAgent(), dependsOn: ['root'] });
    const result = await graph.run();

    expect(result.status).toBe('error');
    expect(result.error).toBe('exit code 1');
    expect(result.nodes.get('child')!.status).toBe('skipped');
  });

  it('preserves the error envelope on the failed node', async () => {
    const graph = new AgentGraph().addNode({ name: 'root', agent: new SoftFailAgent() });
    const result = await graph.run();

    expect(result.nodes.get('root')!.result.status).toBe('error');
    expect(result.nodes.get('root')!.result.message).toBe('exit code 1');
  });

  it('treats a thrown failure and a resolved error envelope identically', async () => {
    const soft = await new AgentGraph()
      .addNode({ name: 'a', agent: new SoftFailAgent() })
      .addNode({ name: 'b', agent: new OkAgent(), dependsOn: ['a'] })
      .run();
    const hard = await new AgentGraph()
      .addNode({ name: 'a', agent: new ThrowAgent() })
      .addNode({ name: 'b', agent: new OkAgent(), dependsOn: ['a'] })
      .run();

    expect(soft.status).toBe(hard.status);
    expect(soft.nodes.get('a')!.status).toBe(hard.nodes.get('a')!.status);
    expect(soft.nodes.get('b')!.status).toBe(hard.nodes.get('b')!.status);
  });

  it('still reports success when every node returns a success envelope', async () => {
    const graph = new AgentGraph()
      .addNode({ name: 'root', agent: new OkAgent() })
      .addNode({ name: 'child', agent: new OkAgent('Ok2'), dependsOn: ['root'] });
    const result = await graph.run();

    expect(result.status).toBe('success');
    expect(result.nodes.get('child')!.status).toBe('success');
  });
});

// ── BroadcastManager ──

describe('BroadcastManager — resolved error envelopes are failures', () => {
  it('all mode: an errored branch clears allSucceeded but keeps the other branch', async () => {
    const agents = { ok: new OkAgent(), bad: new SoftFailAgent() };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['ok', 'bad'], mode: 'all' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.allSucceeded).toBe(false);
    expect(result.anySucceeded).toBe(true);
  });

  it('all mode: the failing branch keeps its full error envelope (nothing discarded)', async () => {
    const agents = { ok: new OkAgent(), bad: new SoftFailAgent() };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['ok', 'bad'], mode: 'all' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));
    const bad = result.results.get('bad') as AgentResult;

    expect(bad).not.toBeInstanceOf(Error);
    expect(bad.status).toBe('error');
    expect(bad.message).toBe('exit code 1');
    expect(result.results.get('ok')).toBeDefined();
  });

  it('all mode: reports total failure when every branch returns an error envelope', async () => {
    const agents = { a: new SoftFailAgent('A'), b: new SoftFailAgent('B') };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['a', 'b'], mode: 'all' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.anySucceeded).toBe(false);
    expect(result.allSucceeded).toBe(false);
    expect(result.firstResponse).toBeUndefined();
  });

  it('all mode: firstResponse never points at an errored branch', async () => {
    const agents = { bad: new SoftFailAgent(), ok: new OkAgent() };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['bad', 'ok'], mode: 'all' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.firstResponse?.agentId).toBe('ok');
  });

  it('fallback mode: an error envelope falls through to the next agent', async () => {
    const agents = { bad: new SoftFailAgent(), ok: new OkAgent() };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['bad', 'ok'], mode: 'fallback' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(Array.from(result.results.keys())).toEqual(['bad', 'ok']);
    expect(result.firstResponse?.agentId).toBe('ok');
    expect(result.anySucceeded).toBe(true);
  });

  it('fallback mode: forwards data_slush from a soft-failed agent to the next', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['bad', 'ok'], mode: 'fallback' });

    await mgr.broadcast('g', 'ping', async (agentId, _message, upstreamSlush) => {
      seen.push(upstreamSlush);
      return agentId === 'bad'
        ? ({ status: 'error', message: 'nope', data_slush: { tried: 'bad' } } as AgentResult)
        : ({ status: 'success' } as AgentResult);
    });

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ tried: 'bad' });
  });

  it('fallback mode: reports failure when every agent returns an error envelope', async () => {
    const agents = { a: new SoftFailAgent('A'), b: new SoftFailAgent('B') };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['a', 'b'], mode: 'fallback' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.anySucceeded).toBe(false);
    expect(result.firstResponse).toBeUndefined();
  });

  it('race mode: an error envelope does not win the race', async () => {
    const agents = { bad: new SoftFailAgent(), slow: new SlowOkAgent() };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['bad', 'slow'], mode: 'race' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.firstResponse?.agentId).toBe('slow');
    expect(result.anySucceeded).toBe(true);
    expect(result.allSucceeded).toBe(false);
  });

  it('race mode: no winner when every branch returns an error envelope', async () => {
    const agents = { a: new SoftFailAgent('A'), b: new SoftFailAgent('B') };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['a', 'b'], mode: 'race' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.firstResponse).toBeUndefined();
    expect(result.anySucceeded).toBe(false);
  });

  it('leaves an all-success broadcast reporting success', async () => {
    const agents = { a: new OkAgent('A'), b: new OkAgent('B') };
    const mgr = new BroadcastManager();
    mgr.createGroup({ id: 'g', name: 'g', agentIds: ['a', 'b'], mode: 'all' });

    const result = await mgr.broadcast('g', 'ping', asExecutor(agents));

    expect(result.allSucceeded).toBe(true);
    expect(result.anySucceeded).toBe(true);
  });
});

// ── AgentChain ──

describe('AgentChain — resolved error envelopes are failures', () => {
  it('stopOnError halts the chain on a resolved error envelope', async () => {
    const ran: string[] = [];
    const chain = new AgentChain()
      .add('good', new OkAgent())
      .add('bad', new SoftFailAgent())
      .add('after', new TrackingAgent('After', ran));
    const result = await chain.run();

    expect(result.status).toBe('error');
    expect(result.failedStep).toBe('bad');
    expect(result.error).toBe('exit code 1');
    expect(result.steps.map(s => s.name)).toEqual(['good', 'bad']);
    expect(ran).toEqual([]);
  });

  it('preserves the failed step envelope as finalResult (nothing discarded)', async () => {
    const chain = new AgentChain().add('bad', new SoftFailAgent());
    const result = await chain.run();

    expect(result.finalResult?.status).toBe('error');
    expect(result.finalResult?.message).toBe('exit code 1');
    expect(result.steps[0].result.message).toBe('exit code 1');
  });

  it('treats a thrown failure and a resolved error envelope identically', async () => {
    const softRan: string[] = [];
    const hardRan: string[] = [];
    const soft = await new AgentChain()
      .add('bad', new SoftFailAgent())
      .add('after', new TrackingAgent('SoftAfter', softRan))
      .run();
    const hard = await new AgentChain()
      .add('bad', new ThrowAgent())
      .add('after', new TrackingAgent('HardAfter', hardRan))
      .run();

    expect(soft.status).toBe(hard.status);
    expect(soft.failedStep).toBe(hard.failedStep);
    expect(soft.steps.length).toBe(hard.steps.length);
    expect(softRan).toEqual(hardRan);
  });

  it('continues past a resolved error envelope when stopOnError is false', async () => {
    const ran: string[] = [];
    const chain = new AgentChain({ stopOnError: false })
      .add('bad', new SoftFailAgent())
      .add('after', new TrackingAgent('After', ran));
    const result = await chain.run();

    expect(result.status).toBe('partial');
    expect(ran).toEqual(['After']);
    expect(result.failedStep).toBeUndefined();
  });

  it('rolls up an uppercase error envelope as a failure', async () => {
    const stopping = await new AgentChain().add('bad', new ShoutFailAgent()).run();
    const continuing = await new AgentChain({ stopOnError: false })
      .add('bad', new ShoutFailAgent())
      .run();

    expect(stopping.status).toBe('error');
    expect(stopping.error).toBe('loud failure');
    expect(continuing.status).toBe('partial');
  });

  it('forwards the failed step data_slush to the rollup', async () => {
    const result = await new AgentChain().add('bad', new SoftFailAgent()).run();
    expect(result.finalSlush).toEqual({ failed_by: 'SoftFail' });
  });

  it('leaves an all-success chain reporting success', async () => {
    const chain = new AgentChain().add('a', new OkAgent('A')).add('b', new OkAgent('B'));
    const result = await chain.run();

    expect(result.status).toBe('success');
    expect(result.steps.length).toBe(2);
  });
});

// ── PipelineAgent ──

const runPipeline = async (
  agents: Record<string, BasicAgent>,
  steps: unknown[],
): Promise<Record<string, any>> => {
  const pipeline = new PipelineAgent((name) => agents[name]);
  return JSON.parse(
    await pipeline.execute({ action: 'run', spec: { name: 'p', input: {}, steps } }),
  );
};

describe('PipelineAgent — resolved error envelopes are failures', () => {
  it('marks an agent step that returned {status:error} as errored', async () => {
    const out = await runPipeline({ Bad: new SoftFailAgent('Bad') }, [
      { id: 's1', type: 'agent', agent: 'Bad' },
    ]);

    expect(out.pipeline.steps[0].status).toBe('error');
    expect(out.pipeline.status).toBe('failed');
    expect(out.status).toBe('error');
  });

  it("onError 'stop' halts the pipeline on a resolved error envelope", async () => {
    const ran: string[] = [];
    const out = await runPipeline(
      { Bad: new SoftFailAgent('Bad'), After: new TrackingAgent('After', ran) },
      [
        { id: 's1', type: 'agent', agent: 'Bad', onError: 'stop' },
        { id: 's2', type: 'agent', agent: 'After' },
      ],
    );

    expect(out.pipeline.steps.map((s: { stepId: string }) => s.stepId)).toEqual(['s1']);
    expect(ran).toEqual([]);
  });

  it("onError 'continue' keeps going but reports partial", async () => {
    const ran: string[] = [];
    const out = await runPipeline(
      { Bad: new SoftFailAgent('Bad'), After: new TrackingAgent('After', ran) },
      [
        { id: 's1', type: 'agent', agent: 'Bad', onError: 'continue' },
        { id: 's2', type: 'agent', agent: 'After' },
      ],
    );

    expect(out.pipeline.status).toBe('partial');
    expect(ran).toEqual(['After']);
  });

  it('treats a thrown failure and a resolved error envelope identically', async () => {
    const softRan: string[] = [];
    const hardRan: string[] = [];
    const soft = await runPipeline(
      { Bad: new SoftFailAgent('Bad'), After: new TrackingAgent('SoftAfter', softRan) },
      [
        { id: 's1', type: 'agent', agent: 'Bad', onError: 'stop' },
        { id: 's2', type: 'agent', agent: 'After' },
      ],
    );
    const hard = await runPipeline(
      { Bad: new ThrowAgent(), After: new TrackingAgent('HardAfter', hardRan) },
      [
        { id: 's1', type: 'agent', agent: 'Bad', onError: 'stop' },
        { id: 's2', type: 'agent', agent: 'After' },
      ],
    );

    expect(soft.pipeline.status).toBe(hard.pipeline.status);
    expect(soft.status).toBe(hard.status);
    expect(soft.pipeline.steps.length).toBe(hard.pipeline.steps.length);
    expect(softRan).toEqual(hardRan);
  });

  it('parallel step: an errored branch fails the step and keeps both payloads', async () => {
    const out = await runPipeline({ A: new OkAgent('A'), B: new SoftFailAgent('B') }, [
      { id: 'fan', type: 'parallel', agents: ['A', 'B'], onError: 'continue' },
    ]);

    const byAgent = Object.fromEntries(
      out.pipeline.steps.map((s: { agentName: string; status: string }) => [s.agentName, s.status]),
    );
    expect(byAgent).toEqual({ A: 'success', B: 'error' });
    expect(out.pipeline.status).toBe('partial');
  });

  it('conditional step: an errored body is reported as errored', async () => {
    const out = await runPipeline({ Ok: new OkAgent('Ok'), Bad: new SoftFailAgent('Bad') }, [
      { id: 's1', type: 'agent', agent: 'Ok' },
      {
        id: 's2',
        type: 'conditional',
        agent: 'Bad',
        condition: { field: 'from', equals: 'Ok' },
        onError: 'continue',
      },
    ]);

    expect(out.pipeline.steps[1].status).toBe('error');
    expect(out.pipeline.status).toBe('partial');
  });

  it('loop step: an errored iteration ends the loop', async () => {
    const out = await runPipeline({ Bad: new SoftFailAgent('Bad') }, [
      { id: 'loop', type: 'loop', agent: 'Bad', maxIterations: 4, onError: 'continue' },
    ]);

    expect(out.pipeline.steps.length).toBe(1);
    expect(out.pipeline.steps[0].status).toBe('error');
  });

  it('leaves an all-success pipeline reporting completed', async () => {
    const out = await runPipeline({ A: new OkAgent('A'), B: new OkAgent('B') }, [
      { id: 's1', type: 'agent', agent: 'A' },
      { id: 's2', type: 'agent', agent: 'B' },
    ]);

    expect(out.pipeline.status).toBe('completed');
    expect(out.status).toBe('success');
    expect(out.pipeline.steps.every((s: { status: string }) => s.status === 'success')).toBe(true);
  });
});

// ── SubAgentManager ──

describe('SubAgentManager — resolved error envelopes are failures', () => {
  const managerFor = (agents: Record<string, BasicAgent>) => {
    const mgr = new SubAgentManager();
    mgr.setExecutor(asExecutor(agents));
    return mgr;
  };

  it('records a call that returned {status:error} as errored', async () => {
    const mgr = managerFor({ bad: new SoftFailAgent() });
    await mgr.invoke('bad', 'go', mgr.createContext('root'));

    const call = mgr.getCallHistory().at(-1)!;
    expect(call.status).toBe('error');
    expect(call.error).toBe('exit code 1');
  });

  it('still returns the error envelope to the caller (nothing discarded)', async () => {
    const mgr = managerFor({ bad: new SoftFailAgent() });
    const result = await mgr.invoke('bad', 'go', mgr.createContext('root'));

    expect(result.status).toBe('error');
    expect(result.message).toBe('exit code 1');
    expect(mgr.getCallHistory().at(-1)!.result).toEqual(result);
  });

  it('a thrown failure and a resolved error envelope record the same call status', async () => {
    const soft = managerFor({ bad: new SoftFailAgent() });
    await soft.invoke('bad', 'go', soft.createContext('root'));

    const hard = new SubAgentManager();
    hard.setExecutor(async () => {
      throw new Error('hard failure');
    });
    await expect(hard.invoke('bad', 'go', hard.createContext('root'))).rejects.toThrow(
      'hard failure',
    );

    expect(soft.getCallHistory().at(-1)!.status).toBe(hard.getCallHistory().at(-1)!.status);
  });

  it('clears the call from activeCalls either way', async () => {
    const mgr = managerFor({ bad: new SoftFailAgent() });
    await mgr.invoke('bad', 'go', mgr.createContext('root'));

    expect(mgr.getActiveCalls()).toEqual([]);
    expect(mgr.getCallHistory().length).toBe(1);
  });

  it('still forwards the failed sub-agent data_slush downstream', async () => {
    const mgr = managerFor({ bad: new SoftFailAgent(), ok: new OkAgent() });
    const ctx = mgr.createContext('root');
    await mgr.invoke('bad', 'go', ctx);

    expect(ctx.lastSlush).toEqual({ failed_by: 'SoftFail' });
  });

  it('records a successful call as a success', async () => {
    const mgr = managerFor({ ok: new OkAgent() });
    await mgr.invoke('ok', 'go', mgr.createContext('root'));

    const call = mgr.getCallHistory().at(-1)!;
    expect(call.status).toBe('success');
    expect(call.error).toBeUndefined();
  });
});
