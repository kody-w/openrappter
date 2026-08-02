/**
 * The Google Voice driver, exercised in a REAL browser over REAL CDP.
 *
 * The unit tests next door drive a fake `PageSurface`, which proves the
 * decisions but not the DOM. This one runs the actual JavaScript the driver
 * injects, inside Chrome, against a page shaped like Google Voice — and it has
 * already earned its place: the hardcoded `voice.google.com` URL that made this
 * class unverifiable was found here, not by any fake.
 *
 * It is opt-in. With no DevTools endpoint it skips rather than fails, so CI and
 * anyone without Chrome running are unaffected:
 *
 *   open -a "Google Chrome" --args --remote-debugging-port=9222
 *   OPENRAPPTER_CDP_PORT=9222 npx vitest run google-voice-live
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ChromeSession, type PageSurface } from './chrome-cdp.js';
import { GoogleVoiceBrowserDriver } from './google-voice-browser.js';

const PORT = Number(process.env.OPENRAPPTER_CDP_PORT ?? 0);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, '__fixtures__', 'google-voice-page.html'), 'utf8');

let server: Server | undefined;
let base = '';
let reachable = false;

beforeAll(async () => {
  if (!PORT) return;
  reachable = await new ChromeSession({ port: PORT }).isAvailable();
  if (!reachable) return;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

const live = () => PORT > 0 && reachable;

async function driverOn(url: string, confirmTimeoutMs = 4000) {
  const session = new ChromeSession({ port: PORT });
  const page: PageSurface = await session.page(url, url);
  await page.navigate(url);
  const d = new GoogleVoiceBrowserDriver({ page, messagesUrl: url, confirmTimeoutMs, pollMs: 50 });
  // The account gate is Google-specific and cannot be satisfied by a fixture;
  // what this file exists to prove is the send/confirm/read DOM path.
  (d as unknown as { isSignedIn: () => Promise<boolean> }).isSignedIn = async () => true;
  return { d, page };
}

describe.skipIf(!PORT)('GoogleVoiceBrowserDriver against real Chrome', () => {
  it('sends, and confirms by reading the thread back', async () => {
    if (!live()) return;
    const { d, page } = await driverOn(base);
    await d.sendSms('+15551234567', 'Table for 4 at 7:30?');
    const thread = await page.evaluate<string>(
      'document.querySelector("[gv-test-id=thread]").innerText',
    );
    expect(thread).toContain('Table for 4 at 7:30?');
    await (page.opened ? page.closeTab() : page.close());
  }, 30_000);

  it('reads a real inbound reply out of a live DOM mutation', async () => {
    if (!live()) return;
    const { d, page } = await driverOn(base);
    const id = await d.sendSms('+15551234567', 'ping');
    setTimeout(() => void page.evaluate('window.__reply("we can do 7:45")').catch(() => {}), 300);
    await expect(d.awaitReply(id, 8000)).resolves.toBe('we can do 7:45');
    await (page.opened ? page.closeTab() : page.close());
  }, 30_000);

  // The failure this whole design is arranged around: the click succeeds, the
  // button looks enabled, and nothing is delivered.
  it('REFUSES a send that silently delivers nothing', async () => {
    if (!live()) return;
    const { d, page } = await driverOn(`${base}?swallow`, 1500);
    await expect(d.sendSms('+15551234567', 'this will vanish')).rejects.toThrow(
      /could not be confirmed/i,
    );
    await (page.opened ? page.closeTab() : page.close());
  }, 30_000);
});
