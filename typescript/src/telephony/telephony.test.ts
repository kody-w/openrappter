import { describe, expect, it, beforeEach } from 'vitest';

import {
  CallAgent,
  EvidenceApprover,
  ApprovalGate,
  HotlineGate,
  ManualApprover,
  SimulationProvider,
  checkConstraints,
  decide,
  describeOffer,
  extractOffer,
  matchesIdeal,
  normalizeNumber,
  parseConstraint,
  parseConstraints,
  soundsLikeAgreement,
  soundsLikeRefusal,
  timeToMinutes,
} from './index.js';
import { buildTwiml, twimlEscape } from './providers/twilio.js';
import type { CallObjective } from './types.js';

// 2026-08-07 is a Friday.
const FRIDAY = '2026-08-07';

const dinner: CallObjective = {
  goal: 'Book a table for 2 on Friday at 7pm',
  constraints: [
    { kind: 'not_before', time: '18:00', label: 'not before 6pm' },
    { kind: 'not_after', time: '20:00', label: 'no later than 8pm' },
    { kind: 'party_size', exactly: 2, label: 'party of exactly 2' },
  ],
  ideal: { start: `${FRIDAY}T19:00:00`, partySize: 2 },
};

describe('time parsing', () => {
  it('reads the shapes people write', () => {
    expect(timeToMinutes('19:45')).toBe(19 * 60 + 45);
    expect(timeToMinutes('7:45 pm')).toBe(19 * 60 + 45);
    expect(timeToMinutes('7pm')).toBe(19 * 60);
    expect(timeToMinutes('12am')).toBe(0);
    expect(timeToMinutes('12pm')).toBe(12 * 60);
  });

  it('refuses nonsense rather than guessing', () => {
    expect(() => timeToMinutes('half past whenever')).toThrow();
    expect(() => timeToMinutes('25:00')).toThrow();
  });
});

describe('constraint parsing', () => {
  it('understands the limits a person would type', () => {
    expect(parseConstraint('no later than 20:00')).toMatchObject({ kind: 'not_after', time: '20:00' });
    expect(parseConstraint('not before 6pm')).toMatchObject({ kind: 'not_before', time: '6pm' });
    expect(parseConstraint('party size exactly 2')).toMatchObject({ kind: 'party_size', exactly: 2 });
    expect(parseConstraint('budget under 400')).toMatchObject({ kind: 'max_price', cents: 40000 });
    expect(parseConstraint('must be on Thursday')).toMatchObject({ kind: 'day_of_week', days: ['thursday'] });
  });

  it('splits a range into two rules', () => {
    const { constraints, unparsed } = parseConstraints(['between 6pm and 8pm']);
    expect(unparsed).toEqual([]);
    expect(constraints).toHaveLength(2);
    expect(constraints[0].kind).toBe('not_before');
    expect(constraints[1].kind).toBe('not_after');
  });

  it('surfaces what it could not understand instead of dropping it', () => {
    const { constraints, unparsed } = parseConstraints(['no later than 8pm', 'vibes must be immaculate']);
    expect(constraints).toHaveLength(1);
    // Silently ignoring this would mean negotiating without a limit the owner set.
    expect(unparsed).toEqual(['vibes must be immaculate']);
  });

  it('keeps the original wording for the audit trail', () => {
    expect(parseConstraint('no later than 20:00')?.label).toBe('no later than 20:00');
  });
});

describe('constraint checking', () => {
  it('passes an offer inside the limits', () => {
    expect(checkConstraints(dinner.constraints, { start: `${FRIDAY}T19:45:00`, partySize: 2 })).toEqual([]);
  });

  it('catches a time past the limit', () => {
    const violations = checkConstraints(dinner.constraints, { start: `${FRIDAY}T21:00:00`, partySize: 2 });
    expect(violations).toHaveLength(1);
    expect(violations[0].constraint.kind).toBe('not_after');
  });

  it('catches the wrong party size', () => {
    const violations = checkConstraints(dinner.constraints, { start: `${FRIDAY}T19:00:00`, partySize: 6 });
    expect(violations[0].constraint.kind).toBe('party_size');
  });

  it('checks the day of the week without timezone drift', () => {
    const thursdayOnly = [{ kind: 'day_of_week' as const, days: ['thursday'] }];
    expect(checkConstraints(thursdayOnly, { start: '2026-08-06T09:00:00' })).toEqual([]);
    expect(checkConstraints(thursdayOnly, { start: `${FRIDAY}T09:00:00` })).toHaveLength(1);
  });

  it('enforces a budget', () => {
    const budget = [{ kind: 'max_price' as const, cents: 40000 }];
    expect(checkConstraints(budget, { priceCents: 39900 })).toEqual([]);
    expect(checkConstraints(budget, { priceCents: 45000 })).toHaveLength(1);
  });
});

