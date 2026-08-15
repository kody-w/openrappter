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
import {
  GREETING, ThreadMemory, createAssistantResponder, isAutomated, toSms,
} from '../telephony/reply.js';
import type { LLMProvider } from '../providers/types.js';

/**
 * Conformance R2/R3: every agent declares a manifest so a strain can govern it
 * without reading the source. This file had none.
 */
export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/google-voice',
  version: '1.0.0',
  display_name: 'Google Voice',
  description:
    'Watches a Google Voice inbox and answers texts under the reply policy — '
    + 'rate limits, self-reply and loop guards, quiet hours.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  // Declared from what this actually reaches through `../telephony/watcher.js`:
  //   network           — drives Google Voice in a Chrome CDP session
  //   filesystem-write  — persists poll state so a restart cannot re-answer
  //                       years of history
  // The decision half is the Python google_voice_agent, which reaches neither
  // and declares nothing.
  capabilities: [
    'network',
    'filesystem-write',
  ],
  tags: [
    'openrappter',
    'google-voice',
    'telephony',
  ],
  category: 'communication',
  quality_tier: 'official',
  requires_env: [],
} as const;

export interface GoogleVoiceAgentOptions {
  /** Answers an inbound message. Returning null means "say nothing". */
  respond?: (message: InboxMessage) => Promise<string | null>;
  port?: number;
  statePath?: string;
  /**
   * Where to get a model. Defaults to the same backend selection the daemon
   * uses, so the agent answers with whatever rung is actually working.
   */
  provider?: LLMProvider | (() => Promise<LLMProvider | null>);
  /** Live agent roster, so "what can you do" is answered from fact. */
  capabilities?: string[];
  /** Remembers the thread across ticks — each cron wake is a fresh process. */
  memory?: ThreadMemory;
}

/**
 * The reply of last resort.
 *
 * This is what the agent says when there is no model to reach: the greeting,
 * once, which is true. For a long time it was also the answer to *everything* —
 * a real thread went "What else" → greeting → "Okay well list 10 things you can
 * do" → "You there?" → the same greeting again. The message was never read.
 *
 * It still refuses automated senders before anything else, because a
 * verification code is not a conversation and quoting one back puts a security
 * code in a thread it was never meant to leave.
 */
export async function defaultResponder(message: InboxMessage): Promise<string | null> {
  if (isAutomated(message.text || '')) return null;
  return toSms(GREETING);
}

/**
 * The responder the agent actually uses: reads the message, answers it, and
 * falls back to `defaultResponder`'s greeting only when no model can be reached.
 *
 * Kept lazy — resolving a backend costs a token exchange or a CLI probe, and a
 * tick that finds an empty inbox should not pay for one.
 */
async function defaultProvider(): Promise<LLMProvider | null> {
  const { selectBackend } = await import('../providers/backend-select.js');
  const {
    hasAuthProfileAuthority,
    resolveGithubToken,
  } = await import('../copilot-check.js');
  const profileAuthority = hasAuthProfileAuthority();
  const githubToken = await resolveGithubToken();
  const choice = await selectBackend({
    githubToken: githubToken ?? undefined,
    allowIndependentCli: !profileAuthority,
    allowAmbientCredentials: !profileAuthority,
  });
  return choice.provider;
}

export class GoogleVoiceAgent extends BasicAgent {
  private readonly options: GoogleVoiceAgentOptions;
  /**
   * Thread memory lives on the agent, not inside a tick. A cron wake-up is a
   * fresh call but the same process, and without this a follow-up like
   * "What else" arrives with no idea what it is following.
   */
  private readonly memory: ThreadMemory;

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
    this.memory = options.memory ?? new ThreadMemory();
  }

  /**
   * Read the message and answer it. Only falls back to the greeting when there
   * is no model to reach — which is a real condition, not the normal path.
   */
  private responder(): (m: InboxMessage) => Promise<string | null> {
    if (this.options.respond) return this.options.respond;
    return createAssistantResponder({
      provider: this.options.provider ?? defaultProvider,
      capabilities: this.options.capabilities,
      memory: this.memory,
    });
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
      respond: this.options.respond ?? this.responder(),
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
