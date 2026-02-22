/**
 * Agent Compiler — PipelineAgent with conditional agent creation
 *
 * A pipeline parses input, conditionally creates a new agent if needed,
 * then executes it — all in a declarative pipeline spec.
 *
 * Run: npx tsx examples/agent-compiler.ts
 */

import { PipelineAgent } from '../src/agents/PipelineAgent.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class InputParserAgent extends BasicAgent {
  constructor() {
    super('InputParser', {
      name: 'InputParser', description: 'Parses input to determine if new agent needed',
      parameters: { type: 'object', properties: { input: { type: 'string', description: 'User input' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const input = (kwargs.input ?? '') as string;
    const needsNew = input.includes('create') || input.includes('new');
    console.log(`  [InputParser] Input: "${input}", needs_new_agent: ${needsNew}`);
    return JSON.stringify({
      status: 'success', needs_new_agent: needsNew, agent_description: needsNew ? `agent for: ${input}` : null,
      data_slush: { needs_new_agent: needsNew, agent_description: needsNew ? `agent for: ${input}` : null },
    });
  }
}

class AgentCreatorAgent extends BasicAgent {
  constructor() {
    super('AgentCreator', {
      name: 'AgentCreator', description: 'Creates a new agent',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown>;
    console.log(`  [AgentCreator] Creating: "${upstream?.agent_description}"`);
    return JSON.stringify({
      status: 'success', created: true, agent_name: 'DynamicProcessor',
      data_slush: { created: true, agent_name: 'DynamicProcessor' },
    });
  }
}

class DynamicExecutorAgent extends BasicAgent {
  constructor() {
    super('DynamicExecutor', {
      name: 'DynamicExecutor', description: 'Executes dynamic agent',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, unknown>;
    console.log(`  [DynamicExecutor] Running: ${upstream?.agent_name ?? 'existing agent'}`);
    return JSON.stringify({
      status: 'success', executed: true, agent_used: upstream?.agent_name ?? 'default',
      data_slush: { executed: true },
    });
  }
}

async function main() {
  console.log('=== Agent Compiler: Conditional Pipeline ===\n');

  const agents: Record<string, BasicAgent> = {
    InputParser: new InputParserAgent(),
    AgentCreator: new AgentCreatorAgent(),
    DynamicExecutor: new DynamicExecutorAgent(),
  };

  const pipeline = new PipelineAgent((name) => agents[name]);

  console.log('--- Run 1: Input that needs new agent ---');
  const result1 = JSON.parse(await pipeline.execute({
    action: 'run',
    spec: {
      name: 'agent-compiler',
      steps: [
        { id: 'parse', type: 'agent', agent: 'InputParser', input: { input: 'create a sentiment analyzer' } },
        { id: 'create', type: 'conditional', agent: 'AgentCreator', condition: { field: 'needs_new_agent', equals: true } },
        { id: 'execute', type: 'agent', agent: 'DynamicExecutor' },
      ],
      input: {},
    },
  }));
  console.log(`  Pipeline: ${result1.pipeline.status}, Steps: ${result1.pipeline.steps.map((s: Record<string, unknown>) => `${s.stepId}:${s.status}`).join(' → ')}\n`);

  console.log('--- Run 2: Input that uses existing agent ---');
  const result2 = JSON.parse(await pipeline.execute({
    action: 'run',
    spec: {
      name: 'agent-compiler',
      steps: [
        { id: 'parse', type: 'agent', agent: 'InputParser', input: { input: 'run the existing processor' } },
        { id: 'create', type: 'conditional', agent: 'AgentCreator', condition: { field: 'needs_new_agent', equals: true } },
        { id: 'execute', type: 'agent', agent: 'DynamicExecutor' },
      ],
      input: {},
    },
  }));
  console.log(`  Pipeline: ${result2.pipeline.status}, Steps: ${result2.pipeline.steps.map((s: Record<string, unknown>) => `${s.stepId}:${s.status}`).join(' → ')}`);
}

main().catch(console.error);
