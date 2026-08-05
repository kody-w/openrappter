/**
 * The `rapp-twin-chat/1.0` envelope. — kody-w/openrappter#96
 *
 * A device runs an alpha rappter plus any number of hatched twins, and through
 * a neighborhood they interact over `/twin` and `/chat` without any of them
 * knowing whether a peer is a rappter, a brainstem, or a person. `/chat` is the
 * turn; this is the envelope that carries a turn *between named peers*.
 *
 * Shapes are `rapp-neighborhood-protocol/1.0` §6a (request) and §6e (response).
 *
 * WHAT THIS DELIBERATELY REFUSES
 *
 * `console` operates a neighbor's runtime and is SEALED-ONLY (§8/§11). This
 * gateway has no seal: no ECDSA P-256 verification, no PBKDF2 channel key.
 * So a `console` envelope is refused outright. Accepting an unsealed one —
 * or worse, executing it — would be the single worst thing this endpoint could
 * do, and "we'll add the seal later" is exactly how that ships.
 *
 * Nothing here verifies a signature, and nothing here should be read as having
 * authenticated the sender. `from_rappid` is a claim, not proof.
 */

/** §6b. `console` is listed because it must be RECOGNISED in order to be refused. */
export const TWIN_KINDS = [
  'say', 'share-fact', 'share-egg', 'request-fact', 'ack', 'console',
] as const;
export type TwinKind = (typeof TWIN_KINDS)[number];

/** Kinds this gateway will act on. `console` is absent on purpose. */
export const TWIN_KINDS_HANDLED: TwinKind[] = ['say', 'share-fact', 'request-fact', 'ack'];

export const TWIN_SCHEMA = 'rapp-twin-chat/1.0';
export const TWIN_RESPONSE_SCHEMA = 'rapp-twin-chat-response/1.0';
export const TWIN_CHANNEL = '5a-tether';

export interface TwinEnvelope {
  schema: string;
  from_rappid: string;
  to_rappid: string;
  utc: string;
  nonce: string;
  kind: TwinKind;
  payload: Record<string, unknown>;
  facets: unknown[];
}

export type TwinParseResult =
  | { ok: true; value: TwinEnvelope }
  | { ok: false; error: string; status: number };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `rappid:@<owner>/<slug>:<64hex>`.
 *
 * Checked for SHAPE only. A well-formed rappid is not an authenticated one, and
 * this function must never be mistaken for authentication.
 */
export const RAPPID = /^rappid:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[0-9a-f]{64}$/;

/** RFC3339 UTC, no fractional seconds — the spec is specific, so the check is too. */
export const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** 128 bits of hex. */
export const NONCE_128 = /^[0-9a-f]{32}$/;

export function parseTwinEnvelope(body: unknown): TwinParseResult {
  if (!isObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object', status: 400 };
  }
  if (body.schema !== TWIN_SCHEMA) {
    return { ok: false, error: `schema must be "${TWIN_SCHEMA}"`, status: 400 };
  }
  for (const field of ['from_rappid', 'to_rappid'] as const) {
    if (typeof body[field] !== 'string' || !RAPPID.test(body[field] as string)) {
      return { ok: false, error: `${field} must be a rappid`, status: 400 };
    }
  }
  if (typeof body.utc !== 'string' || !UTC_RFC3339.test(body.utc)) {
    return { ok: false, error: 'utc must be RFC3339 UTC with no fractional seconds', status: 400 };
  }
  if (typeof body.nonce !== 'string' || !NONCE_128.test(body.nonce)) {
    return { ok: false, error: 'nonce must be 128 bits of lowercase hex', status: 400 };
  }
  if (typeof body.kind !== 'string' || !TWIN_KINDS.includes(body.kind as TwinKind)) {
    return { ok: false, error: `kind must be one of: ${TWIN_KINDS.join(', ')}`, status: 400 };
  }

  // Recognised, and refused. 403 rather than 400 because the envelope is
  // well-formed — the objection is authority, not syntax.
  if (body.kind === 'console') {
    return {
      ok: false,
      status: 403,
      error: 'console is sealed-only and this gateway has no seal — refused, not queued',
    };
  }
  if (!TWIN_KINDS_HANDLED.includes(body.kind as TwinKind)) {
    return { ok: false, error: `kind "${body.kind}" is not handled here`, status: 501 };
  }
  if (body.payload !== undefined && !isObject(body.payload)) {
    return { ok: false, error: 'payload must be an object', status: 400 };
  }
  if (body.facets !== undefined && !Array.isArray(body.facets)) {
    return { ok: false, error: 'facets must be an array', status: 400 };
  }

  return {
    ok: true,
    value: {
      schema: TWIN_SCHEMA,
      from_rappid: body.from_rappid as string,
      to_rappid: body.to_rappid as string,
      utc: body.utc as string,
      nonce: body.nonce as string,
      kind: body.kind as TwinKind,
      payload: isObject(body.payload) ? body.payload : {},
      facets: Array.isArray(body.facets) ? body.facets : [],
    },
  };
}

/**
 * The text a `say` carries.
 *
 * Accepts the field a brainstem client would reach for first, then the ones a
 * chat client would. A peer should not have to know which runtime it reached —
 * that is the whole premise of this wire.
 */
export function sayText(env: TwinEnvelope): string {
  const p = env.payload;
  for (const key of ['text', 'user_input', 'message', 'content']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** §6e. Echoes the request envelope so a peer can match a reply to what it sent. */
export function buildTwinResponse(input: {
  envelope: TwinEnvelope;
  status?: number;
  response: string;
  sessionId: string;
  agentLogs?: string;
  voiceMode?: boolean;
}): Record<string, unknown> {
  return {
    schema: TWIN_RESPONSE_SCHEMA,
    channel: TWIN_CHANNEL,
    envelope: input.envelope,
    status: input.status ?? 200,
    response: {
      response: input.response,
      session_id: input.sessionId,
      agent_logs: input.agentLogs ?? '',
      voice_mode: input.voiceMode ?? false,
    },
  };
}
