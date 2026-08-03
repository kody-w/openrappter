/**
 * What this organism is called.
 *
 * Two names, both pure functions of one secret:
 *
 *   designation  openrappter-RX-4471   formal, unique, verifiable
 *   called name  Rex                   what it actually goes by
 *
 * The mechanic is Poe Dameron's: he looked at FN-2187 and said "Finn". The
 * friendly name is *derived from* the serial number rather than assigned
 * instead of it, so it carries the same identity rather than replacing it.
 *
 * ── The precision point ────────────────────────────────────────────────────
 *
 * The name comes from the RAPPID, never from the tail.
 *
 * The tail is the 64-hex secret RAPP/1 6.2 mints exactly once and never
 * re-rolls. `rappdex` states it plainly: "your tail is never in it." Naming an
 * organism after the leading characters of its own mint-once secret would leak
 * the one value the whole scheme depends on staying private -- into a window
 * title, a URL, a log line and this page.
 *
 * So the rappid is a *public* value derived from the tail by the same
 * domain-separated construction the alleles already use:
 *
 *   rappid_hex = sha256("rapp/1:rappid\n" + tail)
 *
 * I checked `rapp-mapp/ALLELE.md` and `rappdex/allele.js` first, because the
 * spec wins over any file I write. RAPP/1 specifies the tail (6.2), the allele
 * derivation, and domain separation (5) -- but it does NOT specify a public
 * rappid encoding. So this defines one in the established pattern: a new domain
 * string, which 5 guarantees cannot collide with the particle, wave, egg or
 * allele spaces. Deterministic, offline-verifiable, and it reveals nothing
 * about the tail.
 */

import { createHash, randomUUID } from 'crypto';

/** Domain-separated per RAPP/1 5. Must not collide with allele/egg/wave/particle. */
const RAPPID_DOMAIN = 'rapp/1:rappid';

export interface OrganismName {
  /** `openrappter-RX-4471` -- formal, unique, quotable. */
  designation: string;
  /** `RX-4471` -- the serial on its own. */
  serial: string;
  /** `Rex` -- what it goes by. */
  called: string;
  /** True when the called name came from SOUL.md rather than the hash. */
  chosen: boolean;
}

/** The public rappid for a tail. Safe to display; reveals nothing about the tail. */
export function rappidHex(tail: string): string {
  return createHash('sha256').update(`${RAPPID_DOMAIN}\n${tail}`).digest('hex');
}

/** Mint a new tail -- 64 hex, once, per 6.2. Callers must never re-mint. */
export function mintTail(): string {
  return createHash('sha256')
    .update(`${randomUUID()}${randomUUID()}`)
    .digest('hex');
}

/**
 * Vowel cores and endings, indexed by the hash.
 *
 * Digraphs are included so the output has range -- FN with "i" gives Finn, TK
 * with "ee" gives Teek. Every core is a vowel sound, so a consonant pair can
 * never come out as a bare cluster.
 */
const CORES = ['a', 'e', 'i', 'o', 'u', 'ay', 'ee', 'ei', 'oo', 'ia'];
const ENDINGS = ['', 'n', 'o', 'a', 'i', 'e', 'ix', 'us'];

/**
 * Names that must never be emitted.
 *
 * Two letters plus vowels will eventually spell something obscene or a slur.
 * This goes on a public surface, so a hit deterministically advances to the
 * next core rather than shipping it.
 */
const BLOCKED_EXACT = new Set([
  'ass', 'fag', 'gay', 'jew', 'nazi', 'kike', 'spic', 'wop', 'coon', 'chink',
  'cunt', 'dick', 'cock', 'shit', 'piss', 'twat', 'slut', 'whore', 'rape',
  'hell', 'damn', 'anus', 'butt', 'turd', 'wank', 'homo', 'jap', 'paki',
  'gook', 'dyke', 'kill', 'die', 'pee', 'poo', 'gas',
]);
const BLOCKED_SUBSTRING = [
  'nig', 'fag', 'cun', 'fuk', 'fuc', 'sex', 'rape', 'kkk', 'jizz', 'cum',
  'tit', 'ars', 'jiz', 'sht',
];

export function isBlockedName(candidate: string): boolean {
  const c = candidate.toLowerCase();
  if (BLOCKED_EXACT.has(c)) return true;
  return BLOCKED_SUBSTRING.some(b => c.includes(b));
}

