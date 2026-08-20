import { describe, expect, it } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tickCountFromFlag, wholeNumberFromFlag, wholeNumberOrUndefined } from '../../infra/cli-args.js';
import { portFromFlag } from '../../infra/cli-port.js';
import { registerRappterCommand } from '../../cli/rappters.js';

/**
 * Commander calls an option parser as `fn(value, previous)`. Passing `parseInt`
 * straight in therefore hands the previous value to the RADIX parameter — the
 * `['1','2','3'].map(parseInt)` bug, in a shipped flag.
 */
describe('--evolve was parsed by a bare parseInt', () => {
  const evolve = (parser: (v: string, p?: never) => unknown, args: string[]) => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    program.option('-e, --evolve <n>', 'Run N evolution ticks', parser as never);
    try {
      program.parse(['node', 'openrappter', ...args]);
    } catch {
      return 'rejected';
    }
    return program.opts().evolve;
  };

  it('parsed a repeated flag as NaN, because the previous value became the radix', () => {
    // parseInt('9', 9): base 9 has no digit 9.
    expect(evolve(parseInt, ['-e', '9', '-e', '9'])).toBeNaN();
    expect(evolve(tickCountFromFlag, ['-e', '9', '-e', '9'])).toBe(9);
  });

  it('turned a typo into silence rather than an error', () => {
    // NaN is falsy, and the caller guards with `if (options.evolve)`, so the
    // command ran no ticks and exited 0 — indistinguishable from success.
    expect(evolve(parseInt, ['-e', 'abc'])).toBeNaN();
    expect(evolve(tickCountFromFlag, ['-e', 'abc'])).toBe('rejected');
  });

  it.each([
    ['10abc', 10],
    ['5.7', 5],
    ['0x10', 16],
  ])('read %j as %i', (raw, wasParsedAs) => {
    expect(evolve(parseInt, ['-e', raw])).toBe(wasParsedAs);
    expect(evolve(tickCountFromFlag, ['-e', raw])).toBe('rejected');
  });

  it('accepted a negative count it could not possibly run', () => {
    expect(evolve(parseInt, ['-e', '-3'])).toBe(-3);
    expect(evolve(tickCountFromFlag, ['-e', '-3'])).toBe('rejected');
  });

  it('refuses zero, which fell past the guard into an interactive session', () => {
    expect(evolve(parseInt, ['-e', '0'])).toBe(0);
    expect(evolve(tickCountFromFlag, ['-e', '0'])).toBe('rejected');
  });

  it('still accepts an ordinary count', () => {
    expect(evolve(tickCountFromFlag, ['-e', '5'])).toBe(5);
  });

  /**
   * The consumer guards with `if (options.evolve)`. That guard is only safe
   * because the parser can no longer produce NaN, 0 or a negative.
   */
  it('never yields a value the caller would silently skip', () => {
    for (const raw of ['1', '2', '99', '1000']) {
      expect(tickCountFromFlag(raw)).toBeGreaterThan(0);
    }
  });
});

describe('wholeNumberOrUndefined', () => {
  it.each([
    ['0x1F90', 0, 8080],
    ['1e3', 1, 1000],
    ['8080.5', 8080, 8080.5],
    ['18790abc', 18790, Number.NaN],
  ])('refuses %j, which parseInt read as %s and Number read as %s', (raw) => {
    expect(wholeNumberOrUndefined(raw, 1, 65_535)).toBeUndefined();
  });

  it.each([['8080'], ['  9000  '], ['1'], ['65535']])('accepts %j', (raw) => {
    expect(wholeNumberOrUndefined(raw, 1, 65_535)).toBe(Number(raw.trim()));
  });

  it('honours the bounds it is given', () => {
    expect(wholeNumberOrUndefined('0', 1, 10)).toBeUndefined();
    expect(wholeNumberOrUndefined('11', 1, 10)).toBeUndefined();
    expect(wholeNumberOrUndefined('10', 1, 10)).toBe(10);
  });
});

describe('wholeNumberFromFlag', () => {
  it('throws the error commander knows how to print', () => {
    expect(() => wholeNumberFromFlag('nope', 1, 10)).toThrow(InvalidArgumentError);
  });

  it('names the bounds it was given', () => {
    expect(() => wholeNumberFromFlag('nope', 1, 10)).toThrow(/whole number from 1 to 10/);
  });

  /**
   * `--evolve` has no real upper bound, and printing 9007199254740991 at
   * someone who typed a typo tells them nothing about what to type instead.
   */
  it('does not print MAX_SAFE_INTEGER as though it were a limit', () => {
    let message = '';
    try {
      tickCountFromFlag('abc');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('9007199254740991');
    expect(message).toBe('must be a whole number 1 or more');
  });
});

/**
 * The parsers above are only worth anything if the real commands use them.
 * Mutation testing proved that gap was live: reverting `--evolve` to a bare
 * `parseInt` broke none of the unit tests, because they all built their own
 * throwaway `Command`. These two assert the wiring itself.
 */
describe('the real commands use the validated parsers', () => {
  it('registerRappterCommand rejects a bad --port with a usage error', () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerRappterCommand(program);

    let message = '';
    try {
      program.parse(['node', 'openrappter', 'hatch', 'demo', '--port', '8080.5']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("option '--port <port>' argument '8080.5' is invalid");
  });

  /**
   * `index.ts` calls `program.parse()` at module scope, so it cannot be
   * imported to be inspected. Read the decision out of the source instead —
   * the same approach the repo already uses for rules that live in a module
   * with side effects.
   *
   * Passing a builtin straight to `.option()` is never right: commander calls
   * a parser as `fn(value, previous)`, so `parseInt` silently takes `previous`
   * as its RADIX, and `--evolve 9 --evolve 9` parsed to NaN.
   */
  it('no command hands a bare builtin to commander as an option parser', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = ['../../index.ts', '../../cli/rappters.ts', '../../twin/cli.ts'];

    for (const relative of sources) {
      const source = readFileSync(join(here, relative), 'utf8');
      const offenders = [
        ...source.matchAll(
          /\.(?:option|requiredOption|argument)\([^)]*?,\s*(parseInt|parseFloat|Number|Boolean)\s*[,)]/g,
        ),
      ];
      expect(
        offenders.map((match) => `${relative}: ${match[1]}`),
        `${relative} passes a builtin as a commander parser; commander calls it as `
        + 'fn(value, previous), so previous becomes parseInt\'s radix',
      ).toEqual([]);
    }
  });
});

/**
 * The `--port` validator existed as SEVEN byte-identical copies, not six: the
 * seventh lived in another file and outlived the consolidation. A rule written
 * once cannot drift, so both flags now answer for the same reasons.
 */
describe('every --port flag answers the same way', () => {
  it.each([['8080.5'], ['18790abc'], ['1e3'], ['0x1F90'], ['0'], ['-1'], ['65536'], ['']])(
    'rejects %j',
    (raw) => {
      expect(() => portFromFlag(raw)).toThrow(InvalidArgumentError);
    },
  );

  it('rejects with a usage error, not a stack trace, through commander', () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    program.option('--port <port>', 'override the port derived from the name', portFromFlag);

    let message = '';
    try {
      program.parse(['node', 'rappters', '--port', '8080.5']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("option '--port <port>' argument '8080.5' is invalid");
  });
});
