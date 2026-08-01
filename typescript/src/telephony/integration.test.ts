/**
 * The whole thing, end to end, against the real RAPP Second Brain.
 *
 * These tests spawn the actual `rsb` binary rather than a stub, so what they
 * prove is the real compatibility claim: openrappter's phone agent and the
 * brain are one system, and the events that come out of a call are the same
 * events a brainstem or a terminal would read.
 *
 * Skipped automatically when rsb is not installed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CallAgent, PhoneApprover, SecondBrain, SimulationProvider } from './index.js';
import type { CallObjective } from './types.js';

const RSB_CANDIDATES = [
  process.env.RSB_BIN,
  join(homedir(), 'rapp-secondbrain', 'rsb'),
  join(homedir(), '.local', 'bin', 'rsb'),
].filter(Boolean) as string[];

const RSB = RSB_CANDIDATES.find((path) => existsSync(path));
const describeWithBrain = RSB ? describe : describe.skip;

// Each assertion here spawns a real Python process, several times per test.
// That is the point — but it needs a budget well above vitest's 5s default.
const TIMEOUT = 60_000;

const FRIDAY = '2026-08-07';
const RESTAURANT = '+15551234567';
const OWNER = '+15550000000';

const dinner: CallObjective = {
  goal: 'Book a table for 2 on Friday at 7pm',
  constraints: [
    { kind: 'not_before', time: '18:00', label: 'not before 6pm' },
    { kind: 'not_after', time: '20:00', label: 'no later than 8pm' },
    { kind: 'party_size', exactly: 2, label: 'party of exactly 2' },
  ],
  ideal: { start: `${FRIDAY}T19:00:00`, partySize: 2 },
};

describeWithBrain('openrappter + RAPP Second Brain', () => {
  let home: string;
  let brain: SecondBrain;

  const rsb = (...args: string[]): string =>
    execFileSync(process.execPath === RSB ? RSB! : 'python3', [RSB!, '--home', home, '--json', ...args], {
      encoding: 'utf8',
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'openrappter-brain-'));
    brain = new SecondBrain({ binary: RSB, home, actor: 'openrappter-test' });
    rsb('init', '--owner', 'Kody');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('finds the brain', async () => {
    expect(await brain.isAvailable()).toBe(true);
  }, TIMEOUT);

  it('writes a fact and reads it back', async () => {
    await brain.remember('Kody is allergic to shellfish', ['health']);
    const hits = await brain.recall('shellfish');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('reports a missing brain as an error rather than throwing', async () => {
    const missing = new SecondBrain({ binary: '/nonexistent/rsb' });
    const result = await missing.exec('brief');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  }, TIMEOUT);

  describe('the JARVIS call', () => {
    it('negotiates, refuses to book, calls back, and only then commits', async () => {
      await brain.addContact({ name: 'Bella Vista', phone: '(555) 123-4567', org: 'Restaurant' });

      // 1. the restaurant counter-offers a time that is legal but not the ask
      const restaurant = new SimulationProvider({
        peers: [
          {
            number: RESTAURANT,
            greeting: 'Bella Vista, good evening.',
            replies: ['Seven is fully booked. I could do seven forty-five?'],
          },
        ],
      });

      const agent = new CallAgent({ provider: restaurant, brain, ownerNumber: OWNER });
      const call = await agent.placeCall({
        to: RESTAURANT,
        objective: dinner,
        date: FRIDAY,
        hint: 'evening',
        appointmentTitle: 'Dinner at Bella Vista (2)',
      });

      expect(call.outcome).toBe('escalated');
      expect(call.appointmentId).toBeTruthy();
      expect(call.approvalId).toBeTruthy();

      // 2. nothing is booked, and the owner has a decision waiting
      const beforeApproval = JSON.parse(rsb('appointment', 'list', '--status', 'confirmed'));
      expect(beforeApproval.count).toBe(0);
      expect(await brain.isApproved(call.approvalId!)).toBe(false);
      expect((await brain.pendingApprovals()).length).toBe(1);

      // 3. the callback
      const ownerLine = new SimulationProvider({ peers: [{ number: OWNER, replies: ['Yeah, book it.'] }] });
      const callback = new CallAgent({ provider: ownerLine, brain, ownerNumber: OWNER });
      const approver = new PhoneApprover(callback, OWNER);

      const outcome = await approver.decide({
        approvalId: call.approvalId!,
        question: call.decision?.question ?? 'Take 7:45?',
        appointmentId: call.appointmentId,
      });

      expect(outcome.approved).toBe(true);
      expect(outcome.via).toBe('phone');

      // 4. now — and only now — it is on the calendar
      expect(await brain.isApproved(call.approvalId!)).toBe(true);
      const afterApproval = JSON.parse(rsb('appointment', 'list', '--status', 'confirmed'));
      expect(afterApproval.count).toBe(1);
      expect(afterApproval.appointments[0].start).toBe(`${FRIDAY}T19:45:00`);

      // 5. and all of it is provable
      const verified = await brain.verify();
      expect(verified.ok).toBe(true);

      const transcript = JSON.parse(rsb('call', 'show', call.callId));
      expect(transcript.call.turns.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(transcript.call.turns)).toMatch(/forty-five/);

      const calls = JSON.parse(rsb('call', 'list'));
      expect(calls.count).toBe(2); // the restaurant, and the callback
    }, TIMEOUT);

    it('books on its own authority when the offer is what was asked for', async () => {
      const restaurant = new SimulationProvider({
        peers: [{ number: RESTAURANT, replies: ["Seven o'clock, table for two — that's fine."] }],
      });
      const agent = new CallAgent({ provider: restaurant, brain, ownerNumber: OWNER });

      const call = await agent.placeCall({ to: RESTAURANT, objective: dinner, date: FRIDAY, hint: 'evening' });

      expect(call.outcome).toBe('agreed');
      expect(call.approvalId).toBeUndefined();
      // no approval was needed, so it is already confirmed
      expect(JSON.parse(rsb('appointment', 'list', '--status', 'confirmed')).count).toBe(1);
      expect((await brain.pendingApprovals()).length).toBe(0);
    }, TIMEOUT);

    it('cancels the hold when the owner says no', async () => {
      const restaurant = new SimulationProvider({
        peers: [{ number: RESTAURANT, replies: ['Only seven forty-five, I\'m afraid.'] }],
      });
      const call = await new CallAgent({ provider: restaurant, brain }).placeCall({
        to: RESTAURANT,
        objective: dinner,
        date: FRIDAY,
        hint: 'evening',
      });
      expect(call.outcome).toBe('escalated');

      const ownerLine = new SimulationProvider({ peers: [{ number: OWNER, replies: ['No, forget it.'] }] });
      const callback = new CallAgent({ provider: ownerLine, brain, ownerNumber: OWNER });

      const outcome = await new PhoneApprover(callback, OWNER).decide({
        approvalId: call.approvalId!,
        question: 'Take 7:45?',
        appointmentId: call.appointmentId,
      });

      expect(outcome.approved).toBe(false);
      expect(JSON.parse(rsb('appointment', 'list', '--status', 'confirmed')).count).toBe(0);
      expect(JSON.parse(rsb('appointment', 'list', '--status', 'cancelled')).count).toBe(1);
    }, TIMEOUT);

    it('leaves the approval pending when the owner does not answer', async () => {
      const restaurant = new SimulationProvider({
        peers: [{ number: RESTAURANT, replies: ['I could do seven forty-five.'] }],
      });
      const call = await new CallAgent({ provider: restaurant, brain }).placeCall({
        to: RESTAURANT,
        objective: dinner,
        date: FRIDAY,
        hint: 'evening',
      });

      const silent = new SimulationProvider({ peers: [{ number: OWNER, replies: [] }] });
      const callback = new CallAgent({ provider: silent, brain, ownerNumber: OWNER });
      await callback.callBackForApproval({
        approvalId: call.approvalId!,
        question: 'Take 7:45?',
        appointmentId: call.appointmentId,
      });

      // Silence is not a no on the record — it stays a question the owner owes
      // an answer to — but nothing gets booked either.
      expect((await brain.pendingApprovals()).length).toBe(1);
      expect(JSON.parse(rsb('appointment', 'list', '--status', 'confirmed')).count).toBe(0);
    }, TIMEOUT);

    it('records a failed negotiation without inventing a booking', async () => {
      const restaurant = new SimulationProvider({
        peers: [{ number: RESTAURANT, replies: ['Sorry, we are fully booked all night.'] }],
      });

      const call = await new CallAgent({ provider: restaurant, brain }).placeCall({
        to: RESTAURANT,
        objective: dinner,
        date: FRIDAY,
        hint: 'evening',
      });

      expect(call.outcome).toBe('declined');
      expect(JSON.parse(rsb('appointment', 'list')).count).toBe(0);
      expect((await brain.verify()).ok).toBe(true);
    }, TIMEOUT);
  });

  describe('the business side', () => {
    it('turns a voice note into a lead the brain remembers', async () => {
      const leadId = await brain.addLead({
        name: 'Riverside Cafe',
        phone: '5552223333',
        source: 'telegram voice note',
        need: 'Weekly deep clean',
        value: '1200.00',
      });

      expect(leadId).toBeTruthy();
      const listed = JSON.parse(rsb('lead', 'list'));
      expect(listed.count).toBe(1);
      expect(listed.leads[0].value_cents).toBe(120000);

      // and the contact came along with it
      expect(await brain.findContact('Riverside')).toBeTruthy();
    }, TIMEOUT);
  });

  it('keeps one unbroken chain across everything openrappter wrote', async () => {
    await brain.remember('a fact');
    await brain.addContact({ name: 'Someone', phone: '5551119999' });
    const callId = await brain.startCall({ to: '5551119999', objective: 'say hello' });
    await brain.logTurn(callId!, 'agent', 'hello');
    await brain.endCall(callId!, 'agreed', true, 'said hello');

    const verified = await brain.verify();
    expect(verified.ok).toBe(true);
    expect(verified.problems).toEqual([]);
  }, TIMEOUT);

  it('survives concurrent writers without corrupting the log', async () => {
    // An append reads the last hash and chains onto it. Overlapping writers
    // would both chain onto the same event, silently forking history. The
    // client serialises them, so firing everything at once must still produce
    // one clean chain.
    await Promise.all([
      brain.remember('one'),
      brain.remember('two'),
      brain.remember('three'),
      brain.addContact({ name: 'Racer', phone: '5550001111' }),
      brain.remember('four'),
      brain.remember('five'),
    ]);

    const verified = await brain.verify();
    expect(verified.ok).toBe(true);
    expect(verified.problems).toEqual([]);

    const log = JSON.parse(rsb('log', '--limit', '100'));
    const seqs = log.events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, TIMEOUT);
});
