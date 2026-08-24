import { describe, expect, it } from 'vitest';
import {
  createSpeechTicket,
  verifySpeechTicket,
} from './speech-ticket.js';

const KEY = 'b'.repeat(64);

describe('assistant-only speech tickets', () => {
  it('round trips the exact selected assistant speech and no conversation history', () => {
    const ticket = createSpeechTicket({
      runId: 'run_123',
      text: 'The exact final spoken sentence.',
      key: KEY,
      now: 1_000,
    });
    expect(verifySpeechTicket(ticket, KEY, 1_001)).toEqual({
      runId: 'run_123',
      text: 'The exact final spoken sentence.',
    });
    expect(ticket).not.toContain('user prompt');
  });

  it('rejects tampering, expiry, arbitrary text, and oversized tickets', () => {
    const ticket = createSpeechTicket({
      runId: 'run_123',
      text: 'assistant output',
      key: KEY,
      now: 1_000,
      ttlMs: 100,
    });
    expect(() => verifySpeechTicket(`${ticket}x`, KEY, 1_001)).toThrow(/invalid/i);
    expect(() => verifySpeechTicket(ticket, KEY, 1_101)).toThrow(/expired/i);
    expect(() => createSpeechTicket({
      runId: 'run_123',
      text: 'x'.repeat(5_001),
      key: KEY,
      now: 1_000,
    })).toThrow(/too long/i);
  });
});
