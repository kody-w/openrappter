/**
 * The Google Voice browser driver's job is not to click things — it is to be
 * unable to lie about whether a message went out.
 *
 * The failure this file mostly exists to prevent: a send that quietly does
 * nothing. The negotiation loop above will wait for a reply to a message that
 * was never delivered, then write an outcome for a conversation that never
 * happened. So an unconfirmed send must be an error, never an optimistic
 * success.
 */

import { describe, it, expect } from 'vitest';
import { GoogleVoiceBrowserDriver, GoogleVoiceSurfaceError } from './google-voice-browser.js';
import type { PageSurface } from './chrome-cdp.js';

/**
 * A fake page that answers the driver's evaluations by intent rather than by
 * running JavaScript. Each knob corresponds to a real way the live app fails.
 */
function fakePage(opts: {
  signedIn?: boolean;
  account?: string | null;
  inputAppears?: boolean;
  inputTakesText?: boolean;
  sendButton?: boolean;
  /** Does the sent text actually show up in the thread afterwards? */
  landsInThread?: boolean;
  inbound?: string[];
  url?: string;
} = {}): { page: PageSurface; sent: string[]; navigations: string[] } {
  const o = {
    signedIn: true, account: null, inputAppears: true, inputTakesText: true,
    sendButton: true, landsInThread: true, inbound: [] as string[],
    url: 'https://voice.google.com/u/0/messages?itemId=t.42', ...opts,
  };
  const sent: string[] = [];
  const navigations: string[] = [];
  let clicked = false;
  let inboundIdx = 0;

  const page: PageSurface = {
    async evaluate<T>(expr: string): Promise<T> {
      if (expr.includes('location.href')) return o.url as unknown as T;
      if (expr.includes('signedIn')) {
        return { signedIn: o.signedIn, account: o.account } as unknown as T;
      }
      if (expr.includes('no message input appeared')) {
        if (!o.inputAppears) return { ok: false, why: 'no message input appeared' } as unknown as T;
        if (!o.inputTakesText) return { ok: false, why: 'input did not take the text' } as unknown as T;
        const m = expr.match(/const value = ("(?:[^"\\]|\\.)*")/);
        if (m) sent.push(JSON.parse(m[1]));
        return { ok: true } as unknown as T;
      }
      if (expr.includes('no enabled send button')) {
        if (!o.sendButton) return { ok: false, why: 'no enabled send button' } as unknown as T;
        clicked = true;
        return { ok: true } as unknown as T;
      }
      if (expr.includes('nodes.filter')) {
        const v = inboundIdx < o.inbound.length ? o.inbound[inboundIdx++] : (o.inbound.at(-1) ?? null);
        return v as unknown as T;
      }
      if (expr.includes('indexOf(want)')) {
        // Count of the outbound text in the thread: 0 before the click, 1 after —
        // but only when this fake is configured to actually deliver it.
        return (clicked && o.landsInThread ? 1 : 0) as unknown as T;
      }
      return undefined as unknown as T;
    },
    async navigate(url: string) { navigations.push(url); },
    async url() { return o.url; },
    async close() {},
  };
  return { page, sent, navigations };
}

