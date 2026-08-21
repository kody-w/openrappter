import {
  CARD_AUTHORITY_SCHEMA,
  CARD_AUTHORITY_VIEW_KEYS,
  CARD_CLASSIFICATIONS,
  CARD_CONTINUITY_KEYS,
  CARD_FETCH_HOP_KEYS,
  CARD_PROFILE,
  CARD_PROVENANCE_KEYS,
  CARD_REVOCATION_ENTRY_KEYS,
  CARD_REVOCATION_SCHEMA,
  CARD_REVOCATION_VIEW_KEYS,
  CARD_RUNTIME_POLICY_KEYS,
  CARD_RUNTIME_POLICY_SCHEMA,
  CARD_TEST_PROFILE,
  CardStateBackend,
  FRAME_KEYS,
} from './types.js';
import type {
  CardAuthorityView,
  CardAuthorization,
  CardContinuity,
  CardFetchHop,
  CardFrame,
  CardPayload,
  CardRevocationEntry,
  CardRevocationView,
  CardRuntimePolicy,
  CardVerificationResult,
  JsonValue,
} from './types.js';
import {
  CONNECTION,
  H,
  LCLABEL,
  PROFILE_TOKEN,
  CardTrustStore,
  cardContinuity,
  cardPayloadError,
  cardUrlInfo,
  canonicalCardOrigin,
  exactKeys,
  fullMatch,
  forbiddenUrlMaterial,
  hex64,
  ipIsGlobal,
  lclabel,
  parseCardLink,
  rappidValid,
  sortedUniqueStrings,
  uint53,
  validUtc,
  verifyDetachedEdDsa,
  verifyFrame,
  verifyFrameEdDsa,
  verifyHydration,
  withMaterialScannersDisabledForTest,
} from './contract.js';

