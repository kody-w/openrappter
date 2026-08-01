import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderSoul, toShape, fingerprint } from './index.js';
import type { TwinProfile } from './types.js';

/**
 * The twin lives on either set of bones.
 *
 * The GOD half belongs to the operator, not to a platform — so the same vault
 * file must render the same persona whether the grail brainstem (Python) or
 * openrappter (TypeScript) is reading it. A twin that only works on one
 * platform is not a twin, it is lock-in.
 *
 * Python side: python3 python/tests/test_twin_agent.py
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'tests', 'twin-parity.json'), 'utf8'));

const profile = fixture.profile as TwinProfile;
const secrets = fixture.secrets as string[];

describe('twin portability across bones', () => {
  it('the fixture is present and populated', () => {
    expect(secrets.length).toBeGreaterThan(4);
    expect(profile.identity.name).toBeTruthy();
  });

  for (const audience of ['owner', 'trusted', 'public'] as const) {
    describe(`${audience} projection`, () => {
      const expectations = fixture.expect[audience];

      it(expectations.$why, () => {
        const soul = renderSoul(profile, { audience });

        for (const needle of expectations.contains as string[]) {
          expect(soul, `${audience} should contain ${needle}`).toContain(needle);
        }
        for (const needle of expectations.absent as string[]) {
          expect(soul, `${audience} LEAKED ${needle}`).not.toContain(needle);
        }
      });
    });
  }

  it('accounts never reach the prompt, on any audience', () => {
    for (const audience of ['owner', 'trusted', 'public'] as const) {
      const soul = renderSoul(profile, { audience });
      expect(soul).not.toContain('private.person@example.com');
      expect(soul).not.toContain('+15551234567');
    }
  });

  it('the public projection leaks none of the fixture secrets', () => {
    const soul = renderSoul(profile, { audience: 'public' });
    for (const secret of secrets) {
      expect(soul, `the public soul leaked ${secret}`).not.toContain(secret);
    }
  });

  it('the shape export matches the fixture exactly', () => {
    expect(toShape(profile).present).toEqual(fixture.shape.present);
  });

  it('the shape carries no values', () => {
    const body = JSON.stringify(toShape(profile));
    for (const secret of secrets) expect(body).not.toContain(secret);
    expect(body).not.toContain('Alex Doe');
  });

  it('the fingerprint is stable and reveals nothing', () => {
    expect(fingerprint(profile)).toBe(fingerprint(JSON.parse(JSON.stringify(profile))));
    expect(fingerprint(profile)).toMatch(/^[0-9a-f]{16}$/);
  });
});
