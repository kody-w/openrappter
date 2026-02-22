/**
 * PipelineAgent Parity Tests
 *
 * Tests the declarative multi-agent pipeline runner that chains agents
 * sequentially with data_slush threading, parallel fan-out,
 * conditional branching, and loop steps.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineAgent } from '../../agents/PipelineAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

// --- Mock agents ---

class MockAgent extends BasicAgent {
  private slushToEmit?: Record<string, unknown>;

  constructor(name: string, slushToEmit?: Record<string, unknown>) {
    super(name, {
      name,
      description: `Mock ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
    this.slushToEmit = slushToEmit;
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    const result: Record<string, unknown> = { status: 'success', agent: this.name };
    if (this.slushToEmit) result.data_slush = this.slushToEmit;
    return JSON.stringify(result);
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

// --- Helpers ---

function makeResolver(agents: BasicAgent[]): (name: string) => BasicAgent | undefined {
  const map = new Map(agents.map(a => [a.name, a]));
  return (name: string) => map.get(name);
}

// --- Tests ---

describe('PipelineAgent', () => {
  let pipeline: PipelineAgent;

  beforeEach(() => {
    pipeline = new PipelineAgent();
  });

  // ── Constructor ─────────────────────────────────────────────────────

  describe('Constructor', () => {
    it('should have correct agent name', () => {
      expect(pipeline.name).toBe('Pipeline');
    });

    it('should have correct metadata name', () => {
      expect(pipeline.metadata.name).toBe('Pipeline');
    });

    it('should have a non-empty description', () => {
      expect(pipeline.metadata.description).toBeDefined();
      expect(pipeline.metadata.description.length).toBeGreaterThan(0);
    });

    it('should have parameters with action enum containing run, validate, status', () => {
      const actionProp = pipeline.metadata.parameters.properties.action;
      expect(actionProp).toBeDefined();
      expect(actionProp.enum).toEqual(['run', 'validate', 'status']);
    });

    it('should extend BasicAgent', () => {
      expect(pipeline).toBeInstanceOf(BasicAgent);
    });
  });

  // ── No action / unknown action ──────────────────────────────────────

  describe('No action / unknown action', () => {
    it('should return error when no action is specified', async () => {
      const result = await pipeline.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('No action specified');
    });

    it('should return error for unknown action', async () => {
      const result = await pipeline.perform({ action: 'fly' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('Unknown action');
    });
  });

  // ── validate action ─────────────────────────────────────────────────

  describe('validate action', () => {
    it('should return success for a valid spec', async () => {
      const agentA = new MockAgent('AgentA');
      pipeline.setAgentResolver(makeResolver([agentA]));

      const result = await pipeline.perform({
        action: 'validate',
        spec: {
          name: 'TestPipeline',
          steps: [{ id: 'step1', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.valid).toBe(true);
      expect(parsed.stepCount).toBe(1);
    });

    it('should return error when spec has no name', async () => {
      const result = await pipeline.perform({
        action: 'validate',
        spec: {
          steps: [{ id: 'step1', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.valid).toBe(false);
      expect(parsed.errors).toContain('Pipeline name is required');
    });

    it('should return error when agent step is missing the agent field', async () => {
      const result = await pipeline.perform({
        action: 'validate',
        spec: {
          name: 'TestPipeline',
          steps: [{ id: 'step1', type: 'agent' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.valid).toBe(false);
      expect(parsed.errors.some((e: string) => e.includes('agent name is required'))).toBe(true);
    });

    it('should return error when agent cannot be resolved by the resolver', async () => {
      pipeline.setAgentResolver(makeResolver([]));

      const result = await pipeline.perform({
        action: 'validate',
        spec: {
          name: 'TestPipeline',
          steps: [{ id: 'step1', type: 'agent', agent: 'Ghost' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.valid).toBe(false);
      expect(parsed.errors.some((e: string) => e.includes('agent not found'))).toBe(true);
    });
  });

  // ── run: single step ────────────────────────────────────────────────

  describe('run: single agent step', () => {
    it('should succeed and mark pipeline as completed', async () => {
      const agentA = new MockAgent('AgentA');
      pipeline.setAgentResolver(makeResolver([agentA]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'SingleStep',
          steps: [{ id: 'step1', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('run');
      expect(parsed.pipeline.status).toBe('completed');
      expect(parsed.pipeline.steps.length).toBe(1);
      expect(parsed.pipeline.steps[0].stepId).toBe('step1');
      expect(parsed.pipeline.steps[0].status).toBe('success');
    });
  });

  // ── run: slush threading ────────────────────────────────────────────

  describe('run: slush threading', () => {
    it('should thread data_slush from agent A into upstream_slush for agent B', async () => {
      let capturedContext: Record<string, unknown> | null = null;

      const agentA = new MockAgent('AgentA', { source: 'A', value: 42 });

      class InspectAgent extends BasicAgent {
        constructor() {
          super('InspectB', {
            name: 'InspectB',
            description: 'Captures upstream_slush from context',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(_kwargs: Record<string, unknown>): Promise<string> {
          // BasicAgent.execute() moves upstream_slush from kwargs into this.context
          capturedContext = this.context as Record<string, unknown>;
          return JSON.stringify({ status: 'success', agent: 'InspectB' });
        }
      }

      const agentB = new InspectAgent();
      pipeline.setAgentResolver(makeResolver([agentA, agentB]));

      await pipeline.perform({
        action: 'run',
        spec: {
          name: 'SlushChain',
          steps: [
            { id: 'step1', type: 'agent', agent: 'AgentA' },
            { id: 'step2', type: 'agent', agent: 'InspectB' },
          ],
          input: {},
        },
      });

      expect(capturedContext).toBeDefined();
      const upstream = capturedContext!.upstream_slush as Record<string, unknown>;
      expect(upstream).toBeDefined();
      expect(upstream.source).toBe('A');
    });
  });

  // ── run: parallel step ──────────────────────────────────────────────

  describe('run: parallel step', () => {
    it('should run both agents and include both results in steps', async () => {
      const agentA = new MockAgent('AgentA');
      const agentB = new MockAgent('AgentB');
      pipeline.setAgentResolver(makeResolver([agentA, agentB]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'ParallelPipeline',
          steps: [{ id: 'par1', type: 'parallel', agents: ['AgentA', 'AgentB'] }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.pipeline.steps.length).toBe(2);

      const agentNames = parsed.pipeline.steps.map((s: { agentName: string }) => s.agentName);
      expect(agentNames).toContain('AgentA');
      expect(agentNames).toContain('AgentB');

      for (const step of parsed.pipeline.steps) {
        expect(step.status).toBe('success');
      }
    });
  });

  // ── run: conditional skip ───────────────────────────────────────────

  describe('run: conditional skip', () => {
    it('should skip the step when condition is not met', async () => {
      const agentA = new MockAgent('AgentA');
      pipeline.setAgentResolver(makeResolver([agentA]));

      // No slush exists before this step, so condition.exists = true on 'missing_field' won't be met
      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'ConditionalSkip',
          steps: [
            {
              id: 'cond1',
              type: 'conditional',
              agent: 'AgentA',
              condition: { field: 'missing_field', exists: true },
            },
          ],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.pipeline.steps.length).toBe(1);
      expect(parsed.pipeline.steps[0].status).toBe('skipped');
    });
  });

  // ── run: conditional run ────────────────────────────────────────────

  describe('run: conditional run', () => {
    it('should execute agent when condition is met by prior slush', async () => {
      // AgentA emits slush with trigger: true; step2 conditional checks for it
      const agentA = new MockAgent('AgentA', { trigger: true });
      const agentB = new MockAgent('AgentB');
      pipeline.setAgentResolver(makeResolver([agentA, agentB]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'ConditionalRun',
          steps: [
            { id: 'step1', type: 'agent', agent: 'AgentA' },
            {
              id: 'step2',
              type: 'conditional',
              agent: 'AgentB',
              condition: { field: 'trigger', equals: true },
            },
          ],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      const step2 = parsed.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'step2');
      expect(step2).toBeDefined();
      expect(step2.status).toBe('success');
      expect(step2.agentName).toBe('AgentB');
    });
  });

  // ── run: loop with max iterations ───────────────────────────────────

  describe('run: loop with max iterations', () => {
    it('should produce exactly maxIterations step results', async () => {
      const agentA = new MockAgent('LoopAgent');
      pipeline.setAgentResolver(makeResolver([agentA]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'LoopPipeline',
          steps: [{ id: 'loop1', type: 'loop', agent: 'LoopAgent', maxIterations: 3 }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      // Loop with maxIterations: 3 should produce 3 step results all with stepId 'loop1'
      const loopSteps = parsed.pipeline.steps.filter(
        (s: { stepId: string }) => s.stepId === 'loop1',
      );
      expect(loopSteps.length).toBe(3);
      for (const s of loopSteps) {
        expect(s.status).toBe('success');
      }
    });
  });

  // ── run: onError stop ───────────────────────────────────────────────

  describe('run: onError stop', () => {
    it('should halt pipeline and mark as failed when failing step has onError=stop', async () => {
      const failAgent = new MockFailAgent('FailAgent');
      const afterAgent = new MockAgent('AfterAgent');
      pipeline.setAgentResolver(makeResolver([failAgent, afterAgent]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'StopOnError',
          steps: [
            { id: 'step1', type: 'agent', agent: 'FailAgent', onError: 'stop' },
            { id: 'step2', type: 'agent', agent: 'AfterAgent' },
          ],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.pipeline.status).toBe('failed');

      // step2 should not be present since pipeline halted
      const step2 = parsed.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'step2');
      expect(step2).toBeUndefined();
    });
  });

  // ── run: onError continue ───────────────────────────────────────────

  describe('run: onError continue', () => {
    it('should continue to next step and mark pipeline as partial', async () => {
      const failAgent = new MockFailAgent('FailAgent');
      const afterAgent = new MockAgent('AfterAgent');
      pipeline.setAgentResolver(makeResolver([failAgent, afterAgent]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'ContinueOnError',
          steps: [
            { id: 'step1', type: 'agent', agent: 'FailAgent', onError: 'continue' },
            { id: 'step2', type: 'agent', agent: 'AfterAgent' },
          ],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.pipeline.status).toBe('partial');

      const step2 = parsed.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'step2');
      expect(step2).toBeDefined();
      expect(step2.status).toBe('success');
    });
  });

  // ── run: onError skip ───────────────────────────────────────────────

  describe('run: onError skip', () => {
    it('should skip the failing step and continue running subsequent steps', async () => {
      const failAgent = new MockFailAgent('FailAgent');
      const afterAgent = new MockAgent('AfterAgent');
      pipeline.setAgentResolver(makeResolver([failAgent, afterAgent]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'SkipOnError',
          steps: [
            { id: 'step1', type: 'agent', agent: 'FailAgent', onError: 'skip' },
            { id: 'step2', type: 'agent', agent: 'AfterAgent' },
          ],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      // skip still allows continuation; status may be completed or partial
      const step2 = parsed.pipeline.steps.find((s: { stepId: string }) => s.stepId === 'step2');
      expect(step2).toBeDefined();
      expect(step2.status).toBe('success');
    });
  });

  // ── data_slush output ───────────────────────────────────────────────

  describe('data_slush output', () => {
    it('should include data_slush with source_agent set to Pipeline', async () => {
      const agentA = new MockAgent('AgentA');
      pipeline.setAgentResolver(makeResolver([agentA]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'SlushOutput',
          steps: [{ id: 'step1', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.data_slush).toBeDefined();
      expect(parsed.data_slush.source_agent).toBe('Pipeline');
    });

    it('should include signals with pipeline_name in data_slush', async () => {
      const agentA = new MockAgent('AgentA');
      pipeline.setAgentResolver(makeResolver([agentA]));

      const result = await pipeline.perform({
        action: 'run',
        spec: {
          name: 'MyNamedPipeline',
          steps: [{ id: 'step1', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });
      const parsed = JSON.parse(result);
      expect(parsed.data_slush.signals).toBeDefined();
      expect(parsed.data_slush.signals.pipeline_name).toBe('MyNamedPipeline');
    });
  });

  // ── status action ───────────────────────────────────────────────────

  describe('status action', () => {
    it('should return a message when no pipeline has been run yet', async () => {
      const result = await pipeline.perform({ action: 'status' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('status');
      expect(parsed.message).toBeDefined();
      expect(typeof parsed.message).toBe('string');
    });

    it('should return lastRun data after a pipeline has been executed', async () => {
      const agentA = new MockAgent('AgentA');
      pipeline.setAgentResolver(makeResolver([agentA]));

      await pipeline.perform({
        action: 'run',
        spec: {
          name: 'StatusCheck',
          steps: [{ id: 'step1', type: 'agent', agent: 'AgentA' }],
          input: {},
        },
      });

      const statusResult = await pipeline.perform({ action: 'status' });
      const parsed = JSON.parse(statusResult);
      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('status');
      expect(parsed.lastRun).toBeDefined();
      expect(parsed.lastRun.pipelineName).toBe('StatusCheck');
      expect(parsed.lastRun.status).toBe('completed');
    });
  });

  // ── Python parity ───────────────────────────────────────────────────

  describe('Python parity', () => {
    it('should follow the single-file agent pattern', () => {
      expect(pipeline).toBeInstanceOf(BasicAgent);
      expect(pipeline.name).toBe('Pipeline');
      expect(pipeline.metadata.name).toBe('Pipeline');
      expect(pipeline.metadata.description).toBeDefined();
      expect(pipeline.metadata.parameters).toBeDefined();
    });

    it('should have a metadata schema that matches the expected shape', () => {
      const params = pipeline.metadata.parameters;
      expect(params.type).toBe('object');
      expect(params.properties.action).toBeDefined();
      expect(params.properties.action.type).toBe('string');
      expect(params.properties.action.enum).toEqual(['run', 'validate', 'status']);
      expect(params.properties.spec).toBeDefined();
      expect(params.properties.spec.type).toBe('object');
    });
  });
});
