import { describe, it, expect } from 'vitest';
import { buildChatEnvelope } from '../chat-envelope.js';

/**
 * The set of keys on a successful `/chat` reply is deliberate.
 *
 * #116 measures the brainstem answering with 6 keys and this runtime with 11,
 * and records a real conflict between two written standards: PARITY §3 says
 * extra axes are free and only absence is drift, while `server.ts` states a
 * stronger goal in its own words — "a peer must not be able to tell which
 * runtime answered". Both cannot hold on the 200 path, and which governs is
 * the owner's call.
 *
 * These tests take **no side in that**. Every key asserted here is a key the
 * runtime emits today. What they add is that the *set* is closed: a twelfth key
 * cannot appear without this test failing and somebody deciding to change it.
 *
 * That gap was real. `chat-envelope-parity.test.ts` checks the required keys
 * are present and that four named extras are present, and its cross-runtime
 * comparison uses `arrayContaining`, which passes on any superset. So a new
 * key widened the fingerprint silently — which is the failure #116 describes
 * one level up, where an instrument whose twelve cases were all 400s reported
 * `wire_divergences: 0` on a corpus that could not contain the divergence.
 */

/** Exactly what a plain successful reply carries. */
const BASE_KEYS = [
  'agent_logs',
  'content',
  'model',
  'requested_model',
  'response',
  'schema',
  'sessionId',
  'session_id',
  'status',
  'voice_mode',
].sort();

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

describe('the successful /chat key set is closed', () => {
  it('a plain reply carries exactly the base keys', () => {
    const envelope = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    expect(keysOf(envelope)).toEqual(BASE_KEYS);
  });

  it('is unchanged by agent logs or an explicit model', () => {
    // Content varies; the shape must not.
    const envelope = buildChatEnvelope({
      content: 'done',
      sessionId: 's1',
      agentLogs: ['[A] ran'],
      model: 'gpt-4o',
      requestedModel: 'auto',
    });
    expect(keysOf(envelope)).toEqual(BASE_KEYS);
  });

  it('a voice reply adds voice_response and nothing else', () => {
    const envelope = buildChatEnvelope({
      content: 'hello|||VOICE|||spoken',
      sessionId: 's1',
    });
    expect(keysOf(envelope)).toEqual([...BASE_KEYS, 'voice_response'].sort());
  });

  it('an idempotency key puts a twelfth key on the wire', () => {
    // Not hypothetical: `server.ts:1478` passes exactly this when the client
    // sent the header. #116 measured 11 keys with a body that carried no
    // idempotency key, so this one was never in that count — the divergence it
    // reports is real and slightly larger than stated.
    const envelope = buildChatEnvelope({
      content: 'hi',
      sessionId: 's1',
      extra: { idempotency_key: 'abc123' },
    });
    expect(keysOf(envelope)).toEqual([...BASE_KEYS, 'idempotency_key'].sort());
  });

  it('extra widens the wire by exactly what it is given', () => {
    // `extra` is an open spread, so the envelope is not closed by construction
    // — it is closed by each caller choosing what to put there. Pinning the
    // base set is what makes those choices visible.
    const envelope = buildChatEnvelope({
      content: 'hi',
      sessionId: 's1',
      extra: { one: 1, two: 2 },
    });
    expect(keysOf(envelope)).toEqual([...BASE_KEYS, 'one', 'two'].sort());
  });

  it('still refuses the key KERNEL §2.2 forbids', () => {
    const envelope = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    expect(keysOf(envelope)).not.toContain('assistant_response');
  });
});
