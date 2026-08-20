/**
 * The port a user actually typed, wherever Commander decided to put it. — #108
 *
 * The root program declares `--port` for its default chat/daemon command.
 * Commander gives that declaration precedence over a subcommand's own, and the
 * value lands on the ROOT — for a nested command, two levels up. Measured:
 *
 *   $ openrappter imessage service-status --port 19950
 *
 *   subcommand opts.port      = 18790          <- its own default
 *   subcommand source         = default
 *     ancestor 1 opts.port    = undefined      <- the `imessage` group
 *     ancestor 2 opts.port    = 19950   source = cli
 *
 * Four subcommands declare `--port` WITH an 18790 default, so `opts.port` is
 * always populated, always 18790, and nothing errors. Two of them — `service
 * install` and `imessage install-service` — install a launchd service on that
 * port, so the failure silently misconfigures rather than merely misreporting.
 *
 * This matters more since #101/#107, because a device really can have several
 * rappters on different ports and "which port" is now a question with more than
 * one right answer.
 *
 * The default is what makes it invisible: there is no way to tell "the user
 * typed 18790" from "nobody typed anything" by looking at the value. Only
 * `getOptionValueSource` distinguishes them, which is why this asks for the
 * SOURCE rather than comparing against the default.
 */

import type { Command } from 'commander';

/**
 * Walk this command and its ancestors for a `--port` that came from the command
 * line, and return it.
 *
 * Returns undefined when the user typed no port anywhere, so a caller keeps
 * whatever default it already had. Nearest wins: a subcommand that really did
 * receive the flag itself is more specific than an ancestor that captured it.
 */
export function portTypedOnCommandLine(command: Command): number | undefined {
  for (
    let node: Command | null | undefined = command;
    node;
    node = node.parent
  ) {
    // `getOptionValueSource` is what separates a typed 18790 from an untyped
    // one. Comparing the value against the default cannot do it.
    if (node.getOptionValueSource?.('port') !== 'cli') continue;

    const raw = (node.opts() as { port?: unknown }).port;
    const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    // A root that declared `--port` without a parser hands back a string, and
    // an unparseable one must never become a bind or install target.
    if (
      typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 1
      && value <= 65_535
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * The port `OPENRAPPTER_PORT` asks for, parsed once and the same way everywhere.
 *
 * The variable was read in five places with two different parsers, and they do
 * not agree. Measured:
 *
 *   OPENRAPPTER_PORT   parseInt(v, 10)          Number(v)
 *   0x1F90             0     -> ephemeral port  8080
 *   18790abc           18790 -> binds           NaN
 *   8080.5             8080                     8080.5
 *   ""                 NaN                      0
 *
 * The disagreement was not cosmetic, because the two parsers fed different
 * things. `parseInt` produced the port the gateway BINDS; `Number` produced the
 * port its lock file is NAMED for. So `OPENRAPPTER_PORT=0x1F90` bound an
 * arbitrary ephemeral port and then took the lock for 8080: the lock stopped
 * describing the server it is supposed to be guarding, which is the only job a
 * lock has. `NaN` was worse rather than better — `gatewayPortFor` screens it
 * with `Number.isFinite` and quietly substitutes the derived port, so the
 * mismatch left no trace at all.
 *
 * `0` reached the same place by a shorter route. `parseInt('0', 10)` is a
 * request for an ephemeral port, so the server landed somewhere unpredictable
 * while the lock recorded the literal 0. `--port 0` is rejected outright, and
 * a variable has no business being more permissive than the flag it mirrors.
 *
 * Hence: one parser, and the bounds `--port` already enforces. An unusable
 * value raises rather than quietly becoming some other port, because every
 * silent fallback here ends with a lock pointing at the wrong server. Unset
 * and empty both mean "no opinion" and return undefined, so each caller keeps
 * the default it already had.
 */
export function portFromEnvironment(
  raw: string | undefined = process.env.OPENRAPPTER_PORT,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  // `Number` rather than `parseInt`: it refuses trailing garbage and fractions
  // instead of truncating them into a plausible-looking port.
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Invalid OPENRAPPTER_PORT: ${JSON.stringify(raw)} `
      + '(expected a whole number from 1 to 65535)',
    );
  }
  return port;
}
