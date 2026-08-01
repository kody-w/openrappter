import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PhoneAgent } from './PhoneAgent.js';
import { SecondBrain } from '../telephony/brain.js';
import { SimulationProvider } from '../telephony/providers/simulation.js';

/**
 * The agent surface the model actually calls.
 *
 * The risk this file exists to cover: a model asked to "book a table at 7" will
 * cheerfully accept 9:30 if nothing stops it. These tests assert that the agent
 * turns a request into limits, and that anything outside them comes back as a
 * question rather than a booking.
 */

const RSB = [
  process.env.RSB_BIN,
  join(homedir(), 'rapp-secondbrain', 'rsb'),
  join(homedir(), '.local', 'bin', 'rsb'),
]
  .filter(Boolean)
  .find((path) => existsSync(path as string)) as string | undefined;

const FRIDAY = '2026-08-07';

function restaurant(replies: string[]) {
  return new SimulationProvider({ peers: [{ number: '*', greeting: 'Bella Vista.', replies }] });
}

/**
 * An in-memory stand-in for the brain.
 *
 * The unit tests below must never spawn a process, and above all must never
 * touch the developer's real `~/.rapp-second-brain`. Recording a test booking
 * in someone's actual calendar would be a genuinely bad bug to ship.
 */
function fakeBrain() {
  const state = {
    calls: [] as string[],
    turns: [] as { call: string; role: string; text: string }[],
    appointments: [] as { id: string; status: string }[],
    approvals: [] as { id: string; subject: string; ref?: string; status: string }[],
  };
  let seq = 0;
  const next = (prefix: string) => `${prefix}_${++seq}`;

  const brain = {
    state,
    async isAvailable() {
      return true;
    },
    async startCall() {
      const id = next('call');
      state.calls.push(id);
      return id;
    },
    async logTurn(call: string, role: string, text: string) {
      state.turns.push({ call, role, text });
    },
    async endCall() {},
    async proposeAppointment() {
      const id = next('appt');
      state.appointments.push({ id, status: 'proposed' });
      return id;
    },
    async confirmAppointment(id: string) {
      const found = state.appointments.find((a) => a.id === id);
      if (found) found.status = 'confirmed';
      return Boolean(found);
    },
    async cancelAppointment(id: string) {
      const found = state.appointments.find((a) => a.id === id);
      if (found) found.status = 'cancelled';
      return Boolean(found);
    },
    async requestApproval(input: { subject: string; ref?: string }) {
      const id = next('apr');
      state.approvals.push({ id, subject: input.subject, ref: input.ref, status: 'pending' });
      return id;
    },
    async decideApproval(id: string, decision: 'approve' | 'deny') {
      const found = state.approvals.find((a) => a.id === id);
      if (!found || found.status !== 'pending') return false;
      found.status = decision;
      return true;
    },
    async isApproved(id: string) {
      return state.approvals.find((a) => a.id === id)?.status === 'approve';
    },
    async pendingApprovals() {
      return state.approvals.filter((a) => a.status === 'pending');
    },
    async brief() {
      return { totals: { calls: state.calls.length } };
    },
    async exec(...args: string[]) {
      if (args[0] === 'approval' && args[1] === 'list') {
        return { ok: true, code: 0, data: { approvals: state.approvals } };
      }
      if (args[0] === 'call' && args[1] === 'show') {
        return { ok: true, code: 0, data: { call: { turns: state.turns.filter((t) => t.call === args[2]) } } };
      }
      return { ok: true, code: 0, data: {} };
    },
  };

  return brain as unknown as SecondBrain;
}

