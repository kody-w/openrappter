/**
 * The watcher's judgement, held identical across both sets of bones.
 *
 * openrappter can drive a browser and a grail brainstem in Pyodide cannot, so
 * the TRANSPORT legitimately differs by device. The judgement must not. If the
 * same inbox produces a reply on one platform and silence on the other, then
 * which machine happened to wake up first is a behavioural fact, and "the same
 * organism on either bones" stops being true.
 *
 * Python side: python3 python/tests/test_google_voice_agent.py
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decide, observe, recordReply, emptyState, DEFAULT_POLICY } from './watch.js';
import type { InboxMessage, WatchPolicy, WatchState } from './watch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', 'tests', 'google-voice-parity.json'), 'utf8'),
);

describe('google voice watch parity', () => {
  it('the fixture covers every way this can go wrong', () => {
    const reasons = new Set(fixture.cases.map((c: { expect: { reason: string } }) => c.expect.reason));
    // Each of these is a real incident this watcher is built to avoid, not a
    // branch chased for coverage.
    for (const required of [
      'outbound', 'self', 'already-handled', 'thread-unseen',
      'older-than-watermark', 'too-old', 'not-allowed', 'rate-limited', 'new-inbound',
    ]) {
      expect(reasons, `no case covers "${required}"`).toContain(required);
    }
  });

  for (const c of fixture.cases as Array<{
    $why: string;
    message: InboxMessage;
    state: WatchState;
    policy?: WatchPolicy;
    expect: { act: boolean; reason: string };
  }>) {
    it(c.$why, () => {
      const policy = (c.policy ?? fixture.policy) as WatchPolicy;
      const verdict = decide(c.message, c.state, policy, fixture.now);
      expect(verdict.act).toBe(c.expect.act);
      expect(verdict.reason).toBe(c.expect.reason);
    });
  }

  for (const t of fixture.transitions as Array<{
    $why: string; op: string; state: WatchState; threadId?: string;
    message?: InboxMessage; at: number; expect: WatchState;
  }>) {
    it(t.$why, () => {
      const next =
        t.op === 'observe'
          ? observe(t.state, t.threadId as string, t.at)
          : recordReply(t.state, t.message as InboxMessage, t.at);
      expect(next).toEqual(t.expect);
    });
  }

  it('starts from a state that cannot act on anything', () => {
    // The safest possible starting position: an empty watcher answers nobody
    // until it has seen a thread once.
    const s = emptyState();
    const msg: InboxMessage = {
      id: 'x', threadId: 't.any', from: '+15551112222',
      direction: 'inbound', text: 'hi', at: fixture.now - 1000,
    };
    expect(decide(msg, s, DEFAULT_POLICY, fixture.now).act).toBe(false);
  });

  it('becomes able to act only after the thread has been observed once', () => {
    const msg: InboxMessage = {
      id: 'x', threadId: 't.any', from: '+15551112222',
      direction: 'inbound', text: 'hi', at: fixture.now - 1000,
    };
    const seen = observe(emptyState(), 't.any', fixture.now - 5000);
    expect(decide(msg, seen, DEFAULT_POLICY, fixture.now).act).toBe(true);
  });

  it('stops after the cap and does not creep past it', () => {
    // Walk the real loop: reply, record, reply, record… and confirm it stops.
    let state = observe(emptyState(), 't.loop', fixture.now - 10_000);
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const msg: InboxMessage = {
        id: `loop-${i}`, threadId: 't.loop', from: '+15551113333',
        direction: 'inbound', text: 'again', at: fixture.now - 1000 + i,
      };
      const v = decide(msg, state, DEFAULT_POLICY, fixture.now);
      if (!v.act) break;
      allowed++;
      state = recordReply(state, msg, fixture.now);
    }
    expect(allowed).toBe(DEFAULT_POLICY.maxRepliesPerThread);
  });

  it('keeps handled ids bounded so a 24/7 daemon cannot grow without limit', () => {
    let state = observe(emptyState(), 't.big', 0);
    for (let i = 0; i < 700; i++) {
      state = recordReply(
        state,
        { id: `n${i}`, threadId: 't.big', from: '+1555', direction: 'inbound', text: 'x', at: i },
        i,
      );
    }
    expect(state.handled.length).toBeLessThanOrEqual(500);
    // The newest must survive, or the watcher would re-answer what it just did.
    expect(state.handled).toContain('n699');
  });
});
