/**
 * The inbox extraction script, run against a real DOM.
 *
 * That script is a template literal executed in the page, so nothing type-checks
 * it and the provider's own tests stub `evaluate` with canned values — it was
 * effectively untested. Two separate production bugs have already lived in it:
 * a greedy digit match that nearly texted a number that does not exist, and a
 * backslash escape that silently emptied every timestamp.
 *
 * The third was direction. Google Voice previews the newest message in a thread
 * whichever way it went, marking its own with "You: ". Without reading that, the
 * agent answered its own reply every five minutes.
 *
 * The fixtures below are the markup shapes observed on the live page.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { GoogleVoiceBrowserDriver } from './google-voice-browser.js';
import type { PageSurface } from './chrome-cdp.js';

interface Row {
  /** innerText of the thread row, as the list renders it. */
  text: string;
  /** The aria-label that carries the preview, "You: " prefix and all. */
  aria: string;
}

/** Run whatever expression the provider asks for inside a DOM built from `rows`. */
function domPage(rows: Row[]): PageSurface {
  const html = rows
    .map(
      (r) =>
        `<gv-thread-list-item><div class="t">${r.text}</div>` +
        `<span aria-label="${r.aria.replace(/"/g, '&quot;')}"></span></gv-thread-list-item>`,
    )
    .join('');
  // The provider refuses to read an inbox it cannot prove is signed in, so the
  // fixture has to look like the real app: the right origin and the app element.
  const dom = new JSDOM(`<body><gv-app>${html}</gv-app></body>`, {
    runScripts: 'outside-only',
    url: 'https://voice.google.com/u/0/messages',
  });

  // innerText is a layout concept jsdom does not implement; the extraction reads
  // it, so back it with textContent.
  const win = dom.window as unknown as {
    HTMLElement: { prototype: object };
    eval: (code: string) => unknown;
  };
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    get(this: { textContent: string | null }) {
      return this.textContent ?? '';
    },
    configurable: true,
  });

  return {
    async evaluate<T>(expr: string): Promise<T> {
      return (await win.eval(expr)) as T;
    },
    async navigate() {},
    async url() {
      return 'https://voice.google.com/u/0/messages';
    },
    async close() {},
    async closeTab() {},
    opened: false,
  } satisfies PageSurface;
}

function browser(rows: Row[]): GoogleVoiceBrowserDriver {
  return new GoogleVoiceBrowserDriver({ page: domPage(rows) });
}

// Shapes copied from the live inbox.
const INBOUND: Row = {
  text: 'person ‪(404) 862-8786‬ 4 0 4 8 6 2 8 7 8 6 . 10:25 AM hello there',
  aria: 'hello there',
};
const OUR_REPLY: Row = {
  text: 'person ‪(404) 862-8786‬ 4 0 4 8 6 2 8 7 8 6 . 10:25 AM You: This is an openrappter agent',
  aria: 'You: This is an openrappter agent on this number.',
};

describe('inbox extraction reports message direction', () => {
  it('marks a thread whose newest message is ours as outbound', async () => {
    const [entry] = await browser([OUR_REPLY]).listInbox();
    expect(entry.outbound).toBe(true);
  });

  it('marks a genuine inbound message as inbound', async () => {
    const [entry] = await browser([INBOUND]).listInbox();
    expect(entry.outbound).toBe(false);
  });

  it('strips the "You: " prefix from the preview', async () => {
    // The prefix is a direction marker, not part of what was said. Leaving it in
    // makes the same sentence hash differently coming and going.
    const [entry] = await browser([OUR_REPLY]).listInbox();
    expect(entry.preview.startsWith('You:')).toBe(false);
    expect(entry.preview).toBe('This is an openrappter agent on this number.');
  });

  it('does not mistake a message that merely mentions you for an outbound one', async () => {
    const [entry] = await browser([
      { text: 'person ‪(404) 862-8786‬ . 10:25 AM you: are you there?', aria: 'are you there? You: is in the middle' },
    ]).listInbox();
    expect(entry.outbound).toBe(false);
  });
});

describe('the extraction still holds its earlier guarantees', () => {
  it('parses the formatted number rather than the screen-reader digit run', async () => {
    const [entry] = await browser([INBOUND]).listInbox();
    expect(entry.from).toBe('+14048628786');
    expect(entry.threadId).toBe('t.+14048628786');
  });

  it('keeps a group thread, identified by its whole sorted participant set', async () => {
    const [entry] = await browser([
      {
        text: 'people ‪(404) 840-6745‬, ‪(704) 386-7727‬ . 9:02 PM hey both',
        aria: 'hey both',
      },
    ]).listInbox();
    expect(entry.isGroup).toBe(true);
    expect(entry.threadId).toBe('g.4048406745-7043867727');
  });

  it('captures the displayed time, which message identity depends on', async () => {
    const [entry] = await browser([INBOUND]).listInbox();
    expect(entry.shownAt).toBe('10:25 AM');
  });

  it('skips a short code, which is never a conversation', async () => {
    const rows = await browser([
      { text: 'person ‪64241‬ 6 4 2 4 1 . Mar 9 Your Apple Account Code is: 602998.', aria: 'Your Apple Account Code is: 602998.' },
    ]).listInbox();
    expect(rows).toEqual([]);
  });
});
