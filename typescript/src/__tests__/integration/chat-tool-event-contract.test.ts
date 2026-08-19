/**
 * The `agent.tool` emitter must speak the vocabulary the chat UI reads.
 *
 * #336 added the emitter for an event the UI had listened for since before it
 * existed. The two did not agree. `chat.ts` renders the status literally:
 *
 *     tool.status === 'running' ? spinner : tool.status === 'success' ? '✓' : '✗'
 *
 * and the emitter sent `'ok'`, which matches neither arm — so every
 * **successful** tool call drew the failure mark. The event fired, the feature
 * looked implemented, and it reported the opposite of the truth.
 *
 * Nothing caught it because each side was tested against itself: the emitter's
 * tests asserted what the emitter sent, and the UI's tests asserted what the UI
 * did with a hand-written payload. That is the shape #335 found in the parity
 * harness and #287 found in the redaction lists — two copies of one contract,
 * each verified in isolation.
 *
 * This test reads both sides.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { AgentToolEvent } from '../../agents/Assistant.js';

const CHAT_UI = resolve(__dirname, '../../../ui/src/components/chat.ts');
const ASSISTANT = resolve(__dirname, '../../agents/Assistant.js').replace(/\.js$/, '.ts');

/** The status values `chat.ts` compares against, read from its source. */
function statusesTheUiRenders(): string[] {
  const source = readFileSync(CHAT_UI, 'utf-8');
  const matches = [...source.matchAll(/tool\.status === '([a-z]+)'/g)].map((m) => m[1]);
  return [...new Set(matches)].sort();
}

describe('agent.tool status vocabulary', () => {
  it('the UI renders a known set of statuses', () => {
    // Anti-vacuity: if the extractor stops matching, every assertion below
    // would pass against nothing.
    const statuses = statusesTheUiRenders();
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain('success');
  });

  it('the success value is the one the UI compares for success', () => {
    // This is the whole contract. The UI's ternary is
    //   running ? spinner : success ? '✓' : '✗'
    // so a failure status is safe -- it falls to '✗', which is right -- but a
    // *success* the UI does not recognise falls there too, and reports the
    // opposite of the truth. `'ok'` did exactly that.
    const source = readFileSync(ASSISTANT, 'utf-8');
    const declared = /status: ((?:'[a-z]+'(?:\s*\|\s*)?)+);/.exec(source);
    expect(declared, 'AgentToolEvent.status union should be readable').toBeTruthy();

    const emitted = [...declared![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(emitted.length).toBeGreaterThanOrEqual(2);

    const rendered = statusesTheUiRenders();
    const successes = emitted.filter((s) => s !== 'error');

    // Every non-failure value the emitter can send must be one the UI draws as
    // a success; anything else silently becomes a cross.
    for (const value of successes) {
      expect(
        rendered,
        `the emitter can send '${value}', which the UI would draw as a failure`,
      ).toContain(value);
    }
  });

  it('a success is not drawn with the failure mark', () => {
    // The consequence, stated as behaviour rather than as string equality.
    const source = readFileSync(CHAT_UI, 'utf-8');
    const success: AgentToolEvent['status'] = 'success';
    expect(source).toContain(`tool.status === '${success}'`);
  });

  it('the emitter sends the field the UI keys its list on', () => {
    // `chat.ts` does `const id = data.toolCallId ?? \`tool_\${Date.now()}\``.
    // Without `toolCallId`, two tools finishing in the same millisecond
    // resolve to the same key and the second *updates* the first's row rather
    // than adding one -- so a tool silently disappears from the transcript.
    const ui = readFileSync(CHAT_UI, 'utf-8');
    expect(ui).toMatch(/data\.toolCallId/);

    const assistant = readFileSync(ASSISTANT, 'utf-8');
    expect(assistant).toMatch(/toolCallId: string;/);
    expect(assistant).toMatch(/onToolEvent\(\{[^}]*toolCallId/);
  });
});