describe('the decision policy', () => {
  it('accepts exactly what was asked for', () => {
    const decision = decide(dinner, { start: `${FRIDAY}T19:00:00`, partySize: 2 });
    expect(decision.action).toBe('accept');
  });

  it('ESCALATES an offer that is legal but not what was asked for', () => {
    // This is the whole point: 7:45 is inside the limits, but it is not 7:00,
    // so the agent must stop and ask rather than decide.
    const decision = decide(dinner, { start: `${FRIDAY}T19:45:00`, partySize: 2 });
    expect(decision.action).toBe('escalate');
    expect(decision.question).toContain('19:45');
    expect(decision.violations).toEqual([]);
  });

  it('counters an offer that breaks a limit, while there is room', () => {
    const decision = decide(dinner, { start: `${FRIDAY}T21:30:00`, partySize: 2 }, { roomToNegotiate: true });
    expect(decision.action).toBe('counter');
    expect(decision.violations).toHaveLength(1);
  });

  it('declines rather than escalating once negotiation is exhausted', () => {
    // An illegal offer must never reach the owner as an approval request.
    const decision = decide(dinner, { start: `${FRIDAY}T21:30:00`, partySize: 2 }, { roomToNegotiate: false });
    expect(decision.action).toBe('decline');
  });

  it('accepts freely when the owner gave limits but no preference', () => {
    const openEnded: CallObjective = { goal: 'Any table Friday evening', constraints: dinner.constraints };
    expect(decide(openEnded, { start: `${FRIDAY}T19:45:00`, partySize: 2 }).action).toBe('accept');
  });

  it('never escalates something that violates a hard limit', () => {
    const times = ['05:00', '21:00', '23:30'];
    for (const time of times) {
      const decision = decide(dinner, { start: `${FRIDAY}T${time}:00`, partySize: 2 });
      expect(decision.action).not.toBe('escalate');
      expect(decision.action).not.toBe('accept');
    }
  });
});

describe('matchesIdeal', () => {
  it('is exact about time', () => {
    expect(matchesIdeal({ start: `${FRIDAY}T19:00:00` }, { start: `${FRIDAY}T19:00:00` })).toBe(true);
    expect(matchesIdeal({ start: `${FRIDAY}T19:00:00` }, { start: `${FRIDAY}T19:15:00` })).toBe(false);
  });

  it('treats a cheaper price as still ideal', () => {
    expect(matchesIdeal({ priceCents: 40000 }, { priceCents: 35000 })).toBe(true);
    expect(matchesIdeal({ priceCents: 40000 }, { priceCents: 45000 })).toBe(false);
  });
});

describe('hearing an offer', () => {
  const opts = { date: FRIDAY, hint: 'evening' as const };

  it('hears a digit time', () => {
    expect(extractOffer('I could do 7:45', opts)?.start).toBe(`${FRIDAY}T19:45:00`);
    expect(extractOffer('how about 19:30?', opts)?.start).toBe(`${FRIDAY}T19:30:00`);
  });

  it('hears a spoken time, which is what a transcript actually contains', () => {
    expect(extractOffer('I could do seven forty-five', opts)?.start).toBe(`${FRIDAY}T19:45:00`);
    expect(extractOffer('how about eight thirty', opts)?.start).toBe(`${FRIDAY}T20:30:00`);
    expect(extractOffer('half past seven works', opts)?.start).toBe(`${FRIDAY}T19:30:00`);
  });

  it('respects an explicit am/pm over the context hint', () => {
    expect(extractOffer('nine am is free', { date: FRIDAY, hint: 'evening' })?.start).toBe(`${FRIDAY}T09:00:00`);
  });

  it('hears a price', () => {
    expect(extractOffer('that would be $450', opts)?.priceCents).toBe(45000);
    expect(extractOffer('about 1,250 dollars', opts)?.priceCents).toBe(125000);
  });

  it('hears a party size', () => {
    expect(extractOffer('a table for four', opts)?.partySize).toBe(4);
    expect(extractOffer('party of 6', opts)?.partySize).toBe(6);
  });

  it('returns null when nothing was offered, so the agent keeps listening', () => {
    expect(extractOffer('hello, Bella Vista', opts)).toBeNull();
    expect(extractOffer('one moment please', opts)).toBeNull();
  });

  it('keeps the raw utterance for the transcript', () => {
    expect(extractOffer('I could do 7:45', opts)?.note).toBe('I could do 7:45');
  });

  it('tells refusal from a counter-offer', () => {
    expect(soundsLikeRefusal("no, we're fully booked")).toBe(true);
    expect(soundsLikeRefusal("we're fully booked, but I could do 7:45")).toBe(false);
    expect(soundsLikeAgreement('yes, that works')).toBe(true);
    expect(soundsLikeAgreement('let me check')).toBe(false);
  });
});

