/**
 * Broadcast Groups
 * Send messages to multiple agents simultaneously
 */

import type { AgentResult } from './types.js';

export interface BroadcastGroup {
  id: string;
  name: string;
  agentIds: string[];
  mode: 'all' | 'race' | 'fallback';
  timeout?: number;
}

export interface BroadcastResult {
  groupId: string;
  results: Map<string, AgentResult | Error>;
  firstResponse?: { agentId: string; result: AgentResult };
  allSucceeded: boolean;
  anySucceeded: boolean;
}

type AgentExecutor = (agentId: string, message: string, upstreamSlush?: Record<string, unknown>) => Promise<AgentResult>;

export class BroadcastManager {
  private groups = new Map<string, BroadcastGroup>();

  /**
   * Create a broadcast group
   */
  createGroup(group: BroadcastGroup): void {
    this.groups.set(group.id, group);
  }

  /**
   * Remove a broadcast group
   */
  removeGroup(groupId: string): boolean {
    return this.groups.delete(groupId);
  }

  /**
   * Get a broadcast group
   */
  getGroup(groupId: string): BroadcastGroup | undefined {
    return this.groups.get(groupId);
  }

  /**
   * Get all groups
   */
  getGroups(): BroadcastGroup[] {
    return Array.from(this.groups.values());
  }

  /**
   * Broadcast message to a group
   */
  async broadcast(
    groupId: string,
    message: string,
    executor: AgentExecutor
  ): Promise<BroadcastResult> {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Broadcast group not found: ${groupId}`);
    }

    switch (group.mode) {
      case 'all':
        return this.broadcastAll(group, message, executor);
      case 'race':
        return this.broadcastRace(group, message, executor);
      case 'fallback':
        return this.broadcastFallback(group, message, executor);
      default:
        return this.broadcastAll(group, message, executor);
    }
  }

  /**
   * Broadcast to all agents and wait for all responses
   */
  private async broadcastAll(
    group: BroadcastGroup,
    message: string,
    executor: AgentExecutor
  ): Promise<BroadcastResult> {
    const results = new Map<string, AgentResult | Error>();
    let firstResponse: { agentId: string; result: AgentResult } | undefined;

    const promises = group.agentIds.map(async (agentId) => {
      try {
        const result = await this.executeWithTimeout(executor, agentId, message, group.timeout);
        results.set(agentId, result);
        if (!firstResponse) {
          firstResponse = { agentId, result };
        }
        return { agentId, result, success: true };
      } catch (error) {
        results.set(agentId, error as Error);
        return { agentId, error, success: false };
      }
    });

    await Promise.all(promises);

    const successes = Array.from(results.values()).filter(
      (r) => !(r instanceof Error)
    ).length;

    return {
      groupId: group.id,
      results,
      firstResponse,
      allSucceeded: successes === group.agentIds.length,
      anySucceeded: successes > 0,
    };
  }

  /**
   * Broadcast to all agents and return first response
   */
  private async broadcastRace(
    group: BroadcastGroup,
    message: string,
    executor: AgentExecutor
  ): Promise<BroadcastResult> {
    const results = new Map<string, AgentResult | Error>();
    let firstResponse: { agentId: string; result: AgentResult } | undefined;

    const promises = group.agentIds.map(async (agentId) => {
      try {
        const result = await this.executeWithTimeout(executor, agentId, message, group.timeout);
        results.set(agentId, result);
        return { agentId, result, success: true };
      } catch (error) {
        results.set(agentId, error as Error);
        return { agentId, error, success: false };
      }
    });

    // Wait for first successful result
    try {
      const first = await Promise.race(
        promises.map((p) =>
          p.then((r) => {
            if (r.success) return r;
            throw r.error;
          })
        )
      );

      if (first.success && 'result' in first) {
        firstResponse = { agentId: first.agentId, result: first.result as AgentResult };
      }
    } catch {
      // All failed
    }

    // Wait for all to complete (for result map)
    await Promise.allSettled(promises);

    const successes = Array.from(results.values()).filter(
      (r) => !(r instanceof Error)
    ).length;

    return {
      groupId: group.id,
      results,
      firstResponse,
      allSucceeded: successes === group.agentIds.length,
      anySucceeded: successes > 0,
    };
  }

  /**
   * Try agents in order until one succeeds.
   * In fallback mode, data_slush from each failed agent is passed to the next.
   */
  private async broadcastFallback(
    group: BroadcastGroup,
    message: string,
    executor: AgentExecutor
  ): Promise<BroadcastResult> {
    const results = new Map<string, AgentResult | Error>();
    let firstResponse: { agentId: string; result: AgentResult } | undefined;
    let lastSlush: Record<string, unknown> | undefined;

    for (const agentId of group.agentIds) {
      try {
        const result = await this.executeWithTimeout(executor, agentId, message, group.timeout, lastSlush);
        results.set(agentId, result);
        firstResponse = { agentId, result };
        break; // Success, stop trying
      } catch (error) {
        results.set(agentId, error as Error);
        // Extract data_slush from failed agent for downstream chaining
        const err = error as Error & { result?: AgentResult };
        if (err.result && typeof err.result === 'object' && 'data_slush' in err.result) {
          lastSlush = err.result.data_slush as Record<string, unknown>;
        }
        // Continue to next agent
      }
    }

    const successes = Array.from(results.values()).filter(
      (r) => !(r instanceof Error)
    ).length;

    return {
      groupId: group.id,
      results,
      firstResponse,
      allSucceeded: successes === group.agentIds.length,
      anySucceeded: successes > 0,
    };
  }

  /**
   * Execute with optional timeout
   */
  private async executeWithTimeout(
    executor: AgentExecutor,
    agentId: string,
    message: string,
    timeout?: number,
    upstreamSlush?: Record<string, unknown>
  ): Promise<AgentResult> {
    if (!timeout) {
      return executor(agentId, message, upstreamSlush);
    }

    return Promise.race([
      executor(agentId, message, upstreamSlush),
      new Promise<AgentResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent ${agentId} timeout after ${timeout}ms`)), timeout)
      ),
    ]);
  }
}

export function createBroadcastManager(): BroadcastManager {
  return new BroadcastManager();
}
