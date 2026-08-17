/**
 * The macOS Bar's skills and connections calls, against the gateway that runs.
 *
 * Probed before this suite existed, against a real started `GatewayServer`:
 *
 *     total registered: 54
 *     skills.list              -> Method not found: skills.list
 *     skills.install           -> Method not found: skills.install
 *     connections.pair         -> Method not found: connections.pair
 *     connections.disconnect   -> Method not found: connections.disconnect
 *
 * `gateway/methods/skills-methods.ts` and `gateway/methods/connections-methods.ts`
 * declare some of those names, and are deliberately never registered (see the
 * doc comment on `registerBuiltInMethods`). Importing them would prove nothing
 * about production: `skills-methods.ts` hangs every handler off a
 * `skillRegistry` dependency nothing in this repo supplies, and its
 * `skills.list` answers `[]` when that dependency is missing — which is the
 * defect, not a fix for it. So every test here goes over real HTTP or a real
 * websocket to a real `GatewayServer`, driving the exact payloads
 * `macos/Sources/OpenRappterBar/Services/RpcClient.swift` builds.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { GatewayServer, type SkillsRegistryLike } from '../../gateway/server.js';
import type { InstalledSkill } from '../../skills/registry.js';
import { reserveTestPort } from '../support/test-port.js';

/** Scratch roots live under the repo, never the system temp dir. */
const SCRATCH_ROOT = join(process.cwd(), '.test-scratch');

let server: GatewayServer | undefined;
const scratchDirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try { ws.close(); } catch { /* already gone */ }
  }
  await server?.stop();
  server = undefined;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  scratchDirs.push(dir);
  return dir;
}

interface StartOptions {
  auth?: { mode: 'none' | 'token'; tokens?: string[] };
  bundledSkillsDir?: string;
  skillsRegistry?: SkillsRegistryLike;
}

async function startServer(options: StartOptions = {}): Promise<number> {
  const port = await reserveTestPort();
  const dataDir = scratch('skills-contract-');
  server = new GatewayServer({
    port,
    bind: 'loopback',
    auth: options.auth ?? { mode: 'none' },
    dataDir,
  });
  await server.start();
  if (options.bundledSkillsDir !== undefined) server.setBundledSkillsDir(options.bundledSkillsDir);
  if (options.skillsRegistry) server.setSkillsRegistry(options.skillsRegistry);
  return port;
}

interface RpcResult<T = unknown> {
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T = unknown>(
  port: number,
  method: string,
  params?: Record<string, unknown>,
  token?: string,
): Promise<RpcResult<T>> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'contract-1', method, params }),
  });
  return (await res.json()) as RpcResult<T>;
}

/** A connected, handshaken websocket — what the Bar actually holds open. */
async function connectBar(port: number, token?: string): Promise<{ ws: WebSocket; connectionId: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const reply = await wsRpc(ws, 'connect', {
    client: { id: 'openrappter-bar', version: '1.0.0', platform: 'macos', mode: 'bar' },
    ...(token ? { auth: { token } } : {}),
  });
  expect(reply.ok, `handshake failed: ${JSON.stringify(reply.error)}`).toBe(true);
  const hello = reply.payload as { server: { connId: string } };
  return { ws, connectionId: hello.server.connId };
}

/**
 * Push a frame straight into `dispatchMethod` on a connection that never
 * completed the handshake.
 *
 * The connect handshake already blocks everything pre-auth, so over a normal
 * socket a per-method `requiresAuth` flag is invisible — and an invisible
 * flag is one that can quietly become dead code. `integration/gateway.test.ts`
 * measures it this way for the same reason.
 */
async function dispatchUnauthenticated(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const internal = server as unknown as {
    connections: Map<string, { ws: WebSocket; info: { authenticated: boolean } }>;
    dispatchMethod: (
      connId: string,
      ws: WebSocket,
      info: { authenticated: boolean },
      frame: { type: 'req'; id: string; method: string; params?: Record<string, unknown> },
    ) => Promise<void>;
  };

  const deadline = Date.now() + 2000;
  while (internal.connections.size === 0) {
    if (Date.now() >= deadline) throw new Error('the server never registered the socket');
    await new Promise((r) => setTimeout(r, 5));
  }
  const [connId, conn] = Array.from(internal.connections.entries()).at(-1)!;
  expect(conn.info.authenticated, 'no handshake was sent, so this must be unauthenticated').toBe(false);

  const reply = new Promise<{ ok: boolean; payload?: unknown; error?: unknown }>((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 'direct-1') resolve(msg);
    });
  });

  await internal.dispatchMethod(connId, conn.ws, conn.info, {
    type: 'req', id: 'direct-1', method, params,
  });

  return reply;
}