function provenanceError(provenance: unknown): string | null {
  if (!exactKeys(provenance, CARD_PROVENANCE_KEYS)) {
    return 'provenance must be exactly {source, channel}';
  }
  const value = provenance as { source: string; channel: string };
  try {
    cardUrlInfo(value.source);
  } catch (error) {
    return `provenance source: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (forbiddenUrlMaterial(value.source)) return 'provenance source contains prohibited material';
  if (!lclabel(value.channel)) return 'provenance channel is not an lclabel';
  return null;
}

function temporalDocumentError(
  document: {
    generated_utc: string;
    effective_utc: string;
    expires_utc: string;
  },
  now: Date,
  maxAgeSeconds?: number,
): string | null {
  const generated = validUtc(document.generated_utc);
  const effective = validUtc(document.effective_utc);
  const expires = validUtc(document.expires_utc);
  if (generated === null || effective === null || expires === null) {
    return 'signed document time is not calendar-valid';
  }
  if (!(effective <= generated && generated <= now && now < expires)) {
    return 'signed document is not currently effective';
  }
  if (maxAgeSeconds !== undefined) {
    const age = (now.getTime() - generated.getTime()) / 1000;
    if (age < 0 || age > maxAgeSeconds) return 'signed document is stale';
  }
  return null;
}

function documentHash(document: Record<string, unknown>): string {
  return H(
    'rapp/1:particle',
    Object.fromEntries(
      Object.entries(document).filter(([key]) => key !== 'sig'),
    ) as JsonValue,
  );
}

function verifyRuntimePolicy(
  policy: unknown,
  trust: CardTrustStore,
  now: Date,
  state: CardStateBackend,
): [boolean, string] {
  if (!exactKeys(policy, CARD_RUNTIME_POLICY_KEYS)) {
    return [false, 'runtime policy has the wrong closed schema'];
  }
  const value = policy as CardRuntimePolicy;
  if (value.schema !== CARD_RUNTIME_POLICY_SCHEMA) {
    return [false, 'runtime policy schema token is wrong'];
  }
  if (
    value.authority_rappid !== trust.runtimePolicyAuthority
    || value.signer_key_id !== value.authority_rappid
  ) {
    return [false, 'runtime policy signer is not the out-of-band authority'];
  }
  const unsigned = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'sig'),
  ) as JsonValue;
  let verdict = verifyDetachedEdDsa(
    unsigned,
    value.sig,
    value.signer_key_id,
    trust,
  );
  if (!verdict[0]) return verdict;
  let reason = temporalDocumentError(value, now);
  if (reason) return [false, reason];
  reason = provenanceError(value.provenance);
  if (reason) return [false, reason];
  if (!uint53(value.policy_seq)) return [false, 'runtime policy_seq is not uint53'];
  if (!rappidValid(value.card_authority) || trust.spki(value.card_authority) === null) {
    return [false, 'runtime policy card_authority is not a trust anchor'];
  }
  if (!PROFILE_TOKEN.test(value.protocol) || !PROFILE_TOKEN.test(value.runtime)) {
    return [false, 'runtime policy protocol/runtime token is invalid'];
  }
  if (!sortedUniqueStrings(value.features, PROFILE_TOKEN)) {
    return [false, 'runtime policy features are invalid'];
  }
  if (!sortedUniqueStrings(value.profiles, PROFILE_TOKEN)) {
    return [false, 'runtime policy profiles are invalid'];
  }
  if (!value.profiles.every((profile) => profile === CARD_PROFILE || profile === CARD_TEST_PROFILE)) {
    return [false, 'runtime policy includes an unknown profile'];
  }
  const synthetic = value.authority_rappid.startsWith('rappid:@synthetic/');
  if (value.profiles.includes(CARD_PROFILE) && synthetic) {
    return [false, 'production runtime policy cannot use a synthetic authority'];
  }
  if (value.profiles.includes(CARD_TEST_PROFILE) && !synthetic) {
    return [false, 'test runtime policy must use a visibly synthetic authority'];
  }
  if (value.card_authority.startsWith('rappid:@synthetic/') !== synthetic) {
    return [false, 'runtime policy and card-authority roots must share test/production class'];
  }
  if (value.profiles.length !== 1) {
    return [false, 'runtime policy must select exactly one production or test profile'];
  }
  if (!(CARD_CLASSIFICATIONS as readonly string[]).includes(value.max_classification)) {
    return [false, 'runtime policy max_classification is invalid'];
  }
  if (!sortedUniqueStrings(value.granted_scope, LCLABEL)) {
    return [false, 'runtime policy granted_scope is invalid'];
  }
  if (!uint53(value.max_registry_age_seconds) || value.max_registry_age_seconds <= 0) {
    return [false, 'runtime policy max_registry_age_seconds is invalid'];
  }
  verdict = state.acceptSequence(
    'runtime-policy',
    value.authority_rappid,
    value.policy_seq,
    documentHash(value as unknown as Record<string, unknown>),
  );
  return verdict[0] ? [true, 'ok'] : verdict;
}

function verifyFetchTrace(
  trace: unknown,
  endpoint: string,
  approvedOrigins: string[],
): [boolean, string] {
  if (!Array.isArray(trace) || trace.length < 1 || trace.length > 8) {
    return [false, 'fetch trace must contain 1-8 observed hops'];
  }
  if (!exactKeys(trace[0], CARD_FETCH_HOP_KEYS) || (trace[0] as CardFetchHop).url !== endpoint) {
    return [false, 'fetch trace does not begin at URI endpoint'];
  }
  for (let index = 0; index < trace.length; index += 1) {
    const hop = trace[index];
    if (!exactKeys(hop, CARD_FETCH_HOP_KEYS)) {
      return [false, 'fetch hop must be exactly {url, resolved_ip}'];
    }
    const value = hop as CardFetchHop;
    let info;
    try {
      info = cardUrlInfo(value.url, index === trace.length - 1 ? '.rappid-card.json' : undefined);
    } catch (error) {
      return [false, `fetch hop is invalid: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (forbiddenUrlMaterial(value.url)) return [false, 'fetch hop URL contains prohibited material'];
    if (!approvedOrigins.includes(info.origin)) return [false, 'fetch redirect crossed to an unapproved origin'];
    if (!ipIsGlobal(value.resolved_ip)) {
      return [false, 'fetch DNS/IP result is loopback/private/link-local/reserved'];
    }
  }
  return [true, 'ok'];
}

function authorizationKey(entry: CardAuthorization): string {
  return JSON.stringify([
    entry.issuer_key_id,
    entry.subject_rappid ?? '',
    entry.role,
    entry.not_before_utc,
    entry.not_after_utc,
    entry.revoked_utc ?? '',
  ]);
}

