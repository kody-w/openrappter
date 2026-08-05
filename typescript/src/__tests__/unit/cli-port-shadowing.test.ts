/**
 * A --port typed after a subcommand reaches that subcommand. — #107 / #108
 *
 * The root program declares `--port` for the default chat/daemon command.
 * Commander gives that declaration precedence over a subcommand's own, so:
 *
 *   $ openrappter hatch archivist --port 19950
 *   🦖 Hatching archivist on :19591 (pid 50992)
 *
 * 19591 is the port DERIVED from the name. The flag was swallowed silently —
 * no error, no warning, just a different number than the one typed. Caught by
 * running the command, not by any test that existed.
 *
 * These tests parse REAL argv with the flag written after the subcommand name,
 * because that is the only arrangement in which the bug exists. Setting the
 * option programmatically, which is how a unit test would naturally do it,
 * cannot observe this at all — the value is simply present and correct.
 *
 * Four pre-existing subcommands have the same shape and are reported in #108;
 * they are deliberately not changed here.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { explicitPort } from '../../cli/rappters.js';

/**
 * A program shaped like the real one: a root that declares `--port` for its
 * default command, plus a subcommand that also wants a port.
 */
function parsePort(argv: string[]): number | undefined {
  let seen: number | undefined;
  let called = false;

  const program = new Command();
  program.exitOverride();
  // Mirrors index.ts — this declaration is what does the shadowing.
  program
    .argument('[message]')
    .option('--instance <id>', 'instance')
    .option('--port <port>', 'Gateway port', (value: string) => Number.parseInt(value, 10))
    .action(() => {});

  const sub = program.command('hatch');
  sub.exitOverride();
  sub
    .argument('<name>')
    .option('--port <port>', 'override', (value: string) => Number.parseInt(value, 10))
    .action((_name: string, options: { port?: number }, command: Command) => {
      called = true;
      seen = explicitPort(options, command);
    });

  program.parse(['node', 'openrappter', ...argv]);
  expect(called).toBe(true);
  return seen;
}

describe('a port typed after a subcommand is not swallowed by the root', () => {
  it('sees --port written after the subcommand argument', () => {
    // The exact invocation that hatched on the wrong port.
    expect(parsePort(['hatch', 'archivist', '--port', '19950'])).toBe(19_950);
  });

  it('sees --port written before the subcommand argument', () => {
    expect(parsePort(['hatch', '--port', '19950', 'archivist'])).toBe(19_950);
  });

  it('reports nothing when no port was typed, so the name derivation is used', () => {
    // Must be undefined, not 0 and not NaN: the caller falls back to
    // gatewayPortFor() only on undefined, and a NaN would be bound as a random
    // port, making the twin unreachable by the name it was hatched under.
    expect(parsePort(['hatch', 'archivist'])).toBeUndefined();
  });

  it('ignores a root value that is not a usable port', () => {
    const program = new Command();
    program.option('--port <port>', 'root');
    const sub = program.command('x');
    let seen: number | undefined = 1;
    sub.action((_o: unknown, command: Command) => {
      // A raw unparsed string, or junk, must not become the bind port.
      seen = explicitPort({}, command);
    });
    program.parse(['node', 'openrappter', '--port', 'not-a-port', 'x']);
    expect(seen).toBeUndefined();
  });
});
