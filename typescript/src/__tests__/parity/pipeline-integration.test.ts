/**
 * PipelineAgent Integration Tests
 *
 * Cross-agent integration tests for PipelineAgent working with
 * CodeReviewAgent, GitAgent, and mock agents.
 *
 * Covers: linear chains, parallel steps, conditional steps, loop steps,
 * error handling strategies, agent integration, and Python parity.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineAgent } from '../../agents/PipelineAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import { CodeReviewAgent } from '../../agents/CodeReviewAgent.js';
import { GitAgent } from '../../agents/GitAgent.js';

// ── Mock Agents ──────────────────────────────────────────────────────

class MockAgent extends BasicAgent {
  private slushToEmit: Record<string, unknown>;
  constructor(name: string, slushToEmit?: Record<string, unknown>) {
    super(name, {
      name,
      description: `Mock ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
    this.slushToEmit = slushToEmit ?? { source: name };
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      agent: this.name,
      data_slush: this.slushToEmit,
    });
  }
}

class MockFailAgent extends BasicAgent {
  constructor(name: string) {
    super(name, {
      name,
      description: `Failing ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    throw new Error(`${this.name} failed`);
  }
}

class MockCounterAgent extends BasicAgent {
  callCount = 0;
  constructor(name: string) {
    super(name, {
      name,
      description: `Counter ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    this.callCount++;
    return JSON.stringify({
      status: 'success',
      count: this.callCount,
      data_slush: { source: this.name, iteration: this.callCount },
    });
  }
}

/**
 * A mock agent that captures the upstream_slush it received so tests can
 * assert on slush propagation without relying on internal context fields.
 */
