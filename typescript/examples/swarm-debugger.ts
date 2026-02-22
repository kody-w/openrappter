/**
 * Swarm Debugger — BroadcastManager (race) + Fix Agent
 *
 * Multiple debug agents race to diagnose an issue. The fastest
 * responder's diagnosis is forwarded to a fix suggestion agent.
 *
 * Run: npx tsx examples/swarm-debugger.ts
 */

import { BroadcastManager } from '../src/agents/broadcast.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../src/agents/types.js';

class LogAnalyzerAgent extends BasicAgent {
  constructor() {
    super('LogAnalyzer', {
      name: 'LogAnalyzer', description: 'Log analysis',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Error' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    await new Promise(r => setTimeout(r, 10));
    console.log('  [LogAnalyzer] Found: null pointer at auth.ts:42');
    return JSON.stringify({
      status: 'success', diagnosis: 'null pointer',
      data_slush: { source_agent: 'LogAnalyzer', diagnosis: 'null_pointer', file: 'auth.ts', line: 42 },
    });
  }
}

class StackTraceParserAgent extends BasicAgent {
  constructor() {
    super('StackTraceParser', {
      name: 'StackTraceParser', description: 'Stack trace parsing',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Error' } }, required: [] },
    });
  }
  async perform(): Promise<string> {
    await new Promise(r => setTimeout(r, 50));
    console.log('  [StackTraceParser] Found: TypeError in validation');
    return JSON.stringify({
      status: 'success', diagnosis: 'type error',
      data_slush: { source_agent: 'StackTraceParser', diagnosis: 'type_error' },
    });
  }
}

class ErrorCategorizerAgent extends BasicAgent {
  constructor() {
    super('ErrorCategorizer', {
      name: 'ErrorCategorizer', description: 'Error categorization',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Error' } }, required: [] },
    });
  }
  async perform(): Promise<string> {
    await new Promise(r => setTimeout(r, 200));
    console.log('  [ErrorCategorizer] Category: runtime, severity: critical');
    return JSON.stringify({
      status: 'success', diagnosis: 'runtime error',
      data_slush: { source_agent: 'ErrorCategorizer', diagnosis: 'runtime_error' },
    });
  }
}

class FixSuggestionAgent extends BasicAgent {
  constructor() {
    super('FixSuggestion', {
      name: 'FixSuggestion', description: 'Fix suggestions',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Query' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown>;
    const fix = `Add null check in ${upstream?.file ?? 'unknown'} at line ${upstream?.line ?? '?'}`;
    console.log(`  [FixSuggestion] ${fix}`);
    return JSON.stringify({ status: 'success', fix });
  }
}

async function main() {
  console.log('=== Swarm Debugger: Race Mode Diagnosis ===\n');

  const agents: Record<string, BasicAgent> = {
    LogAnalyzer: new LogAnalyzerAgent(),
    StackTraceParser: new StackTraceParserAgent(),
    ErrorCategorizer: new ErrorCategorizerAgent(),
  };

  const manager = new BroadcastManager();
  manager.createGroup({
    id: 'debug-swarm', name: 'Debug Swarm',
    agentIds: ['LogAnalyzer', 'StackTraceParser', 'ErrorCategorizer'],
    mode: 'race',
  });

  console.log('Racing 3 debug agents...');
  const executor = async (agentId: string, message: string): Promise<AgentResult> => {
    const resultStr = await agents[agentId].execute({ query: message });
    return JSON.parse(resultStr);
  };

  const result = await manager.broadcast('debug-swarm', 'NullPointerException in auth', executor);
  const winner = result.firstResponse!;
  console.log(`\nWinner: ${winner.agentId}`);

  const winnerSlush = winner.result.data_slush as Record<string, unknown>;
  console.log('\nForwarding diagnosis to FixSuggestion agent...');
  const fixAgent = new FixSuggestionAgent();
  await fixAgent.execute({ query: 'fix', upstream_slush: winnerSlush });
}

main().catch(console.error);