function wsRpc(
  ws: WebSocket,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: { code: number; message: string } }> {
  return new Promise((resolve, reject) => {
    const id = `req_${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const onMessage = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

/** The macOS Bar's `Skill` — every field its Codable decode requires. */
interface BarSkill {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  installed: boolean;
  enabled: boolean;
  source: string;
}

/** `SkillSource` in `macos/.../Models/SkillModels.swift`. */
const BAR_SKILL_SOURCES = ['local', 'clawhub', 'builtin'];

/** A registry that installs nothing and says so the way the real one does. */
function registryThatInstallsNothing(): SkillsRegistryLike {
  return {
    initialize: async () => {},
    // `SkillsRegistry.install` catches every failure and returns null.
    install: async () => null,
    getInstalled: () => [],
  };
}

function registryThatInstalls(skill: InstalledSkill): SkillsRegistryLike {
  const installed: InstalledSkill[] = [];
  return {
    initialize: async () => {},
    install: async () => { installed.push(skill); return skill; },
    getInstalled: () => installed,
  };
}

// ── skills.list ────────────────────────────────────────────────────────

describe('skills.list, against the wired gateway', () => {
  it('is registered at all — the reproduction', async () => {
    const port = await startServer();

    const { error } = await rpc(port, 'skills.list');

    expect(error, 'skills.list answered "Method not found" before this fix').toBeUndefined();
  });

  it('returns real bundled skills, named — not merely a successful empty list', async () => {
    const port = await startServer();

    const { result } = await rpc<BarSkill[]>(port, 'skills.list');

    const names = (result ?? []).map((s) => s.name);
    // Asserting a specific shipped skill, because "the call succeeded" and
    // "the list has entries" are both satisfiable by an endpoint that has
    // lost its skills directory. #165 is the whole reason.
    expect(names).toContain('weather');
    expect(names).toContain('github');
    expect(names.length).toBeGreaterThanOrEqual(50);
  });

  it('answers in the shape `RpcClient.listSkills` decodes', async () => {
    const port = await startServer();

    const { result } = await rpc<BarSkill[]>(port, 'skills.list');
    const weather = (result ?? []).find((s) => s.name === 'weather');

    // The Bar decodes `[Skill]`, whose non-optional members are `id`,
    // `installed`, `enabled` and `source`. Omitting any of them fails the
    // decode for the WHOLE array, which the pane renders as "No skills
    // installed" — a full list and an empty one look identical to the user.
    expect(weather).toBeDefined();
    expect(typeof weather!.id).toBe('string');
    expect(weather!.id.length).toBeGreaterThan(0);
    expect(typeof weather!.installed).toBe('boolean');
    expect(typeof weather!.enabled).toBe('boolean');
    expect(BAR_SKILL_SOURCES).toContain(weather!.source);

    for (const skill of result ?? []) {
      expect(BAR_SKILL_SOURCES, `source "${skill.source}" is outside the Bar's enum`)
        .toContain(skill.source);
      expect(typeof skill.id, `skill ${skill.name} has no id`).toBe('string');
    }
  });

  it('refuses rather than reporting a missing skills directory as an empty list', async () => {
    const port = await startServer({ bundledSkillsDir: join(scratch('no-skills-'), 'absent') });

    const { result, error } = await rpc<BarSkill[]>(port, 'skills.list');

    // The two causes of "zero skills" must not answer identically: an install
    // that shipped without `skills/` is a fault, and `[]` would hide it.
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/shipped without skills/i);
  });

  it('an empty but present skills directory is an empty list, not an error', async () => {
    const port = await startServer({ bundledSkillsDir: scratch('empty-skills-') });

    const { result, error } = await rpc<BarSkill[]>(port, 'skills.list');

    expect(error).toBeUndefined();
    expect(result).toEqual([]);
  });

  it('includes skills the registry actually installed', async () => {
    const registry = registryThatInstalls({
      manifest: {
        id: 'kody-w/rappterverse',
        name: 'rappterverse',
        version: '2.1.0',
        description: 'a real installed skill',
        author: 'kody-w',
      },
      path: '/somewhere/kody-w--rappterverse',
      installedAt: new Date().toISOString(),
      enabled: true,
    });
    const port = await startServer({ skillsRegistry: registry });

    await rpc(port, 'skills.install', { name: 'kody-w/rappterverse' });
    const { result } = await rpc<BarSkill[]>(port, 'skills.list');

    const installed = (result ?? []).find((s) => s.id === 'kody-w/rappterverse');
    expect(installed).toBeDefined();
    expect(installed!.version).toBe('2.1.0');
    expect(installed!.source).toBe('clawhub');
  });
});

// ── skills.install ─────────────────────────────────────────────────────

