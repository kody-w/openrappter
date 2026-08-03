/**
 * What the agent actually says back to a person who texts the number.
 *
 * THE BUG THIS FILE EXISTS TO FIX
 *
 * The watcher could read an inbox, decide correctly, and send — and then said
 * the same fixed sentence to everybody, forever. A real thread looked like this:
 *
 *   them  10:43  What else
 *   us    10:45  This is an openrappter agent on this number. It read your
 *                message and can answer, negotiate against limits its owner
 *                set, or hand off when a reply needs a person.
 *   them  10:50  Okay well list 10 things you can do
 *   them  11:14  You there?
 *   us    11:20  This is an openrappter agent on this number. It read your …
 *
 * Every safety rule worked. The agent was awake, it was polling, it was
 * replying, and it answered a direct question by repeating its own greeting
 * twice. "It read your message" was, strictly, a lie: nothing ever looked at
 * the text.
 *
 * So this module is the missing half — the part that composes an answer.
 *
 * WHAT IT REFUSES TO DO
 *
 *   - answer automated senders. A verification code is not a conversation, and
 *     quoting one back puts a security code in a thread it was never meant to
 *     leave. That check runs before the model is ever consulted.
 *   - speak as the owner. It is the owner's agent, not the owner, and it never
 *     commits them to anything.
 *   - invent capabilities. Asked what it can do with no roster injected, it
 *     says what it is rather than listing features nobody verified.
 *   - emit markdown. Asterisks and backticks are noise in a text message.
 *
 * And if the model cannot be reached at all, it falls back to the greeting —
 * which is the right thing to say once, and was only ever wrong as an answer to
 * everything.
 */

import type { LLMProvider, Message } from '../providers/types.js';

/** One remembered turn in a thread. */
export interface Turn {
  role: 'them' | 'us';
  text: string;
  at: number;
}

/**
 * Patterns for senders that are machines.
 *
 * Taken from messages actually sitting in a real Google Voice inbox, not
 * invented. An earlier version matched "do not share" and missed "Don't share
 * it with anyone" — the exact wording Apple uses, which was sitting in the
 * inbox this was written against.
 */
