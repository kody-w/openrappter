/**
 * Constraint evaluation — the part of a phone-calling agent that must never be
 * left to a language model.
 *
 * An LLM decides what to *say*. This file decides what the agent is *allowed to
 * agree to*. Keeping that boundary sharp is the difference between an assistant
 * that books you a table and one that books you a table at 11pm on the wrong day.
 */

import type { Constraint, Decision, Offer, CallObjective, Violation } from './types.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Minutes since midnight for "HH:MM" / "H:MM" / "7pm" / "7:30 pm". */
export function timeToMinutes(text: string): number {
  const trimmed = text.trim().toLowerCase();
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(trimmed);
  if (!match) throw new Error(`not a time: ${text}`);

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) throw new Error(`time out of range: ${text}`);

  return hours * 60 + minutes;
}

/** Parse an ISO-8601 local datetime without letting the host timezone shift it. */
export function parseLocalIso(iso: string): { date: string; minutes: number; weekday: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso.trim());
  if (!match) throw new Error(`not an ISO datetime: ${iso}`);

  const [, year, month, day, hour, minute] = match;
  const asUtc = new Date(`${year}-${month}-${day}T00:00:00Z`);

  return {
    date: `${year}-${month}-${day}`,
    minutes: Number(hour) * 60 + Number(minute),
    weekday: asUtc.getUTCDay(),
  };
}

function safeTime(text: string): string | null {
  try {
    timeToMinutes(text);
    return text;
  } catch {
    return null;
  }
}

/**
 * Turn the phrases a person actually types into a machine-checkable rule.
 * Returns null rather than guessing — an unparsed constraint must be surfaced,
 * never silently dropped, or the agent would negotiate without its limits.
 */
export function parseConstraint(text: string): Constraint | null {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  const party = /party\s*(?:size|of)?\s*(?:is\s*)?(?:exactly\s*)?(\d+)/.exec(lower);
  if (party) return { kind: 'party_size', exactly: Number(party[1]), label: raw };

  const price = /(?:budget|under|max(?:imum)?|no more than)\s*(?:of\s*)?\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(lower);
  if (price) {
    const cents = Math.round(Number(price[1].replace(/,/g, '')) * 100);
    return { kind: 'max_price', cents, label: raw };
  }

  const notBefore = /\b(?:no earlier than|not before|not until|after|starting at|from)\s+([\d:]+\s*(?:am|pm)?)/.exec(lower);
  if (notBefore) {
    const time = safeTime(notBefore[1].trim());
    if (time) return { kind: 'not_before', time, label: raw };
  }

  // Checked second: "before" also appears inside "not before", so the
  // lower-bound phrasings above have to win first.
  const notAfter = /\b(?:no later than|not after|before|by|earlier than)\s+([\d:]+\s*(?:am|pm)?)/.exec(lower);
  if (notAfter) {
    const time = safeTime(notAfter[1].trim());
    if (time) return { kind: 'not_after', time, label: raw };
  }

  const day = DAYS.find((name) => new RegExp(`\\b${name}\\b`).test(lower));
  if (day) return { kind: 'day_of_week', days: [day], label: raw };

  return null;
}

/**
 * Parse a list of constraint phrases, keeping the ones that could not be
 * understood so the caller can refuse to dial rather than negotiate blind.
 */
export function parseConstraints(texts: string[]): { constraints: Constraint[]; unparsed: string[] } {
  const constraints: Constraint[] = [];
  const unparsed: string[] = [];

  for (const text of texts) {
    // "between 6pm and 8pm" is two rules, not one
    const between = /\bbetween\s+([\d:]+\s*(?:am|pm)?)\s+and\s+([\d:]+\s*(?:am|pm)?)/.exec(text.toLowerCase());
    if (between) {
      const from = safeTime(between[1].trim());
      const to = safeTime(between[2].trim());
      if (from && to) {
        constraints.push({ kind: 'not_before', time: from, label: text.trim() });
        constraints.push({ kind: 'not_after', time: to, label: text.trim() });
        continue;
      }
    }

    const parsed = parseConstraint(text);
    if (parsed) constraints.push(parsed);
    else unparsed.push(text);
  }

  return { constraints, unparsed };
}

/** Human-readable form, used in approval questions and call logs. */
export function describeConstraint(constraint: Constraint): string {
  if (constraint.label) return constraint.label;
  switch (constraint.kind) {
    case 'not_before':
      return `no earlier than ${constraint.time}`;
    case 'not_after':
      return `no later than ${constraint.time}`;
    case 'on_date':
      return `on ${constraint.date}`;
    case 'day_of_week':
      return `on ${constraint.days.join(' or ')}`;
    case 'party_size':
      return `party of exactly ${constraint.exactly}`;
    case 'max_price':
      return `no more than ${(constraint.cents / 100).toFixed(2)}`;
  }
}

