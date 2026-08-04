/**
 * LearnNewAgent writes agent source from a description a user supplies in an
 * ordinary "create an agent that ..." request. That text was interpolated into
 * generated JavaScript in three places without being encoded for any of them.
 *
 * Two consequences, both reproduced before this file existed:
 *
 *   1. `*​/` in the description closed the doc comment early, and everything
 *      after it became executable code. The generated file parsed cleanly and
 *      ran the statement on load — a green result for a broken outcome.
 *
 *   2. The metadata description escaped quotes and *then* sliced to 200 chars,
 *      which can cut between a backslash and the character it escapes:
 *
 *          description: "AAAA\",
 *
 *      The trailing backslash escapes the closing quote and the agent will not
 *      parse at all. A description ending in a lone backslash did the same.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LearnNewAgent, jsStringLiteral, docCommentSafe } from '../LearnNewAgent.js';

type TemplateAccess = {
  generateAgentCodeTemplate(description: string, name: string, className: string): string;
};

function generate(description: string): string {
  return (new LearnNewAgent() as unknown as TemplateAccess)
    .generateAgentCodeTemplate(description, 'demo', 'DemoAgent');
}

/** Parse as a module body would be parsed, without executing the export. */
function parses(code: string): { ok: boolean; error?: string } {
  try {
    new Function(code.replace(/^export /m, ''));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

describe('generated agent source is escaped for the context it lands in', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).LEARN_NEW_INJECTED;
  });

  it('does not let a description close the doc comment and run as code', () => {
    const code = generate("x */ globalThis.LEARN_NEW_INJECTED = 'yes'; /* y");

    expect(parses(code).ok).toBe(true);
    new Function(code.replace(/^export /m, ''))();

    expect((globalThis as Record<string, unknown>).LEARN_NEW_INJECTED).toBeUndefined();
  });

  it('keeps the comment terminator out of the generated header', () => {
    const header = generate('before */ after').split('\n')[1];
    expect(header).not.toContain('*/');
    // The text is still carried, not silently dropped.
    expect(header).toContain('before');
    expect(header).toContain('after');
  });

  it.each([
    ['a trailing backslash', 'ends with a backslash \\'],
    ['an escape cut at the truncation boundary', `${'A'.repeat(199)}"${'B'.repeat(20)}`],
    ['embedded newlines and quotes', 'line1\n"quoted"\nline2'],
    ['control characters', 'tab\there\u0000null'],
    ['a lone double quote', 'say "hi"'],
    ['a backslash-u sequence', 'literal \\u0041 text'],
  ])('generates parseable source for %s', (_label, description) => {
    const result = parses(generate(description));
    expect(result.ok, result.error).toBe(true);
  });

  it('truncates before escaping, so the escape is never cut in half', () => {
    const line = generate(`${'A'.repeat(199)}"${'B'.repeat(20)}`)
      .split('\n')
      .find(l => l.includes('description:')) ?? '';

    // An odd number of trailing backslashes before the closing quote means the
    // quote is escaped and the literal never closes.
    const trailing = /(\\*)"[,\s]*$/.exec(line.trim())?.[1] ?? '';
    expect(trailing.length % 2).toBe(0);
  });
});

describe('jsStringLiteral', () => {
  it('produces a literal that round-trips back to the input', () => {
    for (const value of ['plain', 'say "hi"', 'back\\slash', 'new\nline', 'nul\u0000', 'emoji 😀']) {
      expect(JSON.parse(jsStringLiteral(value))).toBe(value);
    }
  });

  it('truncates by code point, not UTF-16 unit, so no half emoji survives', () => {
    const literal = jsStringLiteral('😀'.repeat(10), 3);
    expect(JSON.parse(literal)).toBe('😀'.repeat(3));
  });

  it('applies the limit before encoding, so escaping cannot be truncated', () => {
    const literal = jsStringLiteral(`${'A'.repeat(199)}"BBBB`, 200);
    // 200 code points in, and it still parses as one complete literal.
    expect(Array.from(JSON.parse(literal) as string)).toHaveLength(200);
  });
});

describe('docCommentSafe', () => {
  it('neutralises the comment terminator', () => {
    expect(docCommentSafe('a */ b')).not.toContain('*/');
  });

  it('flattens newlines so the comment body cannot escape its prefix', () => {
    expect(docCommentSafe('a\nb\r\nc')).toBe('a b c');
  });

  it('leaves ordinary text alone', () => {
    expect(docCommentSafe('a normal description')).toBe('a normal description');
  });
});
