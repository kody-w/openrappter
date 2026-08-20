/**
 * The rule for a whole number typed on the command line.
 *
 * This exists because the same rule was written seven times for `--port` alone
 * and still managed to disagree with itself, and because `--evolve` skipped
 * writing it at all and passed `parseInt` straight to commander. Both mistakes
 * have the same shape: a number arrives as text, and every parser that reads it
 * casually accepts something the user did not type.
 *
 * Callers name their own bounds and their own wording. The rule itself lives
 * here once.
 */

import { InvalidArgumentError } from 'commander';

/**
 * A whole number written in decimal, within bounds, or undefined.
 *
 * Digits only, deliberately. Both of the obvious readings are worse:
 *
 *   input       parseInt(v, 10)   Number(v)
 *   0x1F90      0                 8080
 *   1e3         1                 1000
 *   8080.5      8080              8080.5
 *   18790abc    18790             NaN
 *
 * `parseInt` truncates at the first character it does not like, so garbage
 * becomes a plausible-looking number instead of an error. `Number` accepts
 * notations nobody uses for a port or a count. They disagree on every row
 * above, which is exactly how `--port` and `OPENRAPPTER_PORT` ended up reading
 * `1e3` a thousand apart. Requiring decimal digits settles all of it in one
 * sentence, and no one writes a port or a tick count any other way.
 *
 * Returns undefined rather than throwing so each caller can say where the
 * value came from; a user who typed `--port` wants to hear about `--port`.
 */
export function wholeNumberOrUndefined(
  raw: string,
  min: number,
  max: number,
): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) return undefined;
  return value;
}

/**
 * The same rule, as a commander option parser.
 *
 * `InvalidArgumentError` rather than a plain `Error`, because commander only
 * recognises the former. A plain one escapes as an uncaught exception, which is
 * how a typo used to earn a stack trace pointing into node_modules instead of
 * the one-line usage error every other bad argument gets.
 *
 * Commander supplies the flag name and the offending value when it formats
 * this, so `expected` is only the reason.
 */
export function wholeNumberFromFlag(raw: string, min: number, max: number): number {
  const value = wholeNumberOrUndefined(raw, min, max);
  if (value === undefined) {
    // An upper bound of MAX_SAFE_INTEGER is not a real limit, it is the absence
    // of one, and printing 9007199254740991 at someone who typed a typo tells
    // them nothing about what to type instead.
    const bounds = max === Number.MAX_SAFE_INTEGER
      ? `${min} or more`
      : `from ${min} to ${max}`;
    throw new InvalidArgumentError(`must be a whole number ${bounds}`);
  }
  return value;
}

/**
 * The count `--evolve` asks for.
 *
 * Commander calls a parser as `fn(value, previous)`, so passing `parseInt`
 * directly — as this option did — silently hands the previous value in as the
 * RADIX. It is the `['1','2','3'].map(parseInt)` bug, in a shipped flag.
 * Measured before this change:
 *
 *   -e abc        NaN   ran nothing, exit 0, and fell through to interactive chat
 *   -e 0          0     same: the caller guards with `if (options.evolve)`
 *   -e 10abc      10    ran ten ticks
 *   -e 5.7        5
 *   -e 0x10       16    parseInt auto-detects hex when the radix is undefined
 *   -e -3         -3    announced "Running -3 evolution ticks", then ran none
 *   -e 9 -e 9     NaN   radix 9 has no digit 9, so a repeated flag parsed to NaN
 *
 * The NaN cases are the reason this matters: asking for evolution ticks and
 * getting silence and a zero exit code looks exactly like success.
 *
 * Zero is refused rather than treated as a no-op, because it was not one — it
 * fell past the guard into an interactive session, which is not what anyone
 * typing `--evolve 0` in a script is expecting.
 */
export function tickCountFromFlag(raw: string): number {
  return wholeNumberFromFlag(raw, 1, Number.MAX_SAFE_INTEGER);
}
