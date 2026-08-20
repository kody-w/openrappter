/**
 * The agent file browser, against the gateway that actually runs.
 *
 * Reproduced first, on a started `GatewayServer` over HTTP:
 *
 *   agents.files.list  -> {"code":-32601,"message":"Method not found: agents.files.list"}
 *   agents.files.read  -> {"code":-32601,"message":"Method not found: agents.files.read"}
 *   agents.files.write -> {"code":-32601,"message":"Method not found: agents.files.write"}
 *
 * `typescript/src/gateway/methods/agents-methods.ts` declares all three, which
 * is what makes grepping the source misleading — that module is never
 * registered, and had it been, it forwarded to `agentRegistry.readAgentFile` /
 * `writeAgentFile`, which no registry in this repo implements, with no path
 * validation and no auth requirement.
 *
 * These tests go over real HTTP for the reason #170 exists: a test that called
 * the method module directly would have passed against a gateway where the
 * feature did not exist at all.
 *
 * The traversal cases are the point of the file. `agents.files.write` puts
 * bytes into the directory `AgentRegistry` loads `*.py` and `*_agent.js` from
 * and executes, so an escapable path here is remote code execution, not a
 * mis-rendered file tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayServer } from '../server.js';
import { userAgentsDir } from '../../agents/agent-import.js';

let server: GatewayServer | undefined;
const temps: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = undefined;
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

interface Fixture {
  port: number;
  /** The agents tree the gateway is allowed to see. */
  agentsRoot: string;
  /** A directory OUTSIDE the tree, holding a secret nothing may reach. */
  outside: string;
  secretPath: string;
}

/**
 * A gateway with a real agents tree:
 *
 *   <root>/hello_agent.py          flat, single-file agent
 *   <root>/Swarm/main_agent.py     an agent with a folder of its own
 *   <root>/Swarm/notes.md
 *   <root>/disabled_agents/off_agent.py   deliberately switched off
 *   <root>/escape -> <outside>            a symlink out of the tree
 *   <outside>/secret.txt
 */
async function boot(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'agent-files-rpc-'));
  temps.push(base);
  const dataDir = join(base, 'data');
  const agentsRoot = join(dataDir, 'agents');
  const outside = join(base, 'outside');
  mkdirSync(join(agentsRoot, 'Swarm'), { recursive: true });
  mkdirSync(join(agentsRoot, 'disabled_agents'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(agentsRoot, 'hello_agent.py'), 'print("hello")\n');
  writeFileSync(join(agentsRoot, 'Swarm', 'main_agent.py'), 'print("swarm")\n');
  writeFileSync(join(agentsRoot, 'Swarm', 'notes.md'), '# notes\n');
  writeFileSync(join(agentsRoot, 'disabled_agents', 'off_agent.py'), 'print("off")\n');
  const secretPath = join(outside, 'secret.txt');
  writeFileSync(secretPath, 'TOP SECRET\n');
  symlinkSync(outside, join(agentsRoot, 'escape'), 'dir');

  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();
  const port = server.port;
  return { port, agentsRoot, outside, secretPath };
}

async function rpc(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'a1', method, params }),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

