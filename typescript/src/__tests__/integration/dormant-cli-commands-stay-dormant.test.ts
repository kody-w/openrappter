import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * The dormant CLI command modules stay dormant.
 *
 * `src/cli/index.ts` re-exports fifteen `register*Command` functions. Only nine
 * are ever invoked by `src/index.ts`; the other six declare fully written
 * commands against dependencies nothing wires — the CLI twin of the dormant
 * `gateway/methods/*.ts` modules that `dormant-methods-stay-dormant.test.ts`
 * pins.
 *
 * The trap here is specific to Commander. The root command declares
 * `.argument('[message]', ...)`, so an *unregistered* command does not error —
 * the token is read as a chat prompt and the process exits 0. `openrappter
 * send hello` looks like it ran; it reached the model. So "the file exists and
 * is exported" tells you nothing about whether the command is reachable, and
 * "it exited 0" tells you nothing about whether it did what it said.
 *
 * Each of the six is dormant for a measured reason, not an oversight. Verified
 * against the running gateway and the OAuth flow, not by reading:
 *
 *  - registerChannelsCommand — sends `{channel}`; `channels.connect` /
 *    `channels.disconnect` read `params.type`, so both would pass `undefined`
 *    to the registry.
 *  - registerSendCommand     — sends `{channel, message, target}`;
 *    `channels.send` reads `{channelId, conversationId, content}`, and `--all`
 *    calls `channels.broadcast`, which the gateway never registers.
 *  - registerLoginCommand    — `initiateOAuthFlow` persists nothing, yet the
 *    command prints "Credentials have been saved to your config." The shape the
 *    memory CLI had before #204 rewired it onto `MemoryAgent`, which is the
 *    store the product actually keeps; `memory` left this list then.
 *
 * This asserts the source of truth — which functions `index.ts` actually calls.
 * The neighbouring `cli-registration.test.ts` asks the built CLI which command
 * *names* it exposes; together they cover both "the module is wired" and "the
 * command is reachable". If any of the six starts being invoked here, someone
 * wired a command that lies.
 */

const CLI_INDEX = resolve(__dirname, '../../cli/index.ts');
const MAIN = resolve(__dirname, '../../index.ts');
const CLI_DIR = resolve(__dirname, '../../cli');

/**
 * The six exports `index.ts` must never invoke, each with the evidence for why.
 *
 * Listed explicitly so wiring a seventh — or removing one of these six — is a
 * deliberate edit here, not a silent one. The justifications are load-bearing:
 * a later reader deciding "just register it" needs to see the failure first.
 */
const INTENTIONALLY_DORMANT = new Map<string, string>([
  [
    'registerChannelsCommand',
    'sends {channel}; gateway channels.connect/disconnect read params.type, so both pass undefined to the channel registry',
  ],
  [
    'registerSendCommand',
    'sends {channel,message,target}; channels.send reads {channelId,conversationId,content}, and --all calls channels.broadcast which the gateway never registers',
  ],
  [
    'registerLoginCommand',
    'initiateOAuthFlow persists nothing and there is no credential store to wire it to (see the OAuth storage issue); the command now says so rather than claiming a save',
  ],
]);

/** Every `register*Command(s)` export re-exported by cli/index.ts, in order. */
function registerExports(): string[] {
  const source = readFileSync(CLI_INDEX, 'utf-8');
  const found: string[] = [];
  for (const match of source.matchAll(/export\s*\{\s*(register[A-Za-z]+)\s*\}\s*from/g)) {
    if (/Commands?$/.test(match[1])) found.push(match[1]);
  }
  return found;
}

/** index.ts with comment lines removed, so only real code is searched. */
function mainCode(): string {
  return readFileSync(MAIN, 'utf-8')
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Is `fn` actually called (not merely imported) in index.ts? */
function invokedByMain(fn: string): boolean {
  return new RegExp(`\\b${fn}\\s*\\(`).test(mainCode());
}

describe('the dormant CLI command modules stay out of the program', () => {
  it('re-exports a non-trivial set of register* commands to classify', () => {
    // Anti-vacuity for the cli/index.ts parser: if it matched nothing, every
    // assertion below would pass over an empty list. There are fifteen today.
    expect(registerExports().length).toBeGreaterThanOrEqual(12);
  });

  it('the invocation detector discriminates (control)', () => {
    // If invokedByMain always returned false, "no dormant is invoked" would
    // pass vacuously; if it always returned true, the wired check below would.
    // A wired command reads as invoked; an invented one does not.
    expect(invokedByMain('registerHubCommands')).toBe(true);
    expect(invokedByMain('registerDefinitelyNotACommand')).toBe(false);
  });

  it('index.ts invokes none of the intentionally-dormant commands', () => {
    // The heart of the file. Checked per-name, so wiring a single module
    // directly — `registerSendCommand(program)` — is caught, not only a bulk
    // loop (the lesson of #201). Each name carries its justification above.
    const wired = [...INTENTIONALLY_DORMANT.keys()].filter(invokedByMain).sort();
    expect(wired).toEqual([]);
  });

  it('index.ts invokes every command that is not on the dormant allowlist', () => {
    // The other half of "exactly the intended set is invoked": the wired set is
    // derived (exports minus the allowlist), never hardcoded, so it cannot rot
    // out of sync. If a supposedly-wired command stops being called, this fails
    // rather than silently shrinking what anyone checks.
    const missing = registerExports()
      .filter((fn) => !INTENTIONALLY_DORMANT.has(fn) && !invokedByMain(fn))
      .sort();
    expect(missing).toEqual([]);
  });

  it('every allowlisted name is still exported by cli/index.ts', () => {
    // Guards the allowlist from rotting: if a dormant module is deleted or
    // renamed, its justification here is stale and its dormancy claim becomes
    // vacuous. Fail so it is revisited rather than left passing over a ghost.
    const stray = [...INTENTIONALLY_DORMANT.keys()]
      .filter((fn) => !registerExports().includes(fn))
      .sort();
    expect(stray).toEqual([]);
  });

  it('the allowlist and the wired set partition the exports exactly', () => {
    // Per-parsing-path integrity, not a merged count: every export is either
    // dormant-by-allowlist or wired-by-invocation, never both and never
    // neither. A newly added command lands in neither and trips this.
    const exports = registerExports();
    const dormant = exports.filter((fn) => INTENTIONALLY_DORMANT.has(fn));
    const wired = exports.filter((fn) => invokedByMain(fn));
    expect(dormant.filter((fn) => wired.includes(fn))).toEqual([]);
    expect([...dormant, ...wired].sort()).toEqual([...exports].sort());
  });

  it('`channel` is served by the inline command, with no duplicate module', () => {
    // `openrappter channel` (release channels) works via an inline
    // `.command('channel')` in index.ts. A `cli/channel.ts` duplicating it was
    // deleted: having two copies means a fix can land in the unreachable one,
    // which is exactly how the macOS launch-agent bug survived. Pin both halves
    // -- the live command must stay, and the duplicate must not come back.
    expect(readFileSync(MAIN, 'utf-8')).toMatch(/\.command\('channel'\)/);
    expect(existsSync(resolve(CLI_DIR, 'channel.ts'))).toBe(false);
  });
});
