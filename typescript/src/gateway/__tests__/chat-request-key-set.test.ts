/**
 * The set of request keys `/chat` reads is as much a fingerprint as the reply.
 *
 * #116 measures the reply side: 6 keys from the brainstem, 11 from this
 * runtime. It also records a *request*-side divergence that is sharper than
 * extra output keys, because it changes the outcome rather than decorating it:
 *
 *     POST /chat {"message":"hi"}
 *       brainstem    400 {"error":"user_input is required"}
 *       openrappter  200 {"schema":"rapp-chat/1.0", …}
 *
 * `chat-envelope-key-set.test.ts` closed the reply set so a twelfth key cannot
 * appear unnoticed. Nothing closed the request set, so a fourth alias could be
 * added and widen the same fingerprint silently -- the exact failure #116
 * describes, where an instrument reported `wire_divergences: 0` on a corpus
 * that could not contain the divergence.
 *
 * These tests take **no side** in the standards conflict #116 raises (PARITY §3
 * says extra axes are free; `server.ts` states a stronger indistinguishability
 * goal; which governs is the owner's call). Every alias asserted here is one
 * the parser reads today. What is new is that the set is *closed*: a fifth key
 * cannot be consulted without this failing and somebody deciding to change it.
 *
 * The read set is observed rather than restated. A hand-written list would only
 * prove I read the file correctly on the day I wrote it; a Proxy records what
 * the parser actually touches, so a key added tomorrow shows up here even if
 * nobody updates the comment above.
 */
import { describe, it, expect } from 'vitest';
import { parseChatRequest } from '../chat-request.js';

/** Every property `parseChatRequest` touches on a body, in access order. */
function keysReadFrom(seed: Record<string, unknown>): string[] {
  const read = new Set<string>();
  const probe = new Proxy(seed, {
    get(target, key) {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key);
    },
    has(target, key) {
      if (typeof key === 'string') read.add(key);
      return Reflect.has(target, key);
    },
  });
  parseChatRequest(probe);
  // Symbol and prototype machinery are not request keys.
  return [...read].filter((k) => !k.startsWith('__') && k !== 'constructor').sort();
}

/**
 * The canonical brainstem spellings, plus the three aliases this runtime adds.
 * Changing this list is a deliberate act, which is the point.
 */
const READ_KEYS = [
  'conversation_history',
  'history',
  'message',
  'session_id',
  'sessionId',
  'user_input',
].sort();

describe('the /chat request key set is closed', () => {
  it('reads exactly the documented keys and their aliases', () => {
    // Seeded so every branch is reachable: `user_input` absent forces the
    // `message` lookup, and so on. With all keys present the parser would
    // short-circuit and never consult an alias.
    expect(keysReadFrom({})).toEqual(READ_KEYS);
  });

  it('consults no additional key when the canonical spellings are present', () => {
    const keys = keysReadFrom({
      user_input: 'hi',
      conversation_history: [],
      session_id: 's',
    });
    for (const key of keys) {
      expect(READ_KEYS).toContain(key);
    }
  });

  it('the aliases behave exactly as the canonical keys do', () => {
    // Documents the divergence #116 reports, rather than asserting it is right.
    // If the owner resolves the conflict by dropping aliases, this test is the
    // thing that says what was dropped.
    expect(parseChatRequest({ message: 'hi' })).toMatchObject({ ok: true });
    expect(parseChatRequest({ user_input: 'hi' })).toMatchObject({ ok: true });

    const viaAlias = parseChatRequest({ message: 'hi', history: [], sessionId: 's1' });
    const viaCanonical = parseChatRequest({
      user_input: 'hi',
      conversation_history: [],
      session_id: 's1',
    });
    expect(viaAlias).toEqual(viaCanonical);
  });

  it('the canonical key wins when both spellings are sent', () => {
    // The parser documents this: the alias is consulted only when the
    // brainstem's key is absent *entirely*, so a client sending the documented
    // field gets documented behaviour including its errors.
    const result = parseChatRequest({ user_input: 123, message: 'hi' });
    expect(result).toMatchObject({ ok: false, error: 'user_input must be a string' });
  });

  it('an undocumented alias is not accepted', () => {
    // The closure stated as behaviour, not just as a key list: a plausible
    // fourth spelling must not quietly work.
    for (const key of ['prompt', 'text', 'input', 'query', 'content']) {
      expect(parseChatRequest({ [key]: 'hi' })).toMatchObject({
        ok: false,
        error: 'user_input is required',
      });
    }
  });
});
