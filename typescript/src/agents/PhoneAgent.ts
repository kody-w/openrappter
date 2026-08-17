/**
 * PhoneAgent — lets the assistant pick up the phone itself.
 *
 * This is the piece that turns "openrappter has telephony" into "ask it and it
 * calls". The model decides *that* a call is warranted and what the goal is;
 * it does not get to decide what may be agreed to once the call is connected —
 * that stays with `decide()` in telephony/constraints.ts.
 *
 * The important behaviour, and the reason this file is careful:
 *
 *   A model asked to "book me a table at 7" will happily accept 9:30 if you let
 *   it. So the agent turns the request into a goal plus hard limits, hands both
 *   to the call loop, and the loop escalates anything outside them. The model
 *   is never in the position of approving on your behalf.
 *
 * Actions: call, approvals, approve, deny, brief, transcript, hotline_check
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

import { CallAgent } from '../telephony/call-agent.js';
import { SecondBrain } from '../telephony/brain.js';
import { HotlineGate } from '../telephony/hotline.js';
import { parseConstraints, parseLocalIso } from '../telephony/constraints.js';
import { resolveProvider } from '../telephony/providers/resolve.js';
import { smsSpeaker } from '../telephony/providers/google-voice.js';
import type { GoogleVoiceDriver } from '../telephony/providers/google-voice.js';
import { capabilityOf } from '../telephony/types.js';
import type { CallObjective, CallProvider, Offer, ProviderCapability } from '../telephony/types.js';

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/phone',
  version: '1.0.0',
  display_name: 'Phone',
  description:
    'Place real phone calls on the owner\'s behalf with a goal and hard limits, negotiate, and stop for approval rather than committing outside them.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: ['network', 'credential-access', 'process-exec'],
  tags: ['openrappter', 'phone', 'telephony', 'second-brain'],
  category: 'communication',
  quality_tier: 'official',
  requires_env: [],
} as const;

interface CallDeps {
  provider?: CallProvider;
  brain?: SecondBrain;
  /** Enables the on-device Google Voice rungs of the ladder. */
  googleVoiceDriver?: GoogleVoiceDriver;
  /** Enables the on-device SMS rungs by reading inbound texts. */
  awaitReply?: (from: string, timeoutMs: number) => Promise<string | null>;
}

export class PhoneAgent extends BasicAgent {
  private deps: CallDeps;

