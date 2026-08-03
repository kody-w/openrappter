/**
 * The `/chat` response envelope, per `rapp-runtime-parity/1.0`.
 *
 * PARITY §2.4 freezes six keys:
 *
 *   response  session_id  agent_logs  voice_mode  model  requested_model
 *
 * and §0 is blunt about why: *"If two runtimes claiming to be RAPP diverge on
 * the wire, then the estate is not one medium — it is N incompatible products
 * wearing the same name."*
 *
 * We were emitting three of the six. Our Python tier emitted four. Two
 * substrates of the *same product* answered differently, which fails parity
 * internally before the estate is even involved — so the envelope is built here,
 * once, and both runtimes call it.
 *
 * §3 says extra axes are free and are not drift: `schema`, `status`, `content`
 * and `sessionId` stay for the existing callers. Only *absence* is drift.
 *
 * KERNEL §2.2 adds one prohibition: **there is no `assistant_response` key.**
 * This builder cannot emit one.
 */

import { parseSenses } from '../channels/senses.js';

export interface EnvelopeInput {
  /** The raw assistant reply, possibly carrying `|||VOICE|||` and other senses. */
  content: string;
  sessionId: string;
  /** Tool-call log lines, in execution order. Joined with "\n" per §2.3. */
  agentLogs?: string[];
  /** The model that actually answered. */
  model?: string;
  /** The model that was asked for — differs from `model` only on fallback. */
  requestedModel?: string;
  /** Extra keys the caller wants carried (idempotency_key, etc). */
  extra?: Record<string, unknown>;
}

export interface ChatEnvelope extends Record<string, unknown> {
  schema: 'rapp-chat/1.0';
  status: 'success';
  response: string;
  content: string;
  session_id: string;
  sessionId: string;
  agent_logs: string;
  voice_mode: boolean;
  model: string;
  requested_model: string;
  voice_response?: string;
}

/** The six keys PARITY §2.4 requires. Exported so tests assert against the spec. */
export const ENVELOPE_REQUIRED_KEYS = [
  'response', 'session_id', 'agent_logs', 'voice_mode', 'model', 'requested_model',
] as const;

/**
 * Build the envelope, splitting the voice seam.
 *
 * §2.4: *"If `voice_mode` is on and the reply contains the `|||VOICE|||`
 * sentinel, the runtime splits it: `response` = text before, `voice_response` =
 * text after."*
 *
 * We shipped neither half. The raw `|||VOICE|||` marker was going out inside
 * `response`, so anyone chatting with openrappter saw the literal sentinel in
 * the reply — a spec violation that was also a visible product bug.
 *
 * `voice_mode` here reports whether this reply actually carries a spoken
 * projection, rather than a server-wide setting. That is the honest reading for
 * a runtime whose model decides per-reply whether to emit one, and it keeps the
 * envelope self-describing: a client can tell from the reply alone whether
 * `voice_response` is meaningful.
 */
export function buildChatEnvelope(input: EnvelopeInput): ChatEnvelope {
  const raw = input.content ?? '';
  const parsed = parseSenses(raw);
  const voice = parsed.senses.voice ?? '';
  // parseSenses returns the whole reply as `text` when there are no markers, so
  // this is a no-op for replies that carry no senses at all.
  const spoken = raw.includes('|||') ? parsed.text : raw;

  const model = input.model ?? 'unknown';
  const envelope: ChatEnvelope = {
    schema: 'rapp-chat/1.0',
    status: 'success',
    response: spoken,
    // Kept identical to `response` for the existing callers that read it. It is
    // an extra axis (§3), not part of the frozen envelope.
    content: spoken,
    session_id: input.sessionId,
    sessionId: input.sessionId,
    agent_logs: (input.agentLogs ?? []).join('\n'),
    voice_mode: voice.length > 0,
    model,
    // §2.4: equal when the runtime performed no fallback.
    requested_model: input.requestedModel ?? model,
    ...(input.extra ?? {}),
  };
  if (voice) envelope.voice_response = voice;
  return envelope;
}
