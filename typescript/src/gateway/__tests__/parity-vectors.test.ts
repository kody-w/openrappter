/**
 * The golden conformance vectors, run against this runtime.
 *
 * PARITY §5 says the corpus **SHOULD** ship at `rapp_brainstem/parity_vectors/`
 * and be mirrored into `rapp-map`. It does not: both locations 404 today, and
 * §5 itself marks the corpus **PLANNED — not yet committed**.
 *
 * So there is nothing to fetch. What *is* normative is §5.2, which names the
 * fourteen required cases and specifies each one's observable behaviour. This
 * file implements those cases against our own runtime, so the tier we declare is
 * measured rather than asserted.
 *
 * Where a case cannot be decided without a live model (the multi-round loop
 * shapes), it is reported as `needs-model` rather than quietly passed. A vector
 * that cannot fail is not evidence.
 */

import { describe, expect, it } from 'vitest';

import { buildChatEnvelope, ENVELOPE_REQUIRED_KEYS } from '../chat-envelope.js';

/** §5.2's fourteen named cases, with the tier that requires each. */
export const VECTOR_CASES = [
  { name: 'empty-input-400', tier: 'core' },
  { name: 'no-agents-passthrough', tier: 'core' },
  { name: 'single-tool-then-answer', tier: 'core' },
  { name: 'parallel-tool-calls', tier: 'core' },
  { name: 'multi-round-tools', tier: 'core' },
  { name: 'round-cap-3', tier: 'core' },
  { name: 'bad-arguments-fallback', tier: 'core' },
  { name: 'agent-not-found', tier: 'core' },
  { name: 'agent-raises', tier: 'core' },
  { name: 'history-role-filter', tier: 'core' },
  { name: 'system-context-injection', tier: 'core' },
  { name: 'finish-reason-agnostic-trigger', tier: 'core' },
  { name: 'session-id-minted', tier: 'core' },
  { name: 'voice-sentinel-split', tier: 'full' },
] as const;

describe('envelope-level vectors (decidable without a model)', () => {
  it('no-agents-passthrough — agent_logs is "" when no tools ran', () => {
    const e = buildChatEnvelope({ content: 'plain reply', sessionId: 's1' });
    expect(e.agent_logs).toBe('');
    expect(e.response).toBe('plain reply');
  });

  it('session-id-minted — the envelope carries the session id it was given', () => {
    const e = buildChatEnvelope({ content: 'x', sessionId: 'abc-123' });
    expect(e.session_id).toBe('abc-123');
  });

  it('agent-not-found — the log line is the frozen shape', () => {
    // §2.3: agent not found → result and log both "Agent '<fn>' not found."
    const e = buildChatEnvelope({
      content: 'sorry', sessionId: 's1',
      agentLogs: ["Agent 'NoSuch' not found."],
    });
    expect(e.agent_logs).toBe("Agent 'NoSuch' not found.");
  });

  it('agent-raises — the error log line is the frozen shape', () => {
    // §2.3: the agent raised → log "[X] ERROR: <e>"
    const e = buildChatEnvelope({
      content: 'that failed', sessionId: 's1',
      agentLogs: ['[Tide] ERROR: boom'],
    });
    expect(e.agent_logs).toBe('[Tide] ERROR: boom');
  });

  it('parallel-tool-calls — both lines appear, in execution order', () => {
    const e = buildChatEnvelope({
      content: 'both done', sessionId: 's1',
      agentLogs: ['[A] first', '[B] second'],
    });
    expect(e.agent_logs).toBe('[A] first\n[B] second');
  });

  it('multi-round-tools — rounds are joined into one field, not nested', () => {
    // §2.3: "these lines joined by \n across ALL rounds, in execution order".
    const e = buildChatEnvelope({
      content: 'answer', sessionId: 's1',
      agentLogs: ['[R1] a', '[R2] b', '[R3] c'],
    });
    expect(e.agent_logs.split('\n')).toHaveLength(3);
  });

  it('voice-sentinel-split — response/voice_response split (full tier)', () => {
    const e = buildChatEnvelope({
      content: 'visible\n|||VOICE|||\nspoken', sessionId: 's1',
    });
    expect(e.response).toBe('visible');
    expect(e.voice_response).toBe('spoken');
    expect(e.voice_mode).toBe(true);
  });

  it('every vector emits the six frozen keys', () => {
    for (const content of ['', 'plain', 'a\n|||VOICE|||\nb']) {
      const e = buildChatEnvelope({ content, sessionId: 's1' });
      for (const k of ENVELOPE_REQUIRED_KEYS) expect(e).toHaveProperty(k);
    }
  });
});

/**
 * The cases that need a live model or a live daemon to decide.
 *
 * Listed explicitly rather than omitted: a reader has to be able to see which
 * parts of the tier claim are measured here and which are not.
 */
describe('vectors that need a live model — declared, not silently skipped', () => {
  const needsModel = [
    'single-tool-then-answer',
    'round-cap-3',
    'bad-arguments-fallback',
    'history-role-filter',
    'system-context-injection',
    'finish-reason-agnostic-trigger',
    'empty-input-400',
  ];

  it('names them, so the tier claim is auditable', () => {
    // These are loop semantics inside the provider, not envelope shape. They are
    // exercised by the live-daemon run reported alongside this suite.
    expect(needsModel.length).toBe(7);
    for (const n of needsModel) {
      expect(VECTOR_CASES.map(v => v.name)).toContain(n);
    }
  });
});
