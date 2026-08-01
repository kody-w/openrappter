/**
 * Google Voice — the on-device fallback, with no API keys at all.
 *
 * An honest note about what this can and cannot do, because getting it wrong
 * would mean the agent claiming a conversation that never happened:
 *
 *   Google Voice has no programmable audio path. A "call" there bridges *your*
 *   phone to the callee. So over Google Voice the agent CANNOT speak or listen
 *   on a voice call.
 *
 *   What it CAN do, fully autonomously, is text. Google Voice SMS is readable
 *   and writable from a signed-in browser session, and the negotiation loop is
 *   identical over text: `say` sends a message, `listen` waits for the reply,
 *   and `decide()` still decides. The agent really can book the table by SMS
 *   with no account, no key and nothing leaving the machine except the message.
 *
 *   For voice it offers a `handoff`: it places the call and connects the owner,
 *   and records it as a handoff — never as something the agent did itself.
 *
 * It drives the owner's real, already-signed-in browser session, so there is no
 * credential to store here. The account is configuration
 * (`GOOGLE_VOICE_ACCOUNT`), never a hardcoded value in this repo.
 */

import type { CallHandle, CallProvider, DialRequest, ProviderCapability } from '../types.js';

/**
 * The browser surface this provider needs.
 *
 * Kept as an interface so the provider is fully testable without a browser, and
 * so it can be backed by openrappter's BrowserService, the Chrome bridge, or
 * anything else that can drive a signed-in session.
 */
export interface GoogleVoiceDriver {
  /** Is a session signed in — optionally, as this specific account? */
  isSignedIn(account?: string): Promise<boolean>;
  /** Send an SMS. Resolves to a thread id. */
  sendSms(to: string, text: string): Promise<string>;
  /**
   * Wait for the next inbound message on a thread. Resolves null on timeout,
   * which the loop treats as the other party going quiet.
   */
  awaitReply(threadId: string, timeoutMs: number): Promise<string | null>;
  /** Bridge the owner's phone to the callee. Not an autonomous call. */
  placeBridgedCall?(to: string): Promise<string>;
}

export interface GoogleVoiceOptions {
  driver: GoogleVoiceDriver;
  /** Which Google account the session must be. Defaults to $GOOGLE_VOICE_ACCOUNT. */
  account?: string;
  /**
   * 'sms'     — negotiate by text, fully autonomous (default)
   * 'handoff' — place a bridged voice call and connect the owner
   */
  mode?: 'sms' | 'handoff';
  replyTimeoutMs?: number;
}

export const GOOGLE_VOICE_SMS: ProviderCapability = {
  modality: 'sms',
  autonomous: true,
  onDevice: true,
  summary: 'negotiates by text message through your own Google Voice number — no API keys',
};

export const GOOGLE_VOICE_HANDOFF: ProviderCapability = {
  modality: 'handoff',
  autonomous: false,
  onDevice: true,
  summary: 'places the call and connects you — the agent cannot speak on it',
};

export class GoogleVoiceProvider implements CallProvider {
  readonly name = 'google-voice';
  readonly capability: ProviderCapability;

  private readonly driver: GoogleVoiceDriver;
  private readonly account?: string;
  private readonly mode: 'sms' | 'handoff';
  private readonly replyTimeoutMs: number;
  private readonly threads = new Map<string, string>();

  constructor(options: GoogleVoiceOptions) {
    this.driver = options.driver;
    this.account = options.account ?? process.env.GOOGLE_VOICE_ACCOUNT;
    this.mode = options.mode ?? 'sms';
    this.replyTimeoutMs = options.replyTimeoutMs ?? 5 * 60_000; // people answer texts slowly
    this.capability = this.mode === 'sms' ? GOOGLE_VOICE_SMS : GOOGLE_VOICE_HANDOFF;
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.driver.isSignedIn(this.account);
    } catch {
      return false;
    }
  }

  async dial(request: DialRequest): Promise<CallHandle> {
    if (this.mode === 'handoff') {
      if (!this.driver.placeBridgedCall) {
        throw new Error('this Google Voice driver cannot place bridged calls');
      }
      const id = await this.driver.placeBridgedCall(request.to);
      return { id, provider: this.name, to: request.to, direction: 'outbound', externalId: id };
    }

    // SMS threads are created lazily by the first `say`, so there is nothing to
    // open here. Dialling a text conversation is just naming it.
    const id = `gv_${Date.now()}_${request.to.replace(/\D/g, '')}`;
    return { id, provider: this.name, to: request.to, direction: 'outbound' };
  }

  async say(handle: CallHandle, text: string): Promise<void> {
    if (this.mode === 'handoff') {
      throw new Error(
        'Google Voice in handoff mode has no audio path — the agent cannot speak. Use mode "sms", or a voice provider.',
      );
    }
    const threadId = await this.driver.sendSms(handle.to, text);
    this.threads.set(handle.id, threadId);
  }

  async listen(handle: CallHandle, timeoutMs?: number): Promise<string | null> {
    if (this.mode === 'handoff') return null;
    const threadId = this.threads.get(handle.id);
    if (!threadId) return null;
    return this.driver.awaitReply(threadId, timeoutMs ?? this.replyTimeoutMs);
  }

  async hangup(): Promise<void> {
    // A text conversation has nothing to hang up. Leaving the thread open is
    // correct: the other party may still reply, and that reply should land.
  }
}

/**
 * Phrasing for a text negotiation.
 *
 * The default speaker is written for a phone call — "Can I call you straight
 * back?" makes no sense in a text thread, and reading a spoken line as an SMS
 * is how an agent gets ignored.
 */
export const smsSpeaker = {
  opening: (objective: { goal: string }) => `Hi — ${objective.goal}. Is that possible?`,
  counter: (_objective: unknown, _offer: unknown, decision: { violations: { detail: string }[] }) =>
    `Sorry, that doesn't work for us — ${decision.violations.map((v) => v.detail).join(', ')}. Anything else available?`,
  accept: (offer: { note?: string }) => `That works, please book it. Thank you! (${offer.note ?? ''})`.trim(),
  holdForApproval: () => `That might work — let me check and confirm shortly. Can you hold it?`,
  decline: (reason: string) => `Thanks anyway — ${reason}.`,
  nudge: () => `What do you have available?`,
};
