/**
 * Pulling a concrete offer out of what a person just said.
 *
 * A language model can do this too, and in production it does — but a phone
 * agent should never be *unable* to hear "how about seven forty-five" just
 * because a model call failed. This is the deterministic floor: cheap, offline,
 * and covered by tests. `CallAgent` accepts a smarter extractor when one exists.
 */

import type { Offer } from './types.js';

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

const NEGATIVE = /\b(?:no|not|none|nothing|fully booked|all booked|can't|cannot|unable|afraid not|sold out)\b/i;

/** "forty five" -> 45, "twenty" -> 20, "seven" -> 7. */
function wordsToNumber(text: string): number | null {
  const parts = text.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let matched = false;

  for (const part of parts) {
    const value = WORD_NUMBERS[part];
    if (value === undefined) return null;
    total += value;
    matched = true;
  }

  return matched ? total : null;
}

function toIso(date: string, hours: number, minutes: number): string {
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${date}T${hh}:${mm}:00`;
}

/**
 * Apply am/pm, or infer it. Business hours bias: a bare "7" from a restaurant
 * or a garage means 19:00 in the evening context and 07:00 never — but "9"
 * plausibly means 09:00. We only promote 1-6 to the afternoon, which covers
 * "half four" without turning "9" into 21:00.
 */
function applyMeridiem(hours: number, meridiem: string | undefined, hint: 'evening' | 'morning' | 'none'): number {
  if (meridiem === 'pm') return hours < 12 ? hours + 12 : hours;
  if (meridiem === 'am') return hours === 12 ? 0 : hours;
  if (hint === 'evening' && hours >= 1 && hours <= 11) return hours + 12;
  if (hint === 'none' && hours >= 1 && hours <= 6) return hours + 12;
  return hours;
}

export interface ExtractOptions {
  /** The date the call is about, as YYYY-MM-DD. Times are attached to it. */
  date: string;
  /** Biases bare numbers. A dinner booking should hear "7" as 19:00. */
  hint?: 'evening' | 'morning' | 'none';
}

const HOUR_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const MINUTE_WORD =
  '(?:(?:twenty|thirty|forty|fifty)(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?|' +
  'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|' +
  'oh[\\s-](?:one|two|three|four|five|six|seven|eight|nine)|o\'?clock)';

const SPOKEN_TIME = new RegExp(`\\b(${HOUR_WORD})\\b(?:[\\s-]+(${MINUTE_WORD}))?`, 'gi');

/** Words that, immediately before a number, mean a time is being proposed. */
const TIME_LEAD_IN = /(?:\bat|\baround|\babout|\bby|\buntil|\btill|\bfrom|\bafter|\bbefore|\bdo|\bmake it|\bsay|\btry|\bhow about|\bwhat about|\bcome in at)[\s,]+$/i;

const HAS_PM = /\b(?:pm|p\.m\.)\b|\bevening\b|\btonight\b/i;
const HAS_AM = /\b(?:am|a\.m\.)\b|\bmorning\b/i;

/**
 * Find a spoken time, requiring evidence that a number really is one.
 *
 * "one moment please" contains the word "one"; it is not an offer of 13:00.
 * A candidate only counts when it is followed by minutes or "o'clock", led in
 * by a word like "at" or "could do", or accompanied by am/pm in the sentence.
 */
function extractSpokenTime(text: string, date: string, hint: 'evening' | 'morning' | 'none'): string | null {
  const meridiem = HAS_PM.test(text) ? 'pm' : HAS_AM.test(text) ? 'am' : undefined;
  let best: string | null = null;

  SPOKEN_TIME.lastIndex = 0;
  for (const match of text.matchAll(SPOKEN_TIME)) {
    const hourWord = wordsToNumber(match[1]);
    if (hourWord === null || hourWord < 1 || hourWord > 12) continue;

    const minuteToken = match[2]?.toLowerCase();
    const isOClock = Boolean(minuteToken && /o'?clock/.test(minuteToken));
    const minutes = minuteToken && !isOClock ? wordsToNumber(minuteToken.replace(/\boh[\s-]/, '')) : 0;
    if (minutes === null || minutes >= 60) continue;

    const leadIn = TIME_LEAD_IN.test(text.slice(0, match.index));
    const hasEvidence = Boolean(minuteToken) || isOClock || leadIn || meridiem !== undefined;
    if (!hasEvidence) continue;

    best = toIso(date, applyMeridiem(hourWord, meridiem, hint), minutes);
  }

  return best;
}

/**
 * Returns null when the utterance contains no offer at all — which is different
 * from an offer of nothing, and lets the agent keep listening.
 */
export function extractOffer(utterance: string, options: ExtractOptions): Offer | null {
  const text = utterance.trim();
  if (!text) return null;

  const hint = options.hint ?? 'none';
  const offer: Offer = {};
  let found = false;

  // 7:45 / 19:45 / 7:45pm
  const digitTime = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(text);
  if (digitTime) {
    const hours = applyMeridiem(Number(digitTime[1]), digitTime[3]?.toLowerCase(), hint);
    offer.start = toIso(options.date, hours, Number(digitTime[2]));
    found = true;
  }

  // 7pm / 7 pm
  if (!found) {
    const bareDigit = /\b(\d{1,2})\s*(am|pm)\b/i.exec(text);
    if (bareDigit) {
      const hours = applyMeridiem(Number(bareDigit[1]), bareDigit[2].toLowerCase(), hint);
      offer.start = toIso(options.date, hours, 0);
      found = true;
    }
  }

  // "quarter past seven", "half seven" — checked before the general scan,
  // because "past seven" would otherwise be read as a bare hour.
  if (!found) {
    const quarterPast = /\bquarter past (\w+)\b/i.exec(text);
    const halfPast = /\bhalf (?:past )?(\w+)\b/i.exec(text);
    const match = quarterPast ?? halfPast;
    if (match) {
      const hourWord = wordsToNumber(match[1]);
      if (hourWord !== null && hourWord >= 1 && hourWord <= 12) {
        offer.start = toIso(options.date, applyMeridiem(hourWord, undefined, hint), quarterPast ? 15 : 30);
        found = true;
      }
    }
  }

  // "seven forty-five", "eight thirty", "seven o'clock"
  //
  // Scanning every candidate rather than the first one matters: a real reply is
  // "Seven is fully booked, but I could do seven forty-five" — the first number
  // is the thing being refused, not the thing being offered. We take the last
  // candidate that actually looks like a time.
  if (!found) {
    const spelled = extractSpokenTime(text, options.date, hint);
    if (spelled) {
      offer.start = spelled;
      found = true;
    }
  }

  // $450 / 450 dollars
  const price = /\$\s*([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i.exec(text);
  if (price) {
    const amount = Number((price[1] ?? price[2]).replace(/,/g, ''));
    if (Number.isFinite(amount)) {
      offer.priceCents = Math.round(amount * 100);
      found = true;
    }
  }

  // "table for four", "party of 2"
  const party = /\b(?:table|party|booking|seats?)\s*(?:for|of)\s*(\d+|\w+)\b/i.exec(text);
  if (party) {
    const size = /^\d+$/.test(party[1]) ? Number(party[1]) : wordsToNumber(party[1]);
    if (size !== null && size > 0 && size < 100) {
      offer.partySize = size;
      found = true;
    }
  }

  if (!found) return null;

  offer.note = text;
  return offer;
}

/**
 * True when the peer is saying no rather than proposing something. Used to end
 * a negotiation instead of looping on an utterance that carries no offer.
 */
export function soundsLikeRefusal(utterance: string): boolean {
  return NEGATIVE.test(utterance) && !/\b(?:but|however|could do|can do|how about|what about)\b/i.test(utterance);
}

/** True when the peer accepted what the agent just proposed. */
export function soundsLikeAgreement(utterance: string): boolean {
  return /\b(?:yes|yep|yeah|sure|of course|that works|that's fine|perfect|booked|done|confirmed|see you then|no problem|all set)\b/i.test(
    utterance,
  );
}
