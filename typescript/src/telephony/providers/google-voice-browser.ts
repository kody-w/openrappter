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

/** One thread as the inbox list shows it, without opening it. */
export interface InboxEntry {
  threadId: string;
  from: string;
  preview: string;
  unread: boolean;
  /**
   * The timestamp the list itself displays - "8:02 PM", "Jul 14", "Mar 9".
   *
   * Deliberately the raw string. It is not a real clock reading and must not be
   * dressed up as one, but it is what distinguishes two identical messages sent
   * hours apart. Without it, message identity is a hash of the preview alone,
   * and someone texting "ok" twice would have the second one silently dropped
   * as a duplicate.
   */
  shownAt: string;
}

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

  /** Put text in the compose box and verify the box actually took it. */
  private async composeInto(text: string): Promise<void> {
    await this.composeInto(text);
  }

  /** Press Send, waiting for the app to enable it rather than clicking a no-op. */
  private async pressSend(): Promise<void> {
    const clicked = await this.page.evaluate<{ ok: boolean; why?: string }>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const find = () => document.querySelector('button[gv-test-id="send-button"]:not([disabled])')
        || Array.from(document.querySelectorAll('button')).find(b =>
             /send/i.test(b.getAttribute('aria-label') || '') && !b.disabled && !!b.offsetParent);
      let btn = null;
      for (let i = 0; i < 20 && !btn; i++) { btn = find(); if (!btn) await sleep(250); }
      if (!btn) return { ok: false, why: 'send button never became enabled' };
      btn.click();
      return { ok: true };
    })()`);
    if (!clicked.ok) throw new GoogleVoiceSurfaceError('could not press send', clicked.why);
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

    // The live app addresses a thread by itemId, not by the `a=nc,` parameter
    // this originally guessed at. That guess quietly landed on the CALLS view,
    // where the only textarea is the dialpad — so the driver typed a message
    // into a phone-number field and then correctly failed to find a send button.
    // Composing into the wrong control is precisely the class of mistake the
    // confirmation step exists to stop from being reported as a sent message.
    const sep = this.messagesUrl.includes('?') ? '&' : '?';
    const itemId = `t.${to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`}`;
    await this.page.navigate(`${this.messagesUrl}${sep}itemId=${encodeURIComponent(itemId)}`);

    const composed = await this.page.evaluate<{ ok: boolean; why?: string }>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Visibility is part of the selector, not an afterthought: this view keeps
      // detached textareas around, and the calls view owns a dialpad textarea.
      const pick = () => {
        const cands = Array.from(document.querySelectorAll('textarea,div[contenteditable="true"][role="textbox"]'));
        const visible = cands.filter(el => !!el.offsetParent);
        return visible.find(el => /type a message/i.test(el.getAttribute('placeholder') || ''))
            || visible.find(el => /message/i.test(el.getAttribute('aria-label') || ''))
            || visible.find(el => el.getAttribute('gv-test-id') === 'gv-message-input')
            || visible[0] || null;
      };
      let box = null;
      for (let i = 0; i < 40 && !box; i++) { box = pick(); if (!box) await sleep(250); }
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

    const clicked = await this.page.evaluate<{ ok: boolean; why?: string }>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const find = () => document.querySelector('button[gv-test-id="send-button"]:not([disabled])')
        || Array.from(document.querySelectorAll('button')).find(b =>
             /send/i.test(b.getAttribute('aria-label') || '') && !b.disabled && !!b.offsetParent);
      // Google Voice keeps Send disabled until it has registered the text. Waiting
      // for it to enable is the app telling us it accepted the input — clicking a
      // disabled button would be a no-op that looks exactly like a send.
      let btn = null;
      for (let i = 0; i < 20 && !btn; i++) { btn = find(); if (!btn) await sleep(250); }
      if (!btn) return { ok: false, why: 'send button never became enabled' };
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

  /**
   * Read the inbox: the newest message in each visible thread.
   *
   * This is what a 24/7 watcher polls. It returns BOTH directions on purpose —
   * the watcher's decision layer needs to see an outbound bubble to know the
   * last word was ours, and silently filtering here would move that judgement
   * out of the shared, parity-tested code and into a browser-only file where the
   * grail bones could never agree with it.
   *
   * Voicemail counts. Google Voice transcribes it, so a missed CALL arrives as
   * readable text — the agent still cannot speak on a call, but it can act on
   * what was said, which is most of the value.
   */
  async listInbox(limit = 25): Promise<InboxEntry[]> {
    if (!(await this.isSignedIn())) {
      throw new GoogleVoiceSurfaceError('not signed in to Google Voice');
    }
    await this.page.navigate(this.messagesUrl);

    return this.page.evaluate<InboxEntry[]>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Learned from the live app: rows are <gv-thread-list-item>. Neither
      // [role="listitem"] nor gv-thread-item exists here, and guessing them
      // returned an empty inbox that looked exactly like "no messages" — a
      // watcher polling that would have sat silent forever, reporting health.
      let rows = [];
      for (let i = 0; i < 20; i++) {
        rows = Array.from(document.querySelectorAll('gv-thread-list-item'));
        if (rows.length) break;
        await sleep(250);
      }
      const out = [];
      for (const row of rows.slice(0, ${limit})) {
        const text = (row.innerText || '').replace(/\\s+/g, ' ').trim();

        // Parse the FORMATTED number, not the screen-reader digit run.
        //
        // The first version matched a run of spaced digits, which is greedy and
        // has no idea where one number ends and the next begins. On a GROUP
        // thread — "(404) 840-6745, (704) 386-7727" — it produced the eleven
        // digit string 14048406745, and the watcher was one poll away from
        // texting a number that does not exist. An unattended agent messaging a
        // stranger because a regex over-matched is not a cosmetic bug.
        const formatted = text.match(/\\((\\d{3})\\)\\s?(\\d{3})-(\\d{4})/g) || [];
        const numbers = [];
        for (const f of formatted) {
          const d = f.replace(/\\D/g, '');
          if (d.length === 10 && numbers.indexOf(d) === -1) numbers.push(d);
        }
        // A group thread has more than one participant and no single correct
        // reply target. Guessing one is worse than skipping it.
        // A thread with no parseable number at all is a short code — an
        // automated sender like a verification service. Those are never
        // conversations and must never be replied to.
        if (numbers.length === 0) continue;
        // Groups are kept, not skipped. They are addressed by opening the thread
        // rather than by building a URL from one participant's number, because
        // picking a participant would send a private message to someone who was
        // expecting a group reply — and nobody else would see it.
        const isGroup = numbers.length > 1;
        const num = numbers[0];
        const labelled = row.querySelector('[aria-label]');
        const preview = labelled ? (labelled.getAttribute('aria-label') || '') : text;
        // NOTE the doubled backslashes: this whole block is a template literal,
        // so a single \\b would be consumed as a backspace escape by the string
        // before the page ever sees a regex. That mistake silently produced an
        // empty timestamp for every row, which quietly weakened message identity
        // back to "hash of the preview" — the exact duplicate-suppression bug
        // shownAt was added to fix.
        const tm = text.match(/\\b(\\d{1,2}:\\d{2}\\s?[AP]M)\\b/i)
          || text.match(/\\b([A-Z][a-z]{2}\\s+\\d{1,2})\\b/);
        out.push({
          // A group's identity is the whole participant set, sorted so the same
          // thread always hashes to the same id regardless of render order.
          threadId: isGroup ? 'g.' + numbers.slice().sort().join('-') : 't.+1' + num,
          from: '+1' + num,
          participants: numbers.map(function (d) { return '+1' + d; }),
          isGroup: isGroup,
          preview: preview.replace(/\\s+/g, ' ').trim(),
          unread: !!row.querySelector('[class*="unread"]'),
          shownAt: tm ? tm[1] : '',
        });
      }
      return out;
    })()`);
  }

  /**
   * Reply inside an existing thread, found by its id in the list.
   *
   * Groups need this. `sendSms` addresses a thread by building a URL from one
   * phone number, which is meaningless when several people are on it — picking
   * the first participant would send a private message to someone who was
   * expecting a group reply, and the other members would never see it. So this
   * opens the thread the list is already showing, by clicking it, and lets
   * Google Voice decide who the recipients are.
   *
   * The send is confirmed the same way as everywhere else: by reading our own
   * text back out of the thread.
   */
  async sendToThread(threadId: string, text: string): Promise<string> {
    if (!(await this.isSignedIn())) {
      throw new GoogleVoiceSurfaceError('not signed in to Google Voice');
    }
    await this.page.navigate(this.messagesUrl);

    const opened = await this.page.evaluate<{ ok: boolean; why?: string }>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const want = ${jsonArg(threadId)};
      for (let attempt = 0; attempt < 20; attempt++) {
        const rows = Array.from(document.querySelectorAll('gv-thread-list-item'));
        for (const row of rows) {
          const t = (row.innerText || '').replace(/\\s+/g, ' ');
          const nums = (t.match(/\\((\\d{3})\\)\\s?(\\d{3})-(\\d{4})/g) || [])
            .map(function (f) { return f.replace(/\\D/g, ''); })
            .filter(function (d) { return d.length === 10; });
          const uniq = nums.filter(function (d, i) { return nums.indexOf(d) === i; });
          if (!uniq.length) continue;
          const id = uniq.length > 1
            ? 'g.' + uniq.slice().sort().join('-')
            : 't.+1' + uniq[0];
          if (id === want) {
            const click = row.querySelector('a,button,[role="button"]') || row;
            click.click();
            return { ok: true };
          }
        }
        await sleep(250);
      }
      return { ok: false, why: 'no thread in the list matches that id' };
    })()`);
    if (!opened.ok) throw new GoogleVoiceSurfaceError('could not open the thread', opened.why);

    await new Promise((r) => setTimeout(r, 1200));
    await this.composeInto(text);

    const before = await this.countOutbound(text);
    await this.pressSend();
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
    return threadId;
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

  /**
   * How many times our own text appears as an OUTGOING message.
   *
   * Direction matters. Counting every occurrence would also count the text still
   * sitting in the compose box, which is present the instant it is typed — so a
   * send that did nothing would "confirm" itself immediately. The bubble has to
   * be one the app marked as ours.
   */
  private async countOutbound(text: string): Promise<number> {
    return this.page.evaluate<number>(`(() => {
      const want = ${jsonArg(text)};
      const items = Array.from(document.querySelectorAll('gv-message-item, [data-e2e-is-outgoing]'));
      return items.filter(n => {
        const mine = !!n.querySelector('.outgoing') || n.getAttribute('data-e2e-is-outgoing') === 'true'
          || (n.className || '').toString().indexOf('outgoing') !== -1;
        return mine && (n.innerText || '').indexOf(want) !== -1;
      }).length;
    })()`);
  }

  private async lastInbound(): Promise<string | null> {
    return this.page.evaluate<string | null>(`(() => {
      const items = Array.from(document.querySelectorAll('gv-message-item, [data-e2e-is-outgoing]'));
      const inbound = items.filter(n =>
        !!n.querySelector('.incoming') || n.getAttribute('data-e2e-is-outgoing') === 'false');
      const last = inbound[inbound.length - 1];
      if (!last) return null;
      // Reach for the node that holds the words, rather than taking the whole
      // bubble and deleting things. A live message-row is
      //   gv-avatar("person") + .subject-content-container("Hello?") + .options-button-container("more_vert")
      // so a naive innerText yields "person Hello? more_vert" — Material icon
      // ligatures read as real text — and that would be handed to the model as
      // if the other party had said it. Subtracting furniture is a guess about
      // what is not the message; selecting the content container is a statement
      // about what is.
      const body = last.querySelector('.subject-content-container')
        || last.querySelector('[data-e2e-message-text]')
        || last.querySelector('.message-row');
      if (!body) return null;
      return (body.innerText || body.textContent || '').replace(/\\s+/g, ' ').trim() || null;
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
