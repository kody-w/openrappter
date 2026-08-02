/**
 * The phone layer as something cron can wake up.
 *
 * The safety rules themselves live in telephony/watch.ts and are covered there
 * and by the Python parity suite. What matters here is the thing that is unique
 * to being scheduled: a tick is a fresh process every time, so if it does not
 * load its durable state it will see every thread as new forever, record
 * watermarks on each wake, and never actually answer anything — running
 * perfectly and doing nothing, which is the hardest failure to notice.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GoogleVoiceAgent, defaultResponder } from './GoogleVoiceAgent.js';
import { saveState, loadState } from '../telephony/watcher.js';
import { emptyState, observe } from '../telephony/watch.js';

let dir = '';
let statePath = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gvagent-'));
  statePath = join(dir, 'state.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe('GoogleVoiceAgent', () => {
  it('advertises itself with the openrappter agent contract', () => {
    const a = new GoogleVoiceAgent();
    expect(a.name).toBe('GoogleVoice');
    expect(a.metadata.description).toMatch(/first time/i);
  });

  it('reports status without polling anything', async () => {
    let state = emptyState();
    state = observe(state, 't.+15551110000', 1000);
    await saveState(state, statePath);

    const a = new GoogleVoiceAgent({ statePath });
    const out = parse(await a.perform({ action: 'status' }));
    expect(out.status).toBe('success');
    expect(out.knownThreads).toBe(1);
  });

  // THE ONE THIS FILE EXISTS FOR. Every cron wake-up is a new process. An agent
  // that forgets between ticks re-watermarks the same threads forever and never
  // reaches the point of replying — it looks healthy and accomplishes nothing.
  it('loads durable state on every tick instead of starting empty', async () => {
    let state = emptyState();
    state = observe(state, 't.+15551110000', 1000);
    state = observe(state, 't.+15551110001', 1000);
    await saveState(state, statePath);

    // No transport available, so the tick is a no-op — but it must still have
    // read the state it was given rather than inventing a blank one.
    const a = new GoogleVoiceAgent({ statePath, port: 59999 });
    const out = parse(await a.perform({}));
    expect(out.knownThreads).toBe(2);
  });

  it('degrades honestly when there is no browser to drive', async () => {
    const a = new GoogleVoiceAgent({ statePath, port: 59999 });
    const out = parse(await a.perform({}));
    expect(out.status).toBe('success');
    expect(out.replied).toBe(0);
    expect((out.log as string[]).join(' ')).toMatch(/no Chrome DevTools endpoint/);
    // Downstream agents in a chain need to be able to tell "nothing to do" from
    // "could not look", so the distinction is carried in the slush.
    expect((out.data_slush as Record<string, unknown>).transport_available).toBe(false);
  });

  it('never leaves the state file behind after a failed poll', async () => {
    const a = new GoogleVoiceAgent({ statePath, port: 59999 });
    await a.perform({});
    const after = await loadState(statePath);
    expect(after.handled).toEqual([]);
  });

  // Automated senders are not conversations, and a verification code quoted
  // back into a thread is a security problem, not a chatty agent.
  it('refuses to answer automated senders', async () => {
    const msg = (text: string) => ({
      id: 'x', threadId: 't.1', from: '+15551110000',
      direction: 'inbound' as const, text, at: 0,
    });
    for (const spam of [
      'Your verification code is 123456',
      'Your Apple Account Code is: 602998. Don\'t share it with anyone.',
      '005768 is your security code for beehiiv',
      'Your one-time passcode is 9911',
      // Verbatim from the real inbox this was written against.
      'Your Google verification code is 254846',
      'Your Link verification code is: 388542. To stop receiving these messages, reply STOP TO CANCEL',
      "Your verification code for Dunkin' is 0475.",
    ]) {
      expect(await defaultResponder(msg(spam)), spam).toBeNull();
    }
  });

  it('does answer an actual person', async () => {
    const reply = await defaultResponder({
      id: 'x', threadId: 't.1', from: '+15551110000',
      direction: 'inbound', text: 'can you do 7:45 instead?', at: 0,
    });
    expect(reply).toBeTruthy();
    expect(reply).toMatch(/openrappter/i);
  });
});
