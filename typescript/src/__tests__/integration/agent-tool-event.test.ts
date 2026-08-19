/**
 * `agent.tool` had a listener and no emitter.
 *
 * `typescript/ui/src/components/chat.ts:909` registers
 * `gateway.on('agent.tool', this.handleToolEvent)`, and the name appeared
 * nowhere else but the `GatewayEvents` catalogue -- so tool use never showed
 * up in chat, and never had (#195). `event-contract-coverage.test.ts` recorded
 * it in `LISTENED_BUT_NEVER_EMITTED`, which is shrink-only, so implementing it
 * is what allows that entry to come off.
 *
 * The payload deliberately carries the tool's **name and outcome only**. Tool
 * arguments can hold secrets: the Flight Recorder omits them by default and
 * scrubs opt-in IO, and this is broadcast to every subscribed client, which is
 * a wider audience than a local trace file. These tests assert that absence
 * rather than leaving it to review.
 */
import { describe, it, expect } from 'vitest';
import { Assistant, type AgentToolEvent } from '../../agents/Assistant.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { LLMProvider } from '../../providers/types.js';

/** An agent whose only job is to succeed or throw on demand. */
class ScriptedTool extends BasicAgent {
  constructor(private readonly behaviour: 'ok' | 'throws' | 'resolves-error') {
    super('secret_tool', {
      name: 'secret_tool',
      description: 'does a thing',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(): Promise<string> {
    if (this.behaviour === 'throws') throw new Error('tool exploded');
    if (this.behaviour === 'resolves-error') {
      // The failure mode #134 is about: the agent returns normally and reports
      // the failure *inside* the envelope. No exception is thrown.
      return JSON.stringify({ status: 'error', message: 'could not reach service' });
    }
    return 'tool result';
  }
}

/** One tool call, then a plain answer. */
function scriptedProvider(): LLMProvider {
  let round = 0;
  return {
    id: 'scripted',
    name: 'scripted',
    isAvailable: async () => true,
    chat: (async () => {
      round += 1;
      if (round === 1) {
        return {
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              // The arguments carry a secret on purpose: the point of the
              // payload design is that this never reaches a subscriber.
              function: { name: 'secret_tool', arguments: '{"password":"hunter2"}' },
            },
          ],
        };
      }
      return { content: 'done' };
    }) as LLMProvider['chat'],
  };
}

function assistantWithScriptedTool(behaviour: 'ok' | 'throws' | 'resolves-error'): Assistant {
  const tool = new ScriptedTool(behaviour);
  return new Assistant(new Map([[tool.name, tool]]), {
    provider: scriptedProvider(),
    model: 'test-model',
    loadWorkspaceContext: false,
    loadMemoryContext: false,
    useTwin: false,
  });
}

describe('agent.tool is emitted for each finished tool call', () => {
  it('reports a successful call with its name and outcome', async () => {
    const assistant = assistantWithScriptedTool('ok');
    const seen: AgentToolEvent[] = [];
    assistant.onToolEvent = (event) => seen.push(event);

    await assistant.getResponse('do the thing', undefined, undefined, 'session-a');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: 'session-a',
      toolCallId: 'call_1',
      name: 'secret_tool',
      status: 'success',
    });
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed call rather than staying silent', async () => {
    // The loop deliberately continues past a tool error so the model can
    // recover, which is exactly why the failure has to be reported: otherwise
    // a surface shows a tool starting and never resolving.
    const assistant = assistantWithScriptedTool('throws');
    const seen: AgentToolEvent[] = [];
    assistant.onToolEvent = (event) => seen.push(event);

    await assistant.getResponse('do the thing', undefined, undefined, 'session-b');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'secret_tool', status: 'error' });
  });

  it('reports a tool that resolves with an error envelope', async () => {
    // The branch a throwing tool never reaches. Agents report failure by
    // resolving with `{"status":"error"}` at least as often as by throwing,
    // and trusting the absence of an exception is how #134 recorded an
    // undelivered alert as sent.
    const assistant = assistantWithScriptedTool('resolves-error');
    const seen: AgentToolEvent[] = [];
    assistant.onToolEvent = (event) => seen.push(event);

    await assistant.getResponse('do the thing', undefined, undefined, 'session-f');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'secret_tool', status: 'error' });
  });

  it('never carries the tool arguments', async () => {
    const assistant = assistantWithScriptedTool('ok');
    const seen: AgentToolEvent[] = [];
    assistant.onToolEvent = (event) => seen.push(event);

    await assistant.getResponse('do the thing', undefined, undefined, 'session-c');

    // The scripted call's arguments contain `hunter2`. Serialising the whole
    // event is the check that matters -- a future field could reintroduce it
    // without any named property looking wrong.
    expect(JSON.stringify(seen)).not.toContain('hunter2');
    expect(JSON.stringify(seen)).not.toContain('password');
    expect(Object.keys(seen[0]).sort()).toEqual([
      'durationMs', 'name', 'sessionId', 'status', 'toolCallId',
    ]);
  });

  it('carries the model call id so two tools cannot collide', async () => {
    // The chat UI keys its list on `toolCallId ?? `tool_${Date.now()}``, so
    // without this two tools finishing in the same millisecond rendered as one
    // row and the second name was lost. Reproduced against the UI's own
    // keying logic before this field was added.
    const assistant = assistantWithScriptedTool('ok');
    const seen: AgentToolEvent[] = [];
    assistant.onToolEvent = (event) => seen.push(event);

    await assistant.getResponse('do the thing', undefined, undefined, 'session-g');

    expect(seen[0].toolCallId).toBe('call_1');
    expect(seen[0].toolCallId).toBeTruthy();
  });

  it('a throwing subscriber does not break the turn', async () => {
    // Agents report failure in their return value rather than by throwing
    // (#134); a broadcast is strictly less important than producing the answer.
    const assistant = assistantWithScriptedTool('ok');
    assistant.onToolEvent = () => {
      throw new Error('subscriber blew up');
    };

    const result = await assistant.getResponse('do the thing', undefined, undefined, 'session-d');
    expect(result.content).toBe('done');
  });

  it('costs nothing when nobody is listening', async () => {
    const assistant = assistantWithScriptedTool('ok');
    // Left unset, as the CLI leaves it.
    const result = await assistant.getResponse('do the thing', undefined, undefined, 'session-e');
    expect(result.content).toBe('done');
  });

  it('the gateway forwards it under the catalogued name', async () => {
    // Guards the wiring rather than the assistant: an emitter nobody forwards
    // is the same defect one layer along.
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const source = readFileSync(resolve(__dirname, '../../index.ts'), 'utf-8');
    expect(source).toMatch(/assistant\.onToolEvent\s*=/);
    expect(source).toMatch(/broadcastEvent\(GatewayEvents\.AGENT_TOOL/);
  });
});
