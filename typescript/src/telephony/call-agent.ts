/**
 * CallAgent — an agent that can be trusted with your phone.
 *
 * It dials, holds a conversation, hears what the other party is actually
 * offering, and then does one of four things: accept, counter, decline, or stop
 * and call you. Which one it does is decided by `decide()` in constraints.ts,
 * not by whatever the model felt like saying, and every step is written to the
 * RAPP Second Brain as it happens.
 *
 * The rule it exists to enforce:
 *
 *     Autonomous inside the mandate. Never outside it.
 */

import { decide, describeOffer, parseLocalIso } from './constraints.js';
import { extractOffer, soundsLikeAgreement, soundsLikeRefusal } from './extract.js';
import type { SecondBrain } from './brain.js';
import type {
  CallObjective,
  CallProvider,
  CallResult,
  CallTurn,
  Decision,
  Offer,
} from './types.js';

/**
 * Produces the agent's words. The default is deterministic English; pass an
 * LLM-backed implementation for a natural voice. Either way the *decisions*
 * above it are unchanged.
 */
export interface Speaker {
  opening(objective: CallObjective): string;
  counter(objective: CallObjective, offer: Offer, decision: Decision): string;
  accept(offer: Offer): string;
  holdForApproval(offer: Offer): string;
  decline(reason: string): string;
  nudge(): string;
}

export const defaultSpeaker: Speaker = {
  opening: (objective) => `Hi — ${objective.goal}. Is that possible?`,
  counter: (objective, _offer, decision) => {
    const blocked = decision.violations.map((v) => v.detail).join(', and ');
    const ideal = objective.ideal ? ` I really need ${describeOffer(objective.ideal)}.` : '';
    return `That doesn't quite work — ${blocked}.${ideal} Is there anything else?`;
  },
  accept: (offer) => `${describeOffer(offer)} works. Let's do that — thank you.`,
  holdForApproval: (offer) =>
    `${describeOffer(offer)} could work, but I need to confirm it before I book. Can I call you straight back?`,
  decline: (reason) => `I don't think we can make that work — ${reason}. Thanks for your time.`,
  nudge: () => 'Sorry — could you tell me what you do have available?',
};

export interface CallAgentOptions {
  provider: CallProvider;
  brain?: SecondBrain;
  speaker?: Speaker;
  /** Safety valve: hang up rather than loop forever. */
  maxTurns?: number;
  /** How many counter-offers to make before giving up. */
  maxCounters?: number;
  /** Owner's number, for approval callbacks. */
  ownerNumber?: string;
  clock?: () => Date;
}

export interface PlaceCallInput {
  to: string;
  objective: CallObjective;
  /** Date the call is about (YYYY-MM-DD). Defaults to the ideal offer's date, else today. */
  date?: string;
  /** Bias for bare numbers — 'evening' hears "seven" as 19:00. */
  hint?: 'evening' | 'morning' | 'none';
  /** Title used if the call produces an appointment. */
  appointmentTitle?: string;
}

export class CallAgent {
  private readonly provider: CallProvider;
  private readonly brain?: SecondBrain;
  private readonly speaker: Speaker;
  private readonly maxTurns: number;
  private readonly maxCounters: number;
  private readonly ownerNumber?: string;
  private readonly clock: () => Date;

  constructor(options: CallAgentOptions) {
    this.provider = options.provider;
    this.brain = options.brain;
    this.speaker = options.speaker ?? defaultSpeaker;
    this.maxTurns = options.maxTurns ?? 12;
    this.maxCounters = options.maxCounters ?? 2;
    this.ownerNumber = options.ownerNumber;
    this.clock = options.clock ?? (() => new Date());
  }

  private today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  /**
   * Place a call and pursue the objective.
   *
   * Resolves with `outcome: 'escalated'` — never a booking — when the best offer
   * on the table is legal but not what was asked for. Nothing is confirmed in
   * that case; call `callBackForApproval` next.
   */
  async placeCall(input: PlaceCallInput): Promise<CallResult> {
    const { to, objective } = input;
    const date = input.date ?? (objective.ideal?.start ? parseLocalIso(objective.ideal.start).date : this.today());
    const hint = input.hint ?? 'none';

    const transcript: CallTurn[] = [];
    const record = async (role: CallTurn['role'], text: string): Promise<void> => {
      transcript.push({ role, text, at: this.clock().toISOString() });
      if (this.brain && callId) await this.brain.logTurn(callId, role, text);
    };

    const callId =
      (await this.brain?.startCall({
        to,
        direction: 'outbound',
        objective: objective.goal,
        constraints: objective.constraints.map((c) => c.label ?? c.kind),
        provider: this.provider.name,
      })) ?? `local_${Date.now()}`;

    let handle;
    try {
      handle = await this.provider.dial({ to, objective });
    } catch (error) {
      const summary = `dial failed: ${(error as Error).message}`;
      await this.brain?.endCall(callId, 'failed', false, summary);
      return {
        callId,
        handle: { id: callId, provider: this.provider.name, to, direction: 'outbound' },
        transcript,
        outcome: 'failed',
        success: false,
        summary,
      };
    }

    const opening = this.speaker.opening(objective);
    await this.provider.say(handle, opening);
    await record('agent', opening);

    let counters = 0;
    let bestOffer: Offer | undefined;
    let finalDecision: Decision | undefined;
    let outcome: CallResult['outcome'] = 'no_answer';
    let summary = 'no answer';

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const heard = await this.provider.listen(handle);
      if (heard === null) break;
      await record('peer', heard);

      const offer = extractOffer(heard, { date, hint });

      if (!offer) {
        if (soundsLikeAgreement(heard) && bestOffer && finalDecision?.action === 'accept') {
          outcome = 'agreed';
          summary = `agreed: ${describeOffer(bestOffer)}`;
          break;
        }
        if (soundsLikeRefusal(heard)) {
          outcome = 'declined';
          summary = 'the other party had nothing available';
          const words = this.speaker.decline('nothing available');
          await this.provider.say(handle, words);
          await record('agent', words);
          break;
        }
        const nudge = this.speaker.nudge();
        await this.provider.say(handle, nudge);
        await record('agent', nudge);
        continue;
      }

      const roomToNegotiate = counters < this.maxCounters;
      const decision = decide(objective, offer, { roomToNegotiate });
      bestOffer = offer;
      finalDecision = decision;

      if (decision.action === 'accept') {
        const words = this.speaker.accept(offer);
        await this.provider.say(handle, words);
        await record('agent', words);
        outcome = 'agreed';
        summary = `agreed: ${describeOffer(offer)}`;

        // Give the peer a chance to confirm, but don't require it.
        const confirmation = await this.provider.listen(handle);
        if (confirmation) await record('peer', confirmation);
        break;
      }

      if (decision.action === 'escalate') {
        const words = this.speaker.holdForApproval(offer);
        await this.provider.say(handle, words);
        await record('agent', words);
        outcome = 'escalated';
        summary = `held for approval: ${describeOffer(offer)} (${decision.reason})`;
        break;
      }

      if (decision.action === 'counter') {
        counters += 1;
        const words = this.speaker.counter(objective, offer, decision);
        await this.provider.say(handle, words);
        await record('agent', words);
        continue;
      }

      const words = this.speaker.decline(decision.reason);
      await this.provider.say(handle, words);
      await record('agent', words);
      outcome = 'declined';
      summary = decision.reason;
      break;
    }

