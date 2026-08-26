/**
 * A dropped agent must reach the assistant's tool set, not just the disk.
 *
 * The acceptance for hot-load is "usable in the very next message". That claim
 * has two halves: the registry has to see the agent (covered in
 * `hot-load.test.ts`), and the assistant has to offer it to the model as a
 * callable tool in the next turn. This covers the second half, with a stub
 * provider so the assertion is about wiring rather than about what an LLM
 * happens to say.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { Assistant } from '../Assistant.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { importAgentFile } from '../agent-import.js';
import type { LLMProvider, Message, ChatOptions, ProviderResponse } from '../../providers/types.js';
import {
  FlightRecorder,
  setFlightRecorder,
} from '../../flight-recorder/recorder.js';

let dir = '';
let registry: AgentRegistry;
let recorder: FlightRecorder;
let previousRecorder: FlightRecorder;

/** Records the tools it was offered, then calls the one it was told to. */
class ToolSpyProvider implements LLMProvider {
  readonly id = 'tool-spy';
  readonly name = 'tool-spy';
  offeredTools: string[] = [];
  private callOnce: { name: string; args: Record<string, unknown> } | null;

  constructor(call: { name: string; args: Record<string, unknown> } | null = null) {
    this.callOnce = call;
  }

  async isAvailable(): Promise<boolean> { return true; }

  async chat(_messages: Message[], options?: ChatOptions): Promise<ProviderResponse> {
    this.offeredTools = (options?.tools ?? []).map(t => t.function.name);
    if (this.callOnce) {
      const call = this.callOnce;
      this.callOnce = null; // one tool round, then answer
      return {
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }],
      };
    }
    return { content: 'done', tool_calls: null };
  }
}

function tideAgent(): Buffer {
  return Buffer.from(`from agents.basic_agent import BasicAgent
import json

class TideAgent(BasicAgent):
    def __init__(self):
        self.name = 'Tide'
        self.metadata = {
            "name": self.name,
            "description": "Reports the tide state for a named beach.",
            "parameters": {"type": "object",
                           "properties": {"beach": {"type": "string", "description": "Beach"}},
                           "required": ["beach"]}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success",
                           "result": "The tide at " + kwargs.get('beach', 'shore') + " is going out."})
`);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-tooling-'));
  registry = new AgentRegistry(path.join(dir, '__no_builtins__'), dir);
  recorder = new FlightRecorder({ enabled: true, inMemory: true });
  await recorder.initialize();
  previousRecorder = setFlightRecorder(recorder);
});

afterEach(async () => {
  setFlightRecorder(previousRecorder);
  await recorder.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a dropped agent is offered to the model on the next turn', () => {
  it('was not a tool before the drop, and is one after', async () => {
    const provider = new ToolSpyProvider();
    const assistant = new Assistant(await registry.getAllAgents(), { provider });

    await assistant.getResponse('hello');
    expect(provider.offeredTools).not.toContain('Tide');

    await importAgentFile('tide_agent.py', tideAgent(), registry, { dir });
    // This is the line that makes "hot" true — the same thing the daemon does
    // in its importer callback.
    assistant.setAgents(await registry.getAllAgents());

    await assistant.getResponse('what is the tide?');
    expect(provider.offeredTools).toContain('Tide');
  }, 40_000);

  it('hands the assistant a live agent, not a stale copy of the map', async () => {
    const provider = new ToolSpyProvider();
    const assistant = new Assistant(await registry.getAllAgents(), { provider });
    await importAgentFile('tide_agent.py', tideAgent(), registry, { dir });
    assistant.setAgents(await registry.getAllAgents());
    await assistant.getResponse('what is the tide?');

    // The tool the model is offered must be backed by an agent that actually
    // runs — offering a name with nothing behind it is the failure mode this
    // whole feature exists to avoid.
    const agents = await registry.getAllAgents();
    expect(provider.offeredTools).toContain('Tide');
    const out = await agents.get('Tide')!.execute({ beach: 'Tybee Island' });
    expect(String(out)).toContain('Tybee Island');
  }, 40_000);
});
