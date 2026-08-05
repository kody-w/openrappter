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
