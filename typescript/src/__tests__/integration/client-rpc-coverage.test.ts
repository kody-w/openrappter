import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

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
const UI_SERVICES = join(REPO, 'ui/src/services');

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
  'agents.files.list',
  'agents.files.read',
  'agents.files.write',
  'cron.runs',
  'skills.toggle',
  'zen.sessions',
  'zen.subscribe',
  'zen.unsubscribe',
  // Live macOS Bar screens that cannot work: usage, logs, node pairing and
  // skills. Being fixed now; each entry is removed as its method lands, and the
  // last test in this file fails if one is left here after it starts existing.
  // Approvals left this list in the exec.pending/exec.respond fix: they are
  // served by the ExecSafety engine ShellAgent actually blocks on, not by the
  // unwired gateway/methods/exec-methods.ts module.
  'connections.disconnect',
  'connections.pair',
  'logs.get',
  'sessions.reset',
  'skills.install',
  'skills.list',
  'usage.history',
  'usage.stats',
]);

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Method names registered by a server with every optional service present. */
async function registeredMethods(): Promise<Set<string>> {
  const port = await reserveTestPort();
  server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
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
  walk(UI_SERVICES);
  return names;
}

describe('every RPC method a client calls exists on the gateway', () => {
  it('finds call sites in both clients', () => {
    // Guards the parsers. If a rename makes either match nothing, the
    // assertions below would pass over an empty list and prove nothing.
    expect(swiftMethods().length).toBeGreaterThan(20);
    expect(uiMethods().length).toBeGreaterThan(10);
  });

  it('the macOS Bar calls nothing the gateway lacks', async () => {
    const registered = await registeredMethods();
    const missing = [...new Set(swiftMethods())]
      .filter((m) => !registered.has(m) && !KNOWN_MISSING.has(m))
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