describe('the hotline gate', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('refuses to run unprotected by accident', () => {
    expect(() => new HotlineGate({})).toThrow(/pin/i);
    expect(() => new HotlineGate({ open: true })).not.toThrow();
    expect(() => new HotlineGate({ pin: '12' })).toThrow(/4-12 digits/);
  });

  it('challenges a stranger and admits a known caller', () => {
    const gate = new HotlineGate({ pin: '4821', trustedNumbers: ['(555) 000-1111'], now: clock });
    expect(gate.admit('+15559998888').outcome).toBe('challenge');
    // the trusted number is recognised despite a different format
    expect(gate.admit('555-000-1111').outcome).toBe('granted');
  });

  it('grants on the right PIN', () => {
    const gate = new HotlineGate({ pin: '4821', now: clock });
    expect(gate.submit('+15559998888', '4821').outcome).toBe('granted');
  });

  it('locks out after repeated failures', () => {
    const gate = new HotlineGate({ pin: '4821', maxAttempts: 3, lockoutSeconds: 900, now: clock });
    const caller = '+15559998888';

    expect(gate.submit(caller, '0000').outcome).toBe('denied');
    expect(gate.submit(caller, '1111').outcome).toBe('denied');
    const third = gate.submit(caller, '2222');
    expect(third.outcome).toBe('locked');
    expect(third.retryAfterSeconds).toBe(900);

    // even the correct PIN is refused while locked out
    expect(gate.submit(caller, '4821').outcome).toBe('locked');
    expect(gate.admit(caller).outcome).toBe('locked');
  });

  it('lets a caller back in once the lockout expires', () => {
    const gate = new HotlineGate({ pin: '4821', maxAttempts: 1, lockoutSeconds: 60, now: clock });
    gate.submit('+15559998888', '0000');
    now += 61_000;
    expect(gate.submit('+15559998888', '4821').outcome).toBe('granted');
  });

  it('locks out each caller separately', () => {
    const gate = new HotlineGate({ pin: '4821', maxAttempts: 1, now: clock });
    gate.submit('+15551110000', '0000');
    expect(gate.admit('+15552220000').outcome).toBe('challenge');
  });

  it('never reveals why access failed', () => {
    const gate = new HotlineGate({ pin: '4821', now: clock });
    const wrongPin = gate.submit('+15559998888', '0000').say;
    const noPin = gate.submit('+15557776666', '').say;
    // An attacker must not be able to distinguish these cases from the wording.
    expect(wrongPin).toBe(noPin);
    expect(wrongPin).not.toMatch(/4821/);
  });

  it('rejects an empty or non-numeric attempt', () => {
    const gate = new HotlineGate({ pin: '4821', now: clock });
    expect(gate.submit('+1555', null).outcome).toBe('denied');
    expect(gate.submit('+1555', 'abcd').outcome).toBe('denied');
  });

  it('normalises numbers so one caller is one caller', () => {
    expect(normalizeNumber('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeNumber('555-123-4567')).toBe('+15551234567');
    expect(normalizeNumber('+1 555 123 4567')).toBe('+15551234567');
  });

  it('can be opened deliberately', () => {
    expect(new HotlineGate({ open: true, now: clock }).admit('+15559998888').outcome).toBe('granted');
  });
});

describe('the call, end to end', () => {
  const restaurant = '+15551234567';

  function agentWith(replies: (string | ((heard: string) => string | null))[]) {
    const provider = new SimulationProvider({
      peers: [{ number: restaurant, greeting: 'Bella Vista, good evening.', replies }],
    });
    return { provider, agent: new CallAgent({ provider, maxCounters: 2 }) };
  }

  it('accepts when the objective is met outright', async () => {
    const { agent } = agentWith(['Seven o\'clock on Friday, table for two — that works.']);

    const result = await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY, hint: 'evening' });

    expect(result.outcome).toBe('agreed');
    expect(result.success).toBe(true);
    expect(result.offer?.start).toBe(`${FRIDAY}T19:00:00`);
  });

  it('escalates rather than booking a legal-but-different time', async () => {
    const { agent, provider } = agentWith(['Seven is fully booked. I could do seven forty-five?']);

    const result = await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY, hint: 'evening' });

    expect(result.outcome).toBe('escalated');
    expect(result.success).toBe(false);
    expect(result.offer?.start).toBe(`${FRIDAY}T19:45:00`);
    expect(result.decision?.action).toBe('escalate');

    // and it said so on the call instead of silently agreeing
    const said = provider.wire.filter((w) => w.from === 'agent').map((w) => w.text).join(' ');
    expect(said).toMatch(/call you (straight )?back|confirm it before I book/i);
  });

  it('counters an illegal offer, then takes the fixed one', async () => {
    const { agent, provider } = agentWith([
      'The only thing I have is nine thirty.',
      'Let me look again — I could do seven o\'clock actually.',
    ]);

    const result = await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY, hint: 'evening' });

    expect(result.outcome).toBe('agreed');
    expect(result.offer?.start).toBe(`${FRIDAY}T19:00:00`);
    const said = provider.wire.filter((w) => w.from === 'agent').map((w) => w.text);
    expect(said.some((line) => /doesn't quite work/i.test(line))).toBe(true);
  });

  it('gives up rather than booking outside the limits', async () => {
    const { agent } = agentWith([
      'Only nine thirty.',
      'Still only nine thirty.',
      'Nine thirty is all we have.',
      'Nine thirty.',
    ]);

    const result = await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY, hint: 'evening' });

    expect(result.outcome).toBe('declined');
    expect(result.success).toBe(false);
  });

  it('handles nobody picking up', async () => {
    const provider = new SimulationProvider({ peers: [{ number: restaurant, replies: [], noAnswer: true }] });
    const agent = new CallAgent({ provider });

    const result = await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY });

    expect(result.outcome).toBe('no_answer');
    expect(result.success).toBe(false);
  });

  it('reports a dial failure instead of throwing', async () => {
    const provider = new SimulationProvider({ peers: [] });
    const agent = new CallAgent({ provider });

    const result = await agent.placeCall({ to: '+15550000000', objective: dinner, date: FRIDAY });

    expect(result.outcome).toBe('failed');
    expect(result.summary).toMatch(/dial failed/);
  });

  it('never loops forever', async () => {
    const { provider } = agentWith([]);
    const chatty = new SimulationProvider({
      peers: [{ number: restaurant, replies: Array.from({ length: 100 }, () => 'one moment please') }],
    });
    const agent = new CallAgent({ provider: chatty, maxTurns: 5 });

    await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY });

    expect(chatty.wire.filter((w) => w.from === 'agent').length).toBeLessThanOrEqual(7);
    expect(provider.wire).toHaveLength(0);
  });

  it('keeps a transcript of everything said', async () => {
    const { agent } = agentWith(['Seven is booked. I could do seven forty-five?']);
    const result = await agent.placeCall({ to: restaurant, objective: dinner, date: FRIDAY, hint: 'evening' });

    expect(result.transcript.length).toBeGreaterThanOrEqual(3);
    expect(result.transcript[0].role).toBe('agent');
    expect(result.transcript.some((t) => t.role === 'peer' && /forty-five/.test(t.text))).toBe(true);
  });
});