    await this.provider.hangup(handle, outcome);

    const success = outcome === 'agreed';
    await this.brain?.endCall(callId, outcome, success, summary);

    const result: CallResult = {
      callId,
      handle,
      transcript,
      outcome,
      success,
      summary,
      offer: bestOffer,
      decision: finalDecision,
    };

    // A commitment or a candidate commitment becomes a record — proposed only.
    if ((outcome === 'agreed' || outcome === 'escalated') && bestOffer && this.brain) {
      const appointmentId = await this.brain.proposeAppointment({
        title: input.appointmentTitle ?? objective.goal,
        with: to,
        start: bestOffer.start,
        callId,
      });
      result.appointmentId = appointmentId ?? undefined;

      if (outcome === 'escalated') {
        result.approvalId =
          (await this.brain.requestApproval({
            subject: decisionQuestion(finalDecision, bestOffer, objective),
            detail: summary,
            ref: appointmentId ?? undefined,
            channel: 'phone',
          })) ?? undefined;
      } else if (appointmentId) {
        // Within the mandate — the agent may confirm on its own authority.
        await this.brain.confirmAppointment(appointmentId);
      }
    }

    return result;
  }

  /**
   * Call the owner back, put the question to them, and record the answer.
   *
   * On approval the held appointment is confirmed. On refusal it is cancelled.
   * Either way the decision is a durable event, not a message in a transcript.
   */
  async callBackForApproval(input: {
    approvalId: string;
    question: string;
    appointmentId?: string;
    to?: string;
  }): Promise<{ approved: boolean; transcript: CallTurn[]; callId: string }> {
    const to = input.to ?? this.ownerNumber;
    if (!to) throw new Error('no owner number configured for the approval callback');

    const transcript: CallTurn[] = [];
    const callId =
      (await this.brain?.startCall({
        to,
        direction: 'outbound',
        objective: 'Call the owner for approval',
        provider: this.provider.name,
      })) ?? `local_${Date.now()}`;

    const record = async (role: CallTurn['role'], text: string): Promise<void> => {
      transcript.push({ role, text, at: this.clock().toISOString() });
      await this.brain?.logTurn(callId, role, text);
    };

    const handle = await this.provider.dial({ to });
    await this.provider.say(handle, input.question);
    await record('agent', input.question);

    let approved = false;
    let answered = false;

    for (let turn = 0; turn < 3 && !answered; turn++) {
      const heard = await this.provider.listen(handle);
      if (heard === null) break;
      await record('owner', heard);

      if (soundsLikeAgreement(heard)) {
        approved = true;
        answered = true;
      } else if (soundsLikeRefusal(heard) || /\b(?:no|nope|don't|do not|skip it|cancel)\b/i.test(heard)) {
        approved = false;
        answered = true;
      } else {
        const again = 'Sorry — is that a yes or a no?';
        await this.provider.say(handle, again);
        await record('agent', again);
      }
    }

    const closing = answered
      ? approved
        ? "Great, I'll book it."
        : "Understood, I'll leave it."
      : "I'll assume no for now and check back later.";
    await this.provider.say(handle, closing);
    await record('agent', closing);
    await this.provider.hangup(handle);

    await this.brain?.endCall(callId, approved ? 'approved' : 'declined', approved, closing);

    // Silence is not consent.
    if (this.brain) {
      if (answered) {
        await this.brain.decideApproval(input.approvalId, approved ? 'approve' : 'deny', 'phone');
      }
      if (input.appointmentId) {
        if (approved) await this.brain.confirmAppointment(input.appointmentId);
        else await this.brain.cancelAppointment(input.appointmentId, answered ? 'owner declined' : 'no answer');
      }
    }

    return { approved, transcript, callId };
  }
}

function decisionQuestion(decision: Decision | undefined, offer: Offer, objective: CallObjective): string {
  if (decision?.question) return decision.question;
  const ideal = objective.ideal ? ` instead of ${describeOffer(objective.ideal)}` : '';
  return `They offered ${describeOffer(offer)}${ideal}. Take it?`;
}
