/**
 * Showcase: Swarm Debugger — BroadcastManager (race) + ShellAgent
 *
 * Multiple debug agents race to diagnose an issue. The fastest winner's
 * data_slush is forwarded to a fix agent via upstream_slush.
 */

import { describe, it, expect } from 'vitest';
import { BroadcastManager } from '../../agents/broadcast.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../../agents/types.js';

// ── Inline debug agents ──

class LogAnalyzerAgent extends BasicAgent {
  private delayMs: number;

  constructor(delayMs = 10) {
    const metadata: AgentMetadata = {
      name: 'LogAnalyzer',
      description: 'Analyzes log files for error patterns',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Error description' } }, required: [] },
    };
    super('LogAnalyzer', metadata);
    this.delayMs = delayMs;
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return JSON.stringify({
      status: 'success',
      diagnosis: 'Found null pointer in auth middleware at line 42',
      confidence: 0.85,
      data_slush: {
        source_agent: 'LogAnalyzer',
        diagnosis: 'null_pointer',
        file: 'src/auth.ts',
        line: 42,
      },
    });
  }
}

class StackTraceParserAgent extends BasicAgent {
  private delayMs: number;

  constructor(delayMs = 50) {
    const metadata: AgentMetadata = {
      name: 'StackTraceParser',
      description: 'Parses stack traces for root cause',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Error description' } }, required: [] },
    };
    super('StackTraceParser', metadata);
    this.delayMs = delayMs;
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return JSON.stringify({
      status: 'success',
      diagnosis: 'TypeError in user validation pipeline',
      confidence: 0.78,
      data_slush: {
        source_agent: 'StackTraceParser',
        diagnosis: 'type_error',
        file: 'src/validation.ts',
        line: 15,
      },
    });
  }
}

class ErrorCategorizerAgent extends BasicAgent {
  private delayMs: number;

  constructor(delayMs = 200) {
    const metadata: AgentMetadata = {
      name: 'ErrorCategorizer',
      description: 'Categorizes errors by type and severity',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Error description' } }, required: [] },
    };
    super('ErrorCategorizer', metadata);
    this.delayMs = delayMs;
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return JSON.stringify({
      status: 'success',
      diagnosis: 'Runtime error, severity: critical',
      confidence: 0.90,
      data_slush: {
        source_agent: 'ErrorCategorizer',
        diagnosis: 'runtime_error',
        severity: 'critical',
      },
    });
  }
}

class FixSuggestionAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'FixSuggestion',
      description: 'Suggests fixes based on diagnosis',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Query' } }, required: [] },
    };
    super('FixSuggestion', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown> | undefined;
    return JSON.stringify({
      status: 'success',
      fix: upstream?.diagnosis ? `Fix for ${upstream.diagnosis}` : 'No diagnosis available',
      based_on: upstream?.source_agent ?? 'unknown',
      data_slush: { source_agent: 'FixSuggestion', applied: true },
    });
  }
}

describe('Showcase: Swarm Debugger', () => {
  const agents: Record<string, BasicAgent> = {};

  function makeAgents(delays: [number, number, number] = [10, 50, 200]) {
    agents['LogAnalyzer'] = new LogAnalyzerAgent(delays[0]);
    agents['StackTraceParser'] = new StackTraceParserAgent(delays[1]);
    agents['ErrorCategorizer'] = new ErrorCategorizerAgent(delays[2]);
    agents['FixSuggestion'] = new FixSuggestionAgent();
  }

  describe('Race mode', () => {
    it('should race 3 debug agents and pick the fastest', async () => {
      makeAgents([10, 50, 200]);

      const manager = new BroadcastManager();
      manager.createGroup({
        id: 'debug-swarm',
        name: 'Debug Swarm',
        agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'],
        mode: 'race',
      });

      const executor = async (agentId: string, message: string): Promise<AgentResult> => {
        const agent = agents[agentId];
        const resultStr = await agent.execute({ query: message });
        return JSON.parse(resultStr) as AgentResult;
      };

      const result = await manager.broadcast('debug-swarm', 'NullPointerException in auth', executor);

      expect(result.anySucceeded).toBe(true);
      expect(result.firstResponse).toBeDefined();
      // LogAnalyzer has 10ms delay, should win the race
      expect(result.firstResponse!.agentId).toBe('LogAnalyzer');
    });

    it('should still collect all results after race', async () => {
      makeAgents([10, 50, 200]);

      const manager = new BroadcastManager();
      manager.createGroup({
        id: 'debug-swarm',
        name: 'Debug Swarm',
        agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'],
        mode: 'race',
      });

      const executor = async (agentId: string, message: string): Promise<AgentResult> => {
        const agent = agents[agentId];
        const resultStr = await agent.execute({ query: message });
        return JSON.parse(resultStr) as AgentResult;
      };

      const result = await manager.broadcast('debug-swarm', 'Error in auth', executor);
      // Race waits for all to settle even though first wins
      expect(result.results.size).toBe(3);
      expect(result.allSucceeded).toBe(true);
    });
  });

  describe('Winner slush forwarding', () => {
    it('should forward race winner data_slush to fix agent', async () => {
      makeAgents([10, 50, 200]);

      const manager = new BroadcastManager();
      manager.createGroup({
        id: 'debug-swarm',
        name: 'Debug Swarm',
        agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'],
        mode: 'race',
      });

      const executor = async (agentId: string, message: string): Promise<AgentResult> => {
        const agent = agents[agentId];
        const resultStr = await agent.execute({ query: message });
        return JSON.parse(resultStr) as AgentResult;
      };

      const raceResult = await manager.broadcast('debug-swarm', 'Auth error', executor);
      const winnerResult = raceResult.firstResponse!.result;
      const winnerSlush = winnerResult.data_slush as Record<string, unknown>;

      // Forward to fix agent
      const fixAgent = agents['FixSuggestion'];
      const fixResultStr = await fixAgent.execute({
        query: 'suggest fix',
        upstream_slush: winnerSlush,
      });
      const fixResult = JSON.parse(fixResultStr);

      expect(fixResult.status).toBe('success');
      expect(fixResult.based_on).toBe('LogAnalyzer');
      expect(fixResult.fix).toContain('null_pointer');
    });
  });

  describe('All mode comparison', () => {
    it('should collect all diagnoses in all mode', async () => {
      makeAgents([10, 10, 10]);

      const manager = new BroadcastManager();
      manager.createGroup({
        id: 'debug-all',
        name: 'Debug All',
        agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'],
        mode: 'all',
      });

      const executor = async (agentId: string, message: string): Promise<AgentResult> => {
        const agent = agents[agentId];
        const resultStr = await agent.execute({ query: message });
        return JSON.parse(resultStr) as AgentResult;
      };

      const result = await manager.broadcast('debug-all', 'Diagnose error', executor);
      expect(result.allSucceeded).toBe(true);
      expect(result.results.size).toBe(3);
    });
  });

  describe('Error handling', () => {
    it('should throw for unknown broadcast group', async () => {
      const manager = new BroadcastManager();
      const executor = async () => ({ status: 'success' as const });
      await expect(manager.broadcast('nonexistent', 'test', executor)).rejects.toThrow('not found');
    });
  });
});
