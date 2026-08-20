import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { GatewayServer } from '../../gateway/server.js';

/**
 * Every RPC method a client calls must exist on the gateway.
 *
 * Ten did not. The macOS Bar's approval, usage, logs, node-pairing and skills
 * screens all called methods the production gateway never registered, and each
 * one failed only at runtime, in the UI, with `Method not found`. They were
 * found one at a time — `config.set` in #170, `cron.update` in #180 — because
 * nothing compared the two sides.
 *
 * The trap this file exists to avoid: `typescript/src/gateway/methods/*.ts`
 * declares many of these names, so grepping the source makes them look present.
 * Only 5 of those 25 modules are ever invoked (see the doc comment on
 * `registerBuiltInMethods`). So this asks a *running* server what it registers
 * rather than reading any source.
 */

const REPO = resolve(__dirname, '../../..');
const SWIFT_RPC = join(REPO, '../macos/Sources/OpenRappterBar/Services/RpcClient.swift');
/**
 * Both halves of the web UI call the gateway directly.
 *
 * This scan used to cover `ui/src/services` alone, which is how
 * `ui/src/components/zen.ts` — a live `<openrappter-zen>` element rendered by
 * the app shell — called three methods nobody had registered without this file
 * noticing: its entries were listed below by hand, not found. Components make
 * `gateway.call(...)` as freely as services do, so both are walked.
 */
const UI_SOURCES = [join(REPO, 'ui/src/services'), join(REPO, 'ui/src/components')];
/**
 * The CLI is a client too.
 *
 * It was missed for the same reason `ui/src/components` was: this file grew
 * from the two clients I happened to be looking at. `src/cli/` talks to the
 * gateway over the same JSON-RPC wire as the Bar and the dashboard.
 */
const CLI_SOURCE = join(REPO, 'src/cli');

/**
 * Not RPC methods.
 *
 * `connect` is the WebSocket handshake, handled before method dispatch — a
 * connection that has not sent it is refused with "Handshake required" — so it
 * never appears in the method registry. Listing it as missing would claim a
 * break that does not exist.
 */
const PROTOCOL_PRIMITIVES = new Set(['connect', 'subscribe', 'unsubscribe']);

/**
 * Methods a client calls that the gateway still does not register.
 *
 * This list is debt, not permission. It may only shrink. Adding to it means
 * shipping a client call that cannot work, which is the bug this file guards.
 */
const KNOWN_MISSING = new Set<string>([
  // Dead client wrappers: defined in RpcClient.swift, invoked by nothing.
  // Tracked in #172 (config.patch) — delete or implement, but they mislead.
  'agents.execute',
  'agents.info',
  'config.patch',
  'connections.info',
  'models.list',
  // Live UI call sites still unimplemented.
  //
  // `skills.toggle` stays deliberately unimplemented, and this is the reason:
  // nothing in this runtime consumes a skill's enabled state. Bundled skills
  // never become agents (`ClawHubClient.loadAllSkills()` returns `[]`), no
  // prompt path reads them, and the `enabled` flag `skills.list` reports is
  // computed *eligibility* — whether the skill's required binaries and env vars
  // are present — which is a fact about the machine, not a setting a switch can
  // change. That listing does not even carry an `id`, so the UI sends
  // `{ id: undefined }`. A handler that persisted a flag would return success,
  // flip the toggle in the UI, change nothing about what the assistant can do,
  // and revert on the next refresh: exactly the stub-reporting-success shape
  // #176 found in `skills install`. Implementing it needs skills to mean
  // something at runtime first.
  'skills.toggle',
  // Live macOS Bar screens that cannot work: node pairing and skills.
  // Being fixed now; each entry is removed as its method lands, and the last
  // test in this file fails if one is left here after it starts existing.
  // Approvals left this list in the exec.pending/exec.respond fix: they are
  // served by the ExecSafety engine ShellAgent actually blocks on, not by the
  // unwired gateway/methods/exec-methods.ts module. Logs and session reset
  // left in #183, wired to the daemon's launchd log files and the live
  // sessionStore. Usage left the same way — usage.stats/usage.history read
  // the Flight Recorder's recorded provider token counts, not the unwired
  // usage-methods.ts module, whose tracker nothing constructs and which
  // answers a hardcoded zero. Skills left it in the skills.list/skills.install
  // fix, and connections.disconnect with them.
  //
  // `connections.pair` stays, and not because nobody got to it. There is no
  // registry of remote peers for a pairing to be recorded in: `infra/roster.ts`
  // holds loopback instances that each publish their *own* endpoint, and
  // writing someone else's entry there is the forgery #132 ruled out
  // ("a record nothing can vouch for is not an address"). `connections.list`
  // reports inbound sockets, so a paired peer could never appear in it — the
  // Bar would get `{paired:true}` and then an empty list. Registering it would
  // buy a green line here at the cost of a screen that lies. See the block
  // comment beside the `connections.*` registrations in gateway/server.ts.
  'connections.pair',
  // Called from CLI modules that #176 deliberately left unregistered, having
  // found them backed by nothing real. Unreachable today, so not a live break
  // — but whoever registers `sessions` or `channels` inherits these.
  'channels.broadcast',
  'sessions.delete',
  'sessions.get',
  'sessions.list',
]);

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Method names registered by a server with every optional service present. */
async function registeredMethods(): Promise<Set<string>> {
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  // surgeon.* and rappter.* register only when their service is set, and only
  // inside start(). A bare server reports them missing and would send someone
  // chasing methods that are fine.
  server.setSurgeonService({} as never);
  server.setRappterManager({} as never);
  await server.start();
  return new Set(
    (server as unknown as { methods: Map<string, unknown> }).methods.keys(),
  );
}