describe('PhoneAgent', () => {
  let home: string | undefined;
  let brain: SecondBrain | undefined;
  let sandbox: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // Belt and braces: even a test that forgets to inject a brain must not be
    // able to reach the developer's real ~/.rapp-second-brain.
    sandbox = mkdtempSync(join(tmpdir(), 'phone-sandbox-'));
    previousHome = process.env.RAPP_SECOND_BRAIN_HOME;
    process.env.RAPP_SECOND_BRAIN_HOME = sandbox;

    if (!RSB) return;
    home = mkdtempSync(join(tmpdir(), 'phone-agent-'));
    brain = new SecondBrain({ binary: RSB, home, actor: 'test' });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.RAPP_SECOND_BRAIN_HOME;
    else process.env.RAPP_SECOND_BRAIN_HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });

    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    brain = undefined;
  });

  const act = async (agent: PhoneAgent, kwargs: Record<string, unknown>) =>
    JSON.parse(await agent.perform(kwargs));

  describe('the tool contract', () => {
    it('advertises a valid OpenAI tool definition', () => {
      const { metadata } = new PhoneAgent({ brain: fakeBrain() });
      expect(metadata.name).toBe('Phone');
      expect(metadata.parameters.type).toBe('object');
      expect(metadata.parameters.required).toEqual(['action']);
      expect(metadata.parameters.properties.action.enum).toContain('call');
    });

    it('documents the constraint forms it accepts', () => {
      // A model cannot use a grammar nobody told it about.
      const description = new PhoneAgent({ brain: fakeBrain() }).metadata.parameters.properties.constraints.description;
      expect(description).toMatch(/no later than/);
      expect(description).toMatch(/party size exactly/);
      expect(description).toMatch(/budget under/);
    });

    it('never throws out of perform', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain() });
      for (const kwargs of [{}, { action: 'nonsense' }, { action: 'call' }, { action: 'approve' }]) {
        const raw = await agent.perform(kwargs);
        expect(() => JSON.parse(raw)).not.toThrow();
      }
    });
  });

  describe('placing a call', () => {
    it('refuses to dial when a stated limit was not understood', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(['sure']) });

      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table',
        constraints: ['no later than 8pm', 'vibes must be immaculate'],
      });

      expect(result.status).toBe('error');
      expect(result.unparsed).toEqual(['vibes must be immaculate']);
      expect(result.understood_forms).toBeInstanceOf(Array);
    });

    it('refuses a malformed wanted_time rather than guessing', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(['sure']) });
      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table',
        wanted_time: 'friday-ish',
      });
      expect(result.status).toBe('error');
      expect(result.message).toMatch(/ISO-8601/);
    });

    it('degrades to on-device rather than pretending, and says which', async () => {
      // With no cloud keys the agent must still do something useful — but it
      // must never report a conversation it did not have.
      const agent = new PhoneAgent({ brain: fakeBrain() });
      const result = await act(agent, { action: 'call', to: '+15551234567', objective: 'Book a table' });

      if (result.status === 'error') {
        // Nothing on-device either: the refusal has to explain the options.
        expect(result.message).toMatch(/RETELL_API_KEY|GOOGLE_VOICE_ACCOUNT|rehearse/);
        return;
      }

      expect(result.on_device ?? true).toBe(true);
      expect(result.booked).toBe(false);
      expect(result.notice).toBeTruthy();

      if (result.outcome === 'handoff') {
        // A handoff is the owner's call to make, and must be described as such.
        expect(result.say_to_owner).toMatch(/cannot speak/i);
        expect(result.say_to_owner).toContain('Book a table');
      }
    });

    it('rehearses without a provider when asked', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain() });
      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        wanted_time: `${FRIDAY}T19:00`,
        rehearse: ['Seven works fine.'],
      });

      expect(result.status).toBe('ok');
      expect(result.rehearsal).toBe(true);
    });

    it('books when the offer is what was asked for', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(["Seven o'clock, table for two, that's fine."]) });

      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        constraints: ['not before 6pm', 'no later than 8pm', 'party size exactly 2'],
        wanted_time: `${FRIDAY}T19:00`,
        wanted_party_size: 2,
      });

      expect(result.outcome).toBe('agreed');
      expect(result.booked).toBe(true);
      expect(result.needs_your_approval).toBe(false);
    });

    it('HOLDS an offer that is legal but not what was asked for', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(['Seven is booked. I could do seven forty-five?']) });

      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        constraints: ['not before 6pm', 'no later than 8pm', 'party size exactly 2'],
        wanted_time: `${FRIDAY}T19:00`,
        wanted_party_size: 2,
      });

      expect(result.outcome).toBe('escalated');
      expect(result.booked).toBe(false);
      expect(result.needs_your_approval).toBe(true);
      expect(result.say_to_owner).toMatch(/NOT booked/);
      expect(result.question).toContain('19:45');
      expect(result.offer.start).toBe(`${FRIDAY}T19:45:00`);
    });

    it('will not book outside the limits however long the negotiation runs', async () => {
      const agent = new PhoneAgent({
        brain: fakeBrain(),
        provider: restaurant(['Only nine thirty.', 'Nine thirty.', 'Nine thirty.', 'Nine thirty.']),
      });

      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        constraints: ['no later than 8pm'],
        wanted_time: `${FRIDAY}T19:00`,
      });

      expect(result.booked).toBe(false);
      expect(result.needs_your_approval).toBe(false);
      expect(result.outcome).toBe('declined');
    });

    it('returns the transcript so the owner can read what happened', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(['Seven is booked. I could do seven forty-five?']) });
      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        wanted_time: `${FRIDAY}T19:00`,
      });
      expect(result.transcript.join(' ')).toMatch(/forty-five/);
    });

    it('emits data_slush so it chains with other agents', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(['Seven is booked. I could do seven forty-five?']) });
      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 at 7pm',
        wanted_time: `${FRIDAY}T19:00`,
      });
      expect(result.data_slush.call_id).toBe(result.call_id);
    });

    it('hears "seven" as the evening for a dinner booking', async () => {
      const agent = new PhoneAgent({ brain: fakeBrain(), provider: restaurant(['We could do seven fifteen.']) });
      const result = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a dinner table for 2',
        constraints: ['not before 6pm', 'no later than 8pm'],
        wanted_time: `${FRIDAY}T19:00`,
      });
      expect(result.offer.start).toBe(`${FRIDAY}T19:15:00`);
    });
  });

  describe('the hotline', () => {
    it('challenges an unknown caller', async () => {
      const result = await act(new PhoneAgent({ brain: fakeBrain() }), { action: 'hotline_check', pin: '4821', from: '+15559998888' });
      expect(result.outcome).toBe('challenge');
    });

    it('needs a pin', async () => {
      const result = await act(new PhoneAgent({ brain: fakeBrain() }), { action: 'hotline_check', from: '+15559998888' });
      expect(result.status).toBe('error');
    });
  });

  describe.runIf(RSB)('against the real second brain', () => {
    it('records the call and leaves the approval for the owner', async () => {
      const agent = new PhoneAgent({
        provider: restaurant(['Seven is booked. I could do seven forty-five?']),
        brain,
      });

      const call = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        constraints: ['not before 6pm', 'no later than 8pm'],
        wanted_time: `${FRIDAY}T19:00`,
      });

      expect(call.needs_your_approval).toBe(true);
      expect(call.approval_id).toBeTruthy();

      const pending = await act(agent, { action: 'approvals' });
      expect(pending.count).toBe(1);
      expect(pending.approvals[0].id).toBe(call.approval_id);

      // nothing is on the calendar yet
      expect(await brain!.isApproved(call.approval_id)).toBe(false);
    }, 60_000);

    it('approving confirms the held appointment', async () => {
      const agent = new PhoneAgent({
        provider: restaurant(['Seven is booked. I could do seven forty-five?']),
        brain,
      });

      const call = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        constraints: ['no later than 8pm'],
        wanted_time: `${FRIDAY}T19:00`,
      });

      const approved = await act(agent, { action: 'approve', id: call.approval_id, note: 'go ahead' });

      expect(approved.status).toBe('ok');
      expect(approved.confirmed_appointment).toBe(call.appointment_id);
      expect(await brain!.isApproved(call.approval_id)).toBe(true);
      expect((await agent.perform({ action: 'approvals' })).includes('"count": 0')).toBe(true);
    }, 60_000);

    it('denying books nothing', async () => {
      const agent = new PhoneAgent({
        provider: restaurant(['Seven is booked. I could do seven forty-five?']),
        brain,
      });

      const call = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table for 2 on Friday at 7pm',
        constraints: ['no later than 8pm'],
        wanted_time: `${FRIDAY}T19:00`,
      });

      const denied = await act(agent, { action: 'deny', id: call.approval_id });
      expect(denied.confirmed_appointment).toBeNull();
      expect(await brain!.isApproved(call.approval_id)).toBe(false);
    }, 60_000);

    it('cannot decide the same approval twice', async () => {
      const agent = new PhoneAgent({
        provider: restaurant(['I could do seven forty-five.']),
        brain,
      });
      const call = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table at 7pm',
        wanted_time: `${FRIDAY}T19:00`,
      });

      await act(agent, { action: 'approve', id: call.approval_id });
      const again = await act(agent, { action: 'deny', id: call.approval_id });
      expect(again.status).toBe('error');
    }, 60_000);

    it('reads back a transcript', async () => {
      const agent = new PhoneAgent({ provider: restaurant(['Seven forty-five?']), brain });
      const call = await act(agent, {
        action: 'call',
        to: '+15551234567',
        objective: 'Book a table at 7pm',
        wanted_time: `${FRIDAY}T19:00`,
      });

      const transcript = await act(agent, { action: 'transcript', id: call.call_id });
      expect(transcript.status).toBe('ok');
      expect(JSON.stringify(transcript.call)).toMatch(/forty-five/);
    }, 60_000);
  });
});
