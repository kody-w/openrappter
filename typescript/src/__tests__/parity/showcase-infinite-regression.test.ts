/**
 * Showcase: Infinite Regression — SubAgentManager depth limits + loop detection
 *
 * Demonstrates the safety mechanisms that prevent recursive agent calls
 * from spiraling out of control: depth limits and loop detection.
 */

import { describe, it, expect } from 'vitest';
import { SubAgentManager, type SubAgentContext, type SubAgentCall } from '../../agents/subagent.js';

describe('Showcase: Infinite Regression', () => {
  describe('Depth limits', () => {
    it('should allow invocation within depth limit', () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      expect(manager.canInvoke('LearnNew', 0)).toBe(true);
      expect(manager.canInvoke('LearnNew', 4)).toBe(true);
    });

    it('should deny invocation at max depth', () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      expect(manager.canInvoke('LearnNew', 5)).toBe(false);
      expect(manager.canInvoke('LearnNew', 10)).toBe(false);
    });

    it('should throw error when invoking at max depth', async () => {
      const manager = new SubAgentManager({ maxDepth: 3 });
      manager.setExecutor(async () => ({ status: 'success' }));

      const context = manager.createContext('RecursiveCreator');
      // Simulate depth 3 by manually setting depth
      context.depth = 3;

      await expect(
        manager.invoke('LearnNew', 'create agent', context)
      ).rejects.toThrow(/Cannot invoke agent LearnNew/);
    });

    it('should increment depth on child context', async () => {
      const manager = new SubAgentManager({ maxDepth: 5 });

      let capturedDepth = -1;
      manager.setExecutor(async (_agentId, _message, context) => {
        capturedDepth = context?.depth ?? -1;
        return { status: 'success' };
      });

      const context = manager.createContext('Parent');
      expect(context.depth).toBe(0);

      await manager.invoke('ChildAgent', 'do work', context);
      // Child context should have depth = parent + 1
      expect(capturedDepth).toBe(1);
    });

    it('should track nested depth across multiple invocations', async () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      const depths: number[] = [];

      manager.setExecutor(async (_agentId, _message, context) => {
        depths.push(context?.depth ?? -1);
        return { status: 'success' };
      });

      const ctx = manager.createContext('Root');
      await manager.invoke('Agent1', 'step 1', ctx);

      // The context's history now has the call, create a deeper context
      const ctx2 = { ...ctx, depth: 2, callId: 'call_2', parentAgentId: 'Agent1', history: [...ctx.history] };
      await manager.invoke('Agent2', 'step 2', ctx2);

      expect(depths).toEqual([1, 3]);
    });
  });

  describe('Loop detection', () => {
    // Note: invoke() creates a child context with history appended but does NOT
    // mutate the parent context. To simulate sequential calls accumulating history
    // (as happens when an agent chains sub-calls), we push call records manually.
    function pushCall(context: SubAgentContext, targetAgentId: string) {
      const call: SubAgentCall = {
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        parentAgentId: context.parentAgentId,
        targetAgentId,
        message: 'test',
        depth: context.depth,
        startedAt: new Date().toISOString(),
        status: 'success',
      };
      context.history.push(call);
    }

    it('should detect repeated invocations of the same agent', async () => {
      const manager = new SubAgentManager({ maxDepth: 10 });
      manager.setExecutor(async () => ({ status: 'success' }));

      const context = manager.createContext('Orchestrator');

      // Accumulate 3 calls to same agent in history
      pushCall(context, 'LearnNew');
      pushCall(context, 'LearnNew');
      pushCall(context, 'LearnNew');

      // Fourth call should trigger loop detection (3+ in last 10)
      await expect(
        manager.invoke('LearnNew', 'call 4', context)
      ).rejects.toThrow(/Recursive loop detected/);
    });

    it('should allow different agents without triggering loop', async () => {
      const manager = new SubAgentManager({ maxDepth: 10 });
      manager.setExecutor(async () => ({ status: 'success' }));

      const context = manager.createContext('Orchestrator');

      pushCall(context, 'AgentA');
      pushCall(context, 'AgentB');
      pushCall(context, 'AgentC');
      // Each agent called once, no loop
      await expect(
        manager.invoke('AgentA', 'task 4', context)
      ).resolves.toBeDefined();
    });

    it('should detect loops within sliding window of 10', async () => {
      const manager = new SubAgentManager({ maxDepth: 20 });
      manager.setExecutor(async () => ({ status: 'success' }));

      const context = manager.createContext('Root');

      // Pad history with different agents
      pushCall(context, 'A');
      pushCall(context, 'B');
      pushCall(context, 'C');
      // Now accumulate 3 calls to Target
      pushCall(context, 'Target');
      pushCall(context, 'Target');
      pushCall(context, 'Target');

      // 3 calls to Target in last 10 → loop detected
      await expect(
        manager.invoke('Target', 'msg', context)
      ).rejects.toThrow(/loop detected/);
    });
  });

  describe('Blocked agents', () => {
    it('should deny invocation of blocked agents', () => {
      const manager = new SubAgentManager({
        maxDepth: 5,
        blockedAgents: ['DangerousAgent'],
      });

      expect(manager.canInvoke('DangerousAgent', 0)).toBe(false);
      expect(manager.canInvoke('SafeAgent', 0)).toBe(true);
    });
  });

  describe('Allowed agents', () => {
    it('should only allow specified agents when allowlist is set', () => {
      const manager = new SubAgentManager({
        maxDepth: 5,
        allowedAgents: ['LearnNew', 'Memory'],
      });

      expect(manager.canInvoke('LearnNew', 0)).toBe(true);
      expect(manager.canInvoke('Memory', 0)).toBe(true);
      expect(manager.canInvoke('Shell', 0)).toBe(false);
    });
  });

  describe('Call history', () => {
    it('should record call history', async () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      manager.setExecutor(async () => ({ status: 'success' }));

      const context = manager.createContext('Root');
      await manager.invoke('AgentA', 'task 1', context);
      await manager.invoke('AgentB', 'task 2', context);

      const history = manager.getCallHistory();
      expect(history.length).toBe(2);
      expect(history[0].targetAgentId).toBe('AgentA');
      expect(history[0].status).toBe('success');
      expect(history[1].targetAgentId).toBe('AgentB');
    });

    it('should record errors in history', async () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      manager.setExecutor(async () => { throw new Error('Agent crashed'); });

      const context = manager.createContext('Root');
      await expect(manager.invoke('CrashAgent', 'do work', context)).rejects.toThrow();

      const history = manager.getCallHistory();
      expect(history.length).toBe(1);
      expect(history[0].status).toBe('error');
      expect(history[0].error).toContain('Agent crashed');
    });
  });

  describe('Graceful failure', () => {
    it('should throw without executor configured', async () => {
      const manager = new SubAgentManager({ maxDepth: 5 });
      const context = manager.createContext('Root');
      await expect(
        manager.invoke('Agent', 'msg', context)
      ).rejects.toThrow('No agent executor configured');
    });
  });
});
