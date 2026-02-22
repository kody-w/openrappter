/**
 * AgentChain — Sequential agent pipeline with automatic data_slush forwarding.
 *
 * Chains agents together so the output of one feeds into the next.
 * Each step's data_slush is automatically passed as upstream_slush
 * to the next step — no manual wiring needed.
 *
 * Usage:
 *   const chain = new AgentChain()
 *     .add('shell', shellAgent, { action: 'bash', command: 'whoami' })
 *     .add('memory', memoryAgent, { action: 'remember', message: 'user ran chain' })
 *     .add('report', reportAgent);
 *
 *   const result = await chain.run();
 *   // result.steps has every step's output
 *   // data_slush flowed automatically between each step
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentResult } from './types.js';

export interface ChainStep {
  /** Unique name for this step */
  name: string;
  /** The agent to execute */
  agent: BasicAgent;
  /** Static kwargs to pass (merged with dynamic context) */
  kwargs?: Record<string, unknown>;
  /** Optional transform applied to the previous step's result before this step runs */
  transform?: (previousResult: AgentResult, slush: Record<string, unknown> | null) => Record<string, unknown>;
}

export interface ChainStepResult {
  name: string;
  agentName: string;
  result: AgentResult;
  dataSlush: Record<string, unknown> | null;
  durationMs: number;
}

export interface ChainResult {
  status: 'success' | 'partial' | 'error';
  steps: ChainStepResult[];
  totalDurationMs: number;
  /** The final step's result */
  finalResult: AgentResult | null;
  /** The final data_slush for downstream consumption */
  finalSlush: Record<string, unknown> | null;
  /** Name of the step that failed, if any */
  failedStep?: string;
  error?: string;
}

export interface ChainOptions {
  /** Stop the chain on first error (default: true) */
  stopOnError?: boolean;
  /** Timeout per step in ms (default: no timeout) */
  stepTimeout?: number;
}

export class AgentChain {
  private steps: ChainStep[] = [];
  private options: ChainOptions;

  constructor(options: ChainOptions = {}) {
    this.options = {
      stopOnError: options.stopOnError ?? true,
      stepTimeout: options.stepTimeout,
    };
  }

  /**
   * Add a step to the chain. Returns `this` for fluent chaining.
   */
  add(
    name: string,
    agent: BasicAgent,
    kwargs?: Record<string, unknown>,
    transform?: ChainStep['transform'],
  ): this {
    this.steps.push({ name, agent, kwargs, transform });
    return this;
  }

  /**
   * Execute the chain. Each step's data_slush flows to the next.
   */
  async run(initialKwargs?: Record<string, unknown>): Promise<ChainResult> {
    const stepResults: ChainStepResult[] = [];
    let currentSlush: Record<string, unknown> | null = null;
    let lastResult: AgentResult | null = null;
    const chainStart = Date.now();

    for (const step of this.steps) {
      const stepStart = Date.now();

      // Build kwargs: static step kwargs + upstream slush + optional transform
      let kwargs: Record<string, unknown> = { ...(step.kwargs ?? {}) };

      // Merge initial kwargs only for the first step
      if (stepResults.length === 0 && initialKwargs) {
        kwargs = { ...initialKwargs, ...kwargs };
      }

      // Apply transform from previous step
      if (step.transform && lastResult) {
        const transformed = step.transform(lastResult, currentSlush);
        kwargs = { ...kwargs, ...transformed };
      }

      // Inject upstream slush
      if (currentSlush) {
        kwargs.upstream_slush = currentSlush;
      }

      try {
        const resultStr = await this.executeWithTimeout(step.agent, kwargs);
        const durationMs = Date.now() - stepStart;

        let result: AgentResult;
        try {
          result = JSON.parse(resultStr) as AgentResult;
        } catch {
          result = { status: 'success', raw: resultStr } as unknown as AgentResult;
        }

        // Extract data_slush from result
        const dataSlush = step.agent.lastDataSlush ?? null;
        if (dataSlush) {
          currentSlush = dataSlush;
        } else {
          // Build slush from the agent's context if no explicit data_slush
          currentSlush = step.agent.slushOut({
            signals: { step_name: step.name, step_result_status: result.status },
          });
        }

        lastResult = result;

        stepResults.push({
          name: step.name,
          agentName: step.agent.name,
          result,
          dataSlush: currentSlush,
          durationMs,
        });
      } catch (e) {
        const durationMs = Date.now() - stepStart;
        const error = e as Error;
        const errorResult: AgentResult = {
          status: 'error',
          message: error.message,
        };

        stepResults.push({
          name: step.name,
          agentName: step.agent.name,
          result: errorResult,
          dataSlush: currentSlush,
          durationMs,
        });

        if (this.options.stopOnError) {
          return {
            status: 'error',
            steps: stepResults,
            totalDurationMs: Date.now() - chainStart,
            finalResult: errorResult,
            finalSlush: currentSlush,
            failedStep: step.name,
            error: error.message,
          };
        }
      }
    }

    const hasErrors = stepResults.some(s => s.result.status === 'error');

    return {
      status: hasErrors ? 'partial' : 'success',
      steps: stepResults,
      totalDurationMs: Date.now() - chainStart,
      finalResult: lastResult,
      finalSlush: currentSlush,
    };
  }

  /**
   * Get the step names in order.
   */
  getStepNames(): string[] {
    return this.steps.map(s => s.name);
  }

  /**
   * Get the number of steps.
   */
  get length(): number {
    return this.steps.length;
  }

  private async executeWithTimeout(
    agent: BasicAgent,
    kwargs: Record<string, unknown>,
  ): Promise<string> {
    const promise = agent.execute(kwargs);
    if (!this.options.stepTimeout) return promise;

    return Promise.race([
      promise,
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Step timeout after ${this.options.stepTimeout}ms`)),
          this.options.stepTimeout,
        )
      ),
    ]);
  }
}

export function createAgentChain(options?: ChainOptions): AgentChain {
  return new AgentChain(options);
}
