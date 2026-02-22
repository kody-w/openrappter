/**
 * Agent Integration Tests
 * Tests that import and exercise real agent classes:
 * - BasicAgent execute/slosh/perform pipeline
 * - getSignal dot-notation access
 * - BroadcastManager all/race/fallback modes
 * - AgentRouter rule matching and routing
 * - SubAgentManager depth limits and loop detection
 */

import { describe, it, expect } from 'vitest';

import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, AgentContext, AgentResult } from '../../agents/types.js';
import { BroadcastManager } from '../../agents/broadcast.js';
import { AgentRouter } from '../../agents/router.js';
import { SubAgentManager } from '../../agents/subagent.js';

// Concrete test agent
class TestAgent extends BasicAgent {
  lastKwargs: Record<string, unknown> | null = null;

  constructor(name = 'TestAgent') {
    const metadata: AgentMetadata = {
      name,
      description: 'Test agent for integration tests',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Input query' },
        },
        required: [],
      },
    };
    super(name, metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.lastKwargs = kwargs;
    const query = kwargs.query as string ?? '';
    return JSON.stringify({ status: 'success', echo: query });
  }
}

describe('Agent Integration', () => {
  // ── BasicAgent ────────────────────────────────────────────────────────

  describe('BasicAgent', () => {
    it('should execute: slosh then perform', async () => {
      const agent = new TestAgent();
      const result = await agent.execute({ query: 'hello world' });

      expect(agent.context).not.toBeNull();
      expect(agent.lastKwargs).toBeDefined();

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.echo).toBe('hello world');
    });

    it('should populate context with all signal categories', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test query' });

      const ctx = agent.context!;
      expect(ctx.timestamp).toBeDefined();
      expect(ctx.temporal).toBeDefined();
      expect(ctx.query_signals).toBeDefined();
      expect(ctx.memory_echoes).toBeDefined();
      expect(ctx.behavioral).toBeDefined();
      expect(ctx.priors).toBeDefined();
      expect(ctx.orientation).toBeDefined();
    });

    it('should set temporal context fields', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });

      const temporal = agent.context!.temporal;
      expect(temporal.time_of_day).toBeDefined();
      expect(temporal.day_of_week).toBeDefined();
      expect(typeof temporal.is_weekend).toBe('boolean');
      expect(temporal.quarter).toMatch(/^Q[1-4]$/);
      expect(temporal.fiscal).toBeDefined();
      expect(temporal.likely_activity).toBeDefined();
      expect(typeof temporal.is_urgent_period).toBe('boolean');
    });

    it('should detect query signals from input', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'show my latest Q3 items today' });

      const signals = agent.context!.query_signals;
      expect(signals.specificity).toBeDefined();
      expect(signals.word_count).toBeGreaterThan(0);
      expect(signals.hints).toContain('ownership:user');
      expect(signals.hints).toContain('temporal:today');
      expect(signals.hints).toContain('temporal:recency');
    });

    it('should detect high specificity for UUID-like patterns', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'find abcdef01-2345-6789' });

      expect(agent.context!.query_signals.specificity).toBe('high');
      expect(agent.context!.query_signals.has_id_pattern).toBe(true);
    });

    it('should detect question queries', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'what is the status?' });

      expect(agent.context!.query_signals.is_question).toBe(true);
    });

    it('should set low specificity for vague queries', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'help' });

      expect(agent.context!.query_signals.specificity).toBe('low');
    });

    it('should synthesize orientation', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });

      const orientation = agent.context!.orientation;
      expect(['low', 'medium', 'high']).toContain(orientation.confidence);
      expect(['direct', 'use_preference', 'contextual', 'clarify']).toContain(orientation.approach);
      expect(Array.isArray(orientation.hints)).toBe(true);
      expect(['concise', 'standard']).toContain(orientation.response_style);
    });

    it('should handle empty query gracefully', async () => {
      const agent = new TestAgent();
      await agent.execute({});

      expect(agent.context!.query_signals.word_count).toBe(0);
      expect(agent.context!.query_signals.specificity).toBe('low');
    });

    it('should pass enriched context in kwargs._context', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });

      expect(agent.lastKwargs!._context).toBeDefined();
      expect((agent.lastKwargs!._context as AgentContext).timestamp).toBeDefined();
    });
  });

  // ── getSignal ─────────────────────────────────────────────────────────

  describe('getSignal', () => {
    it('should access top-level context fields', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });

      const timestamp = agent.getSignal<string>('timestamp');
      expect(timestamp).toBeDefined();
    });

    it('should access nested fields with dot notation', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });

      const timeOfDay = agent.getSignal<string>('temporal.time_of_day');
      expect(timeOfDay).toBeDefined();

      const specificity = agent.getSignal<string>('query_signals.specificity');
      expect(specificity).toBeDefined();
    });

    it('should return default for missing keys', () => {
      const agent = new TestAgent();
      // No execute called, context is null
      expect(agent.getSignal('anything', 'fallback')).toBe('fallback');
    });

    it('should return default for non-existent nested keys', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });

      expect(agent.getSignal('temporal.nonexistent', 'default')).toBe('default');
      expect(agent.getSignal('no.such.path', 42)).toBe(42);
    });
  });

  // ── BroadcastManager ──────────────────────────────────────────────────

  describe('BroadcastManager', () => {
    function mockExecutor(results: Record<string, AgentResult | Error>) {
      return async (agentId: string, _message: string): Promise<AgentResult> => {
        const r = results[agentId];
        if (r instanceof Error) throw r;
        return r;
      };
    }

    it('should create and retrieve groups', () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'Group 1', agentIds: ['a', 'b'], mode: 'all' });

      expect(bm.getGroup('g1')).toBeDefined();
      expect(bm.getGroup('g1')!.agentIds).toEqual(['a', 'b']);
      expect(bm.getGroups()).toHaveLength(1);
    });

    it('should remove groups', () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'G1', agentIds: ['a'], mode: 'all' });
      expect(bm.removeGroup('g1')).toBe(true);
      expect(bm.removeGroup('g1')).toBe(false);
      expect(bm.getGroup('g1')).toBeUndefined();
    });

    it('should throw for unknown group on broadcast', async () => {
      const bm = new BroadcastManager();
      await expect(bm.broadcast('unknown', 'hi', async () => ({ status: 'success' }))).rejects.toThrow(
        'Broadcast group not found'
      );
    });

    it('should broadcast to all agents in "all" mode', async () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'G1', agentIds: ['a', 'b'], mode: 'all' });

      const executor = mockExecutor({
        a: { status: 'success', message: 'from a' },
        b: { status: 'success', message: 'from b' },
      });

      const result = await bm.broadcast('g1', 'hello', executor);
      expect(result.allSucceeded).toBe(true);
      expect(result.anySucceeded).toBe(true);
      expect(result.results.size).toBe(2);
    });

    it('should report partial failure in "all" mode', async () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'G1', agentIds: ['a', 'b'], mode: 'all' });

      const executor = mockExecutor({
        a: { status: 'success' },
        b: new Error('agent b failed'),
      });

      const result = await bm.broadcast('g1', 'hello', executor);
      expect(result.allSucceeded).toBe(false);
      expect(result.anySucceeded).toBe(true);
    });

    it('should return first response in "race" mode', async () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'G1', agentIds: ['a', 'b'], mode: 'race' });

      const executor = mockExecutor({
        a: { status: 'success', message: 'winner' },
        b: { status: 'success', message: 'also done' },
      });

      const result = await bm.broadcast('g1', 'hello', executor);
      expect(result.firstResponse).toBeDefined();
      expect(result.anySucceeded).toBe(true);
    });

    it('should try agents sequentially in "fallback" mode', async () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'G1', agentIds: ['a', 'b'], mode: 'fallback' });

      const executor = mockExecutor({
        a: new Error('a failed'),
        b: { status: 'success', message: 'b rescued' },
      });

      const result = await bm.broadcast('g1', 'hello', executor);
      expect(result.anySucceeded).toBe(true);
      expect(result.firstResponse?.agentId).toBe('b');
    });

    it('should stop on first success in "fallback" mode', async () => {
      const bm = new BroadcastManager();
      bm.createGroup({ id: 'g1', name: 'G1', agentIds: ['a', 'b', 'c'], mode: 'fallback' });

      const called: string[] = [];
      const executor = async (agentId: string): Promise<AgentResult> => {
        called.push(agentId);
        if (agentId === 'a') return { status: 'success' };
        return { status: 'success' };
      };

      await bm.broadcast('g1', 'hello', executor);
      expect(called).toEqual(['a']); // b and c never called
    });
  });

  // ── AgentRouter ───────────────────────────────────────────────────────

  describe('AgentRouter', () => {
    it('should route to default agent when no rules match', () => {
      const router = new AgentRouter();
      router.setDefaultAgent('fallback-agent');

      const result = router.route({
        senderId: 'user1',
        channelId: 'cli',
        conversationId: 'conv1',
        message: 'hello',
      });

      expect(result.agentId).toBe('fallback-agent');
    });

    it('should match sender-based rules', () => {
      const router = new AgentRouter();
      router.addRule({
        id: 'vip',
        priority: 10,
        conditions: [{ type: 'sender', value: 'vip-user' }],
        agentId: 'vip-agent',
      });

      const result = router.route({
        senderId: 'vip-user',
        channelId: 'cli',
        conversationId: 'conv1',
        message: 'hello',
      });

      expect(result.agentId).toBe('vip-agent');
    });

    it('should match channel-based rules', () => {
      const router = new AgentRouter();
      router.addRule({
        id: 'discord',
        priority: 5,
        conditions: [{ type: 'channel', value: 'discord' }],
        agentId: 'discord-agent',
      });

      const result = router.route({
        senderId: 'user1',
        channelId: 'discord',
        conversationId: 'conv1',
        message: 'hello',
      });

      expect(result.agentId).toBe('discord-agent');
    });

    it('should match pattern-based rules', () => {
      const router = new AgentRouter();
      router.addRule({
        id: 'code',
        priority: 5,
        conditions: [{ type: 'pattern', value: 'code|program|function' }],
        agentId: 'code-agent',
      });

      const result = router.route({
        senderId: 'user1',
        channelId: 'cli',
        conversationId: 'conv1',
        message: 'write a function for me',
      });

      expect(result.agentId).toBe('code-agent');
    });

    it('should respect priority ordering', () => {
      const router = new AgentRouter();
      router.addRule({
        id: 'low',
        priority: 1,
        conditions: [{ type: 'always' }],
        agentId: 'low-agent',
      });
      router.addRule({
        id: 'high',
        priority: 100,
        conditions: [{ type: 'always' }],
        agentId: 'high-agent',
      });

      const result = router.route({
        senderId: 'user1',
        channelId: 'cli',
        conversationId: 'conv1',
        message: 'hello',
      });

      expect(result.agentId).toBe('high-agent');
    });

    it('should remove rules', () => {
      const router = new AgentRouter();
      router.setDefaultAgent('default');
      router.addRule({
        id: 'r1',
        priority: 10,
        conditions: [{ type: 'always' }],
        agentId: 'agent-r1',
      });

      expect(router.removeRule('r1')).toBe(true);
      expect(router.removeRule('r1')).toBe(false);

      const result = router.route({
        senderId: 'u',
        channelId: 'c',
        conversationId: 'cv',
        message: 'hi',
      });
      expect(result.agentId).toBe('default');
    });

    it('should generate session keys by format', () => {
      const router = new AgentRouter();
      router.setDefaultAgent('default');

      const ctx = { senderId: 'u1', channelId: 'ch1', conversationId: 'conv1', message: '' };

      router.setSessionKeyFormat('conversation');
      expect(router.route(ctx).sessionKey).toBe('ch1:conv1');

      router.setSessionKeyFormat('sender');
      expect(router.route(ctx).sessionKey).toBe('ch1:u1');

      router.setSessionKeyFormat('channel');
      expect(router.route(ctx).sessionKey).toBe('ch1');

      router.setSessionKeyFormat('custom', (c) => `custom:${c.senderId}`);
      expect(router.route(ctx).sessionKey).toBe('custom:u1');
    });

    it('should load rules from config', () => {
      const router = new AgentRouter();
      router.loadRules([
        { sender: 'admin', agent: 'admin-agent', priority: 10 },
        { channel: 'slack', agent: 'slack-agent' },
        { pattern: 'deploy', agent: 'deploy-agent' },
      ]);

      expect(router.getRules()).toHaveLength(3);
    });
  });

  // ── SubAgentManager ───────────────────────────────────────────────────

  describe('SubAgentManager', () => {
    it('should enforce depth limits', () => {
      const sam = new SubAgentManager({ maxDepth: 3 });
      expect(sam.canInvoke('any', 0)).toBe(true);
      expect(sam.canInvoke('any', 2)).toBe(true);
      expect(sam.canInvoke('any', 3)).toBe(false);
      expect(sam.canInvoke('any', 10)).toBe(false);
    });

    it('should block agents on blocklist', () => {
      const sam = new SubAgentManager({ blockedAgents: ['dangerous'] });
      expect(sam.canInvoke('dangerous', 0)).toBe(false);
      expect(sam.canInvoke('safe', 0)).toBe(true);
    });

    it('should restrict to allowlist when specified', () => {
      const sam = new SubAgentManager({ allowedAgents: ['a', 'b'] });
      expect(sam.canInvoke('a', 0)).toBe(true);
      expect(sam.canInvoke('b', 0)).toBe(true);
      expect(sam.canInvoke('c', 0)).toBe(false);
    });

    it('should invoke executor and track calls', async () => {
      const sam = new SubAgentManager({ maxDepth: 5 });
      sam.setExecutor(async (agentId, message) => ({
        status: 'success',
        message: `${agentId}: ${message}`,
      }));

      const ctx = sam.createContext('parent');
      const result = await sam.invoke('child', 'do something', ctx);

      expect(result.status).toBe('success');
      expect(sam.getCallHistory()).toHaveLength(1);
      expect(sam.getActiveCalls()).toHaveLength(0);
    });

    it('should throw without executor', async () => {
      const sam = new SubAgentManager();
      const ctx = sam.createContext('parent');
      await expect(sam.invoke('child', 'msg', ctx)).rejects.toThrow('No agent executor configured');
    });

    it('should detect recursive loops', async () => {
      const sam = new SubAgentManager({ maxDepth: 10 });
      sam.setExecutor(async () => ({ status: 'success' }));

      // Build a history with 3 calls to same agent
      const ctx = sam.createContext('parent');
      ctx.history = [
        { id: '1', parentAgentId: 'p', targetAgentId: 'loopy', message: '', depth: 0, startedAt: '', status: 'success' },
        { id: '2', parentAgentId: 'p', targetAgentId: 'loopy', message: '', depth: 1, startedAt: '', status: 'success' },
        { id: '3', parentAgentId: 'p', targetAgentId: 'loopy', message: '', depth: 2, startedAt: '', status: 'success' },
      ];

      await expect(sam.invoke('loopy', 'again', ctx)).rejects.toThrow('Recursive loop detected');
    });

    it('should create tool definitions', () => {
      const sam = new SubAgentManager();
      const tool = sam.createTool('shell', 'Shell', 'Run shell commands');

      expect(tool.type).toBe('function');
      expect(tool.function.name).toBe('invoke_shell');
      expect(tool.function.parameters.required).toContain('message');
    });

    it('should handle tool calls', async () => {
      const sam = new SubAgentManager({ maxDepth: 5 });
      sam.setExecutor(async (agentId, message) => ({
        status: 'success',
        message: `${agentId}: ${message}`,
      }));

      const ctx = sam.createContext('parent');
      const result = await sam.handleToolCall('invoke_shell', { message: 'ls' }, ctx);
      expect(result.status).toBe('success');
    });

    it('should reject invalid tool names', async () => {
      const sam = new SubAgentManager();
      const ctx = sam.createContext('parent');
      await expect(sam.handleToolCall('bad_name', { message: 'x' }, ctx)).rejects.toThrow(
        'Invalid sub-agent tool name'
      );
    });
  });
});
