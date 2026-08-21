import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CARD_AUTHORITY_SCHEMA,
  CARD_AUTHORITY_VIEW_KEYS,
  CARD_CALLING,
  CARD_CLASSIFICATIONS,
  CARD_DEBUG,
  CARD_PAYLOAD_KEYS,
  CARD_PROFILE,
  CARD_REVOCATION_SCHEMA,
  CARD_REVOCATION_VIEW_KEYS,
  CARD_RUNTIME_POLICY_KEYS,
  CARD_RUNTIME_POLICY_SCHEMA,
  CARD_TEST_PROFILE,
  CARD_VERIFY_STEPS,
  CARD_VIRTUAL_SUFFIX,
  FRAME_KEYS,
  H,
  Hb,
  RAPPID_CARD_FIXTURE_NAMES,
  SQLiteCardState,
  CardTrustStore,
  buildRappidCardFixture,
  canonical,
  cardParts,
  cardTrust,
  loadRappidCardDeck,
  parseCardLink,
  ipIsGlobal,
  physicalVectorBytes,
  readCardResource,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  simulateRappidCardFixture,
  stateForVector,
  verifyCardLinkScannerControlForTest,
  writeRappidCardFixtureDeck,
} from './index.js';

const generated: string[] = [];

afterEach(() => {
  for (const path of generated.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { recursive: true, force: true });
    }
  }
});

function statePath(name: string): string {
  const path = join(process.cwd(), `.pr9-card-${name}-${process.pid}.sqlite`);
  generated.push(path);
  return path;
}

const mandatory = [
  'valid-test', 'valid-production', 'expired', 'manifest-revoked', 'key-revoked',
  'subject-revoked', 'wrong-manifest-hash', 'unknown-signing-key',
  'attacker-key-impersonation', 'delegation-expired', 'delegation-revoked',
  'forged-revocation-view', 'stale-revocation-view', 'unavailable-revocation-view',
  'rollback-revocation-view', 'protocol-incompatible', 'runtime-incompatible',
  'unsupported-feature', 'feature-superset', 'classification-violation',
  'insufficient-scope', 'missing-engram-part', 'continuity-challenge-failure',
  'reconnect-during-hydration', 'duplicate-replayed-nonce',
  'physical-payload-reproduction', 'test-profile-production',
  'synthetic-key-production', 'auto-execute', 'endpoint-userinfo',
  'endpoint-empty-query', 'endpoint-empty-fragment', 'endpoint-space',
  'endpoint-backslash', 'endpoint-bad-percent', 'endpoint-double-encoding',
  'endpoint-loopback-literal', 'endpoint-private-literal',
  'endpoint-link-local-literal', 'endpoint-reserved-literal',
  'endpoint-unapproved-origin', 'endpoint-redirect-origin', 'endpoint-private-dns',
  'secret-endpoint-password', 'secret-password', 'secret-api-key', 'secret-cookie',
  'secret-bearer', 'secret-private-memory',
] as const;