describe('skills.install, against the wired gateway', () => {
  it('is registered at all — the reproduction', async () => {
    const port = await startServer({ skillsRegistry: registryThatInstallsNothing() });

    const { error } = await rpc(port, 'skills.install', { name: 'kody-w/rappterverse' });

    expect(error?.message ?? '').not.toMatch(/Method not found/);
  });

  it('does not report success when the registry installed nothing', async () => {
    const port = await startServer({ skillsRegistry: registryThatInstallsNothing() });

    // Exactly the params `RpcClient.installSkill(name:)` builds.
    const { result, error } = await rpc(port, 'skills.install', { name: 'kody-w/rappterverse' });

    // #176 found `skills install` printing "Successfully installed" over a
    // stub that wrote nothing. The real registry swallows every failure and
    // returns null; turning that into `{installed: true}` would rebuild the
    // same lie on top of real code.
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/nothing was written/i);
  });

  it('reports what was actually installed when the registry installs', async () => {
    const port = await startServer({
      skillsRegistry: registryThatInstalls({
        manifest: { id: 'kody-w/rappterverse', name: 'rappterverse', version: '2.1.0', description: 'real' },
        path: '/somewhere/kody-w--rappterverse',
        installedAt: '2026-01-01T00:00:00.000Z',
        enabled: true,
      }),
    });

    const { result, error } = await rpc<{ installed: boolean; version: string; name: string }>(
      port, 'skills.install', { name: 'kody-w/rappterverse' },
    );

    expect(error).toBeUndefined();
    expect(result?.installed).toBe(true);
    expect(result?.name).toBe('rappterverse');
    expect(result?.version).toBe('2.1.0');
  });

  it('says what is wrong with a bare skill name instead of failing vaguely', async () => {
    const port = await startServer({ skillsRegistry: registryThatInstallsNothing() });

    const { error } = await rpc(port, 'skills.install', { name: 'weather' });

    expect(error?.message).toMatch(/owner\/repo/);
  });

  it('requires the credential, and does not run the install without it', async () => {
    let installCalls = 0;
    const registry: SkillsRegistryLike = {
      initialize: async () => {},
      install: async () => { installCalls++; return null; },
      getInstalled: () => [],
    };
    const port = await startServer({ auth: { mode: 'token', tokens: ['bar-secret'] }, skillsRegistry: registry });

    const denied = await dispatchUnauthenticated(port, 'skills.install', { name: 'kody-w/rappterverse' });

    // It fetches a third-party manifest off the network and writes it where
    // the agent will load it. #171's reasoning for `/agents/import` applies
    // unchanged: code entering the execution surface needs the credential.
    //
    // Dispatched straight at an unauthenticated connection, past the connect
    // handshake, so what is measured is the per-method `requiresAuth` gate
    // itself and not the handshake that happens to sit in front of it — the
    // same technique `integration/gateway.test.ts` uses for `requiresAuth`.
    expect(denied.ok).toBe(false);
    expect((denied.error as { message: string }).message).toMatch(/requires authentication/i);
    expect(installCalls, 'the handler must not run for an unauthenticated caller').toBe(0);
  });

  it('installs for a caller that presents the credential', async () => {
    let installCalls = 0;
    const registry: SkillsRegistryLike = {
      initialize: async () => {},
      install: async () => { installCalls++; return null; },
      getInstalled: () => [],
    };
    const port = await startServer({ auth: { mode: 'token', tokens: ['bar-secret'] }, skillsRegistry: registry });

    const allowed = await rpc(port, 'skills.install', { name: 'kody-w/rappterverse' }, 'bar-secret');

    expect(allowed.error?.message ?? '').not.toMatch(/requires authentication/i);
    expect(installCalls).toBe(1);
  });

  it('skills.list is not gated behind the credential', async () => {
    const port = await startServer({ auth: { mode: 'token', tokens: ['bar-secret'] } });

    const listed = await dispatchUnauthenticated(port, 'skills.list');

    // Reading what ships with the product is not a privileged operation.
    // (HTTP is fail-closed for every method once credentials are configured;
    // this measures the per-method flag, which is what separates the two.)
    expect((listed.error as { message?: string } | undefined)?.message ?? '')
      .not.toMatch(/requires authentication/i);
  });
});

// ── connections.list / connections.disconnect ──────────────────────────

