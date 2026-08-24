/**
 * The one canonical identity.
 *
 * A Quantum RAPPID is named exactly once. Dimensions, traits, media hashes,
 * weights, heights and lifecycle stages are all downstream of that name and
 * none of them may produce a new one — growth appends, it does not re-mint.
 * The only thing that gets a fresh RAPPID is a true child, and a child says so
 * with an explicit parent pointer.
 *
 * The public identity value is the one `src/identity/name.ts` already defines
 * (`sha256("rapp/1:rappid\n" + tail)`), re-exported here rather than
 * re-derived: two spellings of an identity format is how a fork starts.
 *
 * Mirrored by `python/openrappter/rappids/identity.py`.
 */

import { rappidHex } from '../identity/name.js';
import { QuantumRappidError } from './types.js';
import type { RappidParts } from './types.js';

export { rappidHex };

/** `rappid:@owner/name:<64 hex>` — the address form used on disk. */
const RAPPID_PATTERN = /^rappid:@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*):([0-9a-f]{64})$/;

export function isRappid(value: unknown): value is string {
  return typeof value === 'string' && RAPPID_PATTERN.test(value);
}

export function parseRappid(value: string): RappidParts {
  const match = RAPPID_PATTERN.exec(value);
  if (!match) {
    throw new QuantumRappidError(
      'invalid-rappid',
      `not a RAPPID: ${JSON.stringify(value)} (expected rappid:@owner/name:<64 hex>)`,
    );
  }
  return { owner: match[1], name: match[2], hex: match[3] };
}

export function formatRappid(parts: RappidParts): string {
  const value = `rappid:@${parts.owner}/${parts.name}:${parts.hex}`;
  // Round-trip rather than trust the caller: a malformed owner or name would
  // otherwise become a permanent identity that nothing can parse back.
  parseRappid(value);
  return value;
}

/**
 * The identity a habitat directory claims, from its own name.
 *
 * A directory is a filing decision, not an identity, so this returns null for
 * anything that is not a bare 64-hex name instead of guessing one.
 */
export function directoryHex(directoryName: string): string | null {
  return /^[0-9a-f]{64}$/.test(directoryName) ? directoryName : null;
}

/**
 * Every place a document repeats the RAPPID, checked against the first one.
 *
 * Drift here is the failure that matters most: one file re-minted, or two
 * organisms merged by hand, produce an object that still *looks* like one
 * creature while carrying two identities. Callers get the mismatching sources
 * rather than a boolean so the report can name the file that drifted.
 */
export function identityDrift(
  expected: string,
  claims: ReadonlyArray<{ source: string; value: string | null }>,
): Array<{ source: string; value: string | null }> {
  return claims.filter((claim) => claim.value !== expected);
}

/**
 * A parent pointer is only meaningful for a true child.
 *
 * Null means "this organism was minted, not born". A value must be a RAPPID
 * and must not be the organism itself: self-parenthood is the shape a
 * re-minting bug takes when it tries to look like lineage.
 */
export function validateParentPointer(rappid: string, parent: string | null): void {
  if (parent === null) return;
  if (!isRappid(parent)) {
    throw new QuantumRappidError(
      'invalid-parent',
      `parent_rappid is not a RAPPID: ${JSON.stringify(parent)}`,
    );
  }
  if (parent === rappid) {
    throw new QuantumRappidError(
      'self-parent',
      `${rappid} points at itself as its parent; growth appends to an organism, it never re-mints one`,
    );
  }
}