describe('PR9 contract drift', () => {
  it('pins exact profiles, kinds, trust schemas, classifications, and steps', () => {
    expect(CARD_PROFILE).toBe('rappid-card/1');
    expect(CARD_TEST_PROFILE).toBe('rappid-card-test/1');
    expect(CARD_VIRTUAL_SUFFIX).toBe('.rappid-card.json');
    expect([CARD_CALLING, CARD_DEBUG]).toEqual([
      'body.calling-card',
      'body.debug-card',
    ]);
    expect([
      CARD_RUNTIME_POLICY_SCHEMA,
      CARD_AUTHORITY_SCHEMA,
      CARD_REVOCATION_SCHEMA,
    ]).toEqual([
      'rappid-card-runtime-policy/1',
      'rappid-card-authority/1',
      'rappid-card-revocations/1',
    ]);
    expect(CARD_CLASSIFICATIONS).toEqual([
      'public', 'internal', 'confidential', 'restricted',
    ]);
    expect(CARD_VERIFY_STEPS).toEqual([
      'parse', 'content-address', 'schema', 'signature', 'expiry', 'revocation',
      'compatibility', 'classification-scope', 'replay-nonce', 'hydration',
      'continuity',
    ]);
  });

  it('pins exact frame/payload/trust key sets to the vendored deck', () => {
    const vector = loadRappidCardDeck().vectors[0];
    expect(Object.keys(vector.frame).sort()).toEqual([...FRAME_KEYS].sort());
    expect(Object.keys(vector.frame.payload).sort()).toEqual([...CARD_PAYLOAD_KEYS].sort());
    expect(Object.keys(vector.runtime_policy).sort()).toEqual([...CARD_RUNTIME_POLICY_KEYS].sort());
    expect(Object.keys(vector.authority_view).sort()).toEqual([...CARD_AUTHORITY_VIEW_KEYS].sort());
    expect(Object.keys(vector.revocation_view!).sort()).toEqual([...CARD_REVOCATION_VIEW_KEYS].sort());
    const cardSchema = JSON.parse(
      readFileSync(
        new URL('../../../contracts/rappid-card.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      required: string[];
      $defs: { payload: { required: string[] } };
    };
    const trustSchema = JSON.parse(
      readFileSync(
        new URL('../../../contracts/rappid-card-trust.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      $defs: {
        runtime_policy: { required: string[] };
        authority_view: { required: string[] };
        revocation_view: { required: string[] };
      };
    };
    expect(cardSchema.required.sort()).toEqual([...FRAME_KEYS].sort());
    expect(cardSchema.$defs.payload.required.sort()).toEqual([...CARD_PAYLOAD_KEYS].sort());
    expect(trustSchema.$defs.runtime_policy.required.sort()).toEqual([...CARD_RUNTIME_POLICY_KEYS].sort());
    expect(trustSchema.$defs.authority_view.required.sort()).toEqual([...CARD_AUTHORITY_VIEW_KEYS].sort());
    expect(trustSchema.$defs.revocation_view.required.sort()).toEqual([...CARD_REVOCATION_VIEW_KEYS].sort());
  });

  it('pins every mandatory scenario name and order', () => {
    const deck = loadRappidCardDeck();
    expect(deck.mandatory_scenarios).toEqual(mandatory);
    expect(deck.vectors.map((vector) => vector.name)).toEqual(mandatory);
    expect(RAPPID_CARD_FIXTURE_NAMES).toEqual(mandatory);
  });

  it('matches the reference global-IP classification at edge ranges', () => {
    expect(ipIsGlobal('8.8.8.8')).toBe(true);
    expect(ipIsGlobal('192.0.0.9')).toBe(true);
    expect(ipIsGlobal('192.0.2.1')).toBe(false);
    expect(ipIsGlobal('224.0.0.1')).toBe(true);
    expect(ipIsGlobal('2001:4860:4860::8888')).toBe(true);
    expect(ipIsGlobal('2001:db8::1')).toBe(false);
    expect(ipIsGlobal('::ffff:10.0.0.1')).toBe(false);
    expect(ipIsGlobal('::ffff:8.8.8.8')).toBe(true);
  });
});

describe('PR9 mandatory deck', () => {
  it.each(mandatory)('%s fails or succeeds at the declared step', async (name) => {
    const vector = buildRappidCardFixture(name);
    const { verdict } = await simulateRappidCardFixture(name, statePath(name));
    expect(verdict.ok).toBe(vector.expected.ok);
    expect(verdict.step).toBe(vector.expected.step);
    if (vector.expected.reason_contains !== null) {
      expect(verdict.reason).toContain(vector.expected.reason_contains);
    }
  });

  it('accepts the production vector with explicit signed delegation', async () => {
    const vector = buildRappidCardFixture('valid-production');
    const { verdict } = await simulateRappidCardFixture(
      vector.name,
      statePath('production'),
    );
    expect(verdict).toMatchObject({
      ok: true,
      step: null,
      reason: 'awake',
      result: { profile: 'rappid-card/1', status: 'awake' },
    });
    expect(vector.frame.payload.key_id).not.toContain('@synthetic/');
    expect(
      vector.authority_view.authorizations.some(
        (entry) =>
          entry.issuer_key_id === vector.frame.payload.key_id
          && entry.role === 'card-issuer',
      ),
    ).toBe(true);
  });

  it('covers manifest, key, and subject revocation independently', async () => {
    for (const name of ['manifest-revoked', 'key-revoked', 'subject-revoked']) {
      const { verdict } = await simulateRappidCardFixture(name, statePath(name));
      expect(verdict.step).toBe('revocation');
    }
  });
});

describe('physical payload reproduction', () => {
  it('uses canonical eleven-key frame bytes and exact compact link', () => {
    const physical = physicalVectorBytes();
    const frame = readCardResource(physical.frame);
    const link = physical.link.toString('utf8').trim();
    const vector = buildRappidCardFixture('physical-payload-reproduction');
    const parsed = parseCardLink(link);
    expect(physical.frame.toString('utf8')).toBe(canonical(frame));
    expect(frame).toEqual(vector.frame);
    expect(link).toBe(vector.link);
    expect(parsed.manifest_hash).toBe(frame.payload_hash);
    expect(frame.payload_hash).toBe(H('rapp/1:particle', frame.payload));
    expect(Object.keys(frame).sort()).toEqual([...FRAME_KEYS].sort());
  });

  it('renders the exact physical URI as genuine SVG and PNG QR artifacts', async () => {
    const link = physicalVectorBytes().link.toString('utf8').trim();
    const svg = await renderRappidCardQrSvg(link);
    const png = await renderRappidCardQrPng(link);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});

describe('detached JWS, content roots, and durable state', () => {
  it('binds every trust SPKI to its keyed RAPPID tail', () => {
    const deck = loadRappidCardDeck();
    const keys = Object.fromEntries(
      deck.trust.map((entry) => [entry.kid, Buffer.from(entry.spki_der_b64, 'base64')]),
    );
    expect(() => new CardTrustStore(keys, deck.vectors[0].runtime_policy_authority))
      .not.toThrow();
    const [kid, spki] = Object.entries(keys)[0];
    const mutated = Buffer.from(spki);
    mutated[mutated.length - 1] ^= 1;
    expect(() =>
      new CardTrustStore({ ...keys, [kid]: mutated }, deck.vectors[0].runtime_policy_authority),
    ).toThrow(/does not bind/);
  });

  it('uses rapp/1:egg roots for exactly soul, engram, and reflex-capability', () => {
    const frame = buildRappidCardFixture('valid-test').frame;
    const parts = cardParts();
    expect(frame.payload.inventory.map((entry) => entry.part)).toEqual([
      'engram', 'reflex-capability', 'soul',
    ]);
    for (const entry of frame.payload.inventory) {
      expect(entry.space).toBe('rapp/1:egg');
      expect(entry.hash).toBe(Hb('rapp/1:egg', parts[entry.part]));
    }
  });

  it('proves all seven prohibited-material scenarios depend on the scanners', async () => {
    const controls = loadRappidCardDeck().vectors.filter(
      (vector) => vector.scanner_control,
    );
    expect(controls).toHaveLength(7);
    for (const vector of controls) {
      const state = await stateForVector(
        vector,
        statePath(`scanner-${vector.name}`),
      );
      const parts = cardParts();
      const verdict = verifyCardLinkScannerControlForTest({
        uri: vector.link,
        frame: vector.frame,
        trust: cardTrust(vector),
        now_utc: vector.now_utc,
        runtime_policy: vector.runtime_policy,
        authority_view: vector.authority_view,
        revocation_view: vector.revocation_view,
        state,
        connection_id: vector.connection_id,
        fetch_trace: vector.fetch_trace,
        hydrated: Object.fromEntries(
          vector.hydrated_parts.map((part) => [part, parts[part]]),
        ),
        continuity: vector.continuity,
      });
      expect(verdict.ok, `${vector.name}: ${verdict.reason}`).toBe(true);
    }
  });

  it('persists hydrating, resumes same connection after restart, then commits awake', async () => {
    const vector = buildRappidCardFixture('missing-engram-part');
    const path = statePath('restart');
    const first = await simulateRappidCardFixture(vector.name, path);
    const nonce = parseCardLink(vector.link).nonce;
    expect(first.verdict.step).toBe('hydration');
    expect(first.state.nonceState(nonce)?.state).toBe('hydrating');
    const resumed = await simulateRappidCardFixture(
      vector.name,
      path,
      ['engram', 'reflex-capability', 'soul'],
    );
    expect(resumed.verdict.ok).toBe(true);
    expect(resumed.state.nonceState(nonce)?.state).toBe('awake');
  });

  it('rejects nonce contention and signed-view rollback/fork', async () => {
    const path = statePath('state');
    const state = await SQLiteCardState.open(path);
    const authority = loadRappidCardDeck().vectors[0].runtime_policy.authority_rappid;
    expect(state.claimNonce('thread-contention-nonce', 'connection-a', '2026-08-21T12:30:00.000Z')[0]).toBe(true);
    expect(state.claimNonce('thread-contention-nonce', 'connection-b', '2026-08-21T12:30:00.000Z')[0]).toBe(false);
    expect(state.acceptSequence('card-revocation', authority, 10, 'a'.repeat(64))[0]).toBe(true);
    expect(state.acceptSequence('card-revocation', authority, 9, 'b'.repeat(64))[0]).toBe(false);
    expect(state.acceptSequence('card-revocation', authority, 10, 'c'.repeat(64))[0]).toBe(false);
    expect(state.acceptSequence('card-revocation', authority, 11, 'd'.repeat(64))[0]).toBe(true);
  });
});

describe('artifact export', () => {
  it('exports all 49 canonical frame/link/trust fixtures with provenance', async () => {
    const directory = join(process.cwd(), `.pr9-card-export-${process.pid}`);
    generated.push(directory);
    const result = await writeRappidCardFixtureDeck(directory, 'svg');
    expect(result.fixtures).toBe(49);
    expect(result.provenance).toBe('rapp-1 commit 392f850');
    expect(result.files.filter((file) => file.endsWith('/.rappid-card.json')))
      .toHaveLength(49);
    const physical = readFileSync(
      join(directory, 'physical-payload-reproduction', '.rappid-card.json'),
    );
    expect(physical).toEqual(physicalVectorBytes().frame);
  });
});