function verifyAuthorityView(
  view: unknown,
  policy: CardRuntimePolicy,
  trust: CardTrustStore,
  now: Date,
  state: CardStateBackend,
  frame: CardFrame,
  link: ReturnType<typeof parseCardLink>,
  fetchTrace: CardFetchHop[],
): [boolean, string] {
  if (!exactKeys(view, CARD_AUTHORITY_VIEW_KEYS)) return [false, 'authority view has the wrong closed schema'];
  const value = view as CardAuthorityView;
  if (value.schema !== CARD_AUTHORITY_SCHEMA) return [false, 'authority view schema token is wrong'];
  if (value.authority_rappid !== policy.card_authority || value.signer_key_id !== value.authority_rappid) {
    return [false, 'authority view signer is not the runtime policy card_authority'];
  }
  const unsigned = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'sig'),
  ) as JsonValue;
  let verdict = verifyDetachedEdDsa(unsigned, value.sig, value.signer_key_id, trust);
  if (!verdict[0]) return verdict;
  let reason = temporalDocumentError(value, now, policy.max_registry_age_seconds);
  if (reason) return [false, reason];
  reason = provenanceError(value.provenance);
  if (reason) return [false, reason];
  if (!uint53(value.registry_seq)) return [false, 'authority registry_seq is not uint53'];
  if (!Array.isArray(value.approved_origins)) return [false, 'approved_origins must be an array'];
  let canonicalOrigins: string[];
  try {
    canonicalOrigins = value.approved_origins.map(canonicalCardOrigin);
  } catch (error) {
    return [false, error instanceof Error ? error.message : String(error)];
  }
  if (value.approved_origins.some((origin) => forbiddenUrlMaterial(`${origin}/origin`))) {
    return [false, 'approved origin contains prohibited material'];
  }
  if (JSON.stringify(value.approved_origins) !== JSON.stringify([...new Set(canonicalOrigins)].sort())) {
    return [false, 'approved_origins must be canonical, sorted, and unique'];
  }
  if (!Array.isArray(value.authorizations)) return [false, 'authorizations must be an array'];
  for (const entry of value.authorizations) {
    if (!exactKeys(entry, ['issuer_key_id', 'subject_rappid', 'role', 'not_before_utc', 'not_after_utc', 'revoked_utc'])) {
      return [false, 'authorization has the wrong closed schema'];
    }
    if (!rappidValid(entry.issuer_key_id)) return [false, 'authorization issuer_key_id is invalid'];
    if (entry.subject_rappid !== null && !rappidValid(entry.subject_rappid)) {
      return [false, 'authorization subject_rappid is invalid'];
    }
    if (entry.role !== 'subject' && entry.role !== 'card-issuer') return [false, 'authorization role is invalid'];
    if (entry.role === 'subject' && entry.subject_rappid === null) {
      return [false, 'subject authorization requires an explicit subject_rappid'];
    }
    const before = validUtc(entry.not_before_utc);
    const after = validUtc(entry.not_after_utc);
    const revoked = entry.revoked_utc === null ? null : validUtc(entry.revoked_utc);
    if (before === null || after === null || before >= after) return [false, 'authorization tenure is invalid'];
    if (entry.revoked_utc !== null && (revoked === null || revoked < before)) {
      return [false, 'authorization revoked_utc is invalid'];
    }
  }
  const keys = value.authorizations.map(authorizationKey);
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) return [false, 'authorizations must be sorted'];
  if (new Set(keys).size !== keys.length) return [false, 'authorizations contain a duplicate'];
  verdict = state.acceptSequence('card-authority', value.authority_rappid, value.registry_seq, documentHash(value as unknown as Record<string, unknown>));
  if (!verdict[0]) return verdict;
  if (link.endpoint_origin !== frame.payload.endpoint_origin) return [false, 'endpoint origin does not match signed manifest'];
  if (!value.approved_origins.includes(link.endpoint_origin)) return [false, 'endpoint origin is not approved by signed authority policy'];
  const revocationOrigin = cardUrlInfo(frame.payload.revocation_url).origin;
  if (!value.approved_origins.includes(revocationOrigin)) return [false, 'revocation origin is not approved by signed authority policy'];
  verdict = verifyFetchTrace(fetchTrace, link.endpoint, value.approved_origins);
  if (!verdict[0]) return verdict;
  const issued = validUtc(frame.utc)!;
  const issuer = frame.payload.key_id;
  const subject = frame.payload.rappid;
  const authorized = value.authorizations.some((entry) => {
    if (entry.issuer_key_id !== issuer) return false;
    const before = validUtc(entry.not_before_utc)!;
    const after = validUtc(entry.not_after_utc)!;
    const revoked = entry.revoked_utc === null ? null : validUtc(entry.revoked_utc)!;
    const subjectOk =
      entry.role === 'subject'
        ? entry.subject_rappid === subject
        : entry.subject_rappid === null || entry.subject_rappid === subject;
    return subjectOk && before <= issued && issued < after && now < after && (revoked === null || now < revoked);
  });
  return authorized
    ? [true, 'ok']
    : [false, 'issuer key has no current signed authorization for this subject'];
}

