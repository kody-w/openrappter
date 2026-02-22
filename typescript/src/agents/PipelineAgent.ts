/**
 * PipelineAgent - Declarative multi-agent pipeline runner.
 *
 * Runs a sequence of agent steps with support for:
 * - Sequential agent execution with data_slush threading
 * - Parallel fan-out across multiple agents
 * - Conditional steps based on slush field values
 * - Loop steps with iteration limits
 * - Per-step error handling (stop/continue/skip)
 *
 * Actions: run, validate, status
 *
 * Mirrors Python agents/pipeline_agent.py
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

// ── Type Definitions ────────────────────────────────────────────────

export type StepType = 'agent' | 'parallel' | 'conditional' | 'loop';
export type OnError = 'stop' | 'continue' | 'skip';

export interface PipelineStep {
  id: string;
  type: StepType;
  agent?: string;           // for 'agent' type
  agents?: string[];         // for 'parallel' type
  condition?: { field: string; equals?: unknown; exists?: boolean };
  input?: Record<string, unknown>;
  maxIterations?: number;    // for 'loop', default 5
  onError?: OnError;         // default 'stop'
}

export interface PipelineSpec {
  name: string;
  steps: PipelineStep[];
  input: Record<string, unknown>;
}

export interface StepResult {
  stepId: string;
  agentName: string;
  status: 'success' | 'error' | 'skipped';
  result: string;
  dataSlush: Record<string, unknown> | null;
  latencyMs: number;
}

export interface PipelineResult {
  pipelineName: string;
  timestamp: string;
  steps: StepResult[];
  finalResult: string;
  totalLatencyMs: number;
  status: 'completed' | 'failed' | 'partial';
}

export type AgentResolver = (name: string) => BasicAgent | undefined;

// ── PipelineAgent ───────────────────────────────────────────────────

export class PipelineAgent extends BasicAgent {
  private agentResolver?: AgentResolver;
  private lastPipelineResult: PipelineResult | null = null;

  constructor(agentResolver?: AgentResolver) {
    const metadata: AgentMetadata = {
      name: 'Pipeline',
      description:
        'Declarative multi-agent pipeline runner. Chains agents sequentially with data_slush threading, parallel fan-out, conditional branching, and loop steps.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: ['run', 'validate', 'status'],
          },
          spec: {
            type: 'object',
            description: 'Pipeline specification with name, steps, and input.',
          },
        },
        required: [],
      },
    };
    super('Pipeline', metadata);
    this.agentResolver = agentResolver;
  }

  setAgentResolver(resolver: AgentResolver): void {
    this.agentResolver = resolver;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: run, validate, or status',
      });
    }

    try {
      switch (action) {
        case 'run':
          return await this.runPipeline(kwargs);
        case 'validate':
          return this.validatePipeline(kwargs);
        case 'status':
          return this.getStatus();
        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  // ── run ─────────────────────────────────────────────────────────

  private async runPipeline(kwargs: Record<string, unknown>): Promise<string> {
    const spec = kwargs.spec as PipelineSpec | undefined;

    if (!spec || !spec.name || !spec.steps) {
      return JSON.stringify({
        status: 'error',
        message: 'spec with name and steps is required for run',
      });
    }

    if (!this.agentResolver) {
      return JSON.stringify({
        status: 'error',
        message: 'No agent resolver configured',
      });
    }

    const pipelineStart = Date.now();
    const stepResults: StepResult[] = [];
    let lastSlush: Record<string, unknown> | null = null;
    let pipelineStatus: 'completed' | 'failed' | 'partial' = 'completed';
    let lastResult = '';

    for (const step of spec.steps) {
      const onError = step.onError ?? 'stop';

      try {
        const results = await this.executeStep(step, spec.input, lastSlush);

        for (const result of results) {
          stepResults.push(result);
          lastResult = result.result;

          if (result.dataSlush) {
            lastSlush = result.dataSlush;
          }

          if (result.status === 'error') {
            if (onError === 'stop') {
              pipelineStatus = 'failed';
              return this.buildResult(spec.name, pipelineStart, stepResults, lastResult, pipelineStatus, lastSlush);
            } else if (onError === 'continue') {
              pipelineStatus = 'partial';
            }
          }
        }
      } catch (error) {
        const errorResult: StepResult = {
          stepId: step.id,
          agentName: step.agent ?? step.agents?.join(',') ?? 'unknown',
          status: 'error',
          result: (error as Error).message,
          dataSlush: null,
          latencyMs: 0,
        };
        stepResults.push(errorResult);

        if (onError === 'stop') {
          pipelineStatus = 'failed';
          return this.buildResult(spec.name, pipelineStart, stepResults, (error as Error).message, pipelineStatus, lastSlush);
        } else if (onError === 'continue') {
          pipelineStatus = 'partial';
        }
        // skip: just continue
      }
    }

    return this.buildResult(spec.name, pipelineStart, stepResults, lastResult, pipelineStatus, lastSlush);
  }

  private async executeStep(
    step: PipelineStep,
    pipelineInput: Record<string, unknown>,
    lastSlush: Record<string, unknown> | null,
  ): Promise<StepResult[]> {
    switch (step.type) {
      case 'agent':
        return [await this.executeAgentStep(step, pipelineInput, lastSlush)];
      case 'parallel':
        return await this.executeParallelStep(step, pipelineInput, lastSlush);
      case 'conditional':
        return [await this.executeConditionalStep(step, pipelineInput, lastSlush)];
      case 'loop':
        return await this.executeLoopStep(step, pipelineInput, lastSlush);
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  private async executeAgentStep(
    step: PipelineStep,
    pipelineInput: Record<string, unknown>,
    lastSlush: Record<string, unknown> | null,
  ): Promise<StepResult> {
    if (!step.agent) {
      throw new Error(`Step ${step.id}: agent name is required for agent step`);
    }

    const agent = this.agentResolver!(step.agent);
    if (!agent) {
      throw new Error(`Step ${step.id}: agent not found: ${step.agent}`);
    }

    const input: Record<string, unknown> = {
      ...pipelineInput,
      ...(step.input ?? {}),
    };
    if (lastSlush) {
      input.upstream_slush = lastSlush;
    }

    const startTime = Date.now();
    const result = await agent.execute(input);
    const latencyMs = Date.now() - startTime;

    let dataSlush: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(result);
      if (parsed?.data_slush) {
        dataSlush = parsed.data_slush;
      }
    } catch {
      // non-JSON result
    }

    return {
      stepId: step.id,
      agentName: step.agent,
      status: 'success',
      result,
      dataSlush,
      latencyMs,
    };
  }

  private async executeParallelStep(
    step: PipelineStep,
    pipelineInput: Record<string, unknown>,
    lastSlush: Record<string, unknown> | null,
  ): Promise<StepResult[]> {
    if (!step.agents || step.agents.length === 0) {
      throw new Error(`Step ${step.id}: agents array is required for parallel step`);
    }

    const promises = step.agents.map(async (agentName) => {
      const agent = this.agentResolver!(agentName);
      if (!agent) {
        throw new Error(`Step ${step.id}: agent not found: ${agentName}`);
      }

      const input: Record<string, unknown> = {
        ...pipelineInput,
        ...(step.input ?? {}),
      };
      if (lastSlush) {
        input.upstream_slush = lastSlush;
      }

      const startTime = Date.now();
      const result = await agent.execute(input);
      const latencyMs = Date.now() - startTime;

      let dataSlush: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(result);
        if (parsed?.data_slush) {
          dataSlush = parsed.data_slush;
        }
      } catch {
        // non-JSON result
      }

      return {
        stepId: step.id,
        agentName,
        status: 'success' as const,
        result,
        dataSlush,
        latencyMs,
      };
    });

    return Promise.all(promises);
  }

  private async executeConditionalStep(
    step: PipelineStep,
    pipelineInput: Record<string, unknown>,
    lastSlush: Record<string, unknown> | null,
  ): Promise<StepResult> {
    if (!step.condition) {
      throw new Error(`Step ${step.id}: condition is required for conditional step`);
    }

    const conditionMet = this.evaluateCondition(step.condition, lastSlush);

    if (!conditionMet) {
      return {
        stepId: step.id,
        agentName: step.agent ?? 'conditional',
        status: 'skipped',
        result: 'Condition not met',
        dataSlush: null,
        latencyMs: 0,
      };
    }

    if (!step.agent) {
      throw new Error(`Step ${step.id}: agent name is required when condition is met`);
    }

    return this.executeAgentStep(step, pipelineInput, lastSlush);
  }

  private async executeLoopStep(
    step: PipelineStep,
    pipelineInput: Record<string, unknown>,
    lastSlush: Record<string, unknown> | null,
  ): Promise<StepResult[]> {
    if (!step.agent) {
      throw new Error(`Step ${step.id}: agent name is required for loop step`);
    }

    const maxIterations = step.maxIterations ?? 5;
    const results: StepResult[] = [];
    let currentSlush = lastSlush;

    for (let i = 0; i < maxIterations; i++) {
      const result = await this.executeAgentStep(step, pipelineInput, currentSlush);
      results.push(result);

      if (result.dataSlush) {
        currentSlush = result.dataSlush;
      }

      // Check exit condition if defined
      if (step.condition && this.evaluateCondition(step.condition, currentSlush)) {
        break;
      }
    }

    return results;
  }

  private evaluateCondition(
    condition: { field: string; equals?: unknown; exists?: boolean },
    slush: Record<string, unknown> | null,
  ): boolean {
    if (!slush) return false;

    const value = this.getFieldValue(slush, condition.field);

    if (condition.exists !== undefined) {
      return condition.exists ? value !== undefined : value === undefined;
    }

    if (condition.equals !== undefined) {
      return value === condition.equals;
    }

    return value !== undefined;
  }

  private getFieldValue(obj: Record<string, unknown>, field: string): unknown {
    const parts = field.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  // ── validate ────────────────────────────────────────────────────

  private validatePipeline(kwargs: Record<string, unknown>): string {
    const spec = kwargs.spec as PipelineSpec | undefined;

    if (!spec) {
      return JSON.stringify({
        status: 'error',
        message: 'spec is required for validate',
      });
    }

    const errors: string[] = [];

    if (!spec.name) {
      errors.push('Pipeline name is required');
    }

    if (!spec.steps || !Array.isArray(spec.steps) || spec.steps.length === 0) {
      errors.push('Pipeline must have at least one step');
    } else {
      for (const step of spec.steps) {
        if (!step.id) {
          errors.push('Each step must have an id');
        }
        if (!step.type) {
          errors.push(`Step ${step.id ?? '?'}: type is required`);
        }

        if (step.type === 'agent' && !step.agent) {
          errors.push(`Step ${step.id}: agent name is required for agent step`);
        }

        if (step.type === 'parallel' && (!step.agents || step.agents.length === 0)) {
          errors.push(`Step ${step.id}: agents array is required for parallel step`);
        }

        if (step.type === 'conditional' && !step.condition) {
          errors.push(`Step ${step.id}: condition is required for conditional step`);
        }

        if (step.type === 'loop' && !step.agent) {
          errors.push(`Step ${step.id}: agent name is required for loop step`);
        }

        // Resolve agent names if resolver available
        if (this.agentResolver) {
          const agentNames = step.agent ? [step.agent] : (step.agents ?? []);
          for (const name of agentNames) {
            if (!this.agentResolver(name)) {
              errors.push(`Step ${step.id}: agent not found: ${name}`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      return JSON.stringify({
        status: 'error',
        action: 'validate',
        valid: false,
        errors,
      });
    }

    return JSON.stringify({
      status: 'success',
      action: 'validate',
      valid: true,
      stepCount: spec.steps.length,
    });
  }

  // ── status ──────────────────────────────────────────────────────

  private getStatus(): string {
    if (!this.lastPipelineResult) {
      return JSON.stringify({
        status: 'success',
        action: 'status',
        message: 'No pipeline has been run yet',
      });
    }

    return JSON.stringify({
      status: 'success',
      action: 'status',
      lastRun: this.lastPipelineResult,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────

  private buildResult(
    pipelineName: string,
    startTime: number,
    stepResults: StepResult[],
    lastResult: string,
    pipelineStatus: 'completed' | 'failed' | 'partial',
    lastSlush: Record<string, unknown> | null,
  ): string {
    const pipelineResult: PipelineResult = {
      pipelineName,
      timestamp: new Date().toISOString(),
      steps: stepResults,
      finalResult: lastResult,
      totalLatencyMs: Date.now() - startTime,
      status: pipelineStatus,
    };

    this.lastPipelineResult = pipelineResult;

    const dataSlush = this.slushOut({
      signals: {
        pipeline_name: pipelineName,
        step_count: stepResults.length,
        pipeline_status: pipelineStatus,
      },
      ...(lastSlush ? { pipeline_slush: lastSlush } : {}),
    });

    return JSON.stringify({
      status: pipelineStatus === 'failed' ? 'error' : 'success',
      action: 'run',
      pipeline: pipelineResult,
      data_slush: dataSlush,
    });
  }
}