describe('agents.files.* exist on the running gateway', () => {
  it('answers all three instead of "Method not found"', async () => {
    const { port } = await boot();
    for (const [method, params] of [
      ['agents.files.list', { agentId: 'Swarm' }],
      ['agents.files.read', { agentId: 'Swarm', path: 'notes.md' }],
      ['agents.files.write', { agentId: 'Swarm', path: 'notes.md', content: '# edited\n' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { error } = await rpc(port, method, params);
      expect(error?.code, `${method} must exist`).not.toBe(-32601);
    }
  });
});

describe('the shapes the dashboard destructures', () => {
  it('agents.files.list returns { files } with the entry fields the UI reads', async () => {
    const { port } = await boot();
    const { result } = await rpc(port, 'agents.files.list', { agentId: 'Swarm' });

    // ui/src/components/agents.ts: `result?.files ?? ...`, then name/path/size/modified.
    const files = result?.files as Array<Record<string, unknown>>;
    expect(Array.isArray(files)).toBe(true);
    expect(files.map((f) => f.path).sort()).toEqual(['main_agent.py', 'notes.md']);
    const entry = files.find((f) => f.path === 'notes.md')!;
    expect(entry.name).toBe('notes.md');
    expect(typeof entry.size).toBe('number');
    expect(typeof entry.modified).toBe('string');
  });

  it('agents.files.read returns { content }', async () => {
    const { port } = await boot();
    const { result } = await rpc(port, 'agents.files.read', { agentId: 'Swarm', path: 'notes.md' });
    // The UI does `typeof result === 'string' ? result : result?.content ?? ''`.
    expect(result?.content).toBe('# notes\n');
  });

  it('agents.files.write really changes the bytes on disk', async () => {
    const { port, agentsRoot } = await boot();
    const { result, error } = await rpc(port, 'agents.files.write', {
      agentId: 'Swarm',
      path: 'main_agent.py',
      content: 'print("edited")\n',
    });

    expect(error).toBeUndefined();
    expect(result?.written).toBe(true);
    // Writing always "succeeds" — only the file proves it.
    expect(readFileSync(join(agentsRoot, 'Swarm', 'main_agent.py'), 'utf-8')).toBe('print("edited")\n');
  });

  it('an agent without a folder of its own browses the agents tree it loads from', async () => {
    const { port } = await boot();
    const { result } = await rpc(port, 'agents.files.list', { agentId: 'Hello' });
    const paths = (result?.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain('hello_agent.py');
    expect(paths).toContain('Swarm/main_agent.py');
  });
});

describe('path traversal is impossible', () => {
  it('rejects ../ escapes on read and write', async () => {
    const { port, outside, secretPath } = await boot();

    for (const path_ of ['../../secret.txt', '../outside/secret.txt', 'Swarm/../../../outside/secret.txt']) {
      const read = await rpc(port, 'agents.files.read', { agentId: 'Swarm', path: path_ });
      expect(read.result, `read ${path_}`).toBeUndefined();
      expect(read.error?.message).toMatch(/escapes the agent directory/);

      const write = await rpc(port, 'agents.files.write', {
        agentId: 'Swarm',
        path: path_,
        content: 'PWNED',
      });
      expect(write.result, `write ${path_}`).toBeUndefined();
    }

    expect(readFileSync(secretPath, 'utf-8')).toBe('TOP SECRET\n');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).not.toContain('PWNED');
  });

  it('rejects ".." even when it lands back inside the tree', async () => {
    // `Swarm/../Swarm/notes.md` resolves to a legal file, so containment alone
    // would allow it. It is refused anyway: a path containing `..` is never
    // what the file tab sent, and normalising one away is how the next
    // traversal bug gets in through a case the resolver happens to smooth over
    // (`missing_dir/../secret` normalises before anything is resolved).
    const { port } = await boot();
    const { result, error } = await rpc(port, 'agents.files.read', {
      agentId: 'Swarm',
      path: 'Swarm/../Swarm/notes.md',
    });
    expect(result?.content).toBeUndefined();
    expect(error?.message).toMatch(/escapes the agent directory/);
  });

  it('rejects absolute paths', async () => {
    const { port, secretPath } = await boot();

    const read = await rpc(port, 'agents.files.read', { agentId: 'Swarm', path: secretPath });
    expect(read.result).toBeUndefined();
    expect(read.error?.message).toMatch(/must be relative/);

    const write = await rpc(port, 'agents.files.write', {
      agentId: 'Swarm',
      path: secretPath,
      content: 'PWNED',
    });
    expect(write.result).toBeUndefined();
    expect(readFileSync(secretPath, 'utf-8')).toBe('TOP SECRET\n');
  });

  it('rejects a symlink that leaves the tree, even though every segment is legal', async () => {
    // `escape` is a real directory entry inside the root and `secret.txt` is a
    // real file: nothing about the string is suspicious. Only resolving it
    // reveals that it lands outside, which is why containment is checked after
    // resolution rather than on the raw path.
    const { port, secretPath } = await boot();

    const read = await rpc(port, 'agents.files.read', { agentId: 'Hello', path: 'escape/secret.txt' });
    expect(read.result?.content, 'must not leak a file outside the agents tree').toBeUndefined();
    expect(read.error?.message).toMatch(/escapes the agent directory/);

    const write = await rpc(port, 'agents.files.write', {
      agentId: 'Hello',
      path: 'escape/secret.txt',
      content: 'PWNED',
    });
    expect(write.result).toBeUndefined();
    expect(readFileSync(secretPath, 'utf-8')).toBe('TOP SECRET\n');
  });

  it('an agentId cannot be used to climb out either', async () => {
    const { port } = await boot();
    for (const agentId of ['..', '../outside', '/etc', 'a/../..']) {
      const { result, error } = await rpc(port, 'agents.files.list', { agentId });
      expect(result?.files, `agentId ${agentId}`).toBeUndefined();
      expect(error?.message).toMatch(/Invalid agentId|is required/);
    }
  });

  it('does not follow a symlinked directory when listing', async () => {
    const { port } = await boot();
    const { result } = await rpc(port, 'agents.files.list', { agentId: 'Hello' });
    const paths = (result?.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths.some((p) => p.includes('escape'))).toBe(false);
    expect(paths.some((p) => p.includes('secret'))).toBe(false);
  });
});

describe('reserved agent directories stay reserved', () => {
  it('never lists a disabled agent', async () => {
    const { port } = await boot();
    const { result } = await rpc(port, 'agents.files.list', { agentId: 'Hello' });
    const paths = (result?.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths.some((p) => p.includes('disabled_agents'))).toBe(false);
  });

  it('refuses to read or write inside disabled_agents/', async () => {
    const { port, agentsRoot } = await boot();
    const target = join(agentsRoot, 'disabled_agents', 'off_agent.py');

    const read = await rpc(port, 'agents.files.read', {
      agentId: 'Hello',
      path: 'disabled_agents/off_agent.py',
    });
    expect(read.result).toBeUndefined();
    expect(read.error?.message).toMatch(/reserved/);

    // A directory that does not disable anything means an agent someone
    // deliberately switched off keeps running.
    const write = await rpc(port, 'agents.files.write', {
      agentId: 'Hello',
      path: 'disabled_agents/off_agent.py',
      content: 'print("resurrected")\n',
    });
    expect(write.result).toBeUndefined();
    expect(readFileSync(target, 'utf-8')).toBe('print("off")\n');
  });

  it('refuses a reserved directory as an agentId', async () => {
    const { port } = await boot();
    for (const agentId of ['disabled_agents', 'experimental_agents']) {
      const { result, error } = await rpc(port, 'agents.files.list', { agentId });
      expect(result?.files).toBeUndefined();
      expect(error?.message).toMatch(/reserved/);
    }
  });
});

describe('write edits, it does not plant', () => {
  it('refuses to create a new file the loader would execute', async () => {
    const { port, agentsRoot } = await boot();
    const { result, error } = await rpc(port, 'agents.files.write', {
      agentId: 'Swarm',
      path: 'evil_agent.py',
      content: 'import os; os.system("id")\n',
    });

    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/No such agent file/);
    expect(() => readFileSync(join(agentsRoot, 'Swarm', 'evil_agent.py'))).toThrow();
  });

  it('refuses to write through a symlinked file', async () => {
    const { port, agentsRoot, secretPath } = await boot();
    symlinkSync(secretPath, join(agentsRoot, 'Swarm', 'link.txt'));

    const { result } = await rpc(port, 'agents.files.write', {
      agentId: 'Swarm',
      path: 'link.txt',
      content: 'PWNED',
    });

    expect(result).toBeUndefined();
    expect(readFileSync(secretPath, 'utf-8')).toBe('TOP SECRET\n');
  });
});

describe('the browser points at the tree that actually runs', () => {
  it('defaults to the directory AgentRegistry hot-loads from', async () => {
    // Editing files the loader never reads would be the quiet version of this
    // bug: a tab that saves happily and changes nothing the assistant can do.
    // `AgentRegistry`'s default user dir and `/agents/import`'s target are both
    // `~/.openrappter/agents`; the gateway's default data dir is
    // `~/.openrappter`, so the browser lands on the same tree.
    const bare = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
    const root = (bare as unknown as { agentFilesRoot: string }).agentFilesRoot;
    expect(root).toBe(userAgentsDir());
  });

  it('a gateway given its own data dir can never reach the real user tree', async () => {
    const { agentsRoot } = await boot();
    const root = (server as unknown as { agentFilesRoot: string }).agentFilesRoot;
    expect(root).toBe(agentsRoot);
    expect(root).not.toBe(userAgentsDir());
  });
});

describe('bad input is refused, not half-applied', () => {
  it('rejects a write with no content instead of blanking the file', async () => {
    const { port, agentsRoot } = await boot();
    const { result, error } = await rpc(port, 'agents.files.write', {
      agentId: 'Swarm',
      path: 'notes.md',
    });
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/content must be a string/);
    expect(readFileSync(join(agentsRoot, 'Swarm', 'notes.md'), 'utf-8')).toBe('# notes\n');
  });

  it('rejects a missing or empty agentId and path', async () => {
    const { port } = await boot();
    expect((await rpc(port, 'agents.files.list', {})).error?.message).toMatch(/agentId is required/);
    expect((await rpc(port, 'agents.files.read', { agentId: 'Swarm' })).error?.message)
      .toMatch(/path is required/);
    expect((await rpc(port, 'agents.files.read', { agentId: 'Swarm', path: '   ' })).error?.message)
      .toMatch(/path is required/);
  });

  it('reports a missing file rather than inventing empty content', async () => {
    const { port } = await boot();
    const { result, error } = await rpc(port, 'agents.files.read', {
      agentId: 'Swarm',
      path: 'nope.md',
    });
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/No such agent file/);
  });
});

