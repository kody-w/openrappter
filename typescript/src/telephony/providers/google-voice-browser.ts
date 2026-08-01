/**
 * Google Voice, driven in the owner's own browser — the free phone layer.
 *
 * This is the implementation `GoogleVoiceProvider` has always been written
 * against and never had. Until now `GoogleVoiceDriver` was a type with exactly
 * one implementation, a fake inside a test, so the on-device path could be
 * reasoned about but never dialled.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Every other voice backend bills per minute and wants an account, a key, and a
 * copy of the conversation. The owner already has a phone number that costs
 * nothing, and a browser already signed into it. This reaches that, so the
 * cheapest provider in the ladder is also the one that keeps the most at home.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE IS BUILT AROUND
 *
 *   Never report a message as sent unless the thread can be seen to contain it.
 *
 * A telephony layer that silently no-ops is worse than one that fails: the
 * negotiation loop above will happily wait for a reply to a message that was
 * never delivered, then record an outcome for a conversation that did not
 * happen. Google Voice is a live web app whose DOM is not a stable contract, so
 * "I clicked something" is not evidence. Every send therefore reads the thread
 * back and confirms its own text arrived, and throws if it did not.
 *
 * The same discipline as the rest of the estate: a 403 is an answer, silence is
 * not, and you do not get to claim you spoke because you moved your mouth.
 */

import type { GoogleVoiceDriver } from './google-voice.js';
import type { PageSurface } from './chrome-cdp.js';

const GV_MESSAGES = 'https://voice.google.com/u/0/messages';

export interface GoogleVoiceBrowserOptions {
  page: PageSurface;
  /** The account the session must be. Mismatch is refused, never "close enough". */
  account?: string;
  /**
   * Compose and confirm, but never actually send. Real numbers belong to real
   * people; this makes the whole path exercisable without texting one.
   */
  dryRun?: boolean;
  pollMs?: number;
  /**
   * Where the message view lives. Defaults to the real Google Voice.
   *
   * Configurable because a hardcoded URL made this class impossible to verify:
   * every send navigated to live Google Voice, so the DOM logic could only ever
   * be exercised against the real product with a real account, which is exactly
   * the thing you do not want to be discovering selector bugs on.
   */
  messagesUrl?: string;
  /**
   * How long to wait for a sent message to appear in the thread before giving
   * up and calling it unsent. Configurable because a loaded machine on poor
   * wifi is not the same as a fast one, and because a guard you cannot exercise
   * in a test is a guard you do not know works.
   */
  confirmTimeoutMs?: number;
}

/** Raised when the page is not in the state the driver requires. */
export class GoogleVoiceSurfaceError extends Error {
  constructor(what: string, detail?: string) {
    super(detail ? `${what} — ${detail}` : what);
    this.name = 'GoogleVoiceSurfaceError';
  }
}

const jsonArg = (s: string): string => JSON.stringify(s);

export class GoogleVoiceBrowserDriver implements GoogleVoiceDriver {
  private readonly page: PageSurface;
  private readonly account?: string;
  private readonly dryRun: boolean;
  private readonly pollMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly messagesUrl: string;

  constructor(options: GoogleVoiceBrowserOptions) {
    this.page = options.page;
    this.account = options.account ?? process.env.GOOGLE_VOICE_ACCOUNT;
    this.dryRun = options.dryRun ?? false;
    this.pollMs = options.pollMs ?? 2000;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 15_000;
    this.messagesUrl = options.messagesUrl ?? GV_MESSAGES;
  }

  async isSignedIn(account?: string): Promise<boolean> {
    const want = account ?? this.account;
    const here = await this.page.url().catch(() => '');
    if (!here.includes('voice.google.com') && !here.startsWith(this.messagesUrl)) {
      await this.page.navigate(this.messagesUrl);
    }

    const state = await this.page.evaluate<{ signedIn: boolean; account: string | null }>(`(() => {
      // A sign-in redirect is the unambiguous negative signal.
      if (location.hostname.includes('accounts.google.com')) return { signedIn: false, account: null };
      const blob = document.body ? document.body.innerText : '';
      const m = blob.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
      const hasApp = !!document.querySelector('[gv-test-id], gv-app, [jsname]');
      return { signedIn: hasApp && !location.pathname.startsWith('/signin'), account: m ? m[0] : null };
    })()`);

    if (!state.signedIn) return false;
    // An account mismatch means texting from the wrong number. Refuse rather
    // than guess — the recipient sees whichever number actually sent.
    if (want && state.account && state.account.toLowerCase() !== want.toLowerCase()) {
      throw new GoogleVoiceSurfaceError(
        'signed in as the wrong Google account',
        `session is ${state.account}, expected ${want}`,
      );
    }
    return true;
  }