function swiftMethods(): string[] {
  const source = readFileSync(SWIFT_RPC, 'utf-8');
  return [...source.matchAll(/method:\s*"([a-z][a-zA-Z.]+)"/g)].map((m) => m[1]);
}

function uiMethods(): string[] {
  const names: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const source = readFileSync(full, 'utf-8');
      for (const m of source.matchAll(/\.call(?:<[^>]*>)?\(\s*'([a-z][a-zA-Z.]+)'/g)) {
        names.push(m[1]);
      }
    }
  };
  for (const dir of UI_SOURCES) walk(dir);
  return names;
}

/** Method names the CLI sends over the wire. */
function cliMethods(): string[] {
  const names: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
      const source = readFileSync(full, 'utf-8');
      for (const m of source.matchAll(/\.(?:call|request)\(\s*'([a-z][a-zA-Z.]+)'/g)) {
        names.push(m[1]);
      }
      for (const m of source.matchAll(/method:\s*'([a-z][a-zA-Z.]+)'/g)) {
        names.push(m[1]);
      }
    }
  };
  walk(CLI_SOURCE);
  return names;
}

describe('every RPC method a client calls exists on the gateway', () => {
  it('finds call sites in both clients', () => {
    // Guards the parsers. If a rename makes either match nothing, the
    // assertions below would pass over an empty list and prove nothing.
    // Asserted per source. A combined count hides one parser breaking because
    // the others keep the total up — the trap this file fell into twice.
    expect(swiftMethods().length).toBeGreaterThan(20);
    expect(uiMethods().length).toBeGreaterThan(10);
    expect(cliMethods().length).toBeGreaterThan(5);
  });

  it('the macOS Bar calls nothing the gateway lacks', async () => {
    const registered = await registeredMethods();
    const missing = [...new Set(swiftMethods())]
      .filter((m) => !registered.has(m) && !KNOWN_MISSING.has(m))
      .sort();
    expect(missing).toEqual([]);
  });

  it('the CLI calls nothing the gateway lacks', async () => {
    const registered = await registeredMethods();
    const missing = [...new Set(cliMethods())]
      .filter((m) => !registered.has(m) && !KNOWN_MISSING.has(m) && !PROTOCOL_PRIMITIVES.has(m))
      .sort();
    expect(missing).toEqual([]);
  });

  it('the web UI calls nothing the gateway lacks', async () => {
    const registered = await registeredMethods();
    const missing = [...new Set(uiMethods())]
      .filter((m) => !registered.has(m) && !KNOWN_MISSING.has(m))
      .sort();
    expect(missing).toEqual([]);
  });

  it('the known-missing list contains nothing that now exists', async () => {
    // Makes the debt list self-cleaning: once a method is implemented, this
    // fails until it is removed from KNOWN_MISSING, so the list cannot rot
    // into a permanent excuse.
    const registered = await registeredMethods();
    const stale = [...KNOWN_MISSING].filter((m) => registered.has(m)).sort();
    expect(stale).toEqual([]);
  });
});
