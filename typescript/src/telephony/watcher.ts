import { openrappterPath } from '../infra/openrappter-home.js';
/**
 * The always-on half: poll Google Voice, decide, reply, remember.
 *
 * Everything that decides ANYTHING lives in ./watch.ts, which is shared with the
 * grail brainstem and pinned by a parity fixture. This file only does the parts
 * that are genuinely device-specific: talking to a browser, keeping state on
 * disk, and surviving the night.
 *
 * WHAT RUNNING 24/7 ACTUALLY CHANGES
 *
 * A command you run is supervised by you. A daemon is not, and the failures that
 * matter are the quiet ones:
 *
 *   - Chrome dies at 3am and the watcher reports healthy forever after
 *   - state is lost on restart and every thread looks new again
 *   - a selector changes, the inbox reads empty, and "no messages" is
 *     indistinguishable from "not working"
 *
 * The third is the one that bit this code already: the first inbox selectors
 * were wrong and returned zero rows, which looks exactly like a quiet day. So
 * the loop tracks consecutive empty polls and says so, rather than treating
 * silence as proof of health.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ChromeSession } from './providers/chrome-cdp.js';
import { GoogleVoiceBrowserDriver } from './providers/google-voice-browser.js';
import {
  decide, observe, recordReply, emptyState, DEFAULT_POLICY,
  type InboxMessage, type WatchPolicy, type WatchState,
} from './watch.js';

export const STATE_PATH = openrappterPath('google-voice-watch.json');

/** Answers an inbound message. Returning null means "say nothing". */
export type Responder = (message: InboxMessage) => Promise<string | null>;

export interface WatcherOptions {
  port?: number;
  account?: string;
  policy?: Partial<WatchPolicy>;
  pollMs?: number;
  statePath?: string;
  /** Decide and log, but never send. The honest way to run this in anger first. */
  dryRun?: boolean;
  respond: Responder;
  log?: (line: string) => void;
  now?: () => number;
  /**
   * Override the transport. Exists so the loop's safety rules — above all "do
   * not answer the entire inbox on first run" — can be proven without a browser
   * and without texting anyone.
   */
  driverFactory?: () => Promise<WatchTransport | null>;
}

/** The slice of the Google Voice driver the loop actually uses. */
export interface WatchTransport {
  listInbox(limit?: number): Promise<Array<{
    threadId: string; from: string; preview: string; unread: boolean;
    shownAt?: string; isGroup?: boolean; outbound?: boolean;
  }>>;
  sendSms(to: string, text: string): Promise<string>;
  /**
   * Reply inside an existing thread. Required for groups, where there is no
   * single number to address.
   */
  sendToThread?(threadId: string, text: string): Promise<string>;
}

export async function loadState(path = STATE_PATH): Promise<WatchState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as WatchState;
    // A truncated or hand-edited file must not silently become "everything is
    // new", which would re-answer the whole inbox on the next poll.
    if (!parsed || typeof parsed !== 'object' || !parsed.knownThreads) return emptyState();
    return { knownThreads: parsed.knownThreads, handled: parsed.handled ?? [], replies: parsed.replies ?? {} };
  } catch {
    return emptyState();
  }
}

