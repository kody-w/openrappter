import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFrame, canonicalJson, createFrameSigner, frameHead, isVerifiedChain, keyedIdentity, selectSignaturePolicy,
  type RappFrame, type SignaturePolicy,
} from '@rapp-work/rapp1';
import { SecurityAuthority, type Capability, type Permission } from '@rapp-work/security';
import {
  artifactPath, isWorkspaceSnapshot, WorkspaceStore, type CrashPoint, type FaultInjector,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UTC = '2026-09-11T12:00:00.000Z';
const scratch: string[] = [];
const allPermissions: Permission[] = ['workspace.create', 'workspace.read', 'workspace.append', 'artifact.read', 'artifact.write'];
afterEach(async () => {
  for (const root of scratch.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup(options: { fault?: FaultInjector; lockTimeoutMs?: number; signatures?: SignaturePolicy } = {}) {
  const base = resolve(HERE, '../.test-scratch', randomUUID());
  scratch.push(base);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const root = resolve(base, 'store');
  const security = new SecurityAuthority({
    authenticate: (credential) => credential === 'alice' || credential === 'bob'
      ? { id: credential, kind: 'human', expiresAt: Date.now() + 120_000 } : null,
    authorize: (principal, request) => (principal.id === 'alice' && request.agentId === 'agent-a' && request.workspaceId === 'workspace-a')
      || (principal.id === 'bob' && request.agentId === 'agent-b' && request.workspaceId === 'workspace-b'),
    executionPolicy: () => ({ allowed: false, requiresApproval: true }),
  });
  const principal = await security.authenticate('alice');
  const capability = await security.authorize(principal, {
    agentId: 'agent-a', workspaceId: 'workspace-a', taskId: null, permissions: allPermissions,
    resources: ['workspace:workspace-a'], expiresAt: Date.now() + 60_000,
  });
  const store = await WorkspaceStore.open({ root, security, ...options });
  const workspace = await store.create(capability, { owner: 'alice', slug: 'worker' });
  return { base, root, security, principal, capability, store, workspace, path: resolve(root, 'workspace-a') };
}
function memoryFrame(id: string, head: ReturnType<typeof frameHead> | null, data: object): RappFrame {
  return buildFrame({ kind: 'memory.save', streamId: id, head, utc: UTC, payload: data as never });
}
function child(root: string, mode: string, label = 'child') {
  const process = fork(resolve(HERE, 'worker.mjs'), [root, mode, label], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = '';
  process.stderr!.on('data', (value) => { errors += value.toString(); });
  const result = new Promise<string>((resolve, reject) => {
    process.on('message', (message: { result?: string }) => { if (message.result) resolve(message.result); });
    process.on('error', reject);
    process.on('exit', (code) => { if (code !== 0) reject(new Error(`Child exited ${code}: ${errors}`)); });
  });
  return { process, result };
}
function ready(process: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    process.on('message', (message: { ready?: boolean }) => { if (message.ready) resolve(); });
    process.on('error', reject);
    process.on('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited ${code} before ready`)); });
  });
}

describe('private per-agent ownership and mint-once identity', () => {
  it('creates only private canonical nodes, reopens without reminting, and scans empty streams explicitly', async () => {
    const { root, path, workspace, store, capability } = await setup();
    const identityBytes = await fs.readFile(resolve(path, 'identity.json'));
    const reopened = await store.open(capability);
    expect(reopened.identity).toEqual(workspace.identity);
    expect(await store.create(capability, { owner: 'alice', slug: 'worker' })).toBeDefined();
    expect(await fs.readFile(resolve(path, 'identity.json'))).toEqual(identityBytes);
    await expect(store.create(capability, { owner: 'alice', slug: 'different' })).rejects.toMatchObject({ code: 'mint-once' });
    for (const directory of [root, path, `${path}/frames`, `${path}/frames/body`, `${path}/frames/memory`, `${path}/frames/swarm`, `${path}/artifacts`, `${path}/imports`]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of ['identity.json', 'manifest.json']) expect((await fs.stat(resolve(path, file))).mode & 0o777).toBe(0o600);
    const scan = await reopened.scan();
    expect(scan.heads).toEqual({ body: null, memory: null, swarm: null });
    expect(scan.streams.memory.trust).toMatchObject({ genesis: 'empty', persistedHead: 'empty' });
    expect(isWorkspaceSnapshot(scan)).toBe(true);
    expect(isWorkspaceSnapshot({ ...scan })).toBe(false);
  });
  it('refuses to mint into an existing directory with a missing or damaged identity', async () => {
    const { path, store, capability } = await setup();
    await fs.unlink(resolve(path, 'identity.json'));
    await expect(store.create(capability, { owner: 'alice', slug: 'worker' })).rejects.toMatchObject({ code: 'mint-once' });
    await expect(fs.stat(resolve(path, 'identity.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('isolates two agents, principals and foreign/unserialized handles', async () => {
    const { store, security, capability, workspace, path, root } = await setup();
    const bob = await security.authenticate('bob');
    const bobCap = await security.authorize(bob, {
      agentId: 'agent-b', workspaceId: 'workspace-b', taskId: null, permissions: allPermissions,
      resources: ['workspace:workspace-b'], expiresAt: Date.now() + 60_000,
    });
    const other = await store.create(bobCap, { owner: 'bob', slug: 'worker' });
    expect(other.identity.body_stream).not.toBe(workspace.identity.body_stream);
    const artifact = workspace.artifact('private.txt', ['read', 'write']);
    await workspace.writeArtifact(artifact, Buffer.from('alice private'));
    await expect(other.readArtifact(artifact)).rejects.toMatchObject({ code: 'artifact-capability' });
    await expect(store.open({ ...capability })).rejects.toMatchObject({ code: 'capability' });
    await expect(store.open({ workspaceId: 'workspace-a' } as never)).rejects.toMatchObject({ code: 'capability' });
    const otherScan = await other.scan();
    await expect(other.compareAndAppend({
      expectedHeads: otherScan.heads, frames: [memoryFrame(workspace.identity.memory_stream, null, { secret: true })],
    })).rejects.toMatchObject({ code: 'stream-binding' });
    await fs.copyFile(resolve(path, 'identity.json'), resolve(root, 'workspace-b/identity.json'));
    await expect(store.open(bobCap)).rejects.toMatchObject({ code: 'ownership' });
  });
  it('rechecks grants, expiry and revocation for every read and write', async () => {
    const { security, capability, workspace } = await setup();
    const artifact = workspace.artifact('report.txt', ['write']);
    security.revokeCapability(capability);
    await expect(workspace.scan()).rejects.toMatchObject({ code: 'capability' });
    await expect(workspace.writeArtifact(artifact, Buffer.from('no write'))).rejects.toMatchObject({ code: 'capability' });
  });
  it('does not probe legacy homes or imported executable attachments during normal operation', async () => {
    const { base, workspace, path } = await setup();
    const sentinel = resolve(base, 'legacy-sentinel');
    await fs.mkdir(sentinel, { mode: 0o700 });
    await fs.writeFile(resolve(sentinel, 'credentials.json'), 'not a credential', { mode: 0o600 });
    await fs.writeFile(resolve(path, 'imports/agent.py'), 'raise RuntimeError("must never execute")', { mode: 0o600 });
    const prior = await fs.stat(resolve(sentinel, 'credentials.json'));
    await workspace.scan();
    expect((await fs.stat(resolve(sentinel, 'credentials.json'))).mtimeMs).toBe(prior.mtimeMs);
    expect(await fs.readFile(resolve(path, 'imports/agent.py'), 'utf8')).toContain('must never execute');
  });
});

describe('no-follow paths and immutable artifact capabilities', () => {
  it.each(['', '../outside', 'a/../../outside', '/etc/passwd', 'a//b', './a', 'a/./b', 'a/../b',
    'a\\b', '%2e%2e/secret', 'a/%2Fsecret', 'file:///host', 'a\0b', 'a/', '.', '..', 'a/'.repeat(600)])(
    'refuses path %s', (path) => expect(() => artifactPath(path)).toThrow(),
  );
  it('writes immutable artifacts, verifies bytes and refuses foreign/read-only handles', async () => {
    const { workspace, store, capability, path } = await setup();
    const file = workspace.artifact('reports/a.txt', ['read', 'write']);
    const receipt = await workspace.writeArtifact(file, Buffer.from('canonical evidence attachment'));
    expect(receipt.bytes).toBe(29);
    expect(await workspace.readArtifact(file)).toEqual(Buffer.from('canonical evidence attachment'));
    expect((await fs.stat(resolve(path, 'artifacts/reports/a.txt'))).mode & 0o777).toBe(0o600);
    await expect(workspace.writeArtifact(file, Buffer.from('replacement'))).rejects.toMatchObject({ code: 'already-exists' });
    const readOnly = workspace.artifact('reports/a.txt', ['read']);
    await expect(workspace.writeArtifact(readOnly, Buffer.from('bad'))).rejects.toMatchObject({ code: 'artifact-capability' });
    await expect((await store.open(capability)).readArtifact(file)).rejects.toMatchObject({ code: 'artifact-capability' });
    await expect(workspace.readArtifact({ ...file })).rejects.toMatchObject({ code: 'artifact-capability' });
  });
  it.each(['artifact-file', 'artifact-directory', 'identity', 'manifest', 'stream', 'lock'])(
    'refuses a symlink at %s without changing outside bytes', async (target) => {
      const { base, path, workspace, store, capability } = await setup();
      const outside = resolve(base, 'outside');
      await fs.mkdir(outside, { mode: 0o700 });
      const sentinel = resolve(outside, 'sentinel');
      await fs.writeFile(sentinel, 'untouched', { mode: 0o600 });
      const map: Record<string, [string, string]> = {
        'artifact-file': ['artifacts/out.txt', sentinel],
        'artifact-directory': ['artifacts/reports', outside],
        identity: ['identity.json', sentinel], manifest: ['manifest.json', sentinel],
        stream: ['frames/memory', outside], lock: ['.lock', outside],
      };
      const [relative, destination] = map[target]!;
      await fs.rm(resolve(path, relative), { recursive: true, force: true });
      await fs.symlink(destination, resolve(path, relative));
      if (target.startsWith('artifact')) {
        const artifact = workspace.artifact(target === 'artifact-file' ? 'out.txt' : 'reports/out.txt', ['read', 'write']);
        await expect(workspace.writeArtifact(artifact, Buffer.from('bad'))).rejects.toBeDefined();
        await expect(workspace.readArtifact(artifact)).rejects.toBeDefined();
      } else {
        await expect(store.open(capability)).rejects.toBeDefined();
      }
      expect(await fs.readFile(sentinel, 'utf8')).toBe('untouched');
      expect(await fs.readdir(outside)).toEqual(['sentinel']);
    },
  );
  it('rejects hard links, public permissions, and symlinked store ancestors', async () => {
    const { base, path, workspace, security } = await setup();
    const outside = resolve(base, 'outside-file');
    await fs.writeFile(outside, 'private', { mode: 0o600 });
    await fs.link(outside, resolve(path, 'artifacts/link.txt'));
    const file = workspace.artifact('link.txt', ['read', 'write']);
    await expect(workspace.readArtifact(file)).rejects.toMatchObject({ code: 'unsafe-node' });
    await expect(workspace.writeArtifact(file, Buffer.from('bad'))).rejects.toMatchObject({ code: 'unsafe-node' });
    expect(await fs.readFile(outside, 'utf8')).toBe('private');
    const publicDir = resolve(base, 'public');
    await fs.mkdir(publicDir, { mode: 0o755 });
    await expect(WorkspaceStore.open({ root: publicDir, security })).rejects.toMatchObject({ code: 'unsafe-node' });
    await fs.symlink(path, resolve(base, 'alias'));
    await expect(WorkspaceStore.open({ root: resolve(base, 'alias/child'), security })).rejects.toMatchObject({ code: 'symlink' });
  });
});

describe('full chain scans and atomic expected-head batches', () => {
  it('stores signed swarm chains only with an explicit authenticated registry policy', async () => {
    const key = generateKeyPairSync('ed25519');
    const kid = keyedIdentity('alice', 'swarm-key', key.publicKey);
    const signer = createFrameSigner({ kid, privateKey: key.privateKey });
    const signatures = selectSignaturePolicy([{
      kid, spki_der_b64: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      revoked_utc: null, superseded_utc: null,
    }]);
    const f = await setup({ signatures });
    const before = await f.workspace.scan();
    const first = buildFrame({
      kind: 'swarm.telemetry', streamId: f.workspace.identity.swarm_stream, utc: UTC, head: null,
      payload: { receipt: 'signed' }, signer, signatures,
    });
    await expect(f.workspace.compareAndAppend({ expectedHeads: before.heads, frames: [{ ...first, sig: null }] }))
      .rejects.toMatchObject({ code: 'signature-required' });
    const second = buildFrame({
      kind: 'swarm.echo', streamId: first.stream_id, utc: UTC, head: frameHead(first),
      payload: { receipt: 'next' }, signer, signatures,
    });
    const after = await f.workspace.compareAndAppend({ expectedHeads: before.heads, frames: [first, second] });
    expect(after.heads.swarm?.seq).toBe(1);
    expect(after.streams.swarm.frames[1]?.prev_wave).toBe(first.frame_hash);
    expect(isVerifiedChain(after.streams.swarm)).toBe(true);
    const noRegistry = await WorkspaceStore.open({ root: f.root, security: f.security });
    await expect(noRegistry.open(f.capability)).rejects.toMatchObject({ code: 'signature-profile' });
  });
  it('atomically commits both streams and read-backs exact canonical bytes', async () => {
    const { workspace, path } = await setup();
    const before = await workspace.scan();
    const memory = memoryFrame(workspace.identity.memory_stream, null, { task: 'first' });
    const body = buildFrame({ kind: 'body.pulse', streamId: workspace.identity.body_stream, head: null, utc: UTC, payload: { operation: 'first' } });
    const after = await workspace.compareAndAppend({ expectedHeads: before.heads, frames: [memory, body] });
    expect(after.generation).toBe(1);
    expect(after.heads.memory).toEqual(frameHead(memory));
    expect(after.heads.body).toEqual(frameHead(body));
    expect(isVerifiedChain(after.streams.memory)).toBe(true);
    expect(after.trust).toEqual({ classification: 'integrity-only', source: 'private-store', factualTruth: false, authorship: false });
    for (const [family, frame] of [['memory', memory], ['body', body]] as const) {
      const names = await fs.readdir(resolve(path, `frames/${family}`));
      expect(names).toHaveLength(1);
      expect(await fs.readFile(resolve(path, `frames/${family}`, names[0]!), 'utf8')).toBe(canonicalJson(frame));
      expect((await fs.stat(resolve(path, `frames/${family}`, names[0]!))).nlink).toBe(1);
    }
    await expect(fs.stat(resolve(path, '.transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects stale or incomplete expected heads and bad entire batches before any writes', async () => {
    const { workspace, path } = await setup();
    const before = await workspace.scan();
    const frame = memoryFrame(workspace.identity.memory_stream, null, { a: 1 });
    await expect(workspace.compareAndAppend({ expectedHeads: { memory: null } as never, frames: [frame] })).rejects.toThrow();
    await expect(workspace.compareAndAppend({ expectedHeads: before.heads, frames: [] })).rejects.toMatchObject({ code: 'empty-batch' });
    await expect(workspace.compareAndAppend({
      expectedHeads: before.heads, frames: [frame, { ...frame, seq: 1, payload_hash: '0'.repeat(64) }],
    })).rejects.toBeDefined();
    expect(await fs.readdir(resolve(path, 'frames/memory'))).toEqual([]);
    await workspace.compareAndAppend({ expectedHeads: before.heads, frames: [frame] });
    await expect(workspace.compareAndAppend({ expectedHeads: before.heads, frames: [frame] })).rejects.toMatchObject({ code: 'cas-conflict' });
  });
  it('allows exactly one in-process CAS writer', async () => {
    const { workspace } = await setup();
    const before = await workspace.scan();
    const results = await Promise.allSettled(['one', 'two'].map((label) => workspace.compareAndAppend({
      expectedHeads: before.heads, frames: [memoryFrame(workspace.identity.memory_stream, null, { label })],
    })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await workspace.scan()).heads.memory?.seq).toBe(0);
  });
  it('allows exactly one competing writer across real processes', async () => {
    const { workspace, root } = await setup();
    const a = child(root, 'compete', 'one');
    const b = child(root, 'compete', 'two');
    const aReady = ready(a.process), bReady = ready(b.process);
    await Promise.all([aReady, bReady]);
    a.process.send({ go: true }); b.process.send({ go: true });
    expect((await Promise.all([a.result, b.result])).sort()).toEqual(['cas-conflict', 'committed']);
    const snapshot = await workspace.scan();
    expect(snapshot.heads.memory?.seq).toBe(1);
    expect(snapshot.heads.body?.seq).toBe(0);
    expect(snapshot.generation).toBe(1);
  }, 15_000);
  it.each(['truncated', 'fork', 'whitespace', 'extra-file', 'hash', 'rollback'])('full scan refuses %s', async (mode) => {
    const { workspace, path } = await setup();
    const before = await workspace.scan();
    const originalManifest = await fs.readFile(resolve(path, 'manifest.json'));
    const frame = memoryFrame(workspace.identity.memory_stream, null, { state: 'first' });
    await workspace.compareAndAppend({ expectedHeads: before.heads, frames: [frame] });
    const files = await fs.readdir(resolve(path, 'frames/memory'));
    const file = resolve(path, 'frames/memory', files[0]!);
    if (mode === 'truncated' || mode === 'rollback') {
      await fs.unlink(file);
      if (mode === 'rollback') await fs.writeFile(resolve(path, 'manifest.json'), originalManifest, { mode: 0o600 });
    } else if (mode === 'whitespace') await fs.appendFile(file, '\n');
    else if (mode === 'hash') await fs.writeFile(file, canonicalJson({ ...frame, payload: { altered: true } }), { mode: 0o600 });
    else if (mode === 'extra-file') await fs.writeFile(resolve(path, 'frames/memory/ignored.txt'), 'not ignored', { mode: 0o600 });
    else {
      const fork = memoryFrame(workspace.identity.memory_stream, null, { state: 'fork' });
      await fs.writeFile(resolve(path, `frames/memory/0000000000000000-${fork.frame_hash}.json`), canonicalJson(fork), { mode: 0o600 });
    }
    await expect(workspace.scan()).rejects.toBeDefined();
  });
  it('never steals a live process lock, even if its timestamp would be old', async () => {
    const { workspace, path } = await setup({ lockTimeoutMs: 50 });
    await fs.mkdir(resolve(path, '.lock'), { mode: 0o700 });
    await fs.writeFile(resolve(path, '.lock/owner.json'), canonicalJson({ pid: process.pid, token: 'old-live-process' }), { mode: 0o600 });
    await expect(workspace.scan()).rejects.toMatchObject({ code: 'lock-timeout' });
    expect(await fs.readdir(resolve(path, 'frames/memory'))).toEqual([]);
  });
});

describe('crash cuts and uncertain commits', () => {
  it('refuses an ancestor swapped to a symlink between journal and frame publication', async () => {
    let enabled = false, path = '', outside = '';
    const f = await setup({
      fault: async (point) => {
        if (enabled && point === 'journal-written') {
          await fs.rename(resolve(path, 'frames/memory'), resolve(path, 'frames/memory-held'));
          await fs.symlink(outside, resolve(path, 'frames/memory'));
        }
      },
    });
    path = f.path; outside = resolve(f.base, 'outside');
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(resolve(outside, 'sentinel'), 'unchanged', { mode: 0o600 });
    const before = await f.workspace.scan();
    enabled = true;
    await expect(f.workspace.compareAndAppend({
      expectedHeads: before.heads, frames: [memoryFrame(f.workspace.identity.memory_stream, null, { private: 'data' })],
    })).rejects.toMatchObject({ commitState: 'not-committed' });
    expect(await fs.readdir(outside)).toEqual(['sentinel']);
    expect(await fs.readFile(resolve(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  });
  it('refuses a corrupted pending frame instead of deleting or silently repairing it', async () => {
    let enabled = false;
    const f = await setup({ fault: (point) => { if (enabled && point === 'frame-written') throw new Error('crash'); } });
    const before = await f.workspace.scan();
    enabled = true;
    await expect(f.workspace.compareAndAppend({
      expectedHeads: before.heads, frames: [memoryFrame(f.workspace.identity.memory_stream, null, { pending: true })],
    })).rejects.toMatchObject({ commitState: 'not-committed' });
    const names = await fs.readdir(resolve(f.path, 'frames/memory'));
    await fs.writeFile(resolve(f.path, 'frames/memory', names[0]!), 'corrupt', { mode: 0o600 });
    enabled = false;
    await expect(f.store.open(f.capability)).rejects.toMatchObject({ code: 'recovery-corrupt' });
    expect(await fs.readFile(resolve(f.path, 'frames/memory', names[0]!), 'utf8')).toBe('corrupt');
  });
  it.each(['journal-written', 'frame-written', 'before-commit', 'manifest-written', 'read-back'] as CrashPoint[])(
    'recovers real process death at %s without partial projections', async (point) => {
      const { root, store, capability, path } = await setup();
      const process = fork(resolve(HERE, 'worker.mjs'), [root, `crash:${point}`, point], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      process.stderr!.on('data', (value) => { stderr += value.toString(); });
      const exit = await new Promise<number | null>((resolve, reject) => {
        process.on('error', reject); process.on('exit', resolve);
      });
      expect(exit, stderr).toBe(86);
      const workspace = await store.open(capability);
      const snapshot = await workspace.scan();
      const committed = point === 'manifest-written' || point === 'read-back';
      expect(snapshot.heads.memory?.seq ?? null).toBe(committed ? 1 : null);
      expect(snapshot.heads.body?.seq ?? null).toBe(committed ? 0 : null);
      expect(snapshot.generation).toBe(committed ? 1 : 0);
      await expect(fs.stat(resolve(path, '.transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(resolve(path, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    }, 15_000,
  );
  it('reports uncertainty after commit and resolves by scan, never by automatically appending again', async () => {
    let enabled = false;
    const { workspace, store, capability } = await setup({
      fault: (point) => { if (enabled && point === 'manifest-written') throw new Error('power loss after commit point'); },
    });
    const before = await workspace.scan();
    const frame = memoryFrame(workspace.identity.memory_stream, null, { accepted: true });
    enabled = true;
    await expect(workspace.compareAndAppend({ expectedHeads: before.heads, frames: [frame] }))
      .rejects.toMatchObject({ commitState: 'unknown' });
    enabled = false;
    const current = await (await store.open(capability)).scan();
    expect(current.heads.memory?.frame_hash).toBe(frame.frame_hash);
    await expect(workspace.compareAndAppend({ expectedHeads: before.heads, frames: [frame] }))
      .rejects.toMatchObject({ code: 'cas-conflict' });
  });
  it('does not replace a mint-once identity after creation failure', async () => {
    const base = resolve(HERE, '../.test-scratch', randomUUID());
    scratch.push(base);
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const security = new SecurityAuthority({
      authenticate: () => ({ id: 'alice', kind: 'human', expiresAt: Date.now() + 60_000 }),
      authorize: () => true, executionPolicy: () => ({ allowed: false, requiresApproval: true }),
    });
    const principal = await security.authenticate(null);
    const cap: Capability = await security.authorize(principal, {
      agentId: 'agent-a', workspaceId: 'workspace-a', taskId: null, permissions: allPermissions,
      resources: ['workspace:workspace-a'], expiresAt: Date.now() + 30_000,
    });
    const store = await WorkspaceStore.open({
      root: resolve(base, 'store'), security, fault: (point) => { if (point === 'identity-written') throw new Error('crash'); },
    });
    await expect(store.create(cap, { owner: 'alice', slug: 'worker' })).rejects.toThrow('crash');
    const identity = await fs.readFile(resolve(base, 'store/workspace-a/identity.json'));
    await expect(store.create(cap, { owner: 'alice', slug: 'worker' })).rejects.toBeDefined();
    expect(await fs.readFile(resolve(base, 'store/workspace-a/identity.json'))).toEqual(identity);
  });
});