describe('the approval callback', () => {
  const owner = '+15550000000';

  function callbackAgent(replies: string[]) {
    const provider = new SimulationProvider({ peers: [{ number: owner, replies }] });
    return { provider, agent: new CallAgent({ provider, ownerNumber: owner }) };
  }

  it('records a yes', async () => {
    const { agent } = callbackAgent(['Yeah, book it.']);
    const result = await agent.callBackForApproval({ approvalId: 'apr_1', question: 'Take 7:45?' });
    expect(result.approved).toBe(true);
  });

  it('records a no', async () => {
    const { agent } = callbackAgent(['No, leave it.']);
    const result = await agent.callBackForApproval({ approvalId: 'apr_1', question: 'Take 7:45?' });
    expect(result.approved).toBe(false);
  });

  it('asks again when the answer is ambiguous', async () => {
    const { agent, provider } = callbackAgent(['Hmm, let me think.', 'Yes, go ahead.']);
    const result = await agent.callBackForApproval({ approvalId: 'apr_1', question: 'Take 7:45?' });

    expect(result.approved).toBe(true);
    expect(provider.wire.some((w) => w.from === 'agent' && /yes or a no/i.test(w.text))).toBe(true);
  });

  it('treats silence as no', async () => {
    const { agent } = callbackAgent([]);
    const result = await agent.callBackForApproval({ approvalId: 'apr_1', question: 'Take 7:45?' });
    expect(result.approved).toBe(false);
  });

  it('needs a number to call', async () => {
    const provider = new SimulationProvider({ peers: [] });
    const agent = new CallAgent({ provider });
    await expect(agent.callBackForApproval({ approvalId: 'a', question: 'q' })).rejects.toThrow(/owner number/i);
  });
});

