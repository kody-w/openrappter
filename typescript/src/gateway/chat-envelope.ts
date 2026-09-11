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
  /** The model that actually answered, when the backend reports one. */
  model?: string;
  /** The model that was asked for — differs from `model` only on fallback. */
  requestedModel?: string;
  /**
   * Which rung answered. Used to describe *why* a model is unattributed, so an
   * unreported model is still an actionable answer rather than a shrug.
   */
  backendKind?: string;
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
  /** Stable participant identity. Optional for legacy RAPP peers. */
  rappid?: string;
  /** The process incarnation that produced this reply. */
  live_id?: string;
}

/** The six keys PARITY §2.4 requires. Exported so tests assert against the spec. */
export const ENVELOPE_REQUIRED_KEYS = [
  'response', 'session_id', 'agent_logs', 'voice_mode', 'model', 'requested_model',
] as const;

/**
 * Name the answering model when the backend did not report one.
 *
 * `"unknown"` was the wrong answer twice over: it was returned for *both* keys,
 * so a caller could not even tell whether the request had been honoured, and it
 * gave them nothing to do about it. These two cases are genuinely different and
 * a caller can act on each:
 *
 * - `<kind>:auto` — we asked the backend to choose (`--model auto`). Which one
 *   it picked is decided inside that process and is not returned on the wire.
 *   **Pin `OPENRAPPTER_MODEL` to make this attributable.**
 * - `<kind>:unreported` — we asked for a specific model and the backend
 *   answered without confirming which one served it. The request is in
 *   `requested_model`; treat attribution as unproven.
 *
 * Reporting the *requested* model as though it were the answering model would
 * be the easier lie and a worse one: attribution would look solid while being
 * unverified.
 */
export function unattributedModel(backendKind: string | undefined, requested: string): string {
  const kind = backendKind && backendKind !== 'unknown' ? backendKind : 'no-backend';
  return `${kind}:${requested === 'auto' ? 'auto' : 'unreported'}`;
}

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

  const requested = input.requestedModel ?? input.model ?? 'auto';
  const model = input.model ?? unattributedModel(input.backendKind, requested);
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
    requested_model: requested,
    ...(input.extra ?? {}),
  };
  if (voice) envelope.voice_response = voice;
  return envelope;
}
