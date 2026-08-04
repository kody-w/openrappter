/**
 * `/chat` request conformance with the grail brainstem.
 *
 * The point of this wire is that a peer cannot tell what is on the other end of
 * it — a brainstem, an openrappter, or a person typing. That property is only
 * as good as the worst case, and the worst cases were all divergent.
 *
 * Every expectation below was MEASURED against a live brainstem 0.6.16 on
 * :7071, not read off a spec:
 *
 *   $ curl -s -X POST :7071/chat -d '[]'
 *   400 {"error":"Request body must be a JSON object"}
 *   $ curl -s -X POST :7071/chat -d '{"user_input":123}'
 *   400 {"error":"user_input must be a string"}
 *   $ curl -s -X POST :7071/chat -d '{"user_input":"   "}'
 *   400 {"error":"user_input is required"}
 *   $ curl -s -X POST :7071/chat -d '{"user_input":"hi","conversation_history":"nope"}'
 *   400 {"error":"conversation_history must be an array"}
 *   $ curl -s -X POST :7071/chat -d '{"user_input":"hi","conversation_history":[{"role":"bogus","content":"x"}]}'
 *   400 {"error":"conversation_history[0].role is invalid"}
 *   $ curl -s -X POST :7071/chat -d '{"user_input":"hi","conversation_history":[{"role":"tool","content":123}]}'
 *   400 {"error":"conversation_history[0].content must be a string"}
 *
 * openrappter answered the last three with **200**, having silently discarded
 * the history it could not parse. That is the failure worth a test: not a wrong
 * status, but a caller being told its conversation was understood when it had
 * been thrown away.
 */

import { describe, expect, it } from 'vitest';
import { HISTORY_ROLES, parseChatRequest, validateHistory } from './chat-request.js';

/** The measured brainstem matrix. Each row is a real curl above. */
const BRAINSTEM_REJECTIONS: Array<[label: string, body: unknown, error: string]> = [
  ['an array is not an object', [], 'Request body must be a JSON object'],
  ['a string is not an object', 'hello', 'Request body must be a JSON object'],
  ['null is not an object', null, 'Request body must be a JSON object'],
  ['a number user_input', { user_input: 123 }, 'user_input must be a string'],
  ['a null user_input', { user_input: null }, 'user_input must be a string'],
  ['whitespace only', { user_input: '   ' }, 'user_input is required'],
  ['absent user_input', {}, 'user_input is required'],
  ['history is a string', { user_input: 'hi', conversation_history: 'nope' }, 'conversation_history must be an array'],
  ['history entry is not an object', { user_input: 'hi', conversation_history: ['x'] }, 'conversation_history[0] must be an object'],
  ['history role is unknown', { user_input: 'hi', conversation_history: [{ role: 'bogus', content: 'x' }] }, 'conversation_history[0].role is invalid'],
  ['history content is not a string', { user_input: 'hi', conversation_history: [{ role: 'tool', content: 123 }] }, 'conversation_history[0].content must be a string'],
  ['the index names the broken turn', {
    user_input: 'hi',
    conversation_history: [{ role: 'user', content: 'ok' }, { role: 'user', content: 7 }],
  }, 'conversation_history[1].content must be a string'],
];

describe('parity with the brainstem /chat request contract', () => {
  for (const [label, body, error] of BRAINSTEM_REJECTIONS) {
    it(`rejects ${label} with the brainstem's own sentence`, () => {
      const result = parseChatRequest(body);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toBe(error);
    });
  }

  // Order is load-bearing upstream: history is checked BEFORE the empty-input
  // check, so a request wrong in both ways reports the array fault.
  it('reports the history fault first when the input is also empty', () => {
    const result = parseChatRequest({ user_input: '', conversation_history: 'nope' });
    expect(result.ok === false && result.error).toBe('conversation_history must be an array');
  });

  it('accepts tool turns, which a replayed transcript carries', () => {
    expect(HISTORY_ROLES).toEqual(['user', 'assistant', 'tool']);
    const result = parseChatRequest({
      user_input: 'and then?',
      conversation_history: [
        { role: 'user', content: 'what is in the repo?' },
        { role: 'assistant', content: 'let me look' },
        { role: 'tool', content: '{"files":3}' },
      ],
    });
    expect(result.ok).toBe(true);
    // THE REGRESSION: the old filter kept only user/assistant, so the tool
    // result vanished and the model reasoned about output it could not see.
    expect(result.ok && result.value.conversationHistory).toHaveLength(3);
    expect(result.ok && result.value.conversationHistory[2].role).toBe('tool');
  });

  it('trims like the brainstem does', () => {
    const result = parseChatRequest({ user_input: '  hello  ' });
    expect(result.ok && result.value.userInput).toBe('hello');
  });

  it('takes session_id when given one and leaves it unset otherwise', () => {
    expect(parseChatRequest({ user_input: 'x', session_id: 's-1' }).ok
      && parseChatRequest({ user_input: 'x', session_id: 's-1' }) as never).toBeTruthy();
    const withId = parseChatRequest({ user_input: 'x', session_id: 's-1' });
    expect(withId.ok && withId.value.sessionId).toBe('s-1');
    const without = parseChatRequest({ user_input: 'x' });
    // Left undefined so the caller mints one — the brainstem generates a uuid4.
    expect(without.ok && without.value.sessionId).toBeUndefined();
  });

  it('treats an empty history as absent rather than an error', () => {
    const result = parseChatRequest({ user_input: 'x', conversation_history: [] });
    expect(result.ok && result.value.conversationHistory).toEqual([]);
    expect(validateHistory(undefined)).toEqual({ ok: true, value: [] });
    expect(validateHistory(null)).toEqual({ ok: true, value: [] });
  });
});

describe("openrappter's extra axes, which PARITY §3 allows", () => {
  it('accepts `message` only when the documented key is absent', () => {
    const alias = parseChatRequest({ message: 'via alias' });
    expect(alias.ok && alias.value.userInput).toBe('via alias');
  });

  // The alias must not weaken the documented field. A client sending the real
  // key gets the real error, even if it also happens to send `message`.
  it('still rejects a bad user_input when an alias is also present', () => {
    const result = parseChatRequest({ user_input: 123, message: 'ignored' });
    expect(result.ok === false && result.error).toBe('user_input must be a string');
  });

  it('accepts the camelCase session spelling', () => {
    const result = parseChatRequest({ user_input: 'x', sessionId: 's-2' });
    expect(result.ok && result.value.sessionId).toBe('s-2');
  });

  it('accepts `history` as an alias for conversation_history', () => {
    const result = parseChatRequest({ user_input: 'x', history: [{ role: 'user', content: 'hi' }] });
    expect(result.ok && result.value.conversationHistory).toHaveLength(1);
  });
});
