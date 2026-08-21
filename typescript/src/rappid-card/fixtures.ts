import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CardTrustStore } from './contract.js';
import { verifyCardLink } from './simulator.js';
import { SQLiteCardState } from './sqlite-state-store.js';
import type {
  CardDeck,
  CardVector,
  CardVerificationResult,
} from './types.js';
import { MANDATORY_CARD_SCENARIOS } from './types.js';

export const PROVENANCE_COMMIT = '392f850';

function vectorRoot(): string {
  const source = fileURLToPath(
    new URL('../../../tests/vectors/rapp-1-392f850/rappid-card/', import.meta.url),
  );
  if (existsSync(source)) return source;
  const packaged = fileURLToPath(new URL('./test-vectors/', import.meta.url));
  if (existsSync(packaged)) return packaged;
  throw new Error('vendored PR9 RAPPID card vectors are unavailable');
}

let cachedDeck: CardDeck | undefined;

export function loadRappidCardDeck(): CardDeck {
  cachedDeck ??= JSON.parse(
    readFileSync(join(vectorRoot(), 'deck.json'), 'utf8'),
  ) as CardDeck;
  return cachedDeck;
}

export const RAPPID_CARD_FIXTURE_NAMES = MANDATORY_CARD_SCENARIOS;

export function buildRappidCardFixture(name: string): CardVector {
  const vector = loadRappidCardDeck().vectors.find((entry) => entry.name === name);
  if (!vector) throw new Error(`unknown PR9 RAPPID card scenario: ${name}`);
  return structuredClone(vector);
}

export function cardParts(): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(loadRappidCardDeck().parts_b64).map(([name, value]) => [
      name,
      Buffer.from(value, 'base64'),
    ]),
  );
}

export function cardTrust(vector: CardVector): CardTrustStore {
  const keys = Object.fromEntries(
    loadRappidCardDeck().trust.map((entry) => [
      entry.kid,
      Buffer.from(entry.spki_der_b64, 'base64'),
    ]),
  );
  return new CardTrustStore(keys, vector.runtime_policy_authority);
}

export async function stateForVector(
  vector: CardVector,
  path: string,
): Promise<SQLiteCardState> {
  const state = await SQLiteCardState.open(path);
  for (const nonce of vector.state_seed.nonces) {
    state.seedNonce(nonce.nonce, nonce.connection_id, nonce.state, nonce.utc);
  }
  for (const sequence of vector.state_seed.sequences) {
    state.seedSequence(
      sequence.namespace,
      sequence.authority,
      sequence.seq,
      sequence.view_hash,
    );
  }
  return state;
}

export async function simulateRappidCardFixture(
  name: string,
  statePath: string,
  hydratedParts?: string[],
): Promise<{ verdict: CardVerificationResult; state: SQLiteCardState }> {
  const vector = buildRappidCardFixture(name);
  const state = await stateForVector(vector, statePath);
  const parts = cardParts();
  const selected = hydratedParts ?? vector.hydrated_parts;
  const verdict = verifyCardLink({
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
    hydrated: Object.fromEntries(selected.map((part) => [part, parts[part]])),
    continuity: vector.continuity,
  });
  return { verdict, state };
}

export function listRappidCardFixtures(): Array<{
  name: string;
  profile: string;
  kind: string;
  physical: boolean;
  expected: CardVector['expected'];
}> {
  return loadRappidCardDeck().vectors.map((vector) => ({
    name: vector.name,
    profile: vector.frame.payload.profile,
    kind: vector.frame.kind,
    physical: vector.physical,
    expected: vector.expected,
  }));
}

export function physicalVectorBytes(): {
  frame: Buffer;
  link: Buffer;
} {
  return {
    frame: readFileSync(join(vectorRoot(), 'physical.rappid-card.json')),
    link: readFileSync(join(vectorRoot(), 'physical-payload.txt')),
  };
}

export function vectorDirectory(): string {
  return dirname(join(vectorRoot(), 'deck.json'));
}