function revocationKey(entry: CardRevocationEntry): string {
  return JSON.stringify([entry.target_type, entry.target, entry.effective_utc, entry.reason]);
}

function verifyRevocationView(
  view: unknown,
  policy: CardRuntimePolicy,
  trust: CardTrustStore,
  now: Date,
  state: CardStateBackend,
  payload: CardPayload,
  manifestHash: string,
): [boolean, string] {
  if (view === null || view === undefined) return [false, 'revocation view unavailable'];
  if (!exactKeys(view, CARD_REVOCATION_VIEW_KEYS)) return [false, 'revocation view has the wrong closed schema'];
  const value = view as CardRevocationView;
  if (value.schema !== CARD_REVOCATION_SCHEMA) return [false, 'revocation view schema token is wrong'];
  if (value.authority_rappid !== policy.card_authority || value.signer_key_id !== value.authority_rappid) {
    return [false, 'revocation signer is not the runtime policy card_authority'];
  }
  const unsigned = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'sig'),
  ) as JsonValue;
  let verdict = verifyDetachedEdDsa(unsigned, value.sig, value.signer_key_id, trust);
  if (!verdict[0]) return verdict;
  let reason = temporalDocumentError(value, now, policy.max_registry_age_seconds);
  if (reason) return [false, reason];
  reason = provenanceError(value.provenance);
  if (reason) return [false, reason];
  if (value.provenance.source !== payload.revocation_url) {
    return [false, 'revocation provenance does not match signed manifest location'];
  }
  if (!uint53(value.registry_seq)) return [false, 'revocation registry_seq is not uint53'];
  if (!Array.isArray(value.entries)) return [false, 'revocation entries must be an array'];
  for (const entry of value.entries) {
    if (!exactKeys(entry, CARD_REVOCATION_ENTRY_KEYS)) return [false, 'revocation entry has the wrong closed schema'];
    let targetOk = false;
    if (entry.target_type === 'manifest-hash') targetOk = hex64(entry.target);
    else if (entry.target_type === 'key-id' || entry.target_type === 'subject-rappid') targetOk = rappidValid(entry.target);
    else return [false, 'revocation target_type is invalid'];
    if (!targetOk || validUtc(entry.effective_utc) === null) return [false, 'revocation target/effective_utc is invalid'];
    if (!lclabel(entry.reason)) return [false, 'revocation reason is not an lclabel'];
  }
  const keys = value.entries.map(revocationKey);
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) return [false, 'revocation entries must be sorted'];
  if (new Set(keys).size !== keys.length) return [false, 'revocation entries contain a duplicate'];
  verdict = state.acceptSequence('card-revocation', value.authority_rappid, value.registry_seq, documentHash(value as unknown as Record<string, unknown>));
  if (!verdict[0]) return verdict;
  const targets = {
    'manifest-hash': manifestHash,
    'key-id': payload.key_id,
    'subject-rappid': payload.rappid,
  };
  for (const entry of value.entries) {
    if (entry.target === targets[entry.target_type] && validUtc(entry.effective_utc)! <= now) {
      return [false, `${entry.target_type} is revoked`];
    }
  }
  return [true, 'ok'];
}

export interface VerifyCardInput {
  uri: string;
  frame: CardFrame;
  trust: CardTrustStore;
  now_utc: string;
  runtime_policy: CardRuntimePolicy;
  authority_view: CardAuthorityView;
  revocation_view: CardRevocationView | null;
  state: CardStateBackend;
  connection_id: string;
  fetch_trace: CardFetchHop[];
  hydrated: Record<string, Uint8Array>;
  continuity: CardContinuity;
  head?: CardFrame | null;
}

