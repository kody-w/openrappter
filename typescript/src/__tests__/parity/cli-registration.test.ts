import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * What the CLI actually exposes, asked of the CLI.
 *
 * The neighbouring cli-commands.test.ts reads the source files instead. That
 * is why twelve fully implemented command modules under src/cli could sit
 * unregistered without a single test going red: the files were present and
 * exported, and nothing ever asked the program what it had registered.
 */

const ENTRY = join(__dirname, '../../index.ts');

/** Commands the CLI is known to expose. Each is asserted individually. */
const REGISTERED = [
  'onboard',
  'service',
  'imessage',
  'reset',
  'bar',
  'channel',
  'call',
  'twin',
  'cron',
];

let commands: string[];

function parseCommands(help: string): string[] {
  const section = help.slice(help.indexOf('Commands:'));
  return section
    .split('\n')
    .slice(1)
    .map((line) => line.match(/^\s{2}([a-z][a-z-]*)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

beforeAll(() => {
  // A throwaway HOME so nothing here can read or write the real config.
  const home = mkdtempSync(join(tmpdir(), 'openrappter-cli-'));
  const help = execFileSync(
    'npx',
    ['tsx', ENTRY, '--help'],
    { encoding: 'utf-8', env: { ...process.env, HOME: home }, timeout: 120_000 },
  );
  commands = parseCommands(help);
}, 180_000);

describe('CLI command registration, observed from outside', () => {
  it.each(REGISTERED)('registers %s', (name) => {
    expect(commands).toContain(name);
  });

  it('parses a plausible command list at all', () => {
    // Guards the parser above: if --help changed shape, every assertion in
    // this file would pass vacuously against an empty list.
    expect(commands.length).toBeGreaterThanOrEqual(REGISTERED.length);
  });
});
