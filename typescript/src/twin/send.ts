/**
 * Speaking to a twin. — kody-w/openrappter#100
 *
 * `twin-chat.ts` receives an envelope. This builds and sends one, so a rappter
 * can address a peer instead of only being addressed. Measured before writing
 * it: `rapp-twin-chat/1.0` appeared nowhere in the tree except the receiver and
 * its tests — every member of the neighborhood could listen and none could
 * speak.
 *
 * The two fields worth centralising are the ones the receiver is strict about.
 * `utc` must be RFC3339 with NO fractional seconds — `toISOString()` emits
 * `.123Z` and is rejected — and `nonce` must be exactly 128 bits of lowercase
 * hex. A hand-rolled sender gets 400 from its own sibling, which is a confusing
 * way to learn that two halves of one protocol disagree.
 *
 * Nothing here signs anything. `from_rappid` is a claim on the wire and stays
 * one; this module must never be read as having authenticated the sender.
 */

import { createHash, randomBytes } from 'node:crypto';
import { TWIN_SCHEMA, type TwinKind } from '../gateway/twin-chat.js';

/** RFC3339 UTC, seconds precision. `toISOString()` is NOT this. */
export function twinUtc(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/** 128 bits, lowercase hex, as §6a requires. */
export function twinNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * A stable rappid for this device.
 *
 * `rappid:@<owner>/<slug>:<64hex>`. The digest is derived from owner and slug so
 * the same device presents the same identity across restarts — an id minted per
 * call would make every message look like it came from a stranger, and would
 * make `handled` bookkeeping on the far side meaningless.
 *
 * This is an IDENTIFIER, not a credential. It proves nothing.
 */
export function deviceRappid(owner: string, slug: string): string {
  const safe = (s: string, fallback: string) => {
    const cleaned = (s || '').trim().replace(/[^A-Za-z0-9._-]/g, '-');
    return cleaned || fallback;
  };
  const o = safe(owner, 'unknown');
  const sl = safe(slug, 'alpha');
  const digest = createHash('sha256').update(`rappid:@${o}/${sl}`).digest('hex');
  return `rappid:@${o}/${sl}:${digest}`;
}

export interface TwinSendOptions {
  /** Base URL of the peer, e.g. http://127.0.0.1:19901 */
  to: string;
  fromRappid: string;
  toRappid: string;
  text: string;
  kind?: TwinKind;
  timeoutMs?: number;
  /** Injected in tests so this is provable without a second daemon. */
  fetchImpl?: typeof fetch;
}

export interface TwinSendResult {
  status: number;
  /** The peer's §6e envelope, when it sent one. */
  body: Record<string, unknown>;
  /** What the peer actually said, dug out of the response envelope. */
  said: string;
  /** The envelope that was sent, so a caller can log exactly what went out. */
  sent: Record<string, unknown>;
  /**
   * Which of the neighborhood's two wires answered.
   *
   * A `/chat` reply carries no rappid, no nonce and no envelope. Presenting it
   * identically to a `/twin` reply would claim an identity exchange that never
   * happened, so the caller is told which one it got. #125
   */
  wire: 'twin' | 'chat';
  /**
   * The peer's body verbatim when it was not JSON.
   *
   * A peer answering "this endpoint does not exist" in HTML — the most likely
   * shape there is — used to be reported as `{}`, because that is what
   * `JSON.stringify` makes of a parse failure. The status was right and the
   * body was an invention of the display.
   */
  rawBody?: string;
}

export function buildTwinSay(options: {
  fromRappid: string; toRappid: string; text: string; kind?: TwinKind;
}): Record<string, unknown> {
  return {
    schema: TWIN_SCHEMA,
    from_rappid: options.fromRappid,
    to_rappid: options.toRappid,
    utc: twinUtc(),
    nonce: twinNonce(),
    kind: options.kind ?? 'say',
    payload: { text: options.text },
    facets: [],
  };
}

/**
 * Headers for a peer request, carrying a credential when this rappter has one.
 *
 * Both wires used to send only a content type. `/twin` and `/chat` each call
 * `resolveHttpAuthenticated` before parsing (#113, #119), so those two facts
 * were compatible only because authentication was off — `isAuthCredentialValid`
 * returns true immediately when `authMode` is `none`. Turning the control on
 * anywhere severed the neighborhood: a peer with a token refused both senders,
 * including one whose own environment held the credential.
 *
 * `OPENRAPPTER_TOKEN` is the credential that actually exists on this
 * deployment — the CLI and the daemon both read it. Presenting it when set is
 * what "a rappter presents a credential when it has one" means today.
 *
 * This deliberately does not answer where a credential should come from in
 * general. A device-wide token, a per-instance token exchanged at hatch, and
 * the sealed identity in `rapp-sealed/1.0` are all still open (#133), and all
 * three are compatible with sending what we hold now. Sending nothing is not.
 */
export function peerHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = env.OPENRAPPTER_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The other wire. Plain `/chat`, the one every participant already answers.
 *
 * Deliberately carries no rappid and no envelope: `/chat` has no place to put
 * them, and inventing a field would make a peer's reply look like an identity
 * exchange. The caller is told `wire: 'chat'` so it can say so.
 *
 * Returns null when this wire does not answer either, so the original /twin
 * result is reported rather than a second failure masking the first.
 */
async function sendChat(
  options: TwinSendOptions,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<Omit<TwinSendResult, 'sent'> | null> {
  try {
    const res = await doFetch(`${options.to.replace(/\/$/, '')}/chat`, {
      method: 'POST',
      headers: peerHeaders(),
      body: JSON.stringify({
        user_input: options.text,
        conversation_history: [],
        session_id: options.fromRappid,
      }),
      signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    let parsed = true;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { parsed = false; }
    if (res.status === 404) return null;
    return {
      status: res.status,
      body,
      said: typeof body.response === 'string' ? body.response : '',
      wire: 'chat',
      ...(parsed ? {} : { rawBody: text.slice(0, 400) }),
    };
  } catch {
    return null;
  }
}


export async function sendTwin(options: TwinSendOptions): Promise<TwinSendResult> {
  // Refused here as well as at the receiver. A sender that can emit `console`
  // is a way to smuggle one past a peer that trusts its neighbours, and "we
  // only use it internally" is how that ships.
  if (options.kind === 'console') {
    throw new Error('console is sealed-only and this build has no seal — refusing to send one');
  }

  const envelope = buildTwinSay({
    fromRappid: options.fromRappid,
    toRappid: options.toRappid,
    text: options.text,
    kind: options.kind,
  });

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15 * 60_000);
  try {
    const res = await doFetch(`${options.to.replace(/\/$/, '')}/twin`, {
      method: 'POST',
      headers: peerHeaders(),
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    let parsed = true;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { parsed = false; }

    /**
     * A peer that does not speak `/twin` is still in the neighborhood.
     *
     * The architecture names TWO wires — "they all interact over /twin and
     * /chat" — and this sender spoke one, so a rappter could only ever reach
     * other rappters. The brainstem answers /chat and 404s /twin, which made
     * half the neighborhood unaddressable:
     *
     *   twin say --to http://127.0.0.1:7071  ->  peer answered 404: {}
     *
     * A neighborhood whose members are meant to be interchangeable should not
     * require every member to speak every protocol. #125
     */
    if (res.status === 404) {
      const viaChat = await sendChat(options, doFetch, controller.signal);
      if (viaChat) return { ...viaChat, sent: envelope };
    }

    const inner = (body.response ?? {}) as Record<string, unknown>;
    return {
      status: res.status,
      body,
      said: typeof inner.response === 'string' ? inner.response : '',
      sent: envelope,
      wire: 'twin',
      ...(parsed ? {} : { rawBody: text.slice(0, 400) }),
    };
  } finally {
    clearTimeout(timer);
  }
}
