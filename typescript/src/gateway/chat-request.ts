/**
 * The `/chat` REQUEST contract, shared with the grail brainstem.
 *
 * PARITY §2.4 froze the six response keys, and `chat-envelope.ts` builds them.
 * Nothing ever froze the *request* side — and measured against a live brainstem
 * on :7071, three of six cases disagreed:
 *
 *   body                                          brainstem            openrappter (before)
 *   ────────────────────────────────────────────  ───────────────────  ────────────────────
 *   []                                            400 not-an-object    400 "message is required"
 *   {"user_input": 123}                           400 not-a-string     400 "message is required"
 *   {"user_input": "   "}                         400 required         400 "message is required"
 *   {"conversation_history": "nope"}              400 not-an-array     200
 *   {"conversation_history":[{"role":"bogus"}]}   400 bad role         200
 *   {"conversation_history":[{"content":123}]}    400 bad content      200
 *
 * The last three are the dangerous ones. openrappter silently DROPPED the
 * malformed history and answered 200 as though it had read it, so a caller was
 * told its conversation was understood when it had been thrown away. A brainstem
 * client would never see that failure until the answers stopped making sense.
 *
 * That matters more here than in most places, because the whole point of this
 * wire is that a peer cannot tell what it is talking to. §0 of PARITY: *"If two
 * runtimes claiming to be RAPP diverge on the wire, then the estate is not one
 * medium — it is N incompatible products wearing the same name."* Two things
 * that answer a malformed request differently are distinguishable, and a
 * neighborhood built on `/chat` is only as interchangeable as its worst case.
 *
 * So the checks below are a transliteration of `brainstem.py`'s `chat()` —
 * same conditions, same order, same sentences. Order is load-bearing: history is
 * validated BEFORE the empty-input check, so `{"user_input":"","conversation_history":"nope"}`
 * reports the array problem, not the missing input.
 *
 * PARITY §3 permits extra axes, so openrappter's own additions survive: `message`
 * as an alias for `user_input`, camelCase spellings, and idempotency. They are
 * only consulted where the brainstem would have seen nothing at all.
 */

/** Roles the brainstem accepts in history. `tool` is included — transcripts replay tool turns. */
export const HISTORY_ROLES = ['user', 'assistant', 'tool'] as const;
export type HistoryRole = (typeof HISTORY_ROLES)[number];

export interface ChatHistoryMessage {
  role: HistoryRole;
  content: string;
}

export interface ChatRequest {
  userInput: string;
  conversationHistory: ChatHistoryMessage[];
  sessionId?: string;
}

export type ChatRequestResult =
  | { ok: true; value: ChatRequest }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate `conversation_history`.
 *
 * Mirrors `_validate_conversation_history` in brainstem.py, including the
 * indexed error text — a caller repairing a 40-turn transcript needs to be told
 * *which* turn is wrong, and "history is invalid" does not do that.
 */
export function validateHistory(value: unknown): { ok: true; value: ChatHistoryMessage[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'conversation_history must be an array' };

  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!isObject(entry)) {
      return { ok: false, error: `conversation_history[${i}] must be an object` };
    }
    if (!HISTORY_ROLES.includes(entry.role as HistoryRole)) {
      return { ok: false, error: `conversation_history[${i}].role is invalid` };
    }
    if (typeof entry.content !== 'string') {
      return { ok: false, error: `conversation_history[${i}].content must be a string` };
    }
  }
  return { ok: true, value: value as ChatHistoryMessage[] };
}

/**
 * Parse and validate a `/chat` body exactly as the brainstem does.
 *
 * `body` is the already-JSON-parsed payload. Malformed JSON is the caller's to
 * catch — the brainstem answers that with the same not-an-object sentence, so
 * pass `undefined` and it will.
 */
export function parseChatRequest(body: unknown): ChatRequestResult {
  if (!isObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  // `user_input` is authoritative. openrappter's `message` alias is only
  // consulted when the brainstem's key is absent entirely, so a client sending
  // the documented field gets the documented behaviour — including its errors.
  let rawInput: unknown = body.user_input;
  if (rawInput === undefined) {
    rawInput = body.message !== undefined ? body.message : '';
  }
  if (typeof rawInput !== 'string') {
    return { ok: false, error: 'user_input must be a string' };
  }
  const userInput = rawInput.trim();

  // Before the empty check, exactly as upstream. Swapping these two reports the
  // wrong fault for a request that is wrong in both ways.
  const historyRaw = body.conversation_history !== undefined
    ? body.conversation_history
    : body.history;
  const history = validateHistory(historyRaw);
  if (!history.ok) return { ok: false, error: history.error };

  const sessionRaw = body.session_id !== undefined ? body.session_id : body.sessionId;
  const sessionId = typeof sessionRaw === 'string' && sessionRaw ? sessionRaw : undefined;

  if (!userInput) {
    return { ok: false, error: 'user_input is required' };
  }

  return { ok: true, value: { userInput, conversationHistory: history.value, sessionId } };
}