describe('mutating and content-bearing calls require the credential', () => {
  /** Same policy as `/agents/import` (#171): these bytes get executed. */
  async function bootWithToken(): Promise<{ port: number; agentsRoot: string }> {
    const base = mkdtempSync(join(tmpdir(), 'agent-files-auth-'));
    temps.push(base);
    const dataDir = join(base, 'data');
    const agentsRoot = join(dataDir, 'agents');
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(join(agentsRoot, 'hello_agent.py'), 'print("hello")\n');

    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'token', tokens: ['s3cret'] },
      dataDir,
    });
    await server.start();
    const port = server.port;
    return { port, agentsRoot };
  }

  it('agents.files.write and read are registered with requiresAuth', async () => {
    const { port } = await boot();
    const methods = (server as unknown as {
      methods: Map<string, { requiresAuth: boolean }>;
    }).methods;
    expect(methods.get('agents.files.write')!.requiresAuth).toBe(true);
    expect(methods.get('agents.files.read')!.requiresAuth).toBe(true);
    // Names, sizes and mtimes for agents `agents.list` already names.
    expect(methods.get('agents.files.list')!.requiresAuth).toBe(false);
    expect(port).toBeGreaterThan(0);
  });

  it('rejects an unauthenticated write and leaves the file alone', async () => {
    const { port, agentsRoot } = await bootWithToken();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        method: 'agents.files.write',
        params: { agentId: 'Hello', path: 'hello_agent.py', content: 'print("pwned")\n' },
      }),
    });

    expect(res.status).toBe(401);
    expect(readFileSync(join(agentsRoot, 'hello_agent.py'), 'utf-8')).toBe('print("hello")\n');
  });

  it('accepts the same write with the credential', async () => {
    const { port, agentsRoot } = await bootWithToken();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        method: 'agents.files.write',
        params: { agentId: 'Hello', path: 'hello_agent.py', content: 'print("edited")\n' },
      }),
    });

    const body = (await res.json()) as { result?: { written?: boolean }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.written).toBe(true);
    expect(readFileSync(join(agentsRoot, 'hello_agent.py'), 'utf-8')).toBe('print("edited")\n');
  });
});
