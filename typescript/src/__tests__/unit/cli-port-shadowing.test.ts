/**
 * A --port typed after a subcommand reaches that subcommand. — #107 / #108
 *
 * The root program declares `--port` for its default chat/daemon command.
 * Commander gives that declaration precedence over a subcommand's own, and the
 * value lands on the ROOT. Measured for a nested command:
 *
 *   $ openrappter imessage service-status --port 19950
 *
 *   subcommand opts.port   = 18790          <- its own default
 *   subcommand source      = default
 *     ancestor 1 (imessage) = undefined
 *     ancestor 2 (root)     = 19950   source = cli
 *
 * Two symptoms came from this. `openrappter hatch archivist --port 19950`
 * hatched on :19591, the port DERIVED from the name. And four subcommands
 * declare `--port` with an 18790 default, so `opts.port` is always populated,
 * always 18790, and nothing errors — including `service install` and `imessage
 * install-service`, which INSTALL a launchd service on that port, so the
 * failure misconfigures rather than merely misreporting.
 *
 * The default is what makes it invisible: nothing in the VALUE distinguishes
 * "the user typed 18790" from "nobody typed anything". Only the option's source
 * does.
 *
 * These tests parse REAL argv with the flag written after the subcommand name,
 * because that is the only arrangement in which the bug exists. Setting the
 * option programmatically — which is how a unit test would naturally do it —
 * cannot observe this at all.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { portTypedOnCommandLine } from '../../infra/cli-port.js';

const portParser = (value: string) => Number.parseInt(value, 10);

/**
 * A program shaped like the real one: a root declaring `--port` for its default
 * command, an optional intermediate group, and a leaf that also wants a port.
 */
function parse(argv: string[], options: {
  nested?: boolean;
  leafDefault?: number;
} = {}): { typed: number | undefined; leafOwn: number | undefined } {
  let typed: number | undefined;
  let leafOwn: number | undefined;
  let called = false;

  const root = new Command();
  root.exitOverride();
  root
    .argument('[message]')
    .option('--instance <id>', 'instance')
    .option('--port <port>', 'Gateway port', portParser)
    .action(() => {});

  const parent = options.nested ? root.command('imessage') : root;
  const leaf = parent.command('leaf');
  leaf.exitOverride();
  if (options.leafDefault !== undefined) {
    leaf.option('--port <port>', 'own', portParser, options.leafDefault);
  } else {
    leaf.option('--port <port>', 'own', portParser);
  }
  leaf.action((opts: { port?: number }, command: Command) => {
    called = true;
    leafOwn = opts.port;
    typed = portTypedOnCommandLine(command);
  });

  root.parse(['node', 'openrappter', ...(options.nested ? ['imessage'] : []), ...argv]);
  expect(called).toBe(true);
  return { typed, leafOwn };
}

describe('a port typed after a subcommand is not swallowed by the root', () => {
  it('finds it when the leaf has no default', () => {
    // The `hatch` shape.
    expect(parse(['leaf', '--port', '19950']).typed).toBe(19_950);
  });

  it('finds it through an intermediate command group', () => {
    // The `imessage service-status` shape — the value is TWO levels up, so a
    // fix that only looked at `command.parent` would miss it.
    expect(parse(['leaf', '--port', '19950'], { nested: true }).typed).toBe(19_950);
  });

  it('finds it even when the leaf own default masks the failure', () => {
    // This is the invisible case: the leaf reports 18790 with total confidence
    // while the user asked for 19950.
    const { typed, leafOwn } = parse(
      ['leaf', '--port', '19950'],
      { nested: true, leafDefault: 18_790 },
    );
    expect(leafOwn).toBe(18_790);
    expect(typed).toBe(19_950);
  });

  it('reports nothing when no port was typed, so a caller keeps its default', () => {
    // Must be undefined, not 0 and not NaN. Callers use `?? options.port` and
    // `?? gatewayPortFor(...)`, and a NaN would be bound as a random port or
    // written into a launchd plist.
    expect(parse(['leaf'], { nested: true, leafDefault: 18_790 }).typed).toBeUndefined();
    expect(parse(['leaf']).typed).toBeUndefined();
  });

  it('does not mistake a default of 18790 for a typed 18790', () => {
    // The whole reason this asks for the SOURCE rather than comparing values.
    expect(parse(['leaf'], { leafDefault: 18_790 }).typed).toBeUndefined();
    expect(parse(['leaf', '--port', '18790'], { leafDefault: 18_790 }).typed).toBe(18_790);
  });

  it('ignores a root value that is not a usable port', () => {
    const root = new Command();
    root.option('--port <port>', 'root'); // no parser: hands back a string
    const leaf = root.command('x');
    let seen: number | undefined = 1;
    leaf.action((_o: unknown, command: Command) => {
      seen = portTypedOnCommandLine(command);
    });
    root.parse(['node', 'openrappter', '--port', 'not-a-port', 'x']);
    expect(seen).toBeUndefined();
  });

  it('rejects a port outside the valid range rather than passing it on', () => {
    const root = new Command();
    root.option('--port <port>', 'root', portParser);
    const leaf = root.command('x');
    let seen: number | undefined = 1;
    leaf.action((_o: unknown, command: Command) => {
      seen = portTypedOnCommandLine(command);
    });
    root.parse(['node', 'openrappter', '--port', '70000', 'x']);
    expect(seen).toBeUndefined();
  });
});
