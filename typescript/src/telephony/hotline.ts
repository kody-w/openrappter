/**
 * The inbound hotline gate.
 *
 * Your assistant has a phone number. That means strangers can call it. This is
 * the thing standing between a wrong number and your calendar, your contacts and
 * your invoices.
 *
 * Three rules, all enforced here rather than in a prompt:
 *   - known callers are recognised by number and skip the challenge
 *   - everyone else gets a fixed number of PIN attempts, then a lockout
 *   - the PIN comparison is constant-time, and failures never say why
 */

import { timingSafeEqual } from 'node:crypto';

export type GateOutcome = 'granted' | 'challenge' | 'denied' | 'locked';

export interface GateDecision {
  outcome: GateOutcome;
  /** What the agent should say next. Never leaks whether the number is known. */
  say: string;
  attemptsRemaining?: number;
  /** Seconds until this caller may try again. */
  retryAfterSeconds?: number;
}

export interface HotlineOptions {
  /** The PIN. Required unless `open` is true. */
  pin?: string;
  /** Numbers that skip the challenge entirely (E.164). */
  trustedNumbers?: string[];
  maxAttempts?: number;
  lockoutSeconds?: number;
  /** Explicitly run without a PIN. Must be opt-in — never the default. */
  open?: boolean;
  greeting?: string;
  challengePrompt?: string;
  now?: () => number;
}

interface CallerRecord {
  failures: number;
  lockedUntil: number;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // Compare equal-length buffers so length alone is not a timing oracle,
  // then fold the real length check into the boolean result.
  const width = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(width);
  const paddedRight = Buffer.alloc(width);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

export function normalizeNumber(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('sim:')) return trimmed;
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return `+${digits.slice(1).replace(/\D/g, '')}`;
  const bare = digits.replace(/\D/g, '');
  if (!bare) return trimmed;
  if (bare.length === 10) return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  return `+${bare}`;
}

export class HotlineGate {
  private readonly pin?: string;
  private readonly trusted: Set<string>;
  private readonly maxAttempts: number;
  private readonly lockoutSeconds: number;
  private readonly open: boolean;
  private readonly greeting: string;
  private readonly challengePrompt: string;
  private readonly now: () => number;
  private readonly callers = new Map<string, CallerRecord>();

  constructor(options: HotlineOptions) {
    if (!options.open && !options.pin) {
      throw new Error('HotlineGate needs a pin, or open:true to run deliberately unprotected');
    }
    if (options.pin && !/^\d{4,12}$/.test(options.pin)) {
      throw new Error('hotline pin must be 4-12 digits');
    }

    this.pin = options.pin;
    this.trusted = new Set((options.trustedNumbers ?? []).map(normalizeNumber));
    this.maxAttempts = options.maxAttempts ?? 3;
    this.lockoutSeconds = options.lockoutSeconds ?? 900;
    this.open = Boolean(options.open);
    this.greeting = options.greeting ?? 'Go ahead.';
    this.challengePrompt = options.challengePrompt ?? 'Please enter your access code.';
    this.now = options.now ?? Date.now;
  }

  isTrusted(from: string): boolean {
    return this.trusted.has(normalizeNumber(from));
  }

  /** First contact: does this caller need to prove themselves? */
  admit(from: string): GateDecision {
    const caller = normalizeNumber(from);
    const record = this.callers.get(caller);

    if (record && record.lockedUntil > this.now()) {
      return {
        outcome: 'locked',
        say: 'This line is not available right now. Goodbye.',
        retryAfterSeconds: Math.ceil((record.lockedUntil - this.now()) / 1000),
      };
    }

    if (this.open || this.isTrusted(caller)) {
      return { outcome: 'granted', say: this.greeting };
    }

    return {
      outcome: 'challenge',
      say: this.challengePrompt,
      attemptsRemaining: this.maxAttempts - (record?.failures ?? 0),
    };
  }

  /** Check a PIN attempt. Returns granted, another challenge, or a lockout. */
  submit(from: string, attempt: string | null): GateDecision {
    const caller = normalizeNumber(from);
    const record = this.callers.get(caller) ?? { failures: 0, lockedUntil: 0 };

    if (record.lockedUntil > this.now()) {
      return {
        outcome: 'locked',
        say: 'This line is not available right now. Goodbye.',
        retryAfterSeconds: Math.ceil((record.lockedUntil - this.now()) / 1000),
      };
    }

    const digits = (attempt ?? '').replace(/\D/g, '');
    if (this.pin && digits && constantTimeEquals(digits, this.pin)) {
      this.callers.delete(caller);
      return { outcome: 'granted', say: this.greeting };
    }

    record.failures += 1;

    if (record.failures >= this.maxAttempts) {
      record.lockedUntil = this.now() + this.lockoutSeconds * 1000;
      this.callers.set(caller, record);
      return {
        outcome: 'locked',
        say: 'This line is not available right now. Goodbye.',
        retryAfterSeconds: this.lockoutSeconds,
      };
    }

    this.callers.set(caller, record);
    return {
      outcome: 'denied',
      // Identical wording every time — a wrong PIN and an unknown caller are
      // indistinguishable from the outside.
      say: 'That code was not recognised. Please try again.',
      attemptsRemaining: this.maxAttempts - record.failures,
    };
  }

  /** Clear a lockout, e.g. when the owner vouches for a number. */
  reset(from: string): void {
    this.callers.delete(normalizeNumber(from));
  }

  trust(from: string): void {
    this.trusted.add(normalizeNumber(from));
    this.reset(from);
  }
}
