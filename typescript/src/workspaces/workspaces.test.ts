import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRappFrame,
  createRappFrameProfile,
  isRappBodyStream,
  isRappMemoryStream,
  isRappSwarmStream,
  rappFrameDigest,
  selectRappChainTrustPolicy,
  verifyRappEvidenceChain,
  type RappFrame,
} from '../rapp/index.js';
import { parseRappJson, rappH, RAPP_PARTICLE_DOMAIN } from '../rappids/canonical.js';
import {
  WorkspaceError,
  WorkspaceStore,
  type AgentWorkspace,
  type AppendWorkspaceEvidenceInput,
} from './index.js';

let fixture: string;
let rootDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-09-11T19:59:59.000Z');
  fixture = path.join(process.cwd(), '.test-scratch', `workspaces-${randomUUID()}`);
  rootDir = path.join(fixture, 'workspaces');
  await fs.mkdir(fixture, { recursive: true, mode: 0o700 });
  store = new WorkspaceStore({ rootDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await fs.rm(fixture, { recursive: true, force: true });
});

function evidence(index = 0): AppendWorkspaceEvidenceInput {
  return {
    eventKind: 'task.completed',
    subject: `task:${index}`,
    dataHash: rappH(RAPP_PARTICLE_DOMAIN, { result: `completed task ${index}` }),
    utc: `2026-09-11T20:00:0${index}.000Z`,
  };
}

async function frameFile(workspace: AgentWorkspace, stream = 'body', index = 0): Promise<string> {
  const directory = path.join(workspace.rootDir, 'streams', stream);
  const entries = (await fs.readdir(directory)).filter((entry) => entry.endsWith('.json'));
  expect(entries.length).toBeGreaterThan(0);
  return path.join(directory, entries.sort()[index]);
}

