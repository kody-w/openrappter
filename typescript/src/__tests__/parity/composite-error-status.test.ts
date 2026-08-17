/**
 * Composite error-status parity tests.
 *
 * A sub-agent that *resolves* with a structured `{status: 'error'}` envelope
 * has failed just as surely as one that throws. These tests pin that contract
 * for the composition layers (AgentGraph, BroadcastManager) and pin the shared
 * classifier against the cross-runtime vector file in `contracts/`.
 *
 * Mirrors python/tests/test_composite_error_status.py
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AgentGraph } from '../../agents/graph.js';
import { BroadcastManager } from '../../agents/broadcast.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import { agentResultIsError } from '../../agents/result-status.js';
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

const vectors = (
  JSON.parse(
    readFileSync(
      new URL('../../../../contracts/agent-result-status-vectors.json', import.meta.url),
      'utf8',
    ),
  ) as { vectors: Vector[] }
).vectors;

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
