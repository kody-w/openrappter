/**
 * Telephony types — an agent that can hold a real conversation on a real phone
 * line, and that knows the difference between a deal it may close and a deal it
 * must call you about first.
 */

export type CallDirection = 'inbound' | 'outbound';

/** Who spoke. Mirrors the RAPP Second Brain `call.turn` roles exactly. */
export type TurnRole = 'agent' | 'peer' | 'owner' | 'system';

export interface CallTurn {
  role: TurnRole;
  text: string;
  at: string;
}

/**
 * A concrete thing the other party put on the table: a time, a price, a size.
 * Extracted from what they said; evaluated against the objective.
 */
export interface Offer {
  /** ISO-8601 local datetime, e.g. 2026-08-07T19:45:00 */
  start?: string;
  partySize?: number;
  priceCents?: number;
  note?: string;
}

/**
 * Hard limits, declared up front and evaluated deterministically.
 *
 * These are deliberately data, not code: they are logged to the second brain
 * with the call, so afterwards you can see exactly which rule made the agent
 * stop and ask you.
 */
export type Constraint =
  | { kind: 'not_before'; time: string; label?: string }
  | { kind: 'not_after'; time: string; label?: string }
  | { kind: 'on_date'; date: string; label?: string }
  | { kind: 'day_of_week'; days: string[]; label?: string }
  | { kind: 'party_size'; exactly: number; label?: string }
  | { kind: 'max_price'; cents: number; label?: string };

export interface CallObjective {
  /** What the agent is trying to achieve, in plain language. */
  goal: string;
  /** Hard limits. Violating one of these is never acceptable. */
  constraints: Constraint[];
  /**
   * What the owner actually asked for. Meeting the constraints but missing this
   * is exactly the case that requires a callback rather than a decision.
   */
  ideal?: Offer;
}

export type DecisionAction = 'accept' | 'escalate' | 'counter' | 'decline';

export interface Violation {
  constraint: Constraint;
  detail: string;
}

export interface Decision {
  action: DecisionAction;
  reason: string;
  violations: Violation[];
  /** Set when action is 'escalate' — the question to put to the owner. */
  question?: string;
}

export interface DialRequest {
  to: string;
  from?: string;
  objective?: CallObjective;
  /** Opening line. Providers that own the greeting may ignore this. */
  greeting?: string;
  metadata?: Record<string, unknown>;
}

export interface CallHandle {
  id: string;
  provider: string;
  to: string;
  direction: CallDirection;
  /** Provider-side identifier, when the provider has its own. */
  externalId?: string;
}

export type CallStatus = 'ringing' | 'connected' | 'ended' | 'failed';

/**
 * How a provider actually carries the conversation.
 *
 * This matters because it changes what the agent may claim. A cloud voice API
 * lets the agent speak and listen. Google Voice does not: it bridges *your*
 * phone to the callee, so over that provider the agent can negotiate by text
 * or hand you a connected call, but it cannot say it spoke to anyone.
 */
export type Modality = 'voice' | 'sms' | 'handoff';

export interface ProviderCapability {
  modality: Modality;
  /** The agent can conduct the whole exchange itself. */
  autonomous: boolean;
  /** Works with no cloud account or API key. */
  onDevice: boolean;
  /** Shown to the owner when this provider is chosen. */
  summary: string;
}

/**
 * The contract every telephony backend implements. Deliberately small — the
 * negotiation logic lives above this line so it can be tested without a phone.
 */
export interface CallProvider {
  readonly name: string;
  /** What this backend can actually do. Defaults to autonomous voice. */
  readonly capability?: ProviderCapability;
  isAvailable(): Promise<boolean>;
  dial(request: DialRequest): Promise<CallHandle>;
  /** Speak, or send a message. Resolves once it has been handed to the line. */
  say(handle: CallHandle, text: string): Promise<void>;
  /** Wait for the other party. Resolves null when they have hung up or gone silent. */
  listen(handle: CallHandle, timeoutMs?: number): Promise<string | null>;
  hangup(handle: CallHandle, reason?: string): Promise<void>;
  /** Read DTMF keypad input — used by the hotline PIN gate. */
  readDigits?(handle: CallHandle, count: number, timeoutMs?: number): Promise<string | null>;
}

export const VOICE_CAPABILITY: ProviderCapability = {
  modality: 'voice',
  autonomous: true,
  onDevice: false,
  summary: 'speaks and listens on a real call',
};

export function capabilityOf(provider: CallProvider): ProviderCapability {
  return provider.capability ?? VOICE_CAPABILITY;
}

export interface CallResult {
  callId: string;
  handle: CallHandle;
  transcript: CallTurn[];
  outcome: 'agreed' | 'counter_offer' | 'declined' | 'no_answer' | 'failed' | 'escalated';
  success: boolean;
  summary: string;
  /** The offer the call landed on, if any. */
  offer?: Offer;
  decision?: Decision;
  /** Second Brain approval id, when the agent escalated instead of deciding. */
  approvalId?: string;
  /** Second Brain appointment id, when a commitment was recorded. */
  appointmentId?: string;
}
