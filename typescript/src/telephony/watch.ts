/**
 * What a 24/7 watcher is allowed to do about an incoming message.
 *
 * This file is the shared half of the Google Voice rung. The transport is
 * device-specific — openrappter drives Chrome over CDP, and a grail brainstem
 * running in Pyodide or Azure has no browser at all — but the DECISIONS have to
 * be identical on both sets of bones, or the same inbox produces different
 * behaviour depending on which platform happened to wake up first.
 *
 * So there is no I/O here, no clock of its own, no browser, no imports beyond
 * types. Everything it needs is passed in. That is what makes it portable to
 * every tier under Article VII, and it is why the Python grail agent can be a
 * literal transliteration of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 * An always-on agent with a text-sending capability has one catastrophic
 * failure mode, and it is not "misses a message". It is **replying to things it
 * should not**, at machine speed, to real people:
 *
 *   - first run against an inbox with years of history, answering all of it
 *   - answering its own outbound messages and talking to itself forever
 *   - two automated systems ping-ponging until the number is banned
 *   - re-answering the same message every poll because state was lost
 *
 * Every rule below is one of those. The default answer is NO — a watcher that
 * stays quiet when it is unsure costs you a delayed reply, while one that
 * guesses costs you a hundred texts to a stranger at 3am.
 */

/** One message as the watcher sees it, from any transport. */
export interface InboxMessage {
  /** Stable per message. Two polls of the same message must produce the same id. */
  id: string;
  threadId: string;
  /** The other party's number, E.164 where the transport can manage it. */
  from: string;
  direction: 'inbound' | 'outbound';
  text: string;
  /** Epoch milliseconds. Supplied by the caller, never read from a clock here. */
  at: number;
  /** Google Voice transcribes voicemail; those arrive as messages too. */
  kind?: 'sms' | 'voicemail';
}

/** Everything the watcher remembers between polls, and across restarts. */
export interface WatchState {
  /** Threads this watcher has seen at least one poll of. */
  knownThreads: Record<string, { watermark: number }>;
  /** Message ids already acted on. */
  handled: string[];
  /** Reply timestamps per thread, newest last. Drives the loop guard. */
  replies: Record<string, number[]>;
}

export interface WatchPolicy {
  /** Our own Google Voice number. Never converse with ourselves. */
  selfNumber?: string;
  /** Numbers the watcher may reply to at all. Empty means "any". */
  allowFrom?: string[];
  /** Hard cap on replies to one thread inside `windowMs`. */
  maxRepliesPerThread: number;
  windowMs: number;
  /** Ignore anything older than this at startup. */
  maxAgeMs: number;
}

export const DEFAULT_POLICY: WatchPolicy = {
  // Four replies an hour to one number is plenty for a negotiation and nowhere
  // near enough to be a nuisance if something goes wrong.
  maxRepliesPerThread: 4,
  windowMs: 60 * 60 * 1000,
  // A message older than a day is history, not a live conversation.
  maxAgeMs: 24 * 60 * 60 * 1000,
};

export type SkipReason =
  | 'outbound'
  | 'already-handled'
  | 'thread-unseen'
  | 'older-than-watermark'
  | 'too-old'
  | 'self'
  | 'not-allowed'
  | 'rate-limited';

export interface Verdict {
  act: boolean;
  reason: SkipReason | 'new-inbound';
  /** Plain-language line for the log, so a quiet watcher can be explained. */
  detail: string;
}

export function emptyState(): WatchState {
  return { knownThreads: {}, handled: [], replies: {} };
}

const digits = (n: string): string => (n || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
const sameNumber = (a?: string, b?: string): boolean =>
  !!a && !!b && digits(a) === digits(b) && digits(a).length > 0;

/**
 * Decide whether the watcher may act on one message.
 *
 * `now` is a parameter rather than a call to the clock so the same inputs always
 * produce the same verdict — which is what lets the two implementations be
 * compared byte for byte in a fixture.
 */
export function decide(
  message: InboxMessage,
  state: WatchState,
  policy: WatchPolicy,
  now: number,
): Verdict {
  // We do not talk to ourselves. An outbound bubble is our own voice, and
  // treating it as input is how a loop starts.
  if (message.direction === 'outbound') {
    return { act: false, reason: 'outbound', detail: 'our own message' };
  }
  if (sameNumber(message.from, policy.selfNumber)) {
    return { act: false, reason: 'self', detail: 'from our own number' };
  }

  if (state.handled.includes(message.id)) {
    return { act: false, reason: 'already-handled', detail: 'already acted on this message' };
  }

  // FIRST SIGHT OF A THREAD IS NEVER ACTIONABLE.
  // On first run the inbox is full of history. Answering it would mean texting
  // everyone who has ever messaged this number. So the first poll only records
  // a watermark; a thread becomes live from the next message onward.
  const known = state.knownThreads[message.threadId];
  if (!known) {
    return {
      act: false,
      reason: 'thread-unseen',
      detail: 'first sight of this thread — recording a watermark instead of replying',
    };
  }
  if (message.at <= known.watermark) {
    return { act: false, reason: 'older-than-watermark', detail: 'predates the watermark' };
  }

  if (now - message.at > policy.maxAgeMs) {
    return { act: false, reason: 'too-old', detail: 'older than the freshness window' };
  }

  if (policy.allowFrom && policy.allowFrom.length > 0) {
    if (!policy.allowFrom.some((n) => sameNumber(n, message.from))) {
      return { act: false, reason: 'not-allowed', detail: 'sender is not on the allow list' };
    }
  }

  // The loop guard. If something upstream goes wrong — a bot on the other end,
  // a bad prompt, a bug — this is what stops it at four instead of four hundred.
  const recent = (state.replies[message.threadId] ?? []).filter((t) => now - t < policy.windowMs);
  if (recent.length >= policy.maxRepliesPerThread) {
    return {
      act: false,
      reason: 'rate-limited',
      detail: `already replied ${recent.length} times to this thread in the window`,
    };
  }

  return { act: true, reason: 'new-inbound', detail: 'new inbound message' };
}

/** Record that a thread was observed. Safe to call every poll. */
export function observe(state: WatchState, threadId: string, at: number): WatchState {
  const known = state.knownThreads[threadId];
  return {
    ...state,
    knownThreads: {
      ...state.knownThreads,
      [threadId]: { watermark: known ? Math.max(known.watermark, at) : at },
    },
  };
}

/** Record that we acted on a message and replied to its thread. */
export function recordReply(state: WatchState, message: InboxMessage, at: number): WatchState {
  const replies = { ...state.replies };
  replies[message.threadId] = [...(replies[message.threadId] ?? []), at];
  // Keep `handled` bounded so a long-lived daemon's state file cannot grow
  // without limit; the watermark already covers anything older.
  const handled = [...state.handled, message.id].slice(-500);
  return {
    ...state,
    handled,
    replies,
    knownThreads: {
      ...state.knownThreads,
      [message.threadId]: {
        watermark: Math.max(state.knownThreads[message.threadId]?.watermark ?? 0, message.at),
      },
    },
  };
}
