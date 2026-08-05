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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* left empty */ }

    const inner = (body.response ?? {}) as Record<string, unknown>;
    return {
      status: res.status,
      body,
      said: typeof inner.response === 'string' ? inner.response : '',
      sent: envelope,
    };
  } finally {
    clearTimeout(timer);
  }
}