export function verifyCardLink(input: VerifyCardInput): CardVerificationResult {
  let link;
  try {
    link = parseCardLink(input.uri);
  } catch (error) {
    return { ok: false, step: 'parse', reason: error instanceof Error ? error.message : String(error), result: null };
  }
  if (input.frame === null || typeof input.frame !== 'object' || input.frame.payload === null || typeof input.frame.payload !== 'object') {
    return { ok: false, step: 'content-address', reason: 'endpoint did not return a frame payload', result: null };
  }
  let computed: string;
  try {
    computed = H('rapp/1:particle', input.frame.payload as unknown as JsonValue);
  } catch (error) {
    return { ok: false, step: 'content-address', reason: error instanceof Error ? error.message : String(error), result: null };
  }
  if (computed !== link.manifest_hash || input.frame.payload_hash !== link.manifest_hash) {
    return { ok: false, step: 'content-address', reason: 'URI m does not match the manifest particle', result: null };
  }
  if (!exactKeys(input.frame, FRAME_KEYS)) {
    return { ok: false, step: 'schema', reason: 'card resource is not the eleven-key frame', result: null };
  }
  const frameVerdict = verifyFrame(input.frame, input.head ?? null, link.rappid);
  if (!frameVerdict[0]) {
    return { ok: false, step: 'schema', reason: `frame §7.5 step ${frameVerdict[1]}: ${frameVerdict[2]}`, result: null };
  }
  const payloadReason = cardPayloadError(input.frame.payload, input.frame, link);
  if (payloadReason) return { ok: false, step: 'schema', reason: payloadReason, result: null };
  if (!(input.trust instanceof CardTrustStore)) {
    return { ok: false, step: 'signature', reason: 'a CardTrustStore is required', result: null };
  }
  if (!(input.state instanceof CardStateBackend)) {
    return { ok: false, step: 'signature', reason: 'a transactional CardStateBackend is required', result: null };
  }
  const now = validUtc(input.now_utc);
  if (now === null) return { ok: false, step: 'signature', reason: 'trusted clock now_utc is not calendar-valid', result: null };
  let verdict = verifyFrameEdDsa(input.frame, input.trust);
  if (!verdict[0]) return { ok: false, step: 'signature', reason: verdict[1], result: null };
  try {
    verdict = verifyRuntimePolicy(input.runtime_policy, input.trust, now, input.state);
  } catch (error) {
    return { ok: false, step: 'signature', reason: `runtime policy state failure: ${error instanceof Error ? error.message : String(error)}`, result: null };
  }
  if (!verdict[0]) return { ok: false, step: 'signature', reason: verdict[1], result: null };
  if (!input.runtime_policy.profiles.includes(input.frame.payload.profile)) {
    return { ok: false, step: 'signature', reason: 'runtime policy does not authorize this profile', result: null };
  }
  try {
    verdict = verifyAuthorityView(input.authority_view, input.runtime_policy, input.trust, now, input.state, input.frame, link, input.fetch_trace);
  } catch (error) {
    return { ok: false, step: 'signature', reason: `authority state failure: ${error instanceof Error ? error.message : String(error)}`, result: null };
  }
  if (!verdict[0]) return { ok: false, step: 'signature', reason: verdict[1], result: null };
  if (now >= validUtc(input.frame.payload.expires_utc)!) {
    return { ok: false, step: 'expiry', reason: 'card manifest is expired', result: null };
  }
  try {
    verdict = verifyRevocationView(input.revocation_view, input.runtime_policy, input.trust, now, input.state, input.frame.payload, link.manifest_hash);
  } catch (error) {
    return { ok: false, step: 'revocation', reason: `revocation state failure: ${error instanceof Error ? error.message : String(error)}`, result: null };
  }
  if (!verdict[0]) return { ok: false, step: 'revocation', reason: verdict[1], result: null };
  const compatibility = input.frame.payload.compatibility;
  if (
    compatibility.protocol !== input.runtime_policy.protocol
    || compatibility.runtime !== input.runtime_policy.runtime
    || !compatibility.features.every((feature) => input.runtime_policy.features.includes(feature))
  ) {
    return { ok: false, step: 'compatibility', reason: 'runtime/protocol requirements are not satisfied', result: null };
  }
  const classification = CARD_CLASSIFICATIONS.indexOf(input.frame.payload.classification);
  const maximum = CARD_CLASSIFICATIONS.indexOf(input.runtime_policy.max_classification);
  const missingScope = input.frame.payload.requested_scope.filter((scope) => !input.runtime_policy.granted_scope.includes(scope)).sort();
  if (classification > maximum) return { ok: false, step: 'classification-scope', reason: 'classification exceeds local policy', result: null };
  if (missingScope.length) return { ok: false, step: 'classification-scope', reason: `requested scope not granted: ${missingScope[0]}`, result: null };
  if (!fullMatch(CONNECTION, input.connection_id)) return { ok: false, step: 'replay-nonce', reason: 'connection_id is invalid', result: null };
  try {
    verdict = input.state.claimNonce(link.nonce, input.connection_id, input.now_utc);
  } catch (error) {
    return { ok: false, step: 'replay-nonce', reason: `transactional nonce claim failed: ${error instanceof Error ? error.message : String(error)}`, result: null };
  }
  if (!verdict[0]) return { ok: false, step: 'replay-nonce', reason: verdict[1], result: null };
  verdict = verifyHydration(input.frame.payload.inventory, input.hydrated);
  if (!verdict[0]) return { ok: false, step: 'hydration', reason: verdict[1], result: null };
  if (!exactKeys(input.continuity, CARD_CONTINUITY_KEYS)) {
    return { ok: false, step: 'continuity', reason: 'continuity response has the wrong schema', result: null };
  }
  const expectedValue = cardContinuity(input.frame.payload, link.nonce);
  let expectedChallenge: string;
  let actualChallenge: string;
  try {
    expectedChallenge = H('rapp/1:particle', expectedValue as unknown as JsonValue);
    actualChallenge = H('rapp/1:particle', input.continuity as unknown as JsonValue);
  } catch {
    return { ok: false, step: 'continuity', reason: 'continuity response is not a canonical value', result: null };
  }
  if (input.frame.payload.wake_challenge !== expectedChallenge || actualChallenge !== input.frame.payload.wake_challenge) {
    return { ok: false, step: 'continuity', reason: 'one-time continuity challenge failed', result: null };
  }
  try {
    verdict = input.state.markAwake(link.nonce, input.connection_id, input.now_utc);
  } catch (error) {
    return { ok: false, step: 'replay-nonce', reason: `transactional awake commit failed: ${error instanceof Error ? error.message : String(error)}`, result: null };
  }
  if (!verdict[0]) return { ok: false, step: 'replay-nonce', reason: verdict[1], result: null };
  return {
    ok: true,
    step: null,
    reason: 'awake',
    result: {
      status: 'awake',
      profile: input.frame.payload.profile,
      rappid: input.frame.payload.rappid,
      manifest_hash: link.manifest_hash,
      nonce: link.nonce,
      runtime_policy_seq: input.runtime_policy.policy_seq,
      authority_seq: input.authority_view.registry_seq,
      revocation_seq: input.revocation_view!.registry_seq,
    },
  };
}

