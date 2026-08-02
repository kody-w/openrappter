/**
 * Entry point for the 24/7 Google Voice watcher.
 *
 * Kept deliberately thin: launchd needs one file to exec, and everything worth
 * testing lives in ./watcher.ts and ./watch.ts. Pass --dry-run to decide and log
 * without sending, which is the only sane way to start it against a real inbox.
 */

import { GoogleVoiceWatcher } from './watcher.js';
import type { InboxMessage } from './watch.js';

const dryRun = process.argv.includes('--dry-run');
const port = Number(process.env.OPENRAPPTER_CDP_PORT ?? 9222);
const account = process.env.GOOGLE_VOICE_ACCOUNT;
const selfNumber = process.env.GOOGLE_VOICE_NUMBER;
const allowFrom = (process.env.GOOGLE_VOICE_ALLOW ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * What to say back.
 *
 * This is the seam where the agent belongs. It is a plain function on purpose:
 * the loop around it is already proven, so swapping in a model, the negotiation
 * CallAgent, or a canned reply changes behaviour without touching any of the
 * safety rules that stop it texting your whole address book.
 *
 * Returning null means "say nothing", which the loop records as handled — a
 * decision not to speak is still a decision, and re-asking it every poll forever
 * would be its own kind of loop.
 */
async function respond(message: InboxMessage): Promise<string | null> {
  const text = (message.text || '').toLowerCase();

  // Automated senders are not conversations. Verification codes in particular
  // must never be answered, quoted, or forwarded.
  if (/verification code|security code|do not share|2fa|one-time/.test(text)) return null;

  return (
    "This is Kody's openrappter agent. It reads this thread, decides whether a "
    + 'message needs an answer, and can negotiate against limits he set. '
    + "It can't speak on a call — but voicemail is transcribed, so a missed call still reaches it."
  );
}

const watcher = new GoogleVoiceWatcher({
  port,
  account,
  dryRun,
  respond,
  policy: {
    selfNumber,
    ...(allowFrom.length ? { allowFrom } : {}),
  },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    watcher.stop();
    // Give the current poll a moment to finish writing state; a half-written
    // state file is the one thing that would make the next start unsafe.
    setTimeout(() => process.exit(0), 1500);
  });
}

await watcher.run();