/**
 * Would a person say this out loud without stumbling?
 *
 * "Deterministic" and "pronounceable" are different requirements, and the first
 * attempt only had the first: it emitted Kuwwn, Geijjn and Xicix, which are
 * deterministic and unsayable. The generator explores its table in a fixed
 * order, so rejecting a candidate here costs nothing — it advances to the next
 * one and stays deterministic.
 */
export function isPronounceable(candidate: string): boolean {
  const c = candidate.toLowerCase();
  // Letters that do not double in English and read as typos when they do.
  if (/(ww|xx|qq|jj|vv|yy|hh|kk|zz)/.test(c)) return false;
  // Three of anything is always a mistake.
  if (/(.)\1\1/.test(c)) return false;
  // A hard consonant needs a vowel after it, not another consonant.
  if (/[xqwvj][bcdfghjklmnpqrstvwxz]/.test(c)) return false;
  // Two different awkward consonants together.
  if (/[xzq][xzqj]/.test(c)) return false;
  // The same awkward consonant opening and closing the name (Xicix).
  if (/^[xzqj]/.test(c) && /[xzqj]$/.test(c)) return false;
  // Must end on a vowel or a consonant that can actually close a syllable.
  if (!/[aeiou]$/.test(c) && !/[nlmrstxbdgkp]$/.test(c)) return false;
  return true;
}

function byteAt(hex: string, index: number): number {
  return parseInt(hex.slice(index * 2, index * 2 + 2), 16);
}

/** `RX-4471` -- two letters and four digits, read out of the rappid. */
export function serialFrom(rappid: string): string {
  const a = String.fromCharCode(65 + (byteAt(rappid, 0) % 26));
  const b = String.fromCharCode(65 + (byteAt(rappid, 1) % 26));
  const digits = ((byteAt(rappid, 2) << 8) | byteAt(rappid, 3)) % 10000;
  return `${a}${b}-${String(digits).padStart(4, '0')}`;
}

/**
 * The Finn move: make the two letters speakable.
 *
 * `C1 + core + C2 + ending` — exactly the shape of the worked examples:
 *
 *   FN + i  + n  -> Finn      RX + e  + ''  -> Rex
 *   TK + ee + '' -> Teek      BB + i  + i   -> Bibi
 *   DZ + e  + a  -> Deza      KL + ay + o   -> Kaylo
 *
 * Core and ending both come from later bytes of the same hash, so one rappid
 * always yields one name — on any device, forever, with no clock and no
 * counter. A blocklisted or unsayable result advances deterministically, which
 * keeps that property while guaranteeing the output is shippable.
 */
export function calledNameFrom(rappid: string): string {
  const c1 = String.fromCharCode(65 + (byteAt(rappid, 0) % 26));
  const c2 = String.fromCharCode(65 + (byteAt(rappid, 1) % 26)).toLowerCase();
  const coreStart = byteAt(rappid, 4) % CORES.length;
  const endStart = byteAt(rappid, 5) % ENDINGS.length;

  const total = CORES.length * ENDINGS.length;
  for (let attempt = 0; attempt < total; attempt++) {
    // Walk endings in the outer loop so the core (which carries most of the
    // character) varies first.
    const core = CORES[(coreStart + attempt) % CORES.length];
    const ending = ENDINGS[(endStart + Math.floor(attempt / CORES.length)) % ENDINGS.length];
    const candidate = `${c1}${core}${c2}${ending}`;
    if (isBlockedName(candidate) || !isPronounceable(candidate)) continue;
    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }
  // Every combination rejected — fall back to the plainest possible form.
  return `${c1}${CORES[0]}${c2}`.charAt(0).toUpperCase()
    + `${c1}${CORES[0]}${c2}`.slice(1);
}

/**
 * Both names for a tail.
 *
 * `chosenName` is a user-supplied name (from SOUL.md). It overrides the called
 * name and leaves the designation untouched: what it answers to can change,
 * what it *is* cannot.
 */
export function nameFor(tail: string, chosenName?: string | null): OrganismName {
  const rappid = rappidHex(tail);
  const serial = serialFrom(rappid);
  const derived = calledNameFrom(rappid);
  const chosen = typeof chosenName === 'string' && chosenName.trim().length > 0;
  return {
    designation: `openrappter-${serial}`,
    serial,
    called: chosen ? chosenName!.trim() : derived,
    chosen,
  };
}
