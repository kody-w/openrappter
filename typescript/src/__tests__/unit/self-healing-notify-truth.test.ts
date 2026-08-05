/**
 * An alert is not sent because nothing threw. — #134
 *
 * `SelfHealingCronAgent` set `notified: true` whenever `messageAgent.execute()`
 * returned without throwing. Agents in this codebase do not throw: `execute()`
 * returns a JSON STRING, and `MessageAgent` reports every failure as
 * `{"status":"error", ...}` inside it. So an alert that was never sent — no
 * channel configured, no token, the send refused — was recorded as delivered.
 *
 * Measured by an independent reviewer driving the built agent with fetch
 * intercepted, so nothing left the machine:
 *
 *     network_fetches=[]
 *     reported_notified=true
 *     alert=Service "probe" is DOWN — restart failed
 *
 * This is the failure this project distrusts everywhere else — reporting
 * success it has not earned — and it is worse here than in a test, because the
 * whole point of the alert is that a human learns a service is down. An
 * operator reading `notified: true` has been told the opposite of what
 * happened, in exactly the situation where they most need the truth.
 */

import { describe, it, expect } from 'vitest';
import { SelfHealingCronAgent } from '../../agents/SelfHealingCronAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

/** A sender that answers however the test says, the way real agents answer. */
class StubSender extends BasicAgent {
  public calls: Record<string, unknown>[] = [];

  constructor(private readonly reply: string | (() => never)) {
    super('StubSender', { name: 'StubSender', description: 'test double', parameters: { type: 'object', properties: {}, required: [] } });
  }

  async execute(kwargs: Record<string, unknown> = {}): Promise<string> {
    this.calls.push(kwargs);
    if (typeof this.reply === 'function') this.reply();
    return this.reply as string;
  }

  async perform(): Promise<string> { return this.execute(); }
}

/** A service that is always down, so every run reaches the alert. */
class DownService extends BasicAgent {
  constructor() {
    super('DownService', { name: 'DownService', description: 'test double', parameters: { type: 'object', properties: {}, required: [] } });
  }

  async execute(): Promise<string> {
    return JSON.stringify({ status: 'error', message: 'connection refused' });
  }

  async perform(): Promise<string> { return this.execute(); }
}

async function runAgainst(sender: StubSender): Promise<Record<string, unknown>> {
  const agent = new SelfHealingCronAgent({
    webAgent: new DownService(),
    shellAgent: new StubSender(JSON.stringify({ status: 'success', output: '' })),
    messageAgent: sender,
  });
  await agent.perform({
    action: 'setup',
    name: 'probe',
    url: 'http://127.0.0.1:1/never',
    restartCommand: 'true',
    notifyChannel: 'imessage',
    conversationId: '+15550000000',
    maxRetries: 0,
  });
  const out = JSON.parse(await agent.perform({ action: 'check', name: 'probe' }));
  return out.check as Record<string, unknown>;
}

describe('an alert is only notified if it was actually sent', () => {
  it('does not claim to have notified when the sender reported an error', async () => {
    // The exact shape MessageAgent returns when it cannot send. It does not
    // throw, which is the whole defect.
    const sender = new StubSender(JSON.stringify({
      status: 'error', message: 'No channel configured for imessage',
    }));

    const out = await runAgainst(sender);

    expect(sender.calls).toHaveLength(1);   // it did try
    expect(out.notified).toBe(false);       // and it must not say it succeeded
    // And the operator is told why, because "I could not notify anyone" is a
    // useful answer and silence is not.
    expect(String(out.notifyError ?? '')).toMatch(/No channel configured/);
  });

  it('says it notified when the sender reported success', async () => {
    // The negative control: the fix must not make every alert look undelivered.
    const sender = new StubSender(JSON.stringify({ status: 'success', message: 'sent' }));

    const out = await runAgainst(sender);

    expect(out.notified).toBe(true);
    expect(out.notifyError).toBeUndefined();
  });

  it('does not claim to have notified when the sender threw', async () => {
    const sender = new StubSender((() => { throw new Error('transport exploded'); }) as () => never);

    const out = await runAgainst(sender);

    expect(out.notified).toBe(false);
    expect(String(out.notifyError ?? '')).toMatch(/transport exploded/);
  });

  it('does not claim to have notified when no channel is configured at all', async () => {
    // No notifyChannel means the sender is never called. Reporting `notified:
    // false` is right, and so is saying plainly that nobody was told.
    const sender = new StubSender(JSON.stringify({ status: 'success' }));
    const agent = new SelfHealingCronAgent({
      webAgent: new DownService(),
      shellAgent: new StubSender(JSON.stringify({ status: 'success', output: '' })),
      messageAgent: sender,
    });
    await agent.perform({
      action: 'setup', name: 'probe', url: 'http://127.0.0.1:1/never',
      restartCommand: 'true', maxRetries: 0,
    });

    const out = JSON.parse(await agent.perform({ action: 'check', name: 'probe' })).check;

    expect(sender.calls).toHaveLength(0);
    expect(out.notified).toBe(false);
    expect(String(out.notifyError ?? '')).toMatch(/no notification channel/i);
  });
});
