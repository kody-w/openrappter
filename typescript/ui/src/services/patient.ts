/**
 * A direct line to the patient. — kody-w/openrappter#99
 *
 * Everything else on the surgeon screen is Copilot talking ABOUT OpenRappter.
 * This is OpenRappter answering for itself.
 *
 * It deliberately goes over `POST /chat` — the public wire — rather than an
 * internal RPC. That endpoint is byte-compatible with a RAPP brainstem across
 * every malformed case and was verified identical across three live peers, so
 * the owner's own dashboard reaches its agent through exactly the same door a
 * neighbor would use. If that door ever breaks, this breaks with it, which is
 * the point: no privileged back channel that keeps working while the wire
 * everyone else depends on is down.
 *
 * Same origin — the gateway serves this UI — so no host or token is needed here.
 */

export interface PatientReply {
  /** What the agent said. Senses are already split out by the envelope builder. */
  response: string;
  session_id: string;
  agent_logs: string;
  /** Present only when the reply carried a spoken variant. */
  voice_response?: string;
  /** The model that actually answered, which may differ from the one requested. */
  model?: string;
}

/** A turn generous enough for a tool-using answer, matching the surgeon's budget. */
export const PATIENT_TURN_TIMEOUT_MS = 15 * 60_000;

export async function askPatient(
  userInput: string,
  sessionId?: string,
): Promise<PatientReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PATIENT_TURN_TIMEOUT_MS);
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      // `user_input` is the field the brainstem documents. Using it here keeps
      // this client honest: it speaks the shared contract, not an openrappter
      // dialect that happens to also be accepted.
      body: JSON.stringify({
        user_input: userInput,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    });

    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`The patient answered with something that is not JSON (HTTP ${res.status}).`);
    }

    if (!res.ok) {
      // A rejection on this wire is a bare {error}, exactly as the brainstem
      // writes it — so surface that sentence rather than inventing one.
      throw new Error(String(body.error ?? `HTTP ${res.status}`));
    }

    return {
      response: String(body.response ?? ''),
      session_id: String(body.session_id ?? ''),
      agent_logs: String(body.agent_logs ?? ''),
      ...(typeof body.voice_response === 'string' ? { voice_response: body.voice_response } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
