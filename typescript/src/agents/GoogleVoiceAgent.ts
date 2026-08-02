/**
 * GoogleVoiceAgent — the phone layer as something openrappter can schedule.
 *
 * The launchd installer shipped earlier runs a dedicated always-on process. This
 * is the other shape of the same capability: an ordinary agent that performs ONE
 * poll when invoked, so openrappter's own cron can wake it up. The organism
 * schedules itself instead of asking the operating system to babysit a daemon,
 * which is the difference between a program that happens to run on your machine
 * and one that lives there.
 *
 * WHY A TICK AND NOT A LOOP
 *
 * A cron job that never returns is a cron job that runs once. `perform()` does a
 * single pass and reports what happened; the schedule owns the repetition. That
 * also makes the whole thing testable — one tick is a function call, where a
 * loop is a thing you have to wait for and then kill.
 *
 * WHAT IT REFUSES TO DECIDE
 *
 * Nothing here judges whether a message deserves a reply. That belongs to
 * `telephony/watch.ts`, which is shared byte-for-byte with the grail brainstem's
 * `google_voice_agent.py` and pinned by tests/google-voice-parity.json. If this
 * file started making its own choices, the two platforms would drift and which
 * machine woke up first would become a behavioural fact.
 *
 * Above all it inherits the rule that makes an unattended poll safe at all:
 * first sight of a thread never replies. It records a watermark and says
 * nothing, so scheduling this against an inbox with history does not text
 * everyone who has ever messaged the number.
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { GoogleVoiceWatcher, loadState, STATE_PATH } from '../telephony/watcher.js';
import type { InboxMessage } from '../telephony/watch.js';

export interface GoogleVoiceAgentOptions {
  /** Answers an inbound message. Returning null means "say nothing". */
  respond?: (message: InboxMessage) => Promise<string | null>;
  port?: number;
  statePath?: string;
}

/**
 * The default reply.
 *
 * Deliberately conservative, and deliberately replaceable — the interesting
 * version of this hands the message to a model or to the negotiation CallAgent.
 * What it must never do is answer an automated sender: a verification code is
 * not a conversation, and quoting one back is how a security code ends up in a
 * thread it was never meant to leave.
 */
export async function defaultResponder(message: InboxMessage): Promise<string | null> {
  const text = (message.text || '').toLowerCase();
  // These patterns are taken from messages actually sitting in a real Google
  // Voice inbox, not invented. The first version matched "do not share" and
  // missed "Don't share it with anyone" — which is the exact wording Apple
  // uses, and was sitting in the inbox this was written against. A near-miss
  // here means an agent replying to a security code, in a thread that code was
  // never meant to leave.
  const AUTOMATED = [
    /verification code/,
    /security code/,
    /account code/,
    /one-?time (code|passcode|password)/,
    /passcode/,
    /\b2fa\b/,
    /do ?n['’]?o?t share/,
    /never share/,
    /is your .{0,20}code\b/,
    /\bcode is:? ?\d/,
    /reply stop to/,
    /do not reply/,
  ];
  if (AUTOMATED.some((p) => p.test(text))) return null;
  return (
    'This is an openrappter agent on this number. It read your message and can '
    + 'answer, negotiate against limits its owner set, or hand off when a reply '
    + 'needs a person.'
  );
}

export class GoogleVoiceAgent extends BasicAgent {
  private readonly options: GoogleVoiceAgentOptions;

  constructor(options: GoogleVoiceAgentOptions = {}) {
    const metadata: AgentMetadata = {
      name: 'GoogleVoice',
      description:
        'Check Google Voice for new messages and reply to the ones that deserve it. '
        + 'Performs one poll per invocation so it can be driven by cron. Never replies '
        + 'to a thread it is seeing for the first time, so scheduling it against an '
        + 'existing inbox does not answer its history.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'check (default) — one poll; status — report without polling',
          },
          dryRun: {
            type: 'boolean',
            description: 'Decide and report, but send nothing. The safe way to schedule it first.',
          },
        },
        required: [],
      },
    };
    super('GoogleVoice', metadata);
    this.options = options;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) ?? 'check';
    const statePath = this.options.statePath ?? STATE_PATH;

    if (action === 'status') {
      const state = await loadState(statePath);
      return JSON.stringify({
        status: 'success',
        knownThreads: Object.keys(state.knownThreads).length,
        handled: state.handled.length,
        message:
          'Threads already seen are live; anything new to this watcher gets a watermark '
          + 'on its first poll rather than a reply.',
      }, null, 2);
    }

    const lines: string[] = [];
    const watcher = new GoogleVoiceWatcher({
      port: this.options.port,
      statePath,
      dryRun: kwargs.dryRun === true,
      respond: this.options.respond ?? defaultResponder,
      log: (line) => lines.push(line),
    });

    // A cron tick must load the durable state itself. Without this every wake-up
    // would start from an empty watcher, see every thread as unseen, and — while
    // the first-sight rule keeps that from texting anyone — it would never get
    // past recording watermarks, so the agent would appear to run forever
    // without ever answering anything.
    (watcher as unknown as { state: unknown }).state = await loadState(statePath);

    let replied = 0;
    let error: string | undefined;
    try {
      replied = await watcher.tick();
    } catch (e) {
      error = (e as Error).message;
    }

    const after = await loadState(statePath);
    return JSON.stringify({
      status: error ? 'error' : 'success',
      replied,
      knownThreads: Object.keys(after.knownThreads).length,
      handled: after.handled.length,
      ...(error ? { error } : {}),
      log: lines,
      data_slush: {
        replied,
        known_threads: Object.keys(after.knownThreads).length,
        transport_available: !lines.some((l) => l.includes('no Chrome DevTools endpoint')),
      },
    }, null, 2);
  }
}
