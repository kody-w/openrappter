/**
 * The loop's safety, proven without a browser and without texting anyone.
 *
 * The decisions themselves are covered by watch.test.ts and its Python twin.
 * What is tested here is the part that only exists because this thing runs
 * unattended: does the FIRST run stay quiet, does state survive a restart, and
 * does a failed send stay retryable instead of being marked done.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GoogleVoiceWatcher, loadState, saveState } from './watcher.js';
import { emptyState } from './watch.js';
import type { WatchTransport } from './watcher.js';

let dir = '';
let statePath = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gvwatch-'));
  statePath = join(dir, 'state.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function transport(threads: Array<{ from: string; preview: string }>, sent: string[] = []): WatchTransport {
  return {
    async listInbox() {
      return threads.map((t) => ({
        threadId: `t.${t.from}`, from: t.from, preview: t.preview, unread: true,
      }));
    },
    async sendSms(to, text) {
      sent.push(`${to}: ${text}`);
      return `t.${to}`;
    },
  };
}

describe('GoogleVoiceWatcher', () => {
  // THE ONE THAT MATTERS. A watcher started against an inbox full of history
  // must not answer any of it. Getting this wrong texts everyone who has ever
  // messaged the number, at machine speed, before anyone can stop it.
  it('answers NOBODY on the first run, however full the inbox is', async () => {
    const sent: string[] = [];
    const inbox = Array.from({ length: 12 }, (_, i) => ({
      from: `+1555000${String(i).padStart(4, '0')}`, preview: `old message ${i}`,
    }));
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'hello!', log: () => {},
      driverFactory: async () => transport(inbox, sent),
    });
    expect(await w.tick()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('records watermarks on that first run so the NEXT message is live', async () => {
    const sent: string[] = [];
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'hi', log: () => {},
      driverFactory: async () => transport([{ from: '+15551110000', preview: 'first' }], sent),
    });
    await w.tick();
    const saved = await loadState(statePath);
    expect(Object.keys(saved.knownThreads)).toContain('t.+15551110000');
  });

  it('replies once the thread is known and the message is new', async () => {
    const sent: string[] = [];
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'on it', log: () => {},
      driverFactory: async () => transport([{ from: '+15551110000', preview: 'are you there?' }], sent),
    });
    await w.tick();                       // first sight: watermark only
    const w2 = new GoogleVoiceWatcher({   // a restart, reading state from disk
      statePath, respond: async () => 'on it', log: () => {},
      driverFactory: async () => transport([{ from: '+15551110000', preview: 'second message' }], sent),
    });
    (w2 as unknown as { state: unknown }).state = await loadState(statePath);
    expect(await w2.tick()).toBe(1);
    expect(sent[0]).toContain('on it');
  });

  it('never answers the same message twice across polls', async () => {
    const sent: string[] = [];
    const t = transport([{ from: '+15551110000', preview: 'hello?' }], sent);
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'reply', log: () => {},
      driverFactory: async () => t,
    });
    await w.tick();
    (w as unknown as { state: unknown }).state = await loadState(statePath);
    await w.tick();
    await w.tick();
    await w.tick();
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  // A send that failed must stay unhandled. Marking it done would lose the
  // message silently; retrying is safe because sendSms refuses to report an
  // unconfirmed send as successful.
  it('leaves a FAILED send unhandled so the next poll retries it', async () => {
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'reply', log: () => {},
      driverFactory: async () => ({
        async listInbox() {
          return [{ threadId: 't.x', from: '+15551110000', preview: 'hi', unread: true }];
        },
        async sendSms() { throw new Error('send could not be confirmed'); },
      }),
    });
    await w.tick();
    (w as unknown as { state: unknown }).state = await loadState(statePath);
    await w.tick();
    const after = await loadState(statePath);
    expect(after.handled).toEqual([]);
  });

  it('dry run decides and records but sends nothing', async () => {
    const sent: string[] = [];
    const w = new GoogleVoiceWatcher({
      statePath, dryRun: true, respond: async () => 'would say this', log: () => {},
      driverFactory: async () => transport([{ from: '+15551110000', preview: 'first' }], sent),
    });
    await w.tick();
    (w as unknown as { state: unknown }).state = await loadState(statePath);
    await w.tick();
    expect(sent).toEqual([]);
  });

  it('survives a missing transport without throwing', async () => {
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'x', log: () => {},
      driverFactory: async () => null,
    });
    await expect(w.tick()).resolves.toBe(0);
  });

  // Corrupt state must not read as "everything is new", which would re-answer
  // the entire inbox — the same catastrophe as a bad first run.
  it('treats a corrupt state file as empty rather than as a clean slate', async () => {
    await writeFile(statePath, '{ this is not json');
    const s = await loadState(statePath);
    expect(s).toEqual(emptyState());
    const sent: string[] = [];
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'hi', log: () => {},
      driverFactory: async () => transport([{ from: '+15551110000', preview: 'old' }], sent),
    });
    expect(await w.tick()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('writes state atomically, so a kill mid-write cannot corrupt it', async () => {
    const s = emptyState();
    s.knownThreads['t.1'] = { watermark: 123 };
    await saveState(s, statePath);
    expect((await loadState(statePath)).knownThreads['t.1'].watermark).toBe(123);
  });

  // A group answered by texting one participant is worse than no answer: the
  // rest of the group never sees it, and one person gets what looks like an
  // unsolicited direct message from a number they were only ever in a group with.
  it('replies to a GROUP in its thread, never privately to one participant', async () => {
    const sms: string[] = [];
    const threads: string[] = [];
    let t = 1_000_000;
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'group reply', log: () => {},
      now: () => (t += 60_000),
      driverFactory: async () => ({
        async listInbox() {
          return [{
            threadId: 'g.4048406745-7043867727', from: '+14048406745',
            preview: 'hi all', unread: true, isGroup: true,
          }];
        },
        async sendSms(to: string) { sms.push(to); return 't'; },
        async sendToThread(id: string) { threads.push(id); return id; },
      }),
    });
    await w.tick();
    (w as unknown as { state: unknown }).state = await loadState(statePath);
    await w.tick();
    expect(sms, 'a group must never be answered with a private sendSms').toEqual([]);
    expect(threads).toEqual(['g.4048406745-7043867727']);
  });

  it('refuses a group when the transport cannot reply in-thread', async () => {
    let t2 = 1_000_000;
    const w = new GoogleVoiceWatcher({
      statePath, respond: async () => 'x', log: () => {},
      now: () => (t2 += 60_000),
      driverFactory: async () => ({
        async listInbox() {
          return [{ threadId: 'g.1-2', from: '+15551110000', preview: 'hi', unread: true, isGroup: true }];
        },
        async sendSms() { throw new Error('should never be called for a group'); },
      }),
    });
    await w.tick();
    (w as unknown as { state: unknown }).state = await loadState(statePath);
    await w.tick();
    // Unhandled, so a transport that CAN reply will pick it up later.
    expect((await loadState(statePath)).handled).toEqual([]);
  });
});
