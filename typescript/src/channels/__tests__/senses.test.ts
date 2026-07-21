import { describe, it, expect } from 'vitest';
import { parseSenses, voiceOf } from '../senses.js';

describe('parseSenses — the sense weld point', () => {
  it('returns the whole reply as text when there are no markers', () => {
    const r = parseSenses('Just a plain reply.');
    expect(r.text).toBe('Just a plain reply.');
    expect(r.senses).toEqual({});
  });

  it('splits a single |||VOICE||| block', () => {
    const r = parseSenses('Here is the full answer.\n|||VOICE|||\nHere is the spoken version.');
    expect(r.text).toBe('Here is the full answer.');
    expect(r.senses.voice).toBe('Here is the spoken version.');
    expect(voiceOf(r)).toBe('Here is the spoken version.');
  });

  it('parses multiple senses in one reply', () => {
    const reply = 'Main text here.'
      + '|||VOICE|||Spoken form.'
      + '|||HOLO|||{"creature":"rex","pose":"wave"}'
      + '|||EMOJI|||🦖✨';
    const r = parseSenses(reply);
    expect(r.text).toBe('Main text here.');
    expect(r.senses.voice).toBe('Spoken form.');
    expect(r.senses.holo).toBe('{"creature":"rex","pose":"wave"}');
    expect(r.senses.emoji).toBe('🦖✨');
  });

  it('lower-cases tags and trims content', () => {
    const r = parseSenses('T |||TLDR|||   short   ');
    expect(r.senses.tldr).toBe('short');
  });

  it('drops empty sense blocks', () => {
    const r = parseSenses('body|||VOICE|||   |||EMOJI|||🦕');
    expect(r.senses.voice).toBeUndefined();
    expect(r.senses.emoji).toBe('🦕');
  });

  it('handles a reply that is only a sense block (empty main text)', () => {
    const r = parseSenses('|||VOICE|||just speak this');
    expect(r.text).toBe('');
    expect(r.senses.voice).toBe('just speak this');
  });

  it('is safe on empty / whitespace input', () => {
    expect(parseSenses('')).toEqual({ text: '', senses: {} });
    expect(parseSenses('   ')).toEqual({ text: '', senses: {} });
  });

  it('ignores malformed markers (wrong pipe count / lowercase tag)', () => {
    const r = parseSenses('keep ||VOICE|| and |||voice||| literal');
    expect(r.text).toBe('keep ||VOICE|| and |||voice||| literal');
    expect(r.senses).toEqual({});
  });

  it('last duplicate tag wins', () => {
    const r = parseSenses('x|||VOICE|||first|||VOICE|||second');
    expect(r.senses.voice).toBe('second');
  });
});