describe('private RAPP Work workspaces', () => {
  it('does not create state for list/get and honors the data home at call time', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.get('alice')).toBeNull();
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const defaults = new WorkspaceStore();
    vi.stubEnv('OPENRAPPTER_HOME', path.join(fixture, 'home-one'));
    expect(defaults.rootDir).toBe(path.join(fixture, 'home-one', 'workspaces'));
    await defaults.ensure('alice');
    vi.stubEnv('OPENRAPPTER_HOME', path.join(fixture, 'home-two'));
    expect(await defaults.get('alice')).toBeNull();
    expect(defaults.rootDir).toBe(path.join(fixture, 'home-two', 'workspaces'));
  });

  it('isolates identity, files, tasks, and all three streams for two agents', async () => {
    const alice = await store.ensure('alice');
    const bob = await store.ensure('bob');
    expect(alice.rootDir).toBe(path.join(rootDir, 'alice'));
    expect(bob.rootDir).toBe(path.join(rootDir, 'bob'));
    expect(alice.manifest.identity.rappid).not.toBe(bob.manifest.identity.rappid);
    expect(isRappBodyStream(alice.manifest.streams.body.streamId)).toBe(true);
    expect(isRappMemoryStream(alice.manifest.streams.memory.streamId)).toBe(true);
    expect(isRappSwarmStream(alice.manifest.streams.swarm.streamId)).toBe(true);
    for (const stream of ['body', 'memory', 'swarm'] as const) {
      expect(alice.manifest.streams[stream].streamId).not.toBe(bob.manifest.streams[stream].streamId);
      if (stream === 'body') {
        expect(await store.frames('alice', stream)).toMatchObject({
          total: 1, verification: { status: 'verified', scannedFrames: 1 },
        });
      } else {
        expect(await store.frames('alice', stream)).toMatchObject({
          total: 0, frames: [], head: null, trust: null, verification: { status: 'empty' },
        });
      }
    }
    await fs.writeFile(await store.resolvePath('alice', 'files', 'report.txt'), 'alice only');
    await fs.writeFile(await store.resolvePath('bob', 'files', 'report.txt'), 'bob only');
    await fs.writeFile(await store.resolvePath('alice', 'tasks', 'result.txt'), 'task result artifact');
    expect(await fs.readFile(path.join(bob.filesDir, 'report.txt'), 'utf8')).toBe('bob only');
    expect(await fs.readdir(bob.tasksDir)).toEqual([]);
    await store.appendEvidence('alice', evidence());
    expect((await store.frames('alice')).total).toBe(2);
    expect((await store.frames('bob')).total).toBe(1);
    expect((await store.list()).map((workspace) => workspace.agentId)).toEqual(['alice', 'bob']);
    expect(JSON.stringify(await store.get('alice'))).not.toContain('"tail"');
  });

  it('creates atomically and idempotently without rewriting identity or user files', async () => {
    const original = await store.ensure('alice');
    const identityPath = path.join(original.rootDir, 'identity.json');
    const identity = await fs.readFile(identityPath);
    const manifest = await fs.readFile(path.join(original.rootDir, 'manifest.json'));
    const before = await fs.stat(identityPath);
    await fs.writeFile(path.join(original.filesDir, 'notes.txt'), 'keep this');
    expect(await new WorkspaceStore({ rootDir }).ensure('alice')).toEqual(original);
    expect((await store.frames('alice')).total).toBe(1);
    expect(await fs.readFile(identityPath)).toEqual(identity);
    expect((await fs.stat(identityPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(path.join(original.rootDir, 'manifest.json'))).toEqual(manifest);
    expect(await fs.readFile(path.join(original.filesDir, 'notes.txt'), 'utf8')).toBe('keep this');
    expect((await fs.readdir(rootDir)).filter((entry) => entry.startsWith('.create-'))).toEqual([]);
    expect(await fs.readdir(path.join(rootDir, '.locks'))).toEqual([]);
  });

  it('does not publish a partial workspace when creation is interrupted', async () => {
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (destination === path.join(rootDir, 'alice')) throw new Error('interrupted creation');
      await originalRename(source, destination);
    });
    await expect(store.ensure('alice')).rejects.toThrow(/interrupted creation/);
    expect(await store.get('alice')).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await fs.readdir(rootDir)).toEqual(['.locks']);
    expect(await fs.readdir(path.join(rootDir, '.locks'))).toEqual([]);
    rename.mockRestore();
    expect((await store.ensure('alice')).agentId).toBe('alice');
  });

  it.each(['before-open', 'after-open'])('accepts a complete manifest snapshot across an atomic rename (%s)', async (timing) => {
    const workspace = await store.ensure('alice');
    const manifest = path.join(workspace.rootDir, 'manifest.json');
    const replacement = path.join(workspace.rootDir, '.snapshot-test');
    await fs.copyFile(manifest, replacement);
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!replaced && args[0] === manifest) {
        replaced = true;
        if (timing === 'after-open') {
          const handle = await originalOpen(...args);
          await fs.rename(replacement, manifest);
          return handle;
        }
        await fs.rename(replacement, manifest);
      }
      return originalOpen(...args);
    });
    expect(await store.get('alice')).toEqual(workspace);
    expect(replaced).toBe(true);
  });

  it('serializes concurrent independent stores without reminting or losing frames', async () => {
    const stores = Array.from({ length: 6 }, () => new WorkspaceStore({ rootDir }));
    const created = await Promise.all(stores.map((instance) => instance.ensure('alice')));
    expect(new Set(created.map((workspace) => workspace.manifest.identity.rappid)).size).toBe(1);
    await Promise.all(stores.map((instance, index) =>
      instance.appendEvidence('alice', { ...evidence(index), utc: evidence().utc })));
    const scan = await store.frames('alice');
    expect(scan.frames.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scan.frames.filter((frame) => frame.payload.event_kind === 'workspace.created')).toHaveLength(1);
    expect(scan.trust?.persistedHead).toBe('matched');
  });

  it('serializes writers in separate Node processes', async () => {
    const run = promisify(execFile);
    const program = `
      import { WorkspaceStore } from './src/workspaces/index.ts';
      const store = new WorkspaceStore({ rootDir: process.argv[1] });
      await store.ensure('alice');
      await store.appendEvidence('alice', {
        eventKind: 'task.completed', subject: process.argv[2], dataHash: 'a'.repeat(64)
      });
    `;
    await Promise.all([0, 1, 2].map((index) => run(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', program, rootDir, `process-${index}`,
    ], { cwd: process.cwd(), timeout: 20_000 })));
    expect((await store.frames('alice')).frames.map((frame) => frame.seq)).toEqual([0, 1, 2, 3]);
  }, 30_000);

  it('uses private permissions where POSIX modes are supported', async () => {
    if (process.platform === 'win32') return;
    const workspace = await store.ensure('alice');
    await store.appendEvidence('alice', evidence());
    for (const directory of [
      rootDir, workspace.rootDir, workspace.filesDir, workspace.tasksDir,
      path.join(workspace.rootDir, 'streams'), path.join(workspace.rootDir, 'streams', 'body'),
      path.join(workspace.rootDir, 'streams', 'memory'), path.join(workspace.rootDir, 'streams', 'swarm'),
      path.join(rootDir, '.locks'),
    ]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of [
      path.join(workspace.rootDir, 'manifest.json'), path.join(workspace.rootDir, 'identity.json'),
      await frameFile(workspace), await frameFile(workspace, 'body', 1),
    ]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses weakened permissions instead of silently accepting exposed state', async () => {
    if (process.platform === 'win32') return;
    const workspace = await store.ensure('alice');
    await fs.chmod(rootDir, 0o755);
    await expect(store.get('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
    await fs.chmod(rootDir, 0o700);
    const identity = path.join(workspace.rootDir, 'identity.json');
    await fs.chmod(identity, 0o644);
    await expect(store.ensure('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
    expect((await fs.stat(identity)).mode & 0o777).toBe(0o644);
  });

  it('refuses an incomplete existing workspace rather than replacing its identity', async () => {
    await store.ensure('alice');
    const identity = path.join(rootDir, 'alice', 'identity.json');
    await fs.unlink(identity);
    await expect(store.ensure('alice')).rejects.toMatchObject({ code: 'integrity' });
    await expect(fs.stat(identity)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.list()).rejects.toMatchObject({ code: 'integrity' });
  });

  it('never steals a lock and reports bounded contention explicitly', async () => {
    await store.ensure('alice');
    const lock = path.join(rootDir, '.locks', 'alice.lock');
    await fs.writeFile(lock, '{"pid":1}\n', { mode: 0o600 });
    const blocked = new WorkspaceStore({ rootDir, lockTimeoutMs: 30 });
    await expect(blocked.appendEvidence('alice', evidence())).rejects.toMatchObject({ code: 'busy' });
    expect(await fs.readFile(lock, 'utf8')).toBe('{"pid":1}\n');
    expect((await store.frames('alice')).total).toBe(1);
  });
});

describe('strict workspace paths', () => {
  it('rejects traversal, aliases, encoded separators, non-portable IDs, and non-strings', async () => {
    for (const agentId of [
      '', '.', '..', '../alice', '/alice', 'alice/bob', 'alice\\bob', 'alice..bob',
      'alice%2fbob', 'alice%00', ' alice', 'alice ', 'ALICE', 'a_b', 'a--b', '-a',
      'a-', 'a'.repeat(65), 'con', 'com1', 'nul', 'a\0b', 'alice\n', 'alice\r\n', 12, null, undefined,
    ]) {
      await expect(store.ensure(agentId as string), String(agentId)).rejects.toMatchObject({
        code: 'invalid-agent-id',
      });
    }
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsafe configured roots instead of normalizing traversal away', () => {
    for (const unsafe of ['', '.', path.parse(fixture).root, 'relative/workspaces', `${fixture}/../elsewhere`, `${fixture}/./data`, `${fixture}\0`]) {
      expect(() => new WorkspaceStore({ rootDir: unsafe })).toThrow(WorkspaceError);
    }
  });

  it('confines file/task paths and stream names without silently coercing input', async () => {
    await store.ensure('alice');
    for (const relative of [
      '', '.', '..', '../bob/report.txt', '/etc/passwd', 'a/../b', 'a\\b', 'a//b',
      'a%2fb', 'a\0b', 'C:/x', 'nul.txt', 'a.', 'a/./b', 'report.txt\n',
    ]) {
      await expect(store.resolvePath('alice', 'files', relative), relative).rejects.toMatchObject({
        code: 'invalid-path',
      });
    }
    await expect(store.resolvePath('alice', '../bob' as 'files', 'report.txt')).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(store.frames('alice', '../bob' as 'body')).rejects.toMatchObject({
      code: 'invalid-params',
    });
    expect(await store.resolvePath('alice', 'files', 'drafts/report.txt'))
      .toBe(path.join(rootDir, 'alice', 'files', 'drafts', 'report.txt'));
  });

  it('refuses symlinked roots and ancestors', async () => {
    const outside = path.join(fixture, 'outside');
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, rootDir, 'dir');
    await expect(store.ensure('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
    const nested = new WorkspaceStore({ rootDir: path.join(rootDir, 'nested') });
    await expect(nested.ensure('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses links between agents and links in files, tasks, and frame directories', async () => {
    const alice = await store.ensure('alice');
    const bob = await store.ensure('bob');
    await fs.symlink(bob.rootDir, path.join(rootDir, 'alias'), 'dir');
    await expect(store.get('alias')).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(store.list()).rejects.toMatchObject({ code: 'unsafe-path' });
    await fs.symlink(bob.filesDir, path.join(alice.filesDir, 'escape'), 'dir');
    await expect(store.resolvePath('alice', 'files', 'escape/secret.txt')).rejects.toMatchObject({
      code: 'unsafe-path',
    });
    await fs.rm(alice.tasksDir, { recursive: true });
    await fs.symlink(bob.tasksDir, alice.tasksDir, 'dir');
    await expect(store.ensure('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('rejects symlinked and hard-linked control files', async () => {
    const alice = await store.ensure('alice');
    const bob = await store.ensure('bob');
    const manifest = path.join(alice.rootDir, 'manifest.json');
    await fs.unlink(manifest);
    await fs.symlink(path.join(bob.rootDir, 'manifest.json'), manifest);
    await expect(store.get('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
    await fs.unlink(manifest);
    await fs.link(path.join(bob.rootDir, 'manifest.json'), manifest);
    await expect(store.get('alice')).rejects.toMatchObject({ code: 'unsafe-path' });
  });
});

describe('canonical RAPP/1 evidence and scans', () => {
  it('genuinely emits, persists, parses, and verifies a canonical evidence frame', async () => {
    const workspace = await store.ensure('alice');
    const emitted = await store.appendEvidence('alice', evidence());
    const parsed = parseRappJson(await fs.readFile(await frameFile(workspace, 'body', 1), 'utf8'));
    expect(parsed).toEqual(emitted);
    expect(Object.keys(emitted)).toHaveLength(11);
    expect(emitted).toMatchObject({
      spec: 'rapp/1', kind: 'body.pulse', seq: 1,
      prev: workspace.manifest.streams.body.genesis!.payloadHash, prev_wave: null, sig: null,
      payload: { schema: 'openrappter-evidence/1', protocol_revision: { revision: 'rev-14' } },
    });
    const scan = await store.frames('alice');
    expect(scan.total).toBe(2);
    expect(scan.frames[1]).toEqual(emitted);
    const committed = (await store.get('alice'))!.manifest.streams.body;
    const checked = verifyRappEvidenceChain(scan.frames, selectRappChainTrustPolicy({
      trustedGenesis: committed.genesis!,
      persistedHead: committed.head,
    }));
    expect(checked).toMatchObject({
      ok: true, head: emitted,
      trust: { classification: 'integrity-only', promotionGrade: false, genesis: 'trusted', persistedHead: 'matched' },
    });
  });

  it('continues the persisted chain across restarts using payload, not wave, links', async () => {
    await store.ensure('alice');
    const creation = (await store.frames('alice')).frames[0];
    const first = await store.appendEvidence('alice', evidence(0));
    const second = await new WorkspaceStore({ rootDir }).appendEvidence('alice', evidence(1));
    const third = await store.appendEvidence('alice', evidence(2));
    expect(first).toMatchObject({ seq: 1, prev: creation.payload_hash });
    expect(second).toMatchObject({ seq: 2, prev: first.payload_hash, prev_wave: null });
    expect(second.prev).not.toBe(first.frame_hash);
    expect(third).toMatchObject({ seq: 3, prev: second.payload_hash, prev_wave: null });
    expect((await store.frames('alice')).frames).toEqual([creation, first, second, third]);
  });

  it('keeps accepted memory frames on their own chain and refuses cross-stream or cross-agent frames', async () => {
    const alice = await store.ensure('alice');
    await store.ensure('bob');
    await store.appendEvidence('alice', evidence());
    const profile = createRappFrameProfile({ name: 'workspace-test-memory', kind: 'memory.save' });
    const memory = buildRappFrame({
      kind: 'memory.save', streamId: alice.manifest.streams.memory.streamId,
      utc: evidence().utc!, payload: { fact: 'remember this' }, head: null,
    }, profile);
    await store.appendFrame('alice', 'memory', memory);
    const next = buildRappFrame({
      kind: 'memory.save', streamId: alice.manifest.streams.memory.streamId,
      utc: evidence(1).utc!, payload: { fact: 'and this' }, head: memory,
    }, profile);
    await store.appendFrame('alice', 'memory', next);
    expect((await store.frames('alice', 'memory')).frames).toEqual([memory, next]);
    expect((await store.frames('alice', 'body')).total).toBe(2);
    expect((await store.frames('bob', 'memory')).total).toBe(0);
    await expect(store.appendFrame('bob', 'memory', memory)).rejects.toMatchObject({ code: 'integrity' });
    await expect(store.appendFrame('alice', 'body', memory)).rejects.toMatchObject({ code: 'integrity' });
  });

  it('does not pretend unsigned swarm frames have passed signature verification', async () => {
    await store.ensure('alice');
    await expect(store.appendFrame('alice', 'swarm', {})).rejects.toMatchObject({
      code: 'swarm-verifier-required',
    });
    expect(await store.frames('alice', 'swarm')).toMatchObject({ total: 0, trust: null });
  });

  it('ingests signed swarm continuations only with a real configured signature verifier', async () => {
    const workspace = await store.ensure('alice');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signedStore = new WorkspaceStore({
      rootDir,
      verifySwarmSignature: (frame) =>
        verify(null, Buffer.from(frame.frame_hash, 'hex'), publicKey, Buffer.from(frame.sig!, 'base64')),
    });
    // An external issuer fixture, using canonical hashes; the store is not a swarm issuer.
    const issue = (head: RappFrame | null): RappFrame => {
      const payload = { message: `swarm observation ${(head?.seq ?? -1) + 1}` };
      const frame: RappFrame = {
        spec: 'rapp/1', kind: 'swarm.echo', stream_id: workspace.manifest.streams.swarm.streamId,
        seq: (head?.seq ?? -1) + 1, utc: evidence().utc!, payload,
        payload_hash: rappH(RAPP_PARTICLE_DOMAIN, payload),
        frame_hash: '0'.repeat(64), prev: head?.payload_hash ?? null,
        prev_wave: head?.frame_hash ?? null, sig: null,
      };
      frame.frame_hash = rappFrameDigest(frame);
      frame.sig = sign(null, Buffer.from(frame.frame_hash, 'hex'), privateKey).toString('base64');
      return frame;
    };
    const first = await signedStore.appendFrame('alice', 'swarm', issue(null));
    const second = await signedStore.appendFrame('alice', 'swarm', issue(first));
    expect(second.prev_wave).toBe(first.frame_hash);
    expect(second.prev).toBe(first.payload_hash);
    expect((await signedStore.frames('alice', 'swarm')).frames).toEqual([first, second]);
    await expect(store.frames('alice', 'swarm')).rejects.toMatchObject({ code: 'swarm-verifier-required' });
    await expect(signedStore.appendFrame('alice', 'swarm', { ...issue(second), sig: 'invalid' }))
      .rejects.toMatchObject({ code: 'integrity', cause: { code: 'signature-profile' } });
    const next = issue(second);
    next.prev_wave = first.frame_hash;
    next.frame_hash = rappFrameDigest(next);
    next.sig = sign(null, Buffer.from(next.frame_hash, 'hex'), privateKey).toString('base64');
    await expect(signedStore.appendFrame('alice', 'swarm', next))
      .rejects.toMatchObject({ code: 'integrity', cause: { code: 'prev-wave' } });
    expect((await signedStore.frames('alice', 'swarm')).total).toBe(2);
  });

  it('rejects duplicate evidence, invalid payloads, and time regression before committing', async () => {
    const workspace = await store.ensure('alice');
    await store.appendEvidence('alice', evidence(1));
    const manifestPath = path.join(workspace.rootDir, 'manifest.json');
    const before = await fs.readFile(manifestPath);
    await expect(store.appendEvidence('alice', { ...evidence(1), utc: evidence(2).utc }))
      .rejects.toMatchObject({ code: 'integrity' });
    await expect(store.appendEvidence('alice', evidence(0))).rejects.toMatchObject({ code: 'integrity' });
    await expect(store.appendEvidence('alice', { ...evidence(2), dataHash: 'bad' }))
      .rejects.toMatchObject({ code: 'invalid-params' });
    await expect(store.appendEvidence('alice', {
      ...evidence(2), referenceHashes: ['b'.repeat(64), 'a'.repeat(64)],
    })).rejects.toMatchObject({ code: 'invalid-params' });
    expect(await fs.readFile(manifestPath)).toEqual(before);
    expect((await store.frames('alice')).total).toBe(2);
  });

  it('fails scans and appends explicitly on payload tampering, without rewriting history', async () => {
    const workspace = await store.ensure('alice');
    await store.appendEvidence('alice', evidence());
    const file = await frameFile(workspace);
    const frame = JSON.parse(await fs.readFile(file, 'utf8'));
    frame.payload.subject = 'tampered';
    const tampered = JSON.stringify(frame);
    await fs.writeFile(file, tampered);
    const manifestPath = path.join(workspace.rootDir, 'manifest.json');
    const before = await fs.readFile(manifestPath);
    await expect(store.frames('alice')).rejects.toMatchObject({ code: 'integrity' });
    await expect(store.appendEvidence('alice', evidence(1))).rejects.toMatchObject({ code: 'integrity' });
    expect(await fs.readFile(file, 'utf8')).toBe(tampered);
    expect(await fs.readFile(manifestPath)).toEqual(before);
  });

  it('detects deleted committed frames and never treats a truncated stream as empty', async () => {
    const workspace = await store.ensure('alice');
    await store.appendEvidence('alice', evidence());
    await fs.unlink(await frameFile(workspace));
    await expect(new WorkspaceStore({ rootDir }).frames('alice')).rejects.toMatchObject({ code: 'integrity' });
    await expect(store.appendEvidence('alice', evidence(1))).rejects.toMatchObject({ code: 'integrity' });
  });

  it('rejects duplicate JSON keys rather than trusting JSON.parse last-key wins', async () => {
    const workspace = await store.ensure('alice');
    const frame = await store.appendEvidence('alice', evidence());
    const file = await frameFile(workspace, 'body', 1);
    await fs.writeFile(file, `{"seq":10,${JSON.stringify(frame).slice(1)}`);
    await expect(store.frames('alice')).rejects.toMatchObject({ code: 'integrity' });
  });

  it('pins every committed wave, detecting a rehashed interior frame with unchanged payload links', async () => {
    const workspace = await store.ensure('alice');
    for (const index of [0, 1, 2]) await store.appendEvidence('alice', evidence(index));
    const directory = path.join(workspace.rootDir, 'streams', 'body');
    const file = path.join(directory, (await fs.readdir(directory)).sort()[1]);
    const frame: RappFrame = JSON.parse(await fs.readFile(file, 'utf8'));
    frame.utc = '2026-09-11T20:00:00.500Z';
    frame.frame_hash = rappFrameDigest(frame);
    await fs.writeFile(file, JSON.stringify(frame));
    await expect(store.frames('alice')).rejects.toMatchObject({ code: 'integrity' });
    await expect(store.appendEvidence('alice', evidence(3))).rejects.toMatchObject({ code: 'integrity' });
  });

  it('rejects identity, anchor, and frame filename traversal tampering', async () => {
    const workspace = await store.ensure('alice');
    await store.appendEvidence('alice', evidence());
    const manifestPath = path.join(workspace.rootDir, 'manifest.json');
    const original = await fs.readFile(manifestPath, 'utf8');
    for (const alter of [
      (manifest: any) => { manifest.identity.agentId = 'bob'; },
      (manifest: any) => { manifest.streams.body.streamId = 'net:wrong'; },
      (manifest: any) => { manifest.streams.body.frameHashes[0] = '../../outside'; },
      (manifest: any) => { manifest.streams.body.genesis.frameHash = 'f'.repeat(64); },
      (manifest: any) => { manifest.streams.body.head.seq = 2; },
    ]) {
      const manifest = JSON.parse(original);
      alter(manifest);
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await expect(store.frames('alice')).rejects.toMatchObject({ code: 'integrity' });
    }
  });

  it('commits via one atomic manifest replacement and safely retries an interrupted publication', async () => {
    const workspace = await store.ensure('alice');
    await store.appendEvidence('alice', evidence());
    const before = (await store.frames('alice')).frames;
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (destination === path.join(workspace.rootDir, 'manifest.json')) {
        throw new Error('simulated interruption before commit');
      }
      await originalRename(source, destination);
    });
    await expect(store.appendEvidence('alice', evidence(1))).rejects.toThrow(/simulated interruption/);
    expect((await new WorkspaceStore({ rootDir }).frames('alice')).frames).toEqual(before);
    rename.mockRestore();
    const second = await store.appendEvidence('alice', evidence(1));
    expect((await store.frames('alice')).frames).toEqual([...before, second]);
    expect(await fs.readdir(path.join(rootDir, '.locks'))).toEqual([]);
  });
});