export async function saveState(state: WatchState, path = STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename: a daemon killed mid-write must not leave a half-parsed
  // state file, because the recovery from that is "treat every thread as new".
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export class GoogleVoiceWatcher {
  private readonly opts: WatcherOptions;
  private readonly policy: WatchPolicy;
  private readonly statePath: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private state: WatchState = emptyState();
  private stopping = false;
  private emptyPolls = 0;

  constructor(options: WatcherOptions) {
    this.opts = options;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.statePath = options.statePath ?? STATE_PATH;
    this.log = options.log ?? ((l) => console.log(l));
    this.now = options.now ?? (() => Date.now());
  }

  stop(): void {
    this.stopping = true;
  }

  private async driver(): Promise<WatchTransport | null> {
    if (this.opts.driverFactory) return this.opts.driverFactory();
    const session = new ChromeSession({ port: this.opts.port ?? 9222, timeoutMs: 30_000 });
    if (!(await session.isAvailable())) return null;
    const page = await session
      .page('voice.google.com', 'https://voice.google.com/u/0/messages')
      .catch(() => null);
    if (!page) return null;
    return new GoogleVoiceBrowserDriver({
      page, account: this.opts.account, confirmTimeoutMs: 25_000, pollMs: 1000,
    });
  }

  /** One pass. Returns how many messages were acted on. */
  async tick(): Promise<number> {
    const d = await this.driver();
    if (!d) {
      // Not a crash — Chrome may simply not be up yet. Say so every time rather
      // than once, so a log tailed at 3am shows the real reason for silence.
      this.log('[watch] no Chrome DevTools endpoint — nothing polled this cycle');
      return 0;
    }

    const inbox = await d.listInbox(25).catch((e: Error) => {
      this.log(`[watch] inbox read failed: ${e.message}`);
      return null;
    });
    if (!inbox) return 0;

    if (inbox.length === 0) {
      this.emptyPolls++;
      // An empty inbox is normal once. Twenty times running usually means a
      // selector moved, which reads identically to a quiet day — the failure
      // this whole file is arranged to make visible.
      if (this.emptyPolls % 20 === 0) {
        this.log(`[watch] ${this.emptyPolls} consecutive empty polls — inbox may have changed shape`);
      }
      return 0;
    }
    this.emptyPolls = 0;

    let acted = 0;
    for (const entry of inbox) {
      const at = this.now();
      const message: InboxMessage = {
        // Identity, not time, is what stops a duplicate reply here: `at` below
        // is the POLL clock, because the list view offers no real timestamp.
        // So the id folds in the displayed time as well as the text - otherwise
        // someone texting the same words twice an hour apart would have the
        // second one dropped as already-handled.
        id: `${entry.threadId}:${hash(`${entry.shownAt ?? ''}|${entry.preview}`)}`,
        threadId: entry.threadId,
        from: entry.from,
        // Never hardcode this. decide() has always refused to answer our own
        // messages; the watcher simply asserted every row was inbound, so that
        // guard could not fire and the agent answered itself in a loop.
        direction: entry.outbound ? 'outbound' : 'inbound',
        text: entry.preview,
        at,
      };

      const verdict = decide(message, this.state, this.policy, at);
      if (!verdict.act) {
        if (verdict.reason === 'thread-unseen') {
          this.state = observe(this.state, entry.threadId, at);
          this.log(`[watch] ${entry.from}: ${verdict.detail}`);
          await saveState(this.state, this.statePath);
        }
        continue;
      }

      const reply = await this.opts.respond(message).catch((e: Error) => {
        this.log(`[watch] responder failed for ${entry.from}: ${e.message}`);
        return null;
      });
      if (!reply) {
        // Nothing to say is a valid answer, but it still counts as handled —
        // otherwise the next poll asks again forever.
        this.state = recordReply(this.state, message, at);
        await saveState(this.state, this.statePath);
        continue;
      }

      if (this.opts.dryRun) {
        const target = entry.isGroup ? `group ${entry.threadId}` : entry.from;
        this.log(`[watch] DRY RUN — would reply to ${target}: ${reply.slice(0, 60)}`);
        this.state = recordReply(this.state, message, at);
        await saveState(this.state, this.statePath);
        acted++;
        continue;
      }

      try {
        // A GROUP must be answered in its thread. Calling sendSms(entry.from)
        // would text the first participant PRIVATELY — the rest of the group
        // would never see it, and one person would receive what looks like an
        // unsolicited direct message. The inbox reader already knows which
        // threads are groups; this is where that has to be honoured.
        if (entry.isGroup) {
          if (!d.sendToThread) {
            throw new Error('this transport cannot reply to a group thread');
          }
          await d.sendToThread(entry.threadId, reply);
        } else {
          await d.sendSms(entry.from, reply);
        }
        // Only recorded after the driver confirms the thread contains it. A
        // failed send must stay unhandled so the next poll retries — which is
        // safe precisely because sendSms refuses to claim an unconfirmed send.
        this.state = recordReply(this.state, message, at);
        await saveState(this.state, this.statePath);
        acted++;
        this.log(`[watch] replied to ${entry.from}`);
      } catch (e) {
        this.log(`[watch] send to ${entry.from} FAILED, leaving unhandled: ${(e as Error).message}`);
      }
    }
    return acted;
  }

  async run(): Promise<void> {
    this.state = await loadState(this.statePath);
    const known = Object.keys(this.state.knownThreads).length;
    this.log(`[watch] started — ${known} known threads, ${this.state.handled.length} handled${this.opts.dryRun ? ' (DRY RUN)' : ''}`);
    const every = this.opts.pollMs ?? 20_000;
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        // A daemon that exits on an unexpected throw is a daemon that is not
        // running tomorrow. Log and keep the loop alive; launchd restarts are
        // for the process dying, not for one bad poll.
        this.log(`[watch] cycle error: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
    this.log('[watch] stopped');
  }
}

/** Small, stable, dependency-free digest for message identity. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
