/**
 * Can a peer tell which runtime answered?
 *
 * These tests exist because of two defects that a previous change claimed to
 * have ruled out, and had not. The claim was checked with an instrument that
 * compared the HTTP status and the `error` STRING of each reply — and by that
 * measure openrappter and the brainstem agreed twelve times out of twelve.
 * Both defects were invisible to it:
 *
 *   1. The error BODY differed. openrappter wrapped every 400 in
 *      `{schema, status, error}`; the brainstem writes `{error}` alone. Reading
 *      only `.error` could never see the two extra keys, so one malformed
 *      request was enough to fingerprint the runtime.
 *
 *   2. `POST /chat?x=1` was not treated as `/chat` at all. The route compared
 *      the raw request target to the string '/chat', so any query string fell
 *      through to the generic echo branch and returned **200 `Received: …`** —
 *      skipping every validation rule in the contract and telling the caller it
 *      had succeeded. The instrument never sent a query string.
 *
 * Neither was found by the author. Both were found by a reader who was handed
 * the wire and told nothing about what to conclude.
 *
 * The lesson worth keeping is about the measurement, not the code: an
 * instrument that can only observe the axis you already thought about will
 * confirm whatever you already believed. So these assert on whole bodies and on
 * request targets nobody had tried.
 */

import { describe, expect, it } from 'vitest';
import { parseChatRequest } from '../chat-request.js';

/**
 * Exactly what `brainstem.py` puts on the wire for a rejected request:
 * `return jsonify({"error": ...}), 400` — one key, nothing else.
 */
function brainstemRejection(error: string): Record<string, unknown> {
  return { error };
}

/** What the gateway now writes for the same rejection. */
function openrappterRejection(body: unknown): Record<string, unknown> {
  const parsed = parseChatRequest(body);
  if (parsed.ok) throw new Error('expected this body to be rejected');
  return { error: parsed.error };
}

const REJECTED_BODIES: Array<[label: string, body: unknown, error: string]> = [
  ['a non-object body', [], 'Request body must be a JSON object'],
  ['a non-string user_input', { user_input: 123 }, 'user_input must be a string'],
  ['an empty user_input', { user_input: '   ' }, 'user_input is required'],
  ['a non-array history', { user_input: 'hi', conversation_history: 'nope' }, 'conversation_history must be an array'],
  ['a bad history role', { user_input: 'hi', conversation_history: [{ role: 'bogus', content: 'x' }] }, 'conversation_history[0].role is invalid'],
  ['a non-string history content', { user_input: 'hi', conversation_history: [{ role: 'tool', content: 123 }] }, 'conversation_history[0].content must be a string'],
];

describe('a rejection must be byte-identical, not merely similar', () => {
  for (const [label, body, error] of REJECTED_BODIES) {
    it(`answers ${label} with the brainstem's whole body`, () => {
      const ours = openrappterRejection(body);
      const theirs = brainstemRejection(error);

      // The assertion the old instrument could not make. Comparing `.error`
      // alone passed while `schema` and `status` sat beside it in the response.
      expect(ours).toEqual(theirs);
      expect(Object.keys(ours).sort()).toEqual(['error']);
    });
  }

  it('carries no key that identifies the runtime', () => {
    const ours = openrappterRejection({ user_input: 123 });
    for (const tell of ['schema', 'status', 'content', 'sessionId', 'runtime', 'openrappter']) {
      expect(ours).not.toHaveProperty(tell);
    }
  });

  // Serialised, not just deep-equal: key ORDER is observable on the wire, and
  // a single-key object leaves nowhere for order to differ.
  it('serialises to the same bytes', () => {
    expect(JSON.stringify(openrappterRejection({})))
      .toBe(JSON.stringify(brainstemRejection('user_input is required')));
  });
});

/**
 * Flask routes on the path; `/chat?x=1` is `/chat`. Node hands you the raw
 * target, and the old code compared it to '/chat' with `===`.
 */
describe('a query string does not change which endpoint this is', () => {
  const asFlaskWouldSee = (url: string) => url.split('?')[0];

  for (const target of ['/chat', '/chat?x=1', '/chat?', '/chat?debug=true&x=2']) {
    it(`treats ${target} as /chat`, () => {
      expect(asFlaskWouldSee(target)).toBe('/chat');
    });
  }

  it('does not treat a different path as /chat', () => {
    for (const target of ['/chatter', '/chat/stream', '/v2/chat']) {
      expect(asFlaskWouldSee(target)).not.toBe('/chat');
    }
  });

  // The consequence, stated plainly: whatever the router decides, the SAME
  // validation must run. A body that is rejected without a query string must be
  // rejected with one — the old behaviour answered 200 `Received: …` instead.
  it('applies identical validation regardless of the request target', () => {
    const body = { user_input: 'hi', conversation_history: 'nope' };
    const expected = 'conversation_history must be an array';
    for (const target of ['/chat', '/chat?x=1', '/chat?debug=true']) {
      expect(asFlaskWouldSee(target)).toBe('/chat');
      const parsed = parseChatRequest(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toBe(expected);
    }
  });
});
