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

/**
 * A twin is told which mouths are not its own. — #122
 *
 * #103's rule was enforced on channels, on cron, and on the channel registry.
 * The AGENTS that drive those same single-owner resources stayed available.
 * Measured on a live hatched twin:
 *
 *   Q: name your tools that can contact a person outside this machine
 *   A: "Message, Phone."
 *
 *   Q: would you phone a restaurant for me, or is that reserved for another
 *      rappter on this device?
 *   A: "I can phone a restaurant on your behalf if you ask. This action isn't
 *       reserved for another rappter; I have that capability directly."
 *
 * Every outbound capability on a twin has turned out to be stopped by
 * CONFIGURATION rather than design — Telegram by an unset token (#115, #121),
 * Phone by no provider, GoogleVoice by no Chrome endpoint. Four for four.
 *
 * THIS IS DISCLOSURE, NOT ENFORCEMENT. It is a sentence in a prompt. Anyone who
 * can reach a twin's /chat can still ask it to try, and nothing mechanical stops
 * the agent. Whether a twin should be blocked outright is recorded on #122 as
 * the owner's decision, because it changes what a twin is. These tests pin what
 * the twin is TOLD; they must not be read as proving it cannot act.
 */
describe('a twin is told the outbound channels are not its own', () => {
  it('names the resources and says why there is only one of each', () => {
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toContain('single-owner outbound channels');
    // The reason, not just the rule — a twin that knows why can explain it.
    expect(prompt).toMatch(/two rappters using one of them would talk over each other/);
  });

  it('tells it to decline and offer what it can still do', () => {
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toMatch(/do not\s+place calls, send SMS, or message anyone outside this device/);
    expect(prompt).toMatch(/offer to do the part that does not leave the machine/);
  });

  it('says none of this to the alpha, which does hold them', () => {
    const prompt = systemPrompt({});
    expect(prompt).not.toContain('single-owner outbound channels');
    expect(prompt).toContain('You are the alpha rappter on this device');
  });

  it('still does not let a twin presume what a PEER is', () => {
    // The property from #102 must survive this addition — knowing which mouths
    // are yours is not knowing who is talking to you.
    const prompt = systemPrompt({ instance: 'scout' });
    expect(prompt).toMatch(/may come from a rappter, a brainstem, or a person/);
    expect(prompt).toMatch(/Never assume, and never claim to know/);
  });
});