describe('the approval gate — human in or out of the loop', () => {
  it('approves autonomously when the evidence passes', async () => {
    const gate = new ApprovalGate(new EvidenceApprover());
    const { outcome } = await gate.request({
      subject: 'Ship the change',
      evidence: { claim: 'the suite is green', check: async () => ({ passed: true, proof: '70 tests passed' }) },
    });

    expect(outcome.approved).toBe(true);
    expect(outcome.via).toBe('evidence');
    expect(outcome.rationale).toContain('70 tests passed');
  });

  it('refuses when the evidence fails', async () => {
    const gate = new ApprovalGate(new EvidenceApprover());
    const { outcome } = await gate.request({
      subject: 'Ship the change',
      evidence: { claim: 'the suite is green', check: async () => ({ passed: false, proof: '2 tests failed' }) },
    });

    expect(outcome.approved).toBe(false);
  });

  it('treats a check that throws as a refusal, never as approval', async () => {
    const gate = new ApprovalGate(new EvidenceApprover());
    const { outcome } = await gate.request({
      subject: 'Ship it',
      evidence: {
        claim: 'the suite is green',
        check: async () => {
          throw new Error('runner exploded');
        },
      },
    });

    expect(outcome.approved).toBe(false);
    expect(outcome.rationale).toContain('runner exploded');
  });

  it('refuses when there is no evidence and nobody to ask', async () => {
    const { outcome } = await new ApprovalGate(new EvidenceApprover()).request({ subject: 'Trust me' });
    expect(outcome.approved).toBe(false);
    expect(outcome.undetermined).toBe(true);
  });

  it('falls back to a human when the evidence does not pass', async () => {
    const human = {
      name: 'phone-stub',
      decide: async () => ({ approved: true, via: 'phone', rationale: 'owner overrode' }),
    };
    const gate = new ApprovalGate(new EvidenceApprover(human));
    const { outcome } = await gate.request({
      subject: 'Ship it',
      evidence: { claim: 'green', check: async () => ({ passed: false, proof: '1 failure' }) },
    });

    expect(outcome.approved).toBe(true);
    expect(outcome.rationale).toContain('1 failure');
    expect(outcome.rationale).toContain('owner overrode');
  });

  it('never approves when autonomy is switched off', async () => {
    const { outcome } = await new ApprovalGate(new ManualApprover()).request({ subject: 'anything at all' });
    expect(outcome.approved).toBe(false);
  });
});

describe('TwiML', () => {
  it('escapes anything a caller could inject', () => {
    expect(twimlEscape('<Say>evil</Say>')).toBe('&lt;Say&gt;evil&lt;/Say&gt;');
    expect(twimlEscape('a & b')).toBe('a &amp; b');
  });

  it('builds a speak-then-listen turn', () => {
    const xml = buildTwiml({ say: 'Please enter your access code.', gather: 'dtmf', numDigits: 4, action: '/telephony/pin' });
    expect(xml).toContain('<Gather input="dtmf" numDigits="4"');
    expect(xml).toContain('<Say>Please enter your access code.</Say>');
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('does not let an utterance break out of the document', () => {
    const xml = buildTwiml({ say: '</Say><Dial>+1900PREMIUM</Dial><Say>' });
    expect(xml).not.toContain('<Dial>');
  });
});

describe('describeOffer', () => {
  it('renders something a person can be asked about', () => {
    expect(describeOffer({ start: `${FRIDAY}T19:45:00`, partySize: 2 })).toBe('2026-08-07 at 19:45, party of 2');
    expect(describeOffer({ priceCents: 45000 })).toBe('$450.00');
    expect(describeOffer({ note: 'sometime next week' })).toBe('sometime next week');
  });
});