describe('connections.disconnect, against the wired gateway', () => {
  it('is registered at all — the reproduction', async () => {
    const port = await startServer();

    const { error } = await rpc(port, 'connections.disconnect', { connectionId: 'conn_nope' });

    expect(error?.message ?? '').not.toMatch(/Method not found/);
  });

  it('closes the live connection it names', async () => {
    const port = await startServer();
    const bar = await connectBar(port);
    const victim = await connectBar(port);

    const listed = await wsRpc(bar.ws, 'connections.list');
    const ids = (listed.payload as Array<{ connectionId: string }>).map((c) => c.connectionId);
    expect(ids).toContain(victim.connectionId);

    const closed = new Promise<void>((resolve) => victim.ws.once('close', () => resolve()));
    const result = await wsRpc(bar.ws, 'connections.disconnect', { connectionId: victim.connectionId });

    expect(result.ok, `disconnect failed: ${JSON.stringify(result.error)}`).toBe(true);
    await closed;

    const after = await wsRpc(bar.ws, 'connections.list');
    const remaining = (after.payload as Array<{ connectionId: string }>).map((c) => c.connectionId);
    expect(remaining).not.toContain(victim.connectionId);
  });

  it('does not claim to have disconnected a connection that is not there', async () => {
    const port = await startServer();

    const { result, error } = await rpc(port, 'connections.disconnect', { connectionId: 'conn_absent' });

    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/No connection/);
  });

  it('requires the credential', async () => {
    const port = await startServer({ auth: { mode: 'token', tokens: ['bar-secret'] } });

    const denied = await dispatchUnauthenticated(port, 'connections.disconnect', { connectionId: 'conn_absent' });

    // It terminates other clients' sessions, so it is gated like every other
    // mutating method here.
    expect(denied.ok).toBe(false);
    expect((denied.error as { message: string }).message).toMatch(/requires authentication/i);
  });
});

describe('connections.list, in the shape the Bar decodes', () => {
  it('carries the fields `Node` requires, so a row can be disconnected', async () => {
    const port = await startServer();
    const bar = await connectBar(port);

    const listed = await wsRpc(bar.ws, 'connections.list');
    const rows = listed.payload as Array<Record<string, unknown>>;
    const self = rows.find((r) => r.connectionId === bar.connectionId);

    // `Node` has non-optional `id`, `name`, `host`, `port`, `status`. Without
    // them `RpcClient.listNodes` fails to decode the array, the Nodes pane is
    // empty, and `disconnectNode` — which takes its id from a row here — can
    // never be reached from the UI at all.
    expect(self).toBeDefined();
    expect(typeof self!.id).toBe('string');
    expect(typeof self!.name).toBe('string');
    expect(typeof self!.host).toBe('string');
    expect(typeof self!.port).toBe('number');
    expect(['online', 'offline', 'busy', 'error']).toContain(self!.status);
    expect(self!.connectionId).toBe(bar.connectionId);
  });

  it('reports the peer address the socket actually had', async () => {
    const port = await startServer();
    const bar = await connectBar(port);

    const listed = await wsRpc(bar.ws, 'connections.list');
    const rows = listed.payload as Array<Record<string, unknown>>;
    const self = rows.find((r) => r.connectionId === bar.connectionId)!;

    // A loopback client really is on loopback; this is measured, not filled in.
    expect(String(self.host)).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    expect(Number(self.port)).toBeGreaterThan(0);
  });
});

// ── connections.pair ───────────────────────────────────────────────────

describe('connections.pair is deliberately not registered', () => {
  it('pairing an unreachable peer does not report success', async () => {
    const port = await startServer();
    // A port nothing is listening on — reserved and never bound.
    const deadPort = await reserveTestPort();

    const { result, error } = await rpc(port, 'connections.pair', {
      host: '127.0.0.1',
      port: deadPort,
    });

    // `RpcClient.pairNode` treats any non-`ok` reply as a thrown error, which
    // the Bar surfaces as "Pair failed: …". That is the correct outcome:
    // there is no registry of remote peers to record a pairing in, and
    // `connections.list` reports INBOUND sockets, so `{paired: true}` would
    // be followed by an empty list — success, then nothing. See the comment
    // where `connections.pair` is NOT registered in gateway/server.ts.
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });

  it('pairing a peer that IS reachable does not report success either', async () => {
    const port = await startServer();

    // This gateway pairing with itself: as reachable as a peer can be.
    const { result, error } = await rpc(port, 'connections.pair', { host: '127.0.0.1', port });

    // Reachability is not the reason it refuses. Nothing here can record a
    // peer, so there is no pairing to report — and a truthful refusal beats a
    // record that nothing can vouch for (#132).
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });

  it('no registered method claims to pair a node', async () => {
    const port = await startServer();

    const { result } = await rpc<string[]>(port, 'methods');

    expect(result).not.toContain('connections.pair');
    expect(result).not.toContain('nodes.pair');
    // The guard that keeps this from passing vacuously: the probe works.
    expect(result).toContain('connections.list');
    expect(result).toContain('connections.disconnect');
  });
});
