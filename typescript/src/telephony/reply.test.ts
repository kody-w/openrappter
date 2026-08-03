/**
 * The reply composer.
 *
 * These tests exist because of a real thread. The agent was awake, polling,
 * deciding correctly and sending — and it answered "Okay well list 10 things
 * you can do" by repeating its own greeting, twice, having never looked at the
 * text. Every safety rule passed. Nothing checked that an answer was an answer.
 *
 * So: a model is injected here rather than called. What is under test is whether
 * the message reaches it, whether the reply is shaped for a text message, and
 * whether the things that must never reach a model still never do.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, Message } from '../providers/types.js';
import {
  GREETING,
  ThreadMemory,
  createAssistantResponder,
  isAutomated,
  systemPrompt,
  toSms,
} from './reply.js';

/** A provider that records what it was asked and says what it was told to. */
function fakeProvider(reply: string | (() => string)): {
  provider: LLMProvider; seen: Message[][];
} {
  const seen: Message[][] = [];
  const provider: LLMProvider = {
    id: 'fake',
    name: 'fake',
    async chat(messages: Message[]) {
      seen.push(messages);
      return { content: typeof reply === 'function' ? reply() : reply };
    },
    async isAvailable() { return true; },
  } as unknown as LLMProvider;
  return { provider, seen };
}

const msg = (text: string, threadId = 't.1') => ({
  threadId, from: '+15551110000', text, at: 1_700_000_000_000,
});

describe('automated senders', () => {
  it('never reaches the model at all', async () => {
    const { provider, seen } = fakeProvider('should never be sent');
    const respond = createAssistantResponder({ provider });

    for (const spam of [
      'Your verification code is 123456',
      "Your Apple Account Code is: 602998. Don't share it with anyone.",
      '005768 is your security code for beehiiv',
      'Your one-time passcode is 9911',
      'Your Google verification code is 254846',
      'Your Link verification code is: 388542. To stop receiving these messages, reply STOP TO CANCEL',
      "Your verification code for Dunkin' is 0475.",
    ]) {
      expect(await respond(msg(spam)), spam).toBeNull();
    }
    // The point: not merely "no reply sent" but "no code was ever put in a prompt".
    expect(seen).toHaveLength(0);
  });

  it('classifies the wording Apple actually uses, not just "do not share"', () => {
    expect(isAutomated("Don't share it with anyone")).toBe(true);
    expect(isAutomated('do not share this with anyone')).toBe(true);
    expect(isAutomated('can you do 7:45 instead?')).toBe(false);
  });
});

describe('answering a person', () => {
  // THE ONE THIS FILE EXISTS FOR.
  it('answers the question that was asked instead of repeating the greeting', async () => {
    const { provider, seen } = fakeProvider(
      '1. Read and answer texts here. 2. Check your calendar. 3. Hand off to you when it matters.',
    );
    const respond = createAssistantResponder({ provider });

    const reply = await respond(msg('Okay well list 10 things you can do'));

    expect(reply).toBeTruthy();
    expect(reply).not.toBe(GREETING);
    expect(reply).toContain('Read and answer texts');
    // The model was actually shown the message — the failure being fixed was
    // that it never was.
    expect(seen[0].at(-1)).toEqual({ role: 'user', content: 'Okay well list 10 things you can do' });
  });

  it('carries the thread so a follow-up has something to follow', async () => {
    const { provider, seen } = fakeProvider('Sure — here are three more.');
    const memory = new ThreadMemory();
    const respond = createAssistantResponder({ provider, memory });

    await respond(msg('what can you do?'));
    await respond(msg('What else'));

    const second = seen[1];
    const roles = second.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content}`);
    // Both prior turns, in order, then the new message last.
    expect(roles).toEqual([
      'user:what can you do?',
      'assistant:Sure — here are three more.',
      'user:What else',
    ]);
  });

  it('tells the model what it can really do when a roster is supplied', () => {
    const withRoster = systemPrompt({ capabilities: ['Shell — run commands'], maxChars: 640 });
    expect(withRoster).toContain('Shell — run commands');

    // And refuses to invent when it has none, which is the honest failure mode
    // for "list 10 things you can do".
    const without = systemPrompt({ maxChars: 640 });
    expect(without).toMatch(/Do not invent specific features/i);
  });
});

describe('shaped for a text message', () => {
  it('strips markdown a phone would render as literal punctuation', () => {
    const out = toSms('**Bold** and `code` and\n\n# Heading\n* bullet');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
    expect(out).not.toContain('# ');
    expect(out).toContain('Bold');
    expect(out).toContain('- bullet');
  });

  it('truncates at a boundary a reader will not notice', () => {
    const long = `${'A sentence that runs on. '.repeat(80)}`;
    const out = toSms(long, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    // Not a hard slice through the middle of a word.
    expect(out.endsWith('senten')).toBe(false);
    expect(out).toMatch(/\.$|\w$/);
  });

  it('caps what the model returns, however long it was', async () => {
    const { provider } = fakeProvider('x '.repeat(5000));
    const respond = createAssistantResponder({ provider, maxChars: 300 });
    const reply = await respond(msg('hello?'));
    expect((reply ?? '').length).toBeLessThanOrEqual(300);
  });
});

describe('when there is no model', () => {
  it('says the greeting rather than going silent', async () => {
    const respond = createAssistantResponder({ provider: async () => null });
    expect(await respond(msg('are you there?'))).toBe(GREETING);
  });

  it('falls back instead of throwing when the model call fails', async () => {
    const provider = {
      id: 'broken', name: 'broken',
      chat: vi.fn().mockRejectedValue(new Error('401 from the API')),
      isAvailable: async () => true,
    } as unknown as LLMProvider;

    const lines: string[] = [];
    const respond = createAssistantResponder({ provider, log: (l) => lines.push(l) });

    // A person is owed an answer even when the backend is down.
    expect(await respond(msg('can you do 7:45 instead?'))).toBe(GREETING);
    expect(lines.join(' ')).toMatch(/model call failed/);
  });

  it('falls back when the model answers with nothing usable', async () => {
    const { provider } = fakeProvider('   ');
    const respond = createAssistantResponder({ provider });
    expect(await respond(msg('hello'))).toBe(GREETING);
  });

  it('stays silent on an empty message rather than prompting about nothing', async () => {
    const { provider, seen } = fakeProvider('anything');
    const respond = createAssistantResponder({ provider });
    expect(await respond(msg('   '))).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