/** Every hard limit the offer breaks. Empty means the agent *may* say yes. */
export function checkConstraints(constraints: Constraint[], offer: Offer): Violation[] {
  const violations: Violation[] = [];
  const when = offer.start ? parseLocalIso(offer.start) : null;

  for (const constraint of constraints) {
    switch (constraint.kind) {
      case 'not_before': {
        if (!when) break;
        if (when.minutes < timeToMinutes(constraint.time)) {
          violations.push({ constraint, detail: `offered time is before ${constraint.time}` });
        }
        break;
      }
      case 'not_after': {
        if (!when) break;
        if (when.minutes > timeToMinutes(constraint.time)) {
          violations.push({ constraint, detail: `offered time is after ${constraint.time}` });
        }
        break;
      }
      case 'on_date': {
        if (when && when.date !== constraint.date) {
          violations.push({ constraint, detail: `offered ${when.date}, needed ${constraint.date}` });
        }
        break;
      }
      case 'day_of_week': {
        if (!when) break;
        const wanted = constraint.days.map((d) => d.toLowerCase());
        if (!wanted.includes(DAYS[when.weekday])) {
          violations.push({ constraint, detail: `offered a ${DAYS[when.weekday]}` });
        }
        break;
      }
      case 'party_size': {
        if (offer.partySize !== undefined && offer.partySize !== constraint.exactly) {
          violations.push({ constraint, detail: `offered for ${offer.partySize}, needed ${constraint.exactly}` });
        }
        break;
      }
      case 'max_price': {
        if (offer.priceCents !== undefined && offer.priceCents > constraint.cents) {
          violations.push({ constraint, detail: `quoted ${(offer.priceCents / 100).toFixed(2)}` });
        }
        break;
      }
    }
  }

  return violations;
}

/** True when the offer is exactly what the owner asked for. */
export function matchesIdeal(ideal: Offer | undefined, offer: Offer): boolean {
  if (!ideal) return false;

  if (ideal.start && offer.start) {
    const wanted = parseLocalIso(ideal.start);
    const got = parseLocalIso(offer.start);
    if (wanted.date !== got.date || wanted.minutes !== got.minutes) return false;
  } else if (ideal.start && !offer.start) {
    return false;
  }

  if (ideal.partySize !== undefined && offer.partySize !== undefined && ideal.partySize !== offer.partySize) {
    return false;
  }
  if (ideal.priceCents !== undefined && offer.priceCents !== undefined && offer.priceCents > ideal.priceCents) {
    return false;
  }
  return true;
}

export function describeOffer(offer: Offer): string {
  const parts: string[] = [];
  if (offer.start) {
    const { date, minutes } = parseLocalIso(offer.start);
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    parts.push(`${date} at ${hh}:${mm}`);
  }
  if (offer.partySize !== undefined) parts.push(`party of ${offer.partySize}`);
  if (offer.priceCents !== undefined) parts.push(`$${(offer.priceCents / 100).toFixed(2)}`);
  return parts.join(', ') || offer.note || 'the offer';
}

/**
 * The whole policy, in one pure function.
 *
 *   breaks a hard limit  ->  counter (or decline once the peer is out of room)
 *   meets the limits and is exactly what was asked for  ->  accept
 *   meets the limits but is not what was asked for      ->  escalate to the owner
 *
 * That last line is the behaviour people actually want from an assistant with
 * their phone: autonomous within the mandate, and never outside it.
 */
export function decide(
  objective: CallObjective,
  offer: Offer,
  options: { roomToNegotiate?: boolean } = {},
): Decision {
  const violations = checkConstraints(objective.constraints ?? [], offer);

  if (violations.length > 0) {
    const summary = violations.map((v) => describeConstraint(v.constraint)).join('; ');
    const roomToNegotiate = options.roomToNegotiate ?? true;
    return {
      action: roomToNegotiate ? 'counter' : 'decline',
      reason: `offer breaks a hard limit (${summary})`,
      violations,
    };
  }

  if (matchesIdeal(objective.ideal, offer)) {
    return { action: 'accept', reason: 'offer matches what was asked for', violations: [] };
  }

  if (!objective.ideal) {
    return {
      action: 'accept',
      reason: 'offer is within all limits and nothing more specific was asked for',
      violations: [],
    };
  }

  return {
    action: 'escalate',
    reason: 'offer is within the limits but is not what was asked for',
    violations: [],
    question: `They offered ${describeOffer(offer)} instead of ${describeOffer(objective.ideal)}. Take it?`,
  };
}