  constructor(deps: CallDeps = {}) {
    const metadata: AgentMetadata = {
      name: 'Phone',
      description:
        "Call someone on the owner's behalf. Give a goal and the hard limits the owner will accept. " +
        'The call is negotiated automatically: an offer inside the limits that matches the request is ' +
        'taken, anything inside the limits but different is held and the owner is asked, and anything ' +
        'outside them is countered or refused. Also used to see pending approvals, record the answer, ' +
        'read a past transcript, or check what the brain knows.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'What to do.',
            enum: ['call', 'approvals', 'approve', 'deny', 'brief', 'transcript', 'hotline_check'],
          },
          to: {
            type: 'string',
            description: 'Who to call — a phone number, or a name already in the second brain.',
          },
          objective: {
            type: 'string',
            description: 'What the call is for, in plain language. e.g. "Book a table for 2 on Friday at 7pm".',
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The owner\'s hard limits, one per entry. Understood forms: "no later than 8pm", ' +
              '"not before 6pm", "between 6pm and 8pm", "party size exactly 2", "budget under 400", ' +
              '"must be on Thursday". Anything else is rejected rather than ignored.',
          },
          wanted_time: {
            type: 'string',
            description:
              'The time the owner actually asked for, ISO-8601, e.g. 2026-08-07T19:00. Anything else the ' +
              'other party offers will be held for approval instead of booked.',
          },
          wanted_party_size: { type: 'integer', description: 'The party size the owner actually asked for.' },
          id: { type: 'string', description: 'An approval id, or a call id for transcript.' },
          note: { type: 'string', description: 'Reason recorded with an approve/deny.' },
          from: { type: 'string', description: 'Caller number, for hotline_check.' },
          pin: { type: 'string', description: 'Hotline PIN, for hotline_check.' },
          rehearse: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Practise against these scripted replies instead of dialling anyone. Use this when the ' +
              'owner asks what would happen, or when no telephony provider is configured.',
          },
        },
        required: ['action'],
      },
    };

    super('Phone', metadata);
    this.deps = deps;
  }

  private brain(): SecondBrain {
    return this.deps.brain ?? new SecondBrain({ actor: 'openrappter-phone-agent' });
  }

  private async provider(rehearse?: string[]): Promise<{ provider: CallProvider; rehearsing: boolean; notice: string; capability: ProviderCapability }> {
    if (this.deps.provider) {
      return {
        provider: this.deps.provider,
        rehearsing: false,
        notice: `Using ${this.deps.provider.name}.`,
        capability: capabilityOf(this.deps.provider),
      };
    }

    // Walks the ladder: cloud voice, then on-device text, then a handoff.
    // Throws rather than quietly downgrading to a rehearsal — reporting a call
    // the owner believes was placed would be the worst failure available.
    const resolution = await resolveProvider({
      rehearse,
      googleVoiceDriver: this.deps.googleVoiceDriver,
      awaitReply: this.deps.awaitReply,
    });

    return {
      provider: resolution.provider,
      rehearsing: resolution.rehearsal,
      notice: resolution.notice,
      capability: resolution.capability,
    };
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || 'brief';
    try {
      return await this.dispatch(action, kwargs);
    } catch (error) {
      return JSON.stringify({ status: 'error', action, message: (error as Error).message }, null, 2);
    }
  }

  private async dispatch(action: string, kwargs: Record<string, unknown>): Promise<string> {
    const brain = this.brain();

    switch (action) {
      case 'call':
        return this.placeCall(kwargs, brain);

      case 'approvals': {
        const approvals = await brain.pendingApprovals();
        return JSON.stringify(
          {
            status: 'ok',
            count: approvals.length,
            approvals: approvals.map((a) => ({ id: a.id, subject: a.subject, detail: a.detail, ref: a.ref })),
          },
          null,
          2,
        );
      }

      case 'approve':
      case 'deny': {
        const id = kwargs.id as string | undefined;
        if (!id) return this.fail(action, 'an approval id is required');
        const ok = await brain.decideApproval(id, action, 'assistant', kwargs.note as string | undefined);
        if (!ok) return this.fail(action, `could not ${action} ${id} — it may already be decided`);

        let confirmed: string | null = null;
        if (action === 'approve') {
          // The approval names the appointment it unlocks; honour it.
          const pending = await brain.exec<{ approvals?: { id?: string; ref?: string }[] }>('approval', 'list');
          const ref = pending.data.approvals?.find((a) => a.id === id)?.ref;
          if (ref && (await brain.confirmAppointment(ref))) confirmed = ref;
        }
        return JSON.stringify({ status: 'ok', action, approval_id: id, confirmed_appointment: confirmed }, null, 2);
      }

      case 'brief':
        return JSON.stringify({ status: 'ok', brief: await brain.brief() }, null, 2);

      case 'transcript': {
        const id = kwargs.id as string | undefined;
        if (!id) return this.fail(action, 'a call id is required');
        const call = await brain.exec('call', 'show', id);
        return JSON.stringify({ status: call.ok ? 'ok' : 'error', call: call.data }, null, 2);
      }

      case 'hotline_check': {
        const pin = kwargs.pin as string | undefined;
        const from = (kwargs.from as string) || '';
        if (!pin) return this.fail(action, 'a pin is required');
        const decision = new HotlineGate({ pin }).admit(from);
        return JSON.stringify({ status: 'ok', caller: from, outcome: decision.outcome, say: decision.say }, null, 2);
      }

      default:
        return this.fail(action, `unknown action '${action}'`);
    }
  }

  private fail(action: string, message: string): string {
    return JSON.stringify({ status: 'error', action, message }, null, 2);
  }

  private async placeCall(kwargs: Record<string, unknown>, brain: SecondBrain): Promise<string> {
    const to = kwargs.to as string | undefined;
    if (!to) return this.fail('call', 'who should I call?');

    const rawConstraints = Array.isArray(kwargs.constraints) ? (kwargs.constraints as string[]) : [];
    const { constraints, unparsed } = parseConstraints(rawConstraints);

    if (unparsed.length > 0) {
      // Dialling with a limit the system did not understand means negotiating
      // without it. Better to hand the problem back than to guess.
      return JSON.stringify(
        {
          status: 'error',
          action: 'call',
          message: 'I did not understand some of the limits, so I have not called.',
          unparsed,
          understood_forms: [
            'no later than 8pm',
            'not before 6pm',
            'between 6pm and 8pm',
            'party size exactly 2',
            'budget under 400',
            'must be on Thursday',
          ],
        },
        null,
        2,
      );
    }

    const ideal: Offer = {};
    const wantedTime = kwargs.wanted_time as string | undefined;
    if (wantedTime) {
      try {
        parseLocalIso(wantedTime);
        ideal.start = wantedTime;
      } catch {
        return this.fail('call', `wanted_time must be ISO-8601 like 2026-08-07T19:00, got "${wantedTime}"`);
      }
    }
    if (typeof kwargs.wanted_party_size === 'number') ideal.partySize = kwargs.wanted_party_size;

    const objective: CallObjective = {
      goal: (kwargs.objective as string) || 'Make an enquiry',
      constraints,
      ideal: Object.keys(ideal).length > 0 ? ideal : undefined,
    };

    const rehearse = Array.isArray(kwargs.rehearse) ? (kwargs.rehearse as string[]) : undefined;
    const { provider, rehearsing, notice, capability } = await this.provider(rehearse);

    if (capability.modality === 'handoff') {
      // No audio path. Say so instead of producing a transcript of nothing.
      const handle = await provider.dial({ to, objective });
      return JSON.stringify(
        {
          status: 'ok',
          outcome: 'handoff',
          booked: false,
          needs_your_approval: false,
          provider: provider.name,
          modality: capability.modality,
          notice,
          say_to_owner:
            `I cannot speak on this line, so I have dialled ${to} and connected you. ` +
            `What you are after: ${objective.goal}.` +
            (constraints.length ? ` Your limits: ${constraints.map((c) => c.label ?? c.kind).join('; ')}.` : ''),
          call_id: handle.id,
        },
        null,
        2,
      );
    }

    const agent = new CallAgent({
      provider,
      brain: rehearsing ? undefined : brain,
      // A spoken line read as a text message is how an agent gets ignored.
      speaker: capability.modality === 'sms' ? (smsSpeaker as never) : undefined,
    });
    const result = await agent.placeCall({
      to,
      objective,
      date: ideal.start ? parseLocalIso(ideal.start).date : undefined,
      hint: /dinner|table|restaurant|evening|tonight/i.test(objective.goal) ? 'evening' : 'none',
      appointmentTitle: objective.goal,
    });

    const summaries: Record<string, string> = {
      agreed: 'Done — booked.',
      escalated: 'I have NOT booked it. They offered something different and I need your answer first.',
      declined: 'They could not do anything within your limits, so I left it.',
      no_answer: 'Nobody picked up.',
      failed: 'The call could not be placed.',
      counter_offer: 'Still negotiating.',
    };

    return JSON.stringify(
      {
        status: 'ok',
        rehearsal: rehearsing,
        provider: provider.name,
        modality: capability.modality,
        on_device: capability.onDevice,
        notice,
        outcome: result.outcome,
        booked: result.outcome === 'agreed',
        needs_your_approval: result.outcome === 'escalated',
        say_to_owner: summaries[result.outcome] ?? result.summary,
        question: result.decision?.question,
        approval_id: result.approvalId,
        appointment_id: result.appointmentId,
        call_id: result.callId,
        offer: result.offer,
        transcript: result.transcript.map((t) => `${t.role}: ${t.text}`),
        data_slush: {
          call_id: result.callId,
          approval_id: result.approvalId,
          appointment_id: result.appointmentId,
        },
      },
      null,
      2,
    );
  }
}