describe('GoogleVoiceBrowserDriver', () => {
  it('sends and confirms the message actually reached the thread', async () => {
    const { page, sent } = fakePage();
    const d = new GoogleVoiceBrowserDriver({ page });
    const thread = await d.sendSms('+15551234567', 'Table for 4 at 7:30?');
    expect(sent).toEqual(['Table for 4 at 7:30?']);
    expect(thread).toBe('t.42');
  });

  // The one that matters. A click is an intention; the thread is the evidence.
  it('THROWS when the send cannot be confirmed, rather than reporting success', async () => {
    const { page } = fakePage({ landsInThread: false });
    const d = new GoogleVoiceBrowserDriver({ page, confirmTimeoutMs: 60 });
    await expect(d.sendSms('+15551234567', 'hello')).rejects.toThrow(/could not be confirmed/i);
  });

  it('says why an unconfirmed send is treated as not sent', async () => {
    const { page } = fakePage({ landsInThread: false });
    const d = new GoogleVoiceBrowserDriver({ page, confirmTimeoutMs: 60 });
    await expect(d.sendSms('+1555', 'x')).rejects.toThrow(/NOT sent rather than assuming delivery/);
  });

  it('refuses when the compose box never appears', async () => {
    const { page } = fakePage({ inputAppears: false });
    const d = new GoogleVoiceBrowserDriver({ page });
    await expect(d.sendSms('+1555', 'x')).rejects.toThrow(/could not compose/i);
  });

  it('refuses when the text does not land in the input', async () => {
    const { page } = fakePage({ inputTakesText: false });
    const d = new GoogleVoiceBrowserDriver({ page });
    await expect(d.sendSms('+1555', 'x')).rejects.toThrow(/did not take the text/i);
  });

  it('refuses when there is no enabled send button', async () => {
    const { page } = fakePage({ sendButton: false });
    const d = new GoogleVoiceBrowserDriver({ page });
    await expect(d.sendSms('+1555', 'x')).rejects.toThrow(/could not press send/i);
  });

  it('refuses to send when not signed in', async () => {
    const { page } = fakePage({ signedIn: false });
    const d = new GoogleVoiceBrowserDriver({ page });
    await expect(d.sendSms('+1555', 'x')).rejects.toThrow(/not signed in/i);
  });

  // Texting from the wrong number is not a cosmetic error: the recipient sees
  // whichever number actually sent, and replies go somewhere unwatched.
  it('refuses a session signed in as a different account', async () => {
    const { page } = fakePage({ account: 'someone.else@gmail.com' });
    const d = new GoogleVoiceBrowserDriver({ page, account: 'wildhavenhomesllc@gmail.com' });
    await expect(d.isSignedIn()).rejects.toThrow(/wrong Google account/i);
  });

  it('accepts the configured account', async () => {
    const { page } = fakePage({ account: 'wildhavenhomesllc@gmail.com' });
    const d = new GoogleVoiceBrowserDriver({ page, account: 'WildhavenHomesLLC@gmail.com' });
    await expect(d.isSignedIn()).resolves.toBe(true);
  });

  it('dry run composes but never presses send', async () => {
    const { page, sent } = fakePage({ landsInThread: false });
    const d = new GoogleVoiceBrowserDriver({ page, dryRun: true });
    const thread = await d.sendSms('+15551234567', 'rehearsal');
    // It got as far as composing — so the path is genuinely exercised — but the
    // unconfirmed-send guard never fires because nothing was sent.
    expect(sent).toEqual(['rehearsal']);
    expect(thread).toBe('dry-run:+15551234567');
  });

  it('never polls for a reply to a dry run', async () => {
    const { page } = fakePage();
    const d = new GoogleVoiceBrowserDriver({ page, pollMs: 1 });
    await expect(d.awaitReply('dry-run:+1555', 50)).resolves.toBeNull();
  });

  it('returns a new inbound message', async () => {
    const { page } = fakePage({ inbound: ['old', 'old', 'we can do 7:45'] });
    const d = new GoogleVoiceBrowserDriver({ page, pollMs: 1 });
    await expect(d.awaitReply('t.42', 2000)).resolves.toBe('we can do 7:45');
  });

  it('returns null when the other party stays quiet', async () => {
    const { page } = fakePage({ inbound: ['same'] });
    const d = new GoogleVoiceBrowserDriver({ page, pollMs: 1 });
    await expect(d.awaitReply('t.42', 60)).resolves.toBeNull();
  });

  it('does not treat an unchanged thread as a reply', async () => {
    const { page } = fakePage({ inbound: ['their last message from yesterday'] });
    const d = new GoogleVoiceBrowserDriver({ page, pollMs: 1 });
    await expect(d.awaitReply('t.42', 60)).resolves.toBeNull();
  });
});