export const AUTOMATED_PATTERNS: RegExp[] = [
  /verification code/i,
  /security code/i,
  /account code/i,
  /one-?time (code|passcode|password)/i,
  /passcode/i,
  /\b2fa\b/i,
  /do ?n['’]?o?t share/i,
  /never share/i,
  /is your .{0,20}code\b/i,
  /\bcode is:? ?\d/i,
  /reply stop to/i,
  /do not reply/i,
];

export function isAutomated(text: string): boolean {
  return AUTOMATED_PATTERNS.some((p) => p.test(text || ''));
}

/**
 * The greeting. Correct as a first word to a stranger, and the thing this
 * module exists to stop being the answer to everything.
 */
export const GREETING =
  'This is an openrappter agent on this number. It read your message and can '
  + 'answer, negotiate against limits its owner set, or hand off when a reply '
  + 'needs a person.';

/**
 * Four segments. Long enough for a short numbered list, short enough that the
 * reply still reads as a text message rather than an essay delivered by phone.
 */
export const DEFAULT_MAX_CHARS = 640;

/**
 * Turn model prose into something that reads correctly in a grey bubble.
 *
 * A model asked for a list returns markdown by reflex, and `**bold**` in SMS is
 * literally asterisks on someone's lock screen.
 */
export function toSms(raw: string, maxChars = DEFAULT_MAX_CHARS): string {
  let s = (raw || '').trim();

  s = s.replace(/```[\s\S]*?```/g, ' ');           // fenced code has no place in a text
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2');   // italics, not a bullet
  s = s.replace(/^\s*#{1,6}\s*/gm, '');            // headings
  s = s.replace(/^\s*[-*+]\s+/gm, '- ');           // normalise bullets to one glyph
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');                  // no blank lines in a bubble
  s = s.split('\n').map((l) => l.trim()).join('\n').trim();

  if (s.length <= maxChars) return s;

  // Cut at a boundary a reader will not notice, preferring a sentence end, then
  // a line, then a word. A hard slice mid-word reads as a bug.
  const window = s.slice(0, maxChars);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
  const cut = sentence > maxChars * 0.5 ? sentence + 1 : window.lastIndexOf(' ');
  return (cut > 0 ? window.slice(0, cut) : window).trim();
}

/**
 * Per-thread memory.
 *
 * The watcher hands the responder one message at a time and nothing else, so
 * without this "What else" arrives with no idea what came before — which is
 * exactly the follow-up the old version could not have answered even if it had
 * tried.
 *
 * Bounded on purpose: a daemon that keeps every text forever is a daemon that
 * eventually holds a person's whole message history in memory.
 */
export class ThreadMemory {
  private readonly turns = new Map<string, Turn[]>();

  constructor(private readonly maxTurns = 12) {}

  record(threadId: string, role: Turn['role'], text: string, at: number): void {
    const list = this.turns.get(threadId) ?? [];
    list.push({ role, text, at });
    this.turns.set(threadId, list.slice(-this.maxTurns));
  }

  history(threadId: string): Turn[] {
    return this.turns.get(threadId) ?? [];
  }
}

export interface AssistantResponderOptions {
  /**
   * How to reach a model. Left open so the caller decides the rung — and so the
   * whole responder is testable without a network.
   */
  provider: LLMProvider | (() => Promise<LLMProvider | null>);
  /**
   * Live agent roster, when the caller has one. Without it the reply speaks
   * generally rather than listing capabilities nobody checked.
   */
  capabilities?: string[];
  /** How the owner wants to be described. Never a name the agent claims to be. */
  ownerNote?: string;
  maxChars?: number;
  memory?: ThreadMemory;
  model?: string;
  log?: (line: string) => void;
}

export function systemPrompt(opts: {
  capabilities?: string[];
  ownerNote?: string;
  maxChars: number;
}): string {
  const lines = [
    'You are an openrappter agent answering a text message on its owner\'s Google Voice number.',
    '',
    'How to reply:',
    `- Plain text only. No markdown, no asterisks, no backticks, no headings. Under ${opts.maxChars} characters.`,
    '- Short. Two or three sentences, unless the person explicitly asked for a list.',
    '- Answer the actual question that was asked. Do not restate who you are unless you are asked.',
    '- Write like a person texting, not like documentation.',
    '',
    'What you must not do:',
    '- Never claim to be the owner, and never agree to anything on their behalf. You can say you will pass it on.',
    '- Never state a fact about the owner you were not told here.',
    '- If you do not know, say you do not know and offer to hand it to the owner.',
  ];

  if (opts.ownerNote) lines.push('', `About the owner: ${opts.ownerNote}`);

  if (opts.capabilities && opts.capabilities.length > 0) {
    lines.push(
      '',
      'You can call these agents on this machine, so this is what you can genuinely do:',
      ...opts.capabilities.slice(0, 40).map((c) => `- ${c}`),
    );
  } else {
    // The honest version of "list 10 things you can do" when nothing has told
    // us what is installed. Better a truthful shape than ten invented features.
    lines.push(
      '',
      'You have not been given a list of the tools installed on this machine.',
      'If asked what you can do, describe honestly what you are — an agent that reads and answers',
      'texts on this number, can negotiate within limits its owner set, and hands off to the owner',
      'when a reply needs a person — and say you can check the exact tool list if they want it.',
      'Do not invent specific features.',
    );
  }
  return lines.join('\n');
}

/**
 * Build a responder that actually reads the message.
 *
 * Returns the watcher's `Responder` shape: a string to send, or null for
 * silence. Silence is a real answer here and is never an error path.
 */
export function createAssistantResponder(options: AssistantResponderOptions) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const memory = options.memory ?? new ThreadMemory();
  const log = options.log ?? (() => {});

  return async function respond(message: {
    threadId: string; from: string; text: string; at: number;
  }): Promise<string | null> {
    const text = (message.text || '').trim();
    if (!text) return null;

    // Before the model, always. An automated sender must cost nothing and must
    // never reach a prompt.
    if (isAutomated(text)) return null;

    memory.record(message.threadId, 'them', text, message.at);

    let provider: LLMProvider | null = null;
    try {
      provider = typeof options.provider === 'function' ? await options.provider() : options.provider;
    } catch (e) {
      log(`[reply] no model backend: ${(e as Error).message}`);
    }

    // No model is not a crash. Say the one true thing we can say without one —
    // which is what the greeting was always for.
    if (!provider) {
      const fallback = toSms(GREETING, maxChars);
      memory.record(message.threadId, 'us', fallback, message.at);
      return fallback;
    }

    const history = memory.history(message.threadId);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt({ capabilities: options.capabilities, ownerNote: options.ownerNote, maxChars }) },
      // Everything except the message we are answering, which is appended last
      // so the model is in no doubt about which one it is replying to.
      ...history.slice(0, -1).map((t): Message => ({
        role: t.role === 'them' ? 'user' : 'assistant',
        content: t.text,
      })),
      { role: 'user', content: text },
    ];

    try {
      const res = await provider.chat(messages, options.model ? { model: options.model } : undefined);
      const answer = toSms(res.content ?? '', maxChars);
      if (!answer) {
        log('[reply] model returned nothing usable — falling back to the greeting');
        const fallback = toSms(GREETING, maxChars);
        memory.record(message.threadId, 'us', fallback, message.at);
        return fallback;
      }
      memory.record(message.threadId, 'us', answer, message.at);
      return answer;
    } catch (e) {
      // A model outage must not turn into silence: the person is owed an
      // answer, and the greeting is at least true.
      log(`[reply] model call failed: ${(e as Error).message}`);
      const fallback = toSms(GREETING, maxChars);
      memory.record(message.threadId, 'us', fallback, message.at);
      return fallback;
    }
  };
}