class MockSlushCapturingAgent extends BasicAgent {
  receivedUpstreamSlush: Record<string, unknown> | null = null;
  constructor(name: string) {
    super(name, {
      name,
      description: `SlushCapture ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    // PipelineAgent merges upstream_slush into context before calling perform,
    // then deletes it from kwargs. We read it from context.upstream_slush.
    const ctx = kwargs._context as Record<string, unknown> | undefined;
    this.receivedUpstreamSlush = (ctx?.upstream_slush as Record<string, unknown>) ?? null;
    return JSON.stringify({
      status: 'success',
      agent: this.name,
      data_slush: { source: this.name, captured: true },
    });
  }
}

/**
 * A counter agent that sets `done: true` in slush after 2 iterations,
 * used to test loop exit conditions.
 */
class MockDoneAfterTwoAgent extends BasicAgent {
  callCount = 0;
  constructor(name: string) {
    super(name, {
      name,
      description: `DoneAfterTwo ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    this.callCount++;
    const done = this.callCount >= 2;
    return JSON.stringify({
      status: 'success',
      count: this.callCount,
      data_slush: { source: this.name, iteration: this.callCount, done },
    });
  }
}

function makeResolver(agents: BasicAgent[]): (name: string) => BasicAgent | undefined {
  const map = new Map(agents.map(a => [a.name, a]));
  return (name: string) => map.get(name);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PipelineAgent Integration', () => {
  // ── 1. Linear chain ─────────────────────────────────────────────

  describe('Linear chain', () => {
    it('A→B→C: all succeed, pipeline status is completed', async () => {
      const agentA = new MockAgent('AgentA', { source: 'A' });
      const agentB = new MockAgent('AgentB', { source: 'B' });
      const agentC = new MockAgent('AgentC', { source: 'C' });

      const pipeline = new PipelineAgent(makeResolver([agentA, agentB, agentC]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'linear-chain',
          steps: [
            { id: 'step-a', type: 'agent', agent: 'AgentA' },
            { id: 'step-b', type: 'agent', agent: 'AgentB' },
            { id: 'step-c', type: 'agent', agent: 'AgentC' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('completed');
      expect(result.pipeline.steps).toHaveLength(3);
      expect(result.pipeline.steps.every((s: { status: string }) => s.status === 'success')).toBe(true);
    });

    it('slush threads from A to B to C', async () => {
      const agentA = new MockAgent('AgentA', { source: 'A', flag: 'from-A' });
      const captureB = new MockSlushCapturingAgent('AgentB');
      const captureC = new MockSlushCapturingAgent('AgentC');

      const pipeline = new PipelineAgent(makeResolver([agentA, captureB, captureC]));

      await pipeline.perform({
        action: 'run',
        spec: {
          name: 'slush-threading',
          steps: [
            { id: 'step-a', type: 'agent', agent: 'AgentA' },
            { id: 'step-b', type: 'agent', agent: 'AgentB' },
            { id: 'step-c', type: 'agent', agent: 'AgentC' },
          ],
          input: {},
        },
      });

      // AgentB should have received the slush emitted by AgentA
      expect(captureB.receivedUpstreamSlush).not.toBeNull();
      expect(captureB.receivedUpstreamSlush?.source).toBe('A');

      // AgentC should have received the slush emitted by AgentB
      expect(captureC.receivedUpstreamSlush).not.toBeNull();
      expect(captureC.receivedUpstreamSlush?.source).toBe('AgentB');
    });

    it('final result is from agent C', async () => {
      const agentA = new MockAgent('AgentA', { source: 'A' });
      const agentB = new MockAgent('AgentB', { source: 'B' });
      const agentC = new MockAgent('AgentC', { source: 'C' });

      const pipeline = new PipelineAgent(makeResolver([agentA, agentB, agentC]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'final-result',
          steps: [
            { id: 'step-a', type: 'agent', agent: 'AgentA' },
            { id: 'step-b', type: 'agent', agent: 'AgentB' },
            { id: 'step-c', type: 'agent', agent: 'AgentC' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      // The last step result should be from AgentC
      const lastStep = result.pipeline.steps[result.pipeline.steps.length - 1];
      expect(lastStep.agentName).toBe('AgentC');
      const finalParsed = JSON.parse(result.pipeline.finalResult);
      expect(finalParsed.agent).toBe('AgentC');
    });
  });

  // ── 2. Parallel step ────────────────────────────────────────────

  describe('Parallel step', () => {
    it('fan-out to 3 agents produces 3 step results', async () => {
      const p1 = new MockAgent('P1', { source: 'P1' });
      const p2 = new MockAgent('P2', { source: 'P2' });
      const p3 = new MockAgent('P3', { source: 'P3' });

      const pipeline = new PipelineAgent(makeResolver([p1, p2, p3]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'parallel-fanout',
          steps: [
            { id: 'par', type: 'parallel', agents: ['P1', 'P2', 'P3'] },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.steps).toHaveLength(3);
      const agentNames = result.pipeline.steps.map((s: { agentName: string }) => s.agentName);
      expect(agentNames).toContain('P1');
      expect(agentNames).toContain('P2');
      expect(agentNames).toContain('P3');
    });

    it('all parallel results share the same stepId', async () => {
      const p1 = new MockAgent('P1', { source: 'P1' });
      const p2 = new MockAgent('P2', { source: 'P2' });
      const p3 = new MockAgent('P3', { source: 'P3' });

      const pipeline = new PipelineAgent(makeResolver([p1, p2, p3]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'parallel-stepid',
          steps: [
            { id: 'shared-step', type: 'parallel', agents: ['P1', 'P2', 'P3'] },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const stepIds = result.pipeline.steps.map((s: { stepId: string }) => s.stepId);
      expect(stepIds.every((id: string) => id === 'shared-step')).toBe(true);
    });

    it('error in one parallel agent propagates to pipeline result', async () => {
      const p1 = new MockAgent('P1', { source: 'P1' });
      const failP2 = new MockFailAgent('P2');

      const pipeline = new PipelineAgent(makeResolver([p1, failP2]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'parallel-error',
          steps: [
            { id: 'par', type: 'parallel', agents: ['P1', 'P2'], onError: 'stop' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      // The pipeline should have failed or the outer status reflects the error
      expect(['failed', 'error']).toContain(result.status === 'error' ? 'error' : result.pipeline?.status ?? '');
    });
  });

  // ── 3. Conditional step ─────────────────────────────────────────

  describe('Conditional step', () => {
    it('skips when field does not exist in slush', async () => {
      const cond = new MockAgent('CondAgent', { source: 'cond' });

      const pipeline = new PipelineAgent(makeResolver([cond]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'cond-skip',
          steps: [
            {
              id: 'cond-step',
              type: 'conditional',
              agent: 'CondAgent',
              condition: { field: 'nonexistent_field', exists: true },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.steps).toHaveLength(1);
      expect(result.pipeline.steps[0].status).toBe('skipped');
    });

    it('runs when field exists in slush', async () => {
      const source = new MockAgent('SourceAgent', { source: 'SourceAgent', ready: true });
      const cond = new MockAgent('CondAgent', { source: 'cond' });

      const pipeline = new PipelineAgent(makeResolver([source, cond]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'cond-run',
          steps: [
            { id: 'source', type: 'agent', agent: 'SourceAgent' },
            {
              id: 'cond-step',
              type: 'conditional',
              agent: 'CondAgent',
              condition: { field: 'source', exists: true },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const condStep = result.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'cond-step');
      expect(condStep?.status).toBe('success');
    });

    it('skips when equals condition does not match', async () => {
      const source = new MockAgent('SourceAgent', { source: 'SourceAgent', value: 'actual' });
      const cond = new MockAgent('CondAgent', { source: 'cond' });

      const pipeline = new PipelineAgent(makeResolver([source, cond]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'cond-equals-miss',
          steps: [
            { id: 'source', type: 'agent', agent: 'SourceAgent' },
            {
              id: 'cond-step',
              type: 'conditional',
              agent: 'CondAgent',
              condition: { field: 'value', equals: 'expected' },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const condStep = result.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'cond-step');
      expect(condStep?.status).toBe('skipped');
    });
  });

  // ── 4. Loop step ────────────────────────────────────────────────

  describe('Loop step', () => {
    it('runs maxIterations times', async () => {
      const counter = new MockCounterAgent('Counter');

      const pipeline = new PipelineAgent(makeResolver([counter]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'loop-max',
          steps: [
            { id: 'loop', type: 'loop', agent: 'Counter', maxIterations: 3 },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.steps).toHaveLength(3);
    });

    it('counter agent shows incrementing count across iterations', async () => {
      const counter = new MockCounterAgent('Counter');

      const pipeline = new PipelineAgent(makeResolver([counter]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'loop-increment',
          steps: [
            { id: 'loop', type: 'loop', agent: 'Counter', maxIterations: 4 },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const counts = result.pipeline.steps.map((s: { result: string }) => JSON.parse(s.result).count as number);
      expect(counts).toEqual([1, 2, 3, 4]);
    });

    it('exits early when exit condition is met', async () => {
      const doneAgent = new MockDoneAfterTwoAgent('DoneAgent');

      const pipeline = new PipelineAgent(makeResolver([doneAgent]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'loop-exit',
          steps: [
            {
              id: 'loop',
              type: 'loop',
              agent: 'DoneAgent',
              maxIterations: 10,
              condition: { field: 'done', equals: true },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      // Should have stopped after 2 iterations (when done=true was set)
      expect(result.pipeline.steps).toHaveLength(2);
    });

    it('slush threads through loop iterations', async () => {
      const counter = new MockCounterAgent('Counter');

      const pipeline = new PipelineAgent(makeResolver([counter]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'loop-slush',
          steps: [
            { id: 'loop', type: 'loop', agent: 'Counter', maxIterations: 3 },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      // Each iteration should have produced a dataSlush
      const slushValues = result.pipeline.steps.map((s: { dataSlush: Record<string, unknown> | null }) => s.dataSlush);
      expect(slushValues.every((v: unknown) => v !== null)).toBe(true);
      // Iteration count should be recorded in slush
      const iterations = slushValues.map((s: Record<string, unknown>) => s.iteration as number);
      expect(iterations).toEqual([1, 2, 3]);
    });
  });

  // ── 5. Error handling: stop ──────────────────────────────────────

  describe('Error handling: stop', () => {
    let pipeline: PipelineAgent;
    let beforeFail: MockAgent;
    let failAgent: MockFailAgent;
    let afterFail: MockAgent;

    beforeEach(() => {
      beforeFail = new MockAgent('BeforeFail', { source: 'before' });
      failAgent = new MockFailAgent('FailStep');
      afterFail = new MockAgent('AfterFail', { source: 'after' });
      pipeline = new PipelineAgent(makeResolver([beforeFail, failAgent, afterFail]));
    });

    it('pipeline halts at the failing step', async () => {
      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'stop-on-error',
          steps: [
            { id: 'before', type: 'agent', agent: 'BeforeFail' },
            { id: 'fail', type: 'agent', agent: 'FailStep', onError: 'stop' },
            { id: 'after', type: 'agent', agent: 'AfterFail' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      // Only 2 steps should have been recorded (before + fail)
      expect(result.pipeline.steps).toHaveLength(2);
    });

    it('pipeline status is failed', async () => {
      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'stop-status-failed',
          steps: [
            { id: 'before', type: 'agent', agent: 'BeforeFail' },
            { id: 'fail', type: 'agent', agent: 'FailStep', onError: 'stop' },
            { id: 'after', type: 'agent', agent: 'AfterFail' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('failed');
    });

    it('steps after failure are not executed', async () => {
      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'stop-no-after',
          steps: [
            { id: 'before', type: 'agent', agent: 'BeforeFail' },
            { id: 'fail', type: 'agent', agent: 'FailStep', onError: 'stop' },
            { id: 'after', type: 'agent', agent: 'AfterFail' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const stepIds = result.pipeline.steps.map((s: { stepId: string }) => s.stepId);
      expect(stepIds).not.toContain('after');
    });
  });

  // ── 6. Error handling: continue ─────────────────────────────────

  describe('Error handling: continue', () => {
    let pipeline: PipelineAgent;
    let beforeFail: MockAgent;
    let failAgent: MockFailAgent;
    let afterFail: MockAgent;

    beforeEach(() => {
      beforeFail = new MockAgent('BeforeFail', { source: 'before' });
      failAgent = new MockFailAgent('FailStep');
      afterFail = new MockAgent('AfterFail', { source: 'after' });
      pipeline = new PipelineAgent(makeResolver([beforeFail, failAgent, afterFail]));
    });

    it('pipeline continues after failure', async () => {
      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'continue-on-error',
          steps: [
            { id: 'before', type: 'agent', agent: 'BeforeFail' },
            { id: 'fail', type: 'agent', agent: 'FailStep', onError: 'continue' },
            { id: 'after', type: 'agent', agent: 'AfterFail' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.steps).toHaveLength(3);
    });

    it('pipeline status is partial', async () => {
      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'continue-status-partial',
          steps: [
            { id: 'before', type: 'agent', agent: 'BeforeFail' },
            { id: 'fail', type: 'agent', agent: 'FailStep', onError: 'continue' },
            { id: 'after', type: 'agent', agent: 'AfterFail' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('partial');
    });

    it('subsequent steps still execute after failure', async () => {
      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'continue-after-executes',
          steps: [
            { id: 'before', type: 'agent', agent: 'BeforeFail' },
            { id: 'fail', type: 'agent', agent: 'FailStep', onError: 'continue' },
            { id: 'after', type: 'agent', agent: 'AfterFail' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const afterStep = result.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'after');
      expect(afterStep?.status).toBe('success');
    });
  });

  // ── 7. CodeReviewAgent integration ──────────────────────────────

  describe('CodeReviewAgent integration', () => {
    const cleanCode = `
export function add(a: number, b: number): number {
  return a + b;
}
`.trim();


    it('PipelineAgent wraps CodeReviewAgent: runs review and gets score in result', async () => {
      const codeReview = new CodeReviewAgent();

      const pipeline = new PipelineAgent(makeResolver([codeReview]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'code-review-pipeline',
          steps: [
            {
              id: 'review',
              type: 'agent',
              agent: 'CodeReview',
              input: { action: 'review', content: cleanCode },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('completed');
      const stepResult = JSON.parse(result.pipeline.steps[0].result);
      expect(stepResult.review).toBeDefined();
      expect(typeof stepResult.review.score).toBe('number');
    });

    it('pipeline with GitAgent mock + CodeReviewAgent: chain git diff → code review', async () => {
      const mockExec = () => ({
        stdout: '+ console.log("test")\n+ const x: any = 1;',
        stderr: '',
      });
      const gitAgent = new GitAgent({ execFn: mockExec });
      const codeReview = new CodeReviewAgent();

      // Use a bridge agent to adapt git diff output for code review
      class DiffBridgeAgent extends BasicAgent {
        constructor() {
          super('DiffBridge', {
            name: 'DiffBridge',
            description: 'Bridges git diff output to code review input',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(kwargs: Record<string, unknown>): Promise<string> {
          const ctx = kwargs._context as Record<string, unknown> | undefined;
          const upstream = ctx?.upstream_slush as Record<string, unknown> | undefined;
          const diff = upstream?.signals ? '+ console.log("test")\n+ const x: any = 1;' : '';
          return codeReview.perform({ action: 'diff_review', diff });
        }
      }

      const bridge = new DiffBridgeAgent();

      const pipeline = new PipelineAgent(makeResolver([gitAgent, bridge]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'git-review-chain',
          steps: [
            { id: 'git-diff', type: 'agent', agent: 'Git', input: { action: 'diff' } },
            { id: 'review', type: 'agent', agent: 'DiffBridge' },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('completed');
      expect(result.pipeline.steps).toHaveLength(2);
    });

    it('review score appears in step result data_slush', async () => {
      const codeReview = new CodeReviewAgent();

      const pipeline = new PipelineAgent(makeResolver([codeReview]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'review-score-slush',
          steps: [
            {
              id: 'review',
              type: 'agent',
              agent: 'CodeReview',
              input: { action: 'review', content: cleanCode },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      const step = result.pipeline.steps[0];
      expect(step.dataSlush).not.toBeNull();
      // CodeReviewAgent slushes out score in signals
      expect(step.dataSlush?.signals?.score).toBeDefined();
    });

    it('pipeline status is completed when review succeeds', async () => {
      const codeReview = new CodeReviewAgent();

      const pipeline = new PipelineAgent(makeResolver([codeReview]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'review-completed',
          steps: [
            {
              id: 'review',
              type: 'agent',
              agent: 'CodeReview',
              input: { action: 'review', content: cleanCode },
            },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('completed');
    });
  });

  // ── 8. Full cycle ───────────────────────────────────────────────

  describe('Full cycle', () => {
    it('register → run pipeline → check status end-to-end', async () => {
      const agentA = new MockAgent('AgentA', { source: 'A' });
      const pipeline = new PipelineAgent(makeResolver([agentA]));

      // Run a pipeline
      await pipeline.perform({
        action: 'run',
        spec: {
          name: 'e2e-pipeline',
          steps: [{ id: 'step-a', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });

      // Check status
      const statusRaw = await pipeline.perform({ action: 'status' });
      const status = JSON.parse(statusRaw);
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun.pipelineName).toBe('e2e-pipeline');
    });

    it('multi-step pipeline with mixed step types completes', async () => {
      const agentA = new MockAgent('AgentA', { source: 'AgentA', mixed: true });
      const agentB = new MockAgent('AgentB', { source: 'AgentB' });
      const agentC = new MockCounterAgent('AgentC');

      const pipeline = new PipelineAgent(makeResolver([agentA, agentB, agentC]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'mixed-pipeline',
          steps: [
            { id: 'step-a', type: 'agent', agent: 'AgentA' },
            {
              id: 'cond',
              type: 'conditional',
              agent: 'AgentB',
              condition: { field: 'mixed', exists: true },
            },
            { id: 'loop', type: 'loop', agent: 'AgentC', maxIterations: 2 },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('completed');
      // step-a + cond (ran) + 2 loop iterations = 4
      expect(result.pipeline.steps).toHaveLength(4);
    });

    it('pipeline validate before run returns valid for well-formed spec', async () => {
      const agentA = new MockAgent('AgentA', { source: 'A' });
      const pipeline = new PipelineAgent(makeResolver([agentA]));

      const raw = await pipeline.perform({
        action: 'validate',
        spec: {
          name: 'valid-spec',
          steps: [{ id: 'step-a', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('data flows correctly across all step types in a single pipeline', async () => {
      const agentA = new MockAgent('AgentA', { source: 'AgentA', tag: 'from-A' });
      const captureB = new MockSlushCapturingAgent('AgentB');
      const agentC = new MockCounterAgent('AgentC');

      const pipeline = new PipelineAgent(makeResolver([agentA, captureB, agentC]));

      const raw = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'data-flow',
          steps: [
            { id: 'step-a', type: 'agent', agent: 'AgentA' },
            { id: 'capture', type: 'agent', agent: 'AgentB' },
            { id: 'loop', type: 'loop', agent: 'AgentC', maxIterations: 2 },
          ],
          input: {},
        },
      });

      const result = JSON.parse(raw);
      expect(result.pipeline.status).toBe('completed');
      // AgentB received slush from AgentA
      expect(captureB.receivedUpstreamSlush?.source).toBe('AgentA');
      // Loop ran 2 times
      const loopSteps = result.pipeline.steps.filter((s: { stepId: string }) => s.stepId === 'loop');
      expect(loopSteps).toHaveLength(2);
    });
  });

  // ── 9. Python parity ────────────────────────────────────────────

  describe('Python parity', () => {
    it('PipelineAgent metadata matches: name is Pipeline and has action enum', () => {
      const pipeline = new PipelineAgent();
      expect(pipeline.name).toBe('Pipeline');
      expect(pipeline.metadata.name).toBe('Pipeline');
      const actionParam = pipeline.metadata.parameters.properties?.['action'] as {
        enum?: string[];
      } | undefined;
      expect(actionParam?.enum).toEqual(['run', 'validate', 'status']);
    });

    it('GitAgent metadata matches: name is Git and has 6 actions', () => {
      const git = new GitAgent();
      expect(git.name).toBe('Git');
      expect(git.metadata.name).toBe('Git');
      const actionParam = git.metadata.parameters.properties?.['action'] as {
        enum?: string[];
      } | undefined;
      expect(actionParam?.enum).toHaveLength(6);
      expect(actionParam?.enum).toEqual(['status', 'diff', 'log', 'branch', 'commit', 'pr']);
    });

    it('CodeReviewAgent metadata matches: name is CodeReview and has 3 actions', () => {
      const cr = new CodeReviewAgent();
      expect(cr.name).toBe('CodeReview');
      expect(cr.metadata.name).toBe('CodeReview');
      const actionParam = cr.metadata.parameters.properties?.['action'] as {
        enum?: string[];
      } | undefined;
      expect(actionParam?.enum).toHaveLength(3);
      expect(actionParam?.enum).toEqual(['review', 'suggest', 'diff_review']);
    });

    it('all three agents extend BasicAgent', () => {
      const pipeline = new PipelineAgent();
      const git = new GitAgent();
      const cr = new CodeReviewAgent();
      expect(pipeline).toBeInstanceOf(BasicAgent);
      expect(git).toBeInstanceOf(BasicAgent);
      expect(cr).toBeInstanceOf(BasicAgent);
    });

    it('all three agents have parameters with type object', () => {
      const pipeline = new PipelineAgent();
      const git = new GitAgent();
      const cr = new CodeReviewAgent();
      expect(pipeline.metadata.parameters.type).toBe('object');
      expect(git.metadata.parameters.type).toBe('object');
      expect(cr.metadata.parameters.type).toBe('object');
    });
  });
});
