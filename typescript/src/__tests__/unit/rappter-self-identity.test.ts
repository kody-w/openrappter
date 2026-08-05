/**
 * A rappter knows which rappter it is. — #102
 *
 * `--instance` reached the runtime lock (#94), the listening port (#101) and
 * the outbound channels (#103), and stopped. Nothing put the name into the
 * assistant's own context, so a twin hatched as `scout` — its own process, its
 * own lock, its own port, verified by lsof — answered this over /twin:
 *
 *   "No, I'm the same rappter you're speaking with — I don't have a separate
 *    internal identity or run parallel versions unless explicitly created as
 *    another instance."
 *
 * False in every clause, including the last one: it WAS explicitly created as
 * another instance, and it was the thing answering.
 *
 * The delicate part is what this must NOT do. Asked in the same session who it
 * was talking to, a twin said "You're a person" while being scripted by another
 * rappter — and that is correct, it is the entire point of the product. Self
 * knowledge is one short step from presuming to know others, so these tests
 * pin both halves: it must know itself, and it must still not claim to know
 * anyone else.
 */

import { describe, it, expect } from 'vitest';
import { Assistant } from '../../agents/Assistant.js';

/** Reach the prompt the model actually receives, not a restatement of it. */
function systemPrompt(config: Record<string, unknown>): string {
  const assistant = new Assistant(new Map(), {
    // Pin the persona so the device's real twin vault cannot leak in and make
    // this test pass or fail based on whoever happens to own the machine.
    name: 'openrappter',
    description: 'a local-first AI assistant',
    useTwin: false,
    loadWorkspaceContext: false,
    loadMemoryContext: false,
    ...config,
  } as never);
  return (assistant as unknown as {
    buildBaseSystemPrompt(m?: string, w?: string): string;
  }).buildBaseSystemPrompt();
}

describe('a rappter knows which rappter it is', () => {
  it('tells a hatched twin its own name', () => {
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toContain('<rappter_self>');
    expect(prompt).toContain('hatched twin');
    expect(prompt).toContain('"scout"');
  });

  it('tells a twin it is not the alpha — the exact claim it got wrong', () => {
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toContain('You are not the alpha');
    expect(prompt).toMatch(/not the same rappter as any peer/);
  });

  it('tells the alpha it is the alpha', () => {
    const prompt = systemPrompt({});
    expect(prompt).toContain('<rappter_self>');
    expect(prompt).toContain('You are the alpha rappter on this device');
    expect(prompt).not.toContain('hatched twin on this device, named');
  });

  it('treats an empty or blank instance as the alpha, not as a twin called ""', () => {
    for (const instance of ['', '   ']) {
      const prompt = systemPrompt({ instance });
      expect(prompt).toContain('You are the alpha rappter on this device');
      expect(prompt).not.toContain('named ""');
    }
  });

  it('still refuses to let it presume what a PEER is — both roles', () => {
    // The property the whole product rests on. Knowing yourself must not
    // become knowing others, so every rappter carries the disclaimer.
    for (const config of [{ instance: 'scout' }, {}]) {
      const prompt = systemPrompt(config);
      expect(prompt).toMatch(/may come from a rappter, a brainstem, or a person/);
      expect(prompt).toMatch(/you cannot tell which/);
      expect(prompt).toMatch(/Never assume, and never claim to know/);
    }
  });

  it('adds to the persona rather than replacing it', () => {
    // A twin can carry the owner's persona and still not be the alpha. If this
    // block ever displaced <identity>, hatching a twin would silently strip
    // whoever the rappter is supposed to speak as.
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toContain('<identity>');
    expect(prompt.indexOf('<identity>')).toBeLessThan(prompt.indexOf('<rappter_self>'));
  });

  it('says which one it is even with no agents registered', () => {
    // There are two return paths out of the prompt builder and only one was
    // exercised by the tests above; the no-agent path is what a bare twin hits.
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toContain('<rappter_self>');
    expect(prompt).toContain('<conversation_mode>');
  });
});
