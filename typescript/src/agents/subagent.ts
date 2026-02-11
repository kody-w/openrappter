/**
 * Sub-agent System
 * Allows agents to invoke other agents as tools
 */

import type { AgentResult } from './types.js';

export interface SubAgentConfig {
  id: string;
  name: string;
  description: string;
  maxDepth?: number;
  timeout?: number;
  allowedAgents?: string[];
  blockedAgents?: string[];
}

export interface SubAgentCall {
  id: string;
  parentAgentId: string;
  targetAgentId: string;
  message: string;
  depth: number;
  startedAt: string;
  completedAt?: string;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: AgentResult;
  error?: string;
}

export interface SubAgentContext {
  callId: string;
  parentAgentId: string;
  depth: number;
  history: SubAgentCall[];
}

type AgentExecutor = (agentId: string, message: string, context?: SubAgentContext) => Promise<AgentResult>;

export class SubAgentManager {
  private config: SubAgentConfig;
  private activeCalls = new Map<string, SubAgentCall>();
  private callHistory: SubAgentCall[] = [];
  private executor?: AgentExecutor;

  constructor(config: Partial<SubAgentConfig> = {}) {
    this.config = {
      id: config.id ?? 'subagent-manager',
      name: config.name ?? 'Sub-agent Manager',
      description: config.description ?? 'Manages sub-agent invocations',
      maxDepth: config.maxDepth ?? 5,
      timeout: config.timeout ?? 30000,
      allowedAgents: config.allowedAgents,
      blockedAgents: config.blockedAgents ?? [],
    };
  }

  /**
   * Set the agent executor
   */
  setExecutor(executor: AgentExecutor): void {
    this.executor = executor;
  }

  /**
   * Check if an agent can be invoked
   */
  canInvoke(agentId: string, depth: number): boolean {
    // Check depth limit
    if (depth >= (this.config.maxDepth ?? 5)) {
      return false;
    }

    // Check blocked list
    if (this.config.blockedAgents?.includes(agentId)) {
      return false;
    }

    // Check allowed list (if specified)
    if (this.config.allowedAgents && !this.config.allowedAgents.includes(agentId)) {
      return false;
    }

    return true;
  }

  /**
   * Invoke a sub-agent
   */
  async invoke(
    targetAgentId: string,
    message: string,
    context: SubAgentContext
  ): Promise<AgentResult> {
    if (!this.executor) {
      throw new Error('No agent executor configured');
    }

    // Check if invocation is allowed
    if (!this.canInvoke(targetAgentId, context.depth)) {
      throw new Error(
        `Cannot invoke agent ${targetAgentId}: depth=${context.depth}, maxDepth=${this.config.maxDepth}`
      );
    }

    // Prevent recursive loops
    const recentCalls = context.history.slice(-10);
    const callPattern = recentCalls
      .filter((c) => c.targetAgentId === targetAgentId)
      .length;
    if (callPattern >= 3) {
      throw new Error(`Recursive loop detected: agent ${targetAgentId} called too many times`);
    }

    // Create call record
    const call: SubAgentCall = {
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      parentAgentId: context.parentAgentId,
      targetAgentId,
      message,
      depth: context.depth,
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    this.activeCalls.set(call.id, call);

    // Create child context
    const childContext: SubAgentContext = {
      callId: call.id,
      parentAgentId: targetAgentId,
      depth: context.depth + 1,
      history: [...context.history, call],
    };

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(
        targetAgentId,
        message,
        childContext,
        this.config.timeout
      );

      // Update call record
      call.status = 'success';
      call.completedAt = new Date().toISOString();
      call.result = result;

      this.activeCalls.delete(call.id);
      this.callHistory.push(call);

      return result;
    } catch (error) {
      // Update call record
      call.status = 'error';
      call.completedAt = new Date().toISOString();
      call.error = (error as Error).message;

      this.activeCalls.delete(call.id);
      this.callHistory.push(call);

      throw error;
    }
  }

  /**
   * Create a tool definition for sub-agent invocation
   */
  createTool(agentId: string, name: string, description: string) {
    return {
      type: 'function' as const,
      function: {
        name: `invoke_${agentId}`,
        description: `Invoke the ${name} agent: ${description}`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message/task to send to the agent',
            },
          },
          required: ['message'],
        },
      },
    };
  }

  /**
   * Handle a tool call for sub-agent invocation
   */
  async handleToolCall(
    toolName: string,
    args: { message: string },
    context: SubAgentContext
  ): Promise<AgentResult> {
    // Extract agent ID from tool name (invoke_agentId)
    const match = toolName.match(/^invoke_(.+)$/);
    if (!match) {
      throw new Error(`Invalid sub-agent tool name: ${toolName}`);
    }

    const agentId = match[1];
    return this.invoke(agentId, args.message, context);
  }

  /**
   * Get active calls
   */
  getActiveCalls(): SubAgentCall[] {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Get call history
   */
  getCallHistory(limit = 100): SubAgentCall[] {
    return this.callHistory.slice(-limit);
  }

  /**
   * Create initial context for a top-level call
   */
  createContext(parentAgentId: string): SubAgentContext {
    return {
      callId: `root_${Date.now()}`,
      parentAgentId,
      depth: 0,
      history: [],
    };
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout(
    agentId: string,
    message: string,
    context: SubAgentContext,
    timeout?: number
  ): Promise<AgentResult> {
    const promise = this.executor!(agentId, message, context);

    if (!timeout) {
      return promise;
    }

    return Promise.race([
      promise,
      new Promise<AgentResult>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Sub-agent ${agentId} timeout after ${timeout}ms`)),
          timeout
        )
      ),
    ]);
  }
}

export function createSubAgentManager(config?: Partial<SubAgentConfig>): SubAgentManager {
  return new SubAgentManager(config);
}