  /**
   * Send a text and prove it landed.
   *
   * Returns the thread id, which is what `awaitReply` polls. The id comes from
   * the URL Google Voice itself settles on, not from anything constructed here.
   */
  async sendSms(to: string, text: string): Promise<string> {
    if (!(await this.isSignedIn())) {
      throw new GoogleVoiceSurfaceError('not signed in to Google Voice');
    }

    const sep = this.messagesUrl.includes('?') ? '&' : '?';
    await this.page.navigate(`${this.messagesUrl}${sep}a=nc,${encodeURIComponent(to)}`);

    const composed = await this.page.evaluate<{ ok: boolean; why?: string }>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let box = null;
      for (let i = 0; i < 40 && !box; i++) {
        box = document.querySelector('textarea[gv-test-id="gv-message-input"]')
           || document.querySelector('div[contenteditable="true"][role="textbox"]')
           || document.querySelector('textarea[aria-label*="essage" i]')
           || document.querySelector('textarea');
        if (!box) await sleep(250);
      }
      if (!box) return { ok: false, why: 'no message input appeared' };
      box.focus();
      const value = ${jsonArg(text)};
      if (box.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(box, value);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        box.textContent = value;
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      await sleep(150);
      const read = box.tagName === 'TEXTAREA' ? box.value : box.textContent;
      if (!read || read.indexOf(value) === -1) return { ok: false, why: 'input did not take the text' };
      return { ok: true };
    })()`);

    if (!composed.ok) throw new GoogleVoiceSurfaceError('could not compose the message', composed.why);

    if (this.dryRun) {
      return `dry-run:${to}`;
    }

    const before = await this.countOutbound(text);

    const clicked = await this.page.evaluate<{ ok: boolean; why?: string }>(`(() => {
      const btn = document.querySelector('button[gv-test-id="send-button"]')
               || Array.from(document.querySelectorAll('button')).find(b =>
                    /send/i.test(b.getAttribute('aria-label') || '') && !b.disabled);
      if (!btn) return { ok: false, why: 'no enabled send button' };
      btn.click();
      return { ok: true };
    })()`);
    if (!clicked.ok) throw new GoogleVoiceSurfaceError('could not press send', clicked.why);

    // The confirmation. A click is an intention; the thread is the evidence.
    const landed = await this.waitFor(
      async () => (await this.countOutbound(text)) > before,
      this.confirmTimeoutMs,
    );
    if (!landed) {
      throw new GoogleVoiceSurfaceError(
        'send could not be confirmed',
        'the message does not appear in the thread; treating it as NOT sent rather than assuming delivery',
      );
    }

    const url = await this.page.url();
    const m = url.match(/itemId=([^&]+)/) ?? url.match(/messages\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : `thread:${to}`;
  }

  async awaitReply(threadId: string, timeoutMs: number): Promise<string | null> {
    if (threadId.startsWith('dry-run:')) return null;

    const baseline = await this.lastInbound();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latest = await this.lastInbound();
      if (latest && latest !== baseline) return latest;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return null;
  }

  /** Google Voice cannot put the agent's voice on a call; this bridges the owner. */
  async placeBridgedCall(to: string): Promise<string> {
    if (!(await this.isSignedIn())) {
      throw new GoogleVoiceSurfaceError('not signed in to Google Voice');
    }
    if (this.dryRun) return `dry-run-call:${to}`;
    const callSep = this.messagesUrl.includes('?') ? '&' : '?';
    await this.page.navigate(
      `${this.messagesUrl.replace('/messages', '/calls')}${callSep}a=nc,${encodeURIComponent(to)}`,
    );
    return `bridged:${to}`;
  }

  private async countOutbound(text: string): Promise<number> {
    return this.page.evaluate<number>(`(() => {
      const want = ${jsonArg(text)};
      const nodes = Array.from(document.querySelectorAll('[data-e2e-message-text], .gvMessageText, [gv-test-id*="message"]'));
      const hay = nodes.length ? nodes.map(n => n.textContent || '') : [document.body ? document.body.innerText : ''];
      return hay.filter(t => t.indexOf(want) !== -1).length;
    })()`);
  }

  private async lastInbound(): Promise<string | null> {
    return this.page.evaluate<string | null>(`(() => {
      const nodes = Array.from(document.querySelectorAll('[data-e2e-message-text], .gvMessageText'));
      if (!nodes.length) return null;
      // Inbound bubbles are the ones Google Voice does not mark as ours.
      const inbound = nodes.filter(n => {
        const row = n.closest('[data-e2e-is-outgoing], .gvMessageRow, li, div');
        const flag = row && row.getAttribute && row.getAttribute('data-e2e-is-outgoing');
        return flag !== 'true';
      });
      const last = inbound[inbound.length - 1];
      return last ? (last.textContent || '').trim() || null : null;
    })()`);
  }

  private async waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check().catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }
}

export interface ConnectGoogleVoiceOptions {
  port?: number;
  account?: string;
  dryRun?: boolean;
  confirmTimeoutMs?: number;
  messagesUrl?: string;
}

/**
 * Attach to the owner's Google Voice tab and return a driver the ladder can use.
 *
 * Returns null — rather than throwing — when Chrome has no debugging port open,
 * because that is the ordinary case rather than an error: the ladder simply
 * carries on to the next rung. `ChromeSession.isAvailable()` and
 * `ChromeNotDebuggableError` carry the explanation for anyone who wants it.
 */
export async function connectGoogleVoice(
  options: ConnectGoogleVoiceOptions = {},
): Promise<GoogleVoiceBrowserDriver | null> {
  const { ChromeSession } = await import('./chrome-cdp.js');
  const session = new ChromeSession({ port: options.port });
  if (!(await session.isAvailable())) return null;

  const page = await session
    .page('voice.google.com', 'https://voice.google.com/u/0/messages')
    .catch(() => null);
  if (!page) return null;

  return new GoogleVoiceBrowserDriver({
    page,
    account: options.account,
    dryRun: options.dryRun,
    confirmTimeoutMs: options.confirmTimeoutMs,
    messagesUrl: options.messagesUrl,
  });
}
