import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkConstraints,
  decide,
  extractOffer,
  parseConstraint,
  parseConstraints,
  soundsLikeAgreement,
  soundsLikeRefusal,
} from './index.js';
import type { CallObjective, Offer } from './types.js';

/**
 * Cross-implementation parity.
 *
 * openrappter's phone logic exists twice: here in TypeScript, and in Python at
 * python/openrappter/agents/phone_agent.py so a RAPP brainstem gets the same
 * capability with the same guardrails. There is no runtime both can import
 * from, so the duplication is unavoidable — but drift is not.
 *
 * Both suites read tests/decision-parity.json and must agree on every case.
 * Change the policy in one language without mirroring it, and both builds fail.
 *
 * Python side: python3 python/tests/test_phone_agent.py
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '..', '..', '..', 'tests', 'decision-parity.json');

interface Fixture {
  constraints: { text: string; expect: Record<string, unknown> | null }[];
  constraintLists: { texts: string[]; expectKinds: string[]; expectUnparsed: string[] }[];
  extraction: { utterance: string; date: string; hint?: string; expect: Record<string, unknown> | null; $why?: string }[];
  refusal: { utterance: string; expect: boolean }[];
  agreement: { utterance: string; expect: boolean }[];
  decisions: { objective: CallObjective; offer: Offer; roomToNegotiate?: boolean; expect: string; $why?: string }[];
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('decision parity with the Python brainstem agent', () => {
  it('the fixture is present and populated', () => {
    // A silently-missing fixture would turn this whole file into a no-op.
    expect(fixture.decisions.length).toBeGreaterThan(5);
    expect(fixture.extraction.length).toBeGreaterThan(5);
    expect(fixture.constraints.length).toBeGreaterThan(5);
  });

  describe('constraint parsing', () => {
    for (const testCase of fixture.constraints) {
      it(`${testCase.expect ? 'parses' : 'rejects'} "${testCase.text}"`, () => {
        const parsed = parseConstraint(testCase.text);

        if (testCase.expect === null) {
          // Silently dropping an unparsed limit is the bug this guards.
          expect(parsed).toBeNull();
          return;
        }

        expect(parsed).not.toBeNull();
        for (const [key, value] of Object.entries(testCase.expect)) {
          expect((parsed as unknown as Record<string, unknown>)[key]).toEqual(value);
        }
      });
    }
  });

  describe('constraint lists', () => {
    for (const testCase of fixture.constraintLists) {
      it(`handles ${JSON.stringify(testCase.texts)}`, () => {
        const { constraints, unparsed } = parseConstraints(testCase.texts);
        expect(constraints.map((c) => c.kind)).toEqual(testCase.expectKinds);
        expect(unparsed).toEqual(testCase.expectUnparsed);
      });
    }
  });

  describe('hearing an offer', () => {
    for (const testCase of fixture.extraction) {
      it(testCase.$why ?? `hears "${testCase.utterance}"`, () => {
        const offer = extractOffer(testCase.utterance, {
          date: testCase.date,
          hint: (testCase.hint ?? 'none') as 'evening' | 'morning' | 'none',
        });

        if (testCase.expect === null) {
          expect(offer).toBeNull();
          return;
        }

        expect(offer).not.toBeNull();
        for (const [key, value] of Object.entries(testCase.expect)) {
          expect((offer as unknown as Record<string, unknown>)[key]).toEqual(value);
        }
      });
    }
  });

  describe('reading the room', () => {
    for (const testCase of fixture.refusal) {
      it(`refusal: "${testCase.utterance}" -> ${testCase.expect}`, () => {
        expect(soundsLikeRefusal(testCase.utterance)).toBe(testCase.expect);
      });
    }

    for (const testCase of fixture.agreement) {
      it(`agreement: "${testCase.utterance}" -> ${testCase.expect}`, () => {
        expect(soundsLikeAgreement(testCase.utterance)).toBe(testCase.expect);
      });
    }
  });

  describe('the decision', () => {
    for (const testCase of fixture.decisions) {
      it(testCase.$why ?? `-> ${testCase.expect}`, () => {
        const decision = decide(testCase.objective, testCase.offer, {
          roomToNegotiate: testCase.roomToNegotiate ?? true,
        });
        expect(decision.action).toBe(testCase.expect);
      });
    }

    it('never escalates an illegal offer, at any hour', () => {
      const objective: CallObjective = {
        goal: 'Book a table',
        constraints: [{ kind: 'not_after', time: '20:00' }],
        ideal: { start: '2026-08-07T19:00:00' },
      };

      for (const time of ['21:00', '22:30', '23:59']) {
        const offer = { start: `2026-08-07T${time}:00` };
        expect(checkConstraints(objective.constraints, offer).length).toBeGreaterThan(0);
        expect(['escalate', 'accept']).not.toContain(decide(objective, offer).action);
      }
    });
  });
});