export function verifyCardLinkScannerControlForTest(
  input: VerifyCardInput,
): CardVerificationResult {
  return withMaterialScannersDisabledForTest(() => verifyCardLink(input));
}

class OfflineInspectionState extends CardStateBackend {
  claimNonce(): [boolean, string] {
    return [true, 'offline'];
  }

  markAwake(): [boolean, string] {
    return [true, 'offline'];
  }

  acceptSequence(): [boolean, string] {
    return [true, 'offline'];
  }
}

export function inspectCardOffline(
  input: Omit<VerifyCardInput, 'state'> & { supplied_state_path?: string },
): {
  status: 'historical-valid' | 'historical-invalid';
  awake: false;
  cryptographic_policy_ok: boolean;
  verdict: CardVerificationResult;
} {
  const { supplied_state_path: _ignored, ...verification } = input;
  const verdict = verifyCardLink({
    ...verification,
    state: new OfflineInspectionState(),
  });
  if (verdict.ok) {
    return {
      status: 'historical-valid',
      awake: false,
      cryptographic_policy_ok: true,
      verdict: {
        ok: true,
        step: null,
        reason: 'historical-valid',
        result: null,
      },
    };
  }
  return {
    status: 'historical-invalid',
    awake: false,
    cryptographic_policy_ok: false,
    verdict: { ...verdict, result: null },
  };
}
