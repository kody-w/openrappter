import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRappEvidenceFrame,
  buildRappFrame,
  createRappFrameProfile,
  rappFrameDigest,
  selectRappChainTrustPolicy,
  verifyRappEvidenceChain,
  type RappFrame,
} from '../rapp/index.js';
import { RAPP_PARTICLE_DOMAIN, parseRappJson, rappH } from '../rappids/canonical.js';
import {
  WORKSPACE_CREATED_EVENT_KIND,
  WorkspaceStore,
  commitWorkspaceEvidence,
  type WorkspaceFramePersistence,
  type AgentWorkspace,
} from './index.js';

let fixture: string;
let store: WorkspaceStore;
let persistence: WorkspaceFramePersistence;

beforeEach(() => {
  fixture = path.join(process.cwd(), '.test-scratch', `workspace-persistence-${randomUUID()}`);
  store = new WorkspaceStore({ rootDir: fixture });
  persistence = store;
});

afterEach(async () => {
  await fs.rm(fixture, { recursive: true, force: true });
});

function adapted(overrides: Partial<WorkspaceFramePersistence>): WorkspaceFramePersistence {
  return {
    ensure: store.ensure.bind(store),
    get: store.get.bind(store),
    frames: store.frames.bind(store),
    appendEvidence: store.appendEvidence.bind(store),
    appendFrame: store.appendFrame.bind(store),
    ...overrides,
  };
}

describe('frame-backed workspace lifecycle and integration contract', () => {
  it('atomically creates and really scans a canonical lifecycle frame bound to the public identity', async () => {
    const workspace = await persistence.ensure('alice');
    const scan = await new WorkspaceStore({ rootDir: fixture }).frames('alice');
    expect(scan.frames).toHaveLength(1);
    const creation = scan.frames[0];
    expect(creation).toMatchObject({
      spec: 'rapp/1', kind: 'body.pulse', stream_id: workspace.manifest.identity.rappid,
      seq: 0, prev: null, prev_wave: null, sig: null,
      utc: workspace.manifest.identity.createdAt,
      payload: {
        schema: 'openrappter-evidence/1',
        event_kind: WORKSPACE_CREATED_EVENT_KIND,
        subject: workspace.manifest.identity.rappid,
        data_hash: rappH(RAPP_PARTICLE_DOMAIN, {
          identity: { ...workspace.manifest.identity },
          protocolRevision: { ...workspace.manifest.protocolRevision },
          streams: {
            body: workspace.manifest.streams.body.streamId,
            memory: workspace.manifest.streams.memory.streamId,
            swarm: workspace.manifest.streams.swarm.streamId,
          },
        }),
        reference_hashes: [],
        protocol_revision: { revision: 'rev-14' },
      },
    });
    const files = await fs.readdir(path.join(workspace.rootDir, 'streams', 'body'));
    const bytes = await fs.readFile(path.join(workspace.rootDir, 'streams', 'body', files[0]), 'utf8');
    expect(parseRappJson(bytes)).toEqual(creation);
    const checked = verifyRappEvidenceChain([parseRappJson(bytes)], selectRappChainTrustPolicy({
      trustedGenesis: workspace.manifest.streams.body.genesis!,
      persistedHead: workspace.manifest.streams.body.head,
    }));
    expect(checked).toMatchObject({ ok: true, trust: { promotionGrade: false, persistedHead: 'matched' } });
    await persistence.ensure('alice');
    expect((await persistence.frames('alice')).frames).toEqual([creation]);
  });

  it('labels metadata and empty streams honestly rather than treating either as verified evidence', async () => {
    const workspace = await persistence.ensure('alice');
    expect(workspace.verification).toEqual({
      protocol: 'rapp/1', status: 'not-scanned', scannedFrames: 0, trust: null,
    });
    expect((await persistence.get('alice'))!.verification.status).toBe('not-scanned');
    expect((await persistence.frames('alice')).verification).toMatchObject({
      protocol: 'rapp/1', status: 'verified', scannedFrames: 1,
      trust: { classification: 'integrity-only', promotionGrade: false },
    });
    for (const stream of ['memory', 'swarm'] as const) {
      expect((await persistence.frames('alice', stream)).verification).toEqual({
        protocol: 'rapp/1', status: 'empty', scannedFrames: 0, trust: null,
      });
    }
  });

  it('persists task, approval, VM, and action transitions only as canonical evidence, with scanned causal lineage', async () => {
    await persistence.ensure('alice');
    const transitions = [
      ['task.created', 'task:42'],
      ['approval.requested', 'approval:42'],
      ['approval.granted', 'approval:42'],
      ['vm.started', 'vm:42'],
      ['vm.stopped', 'vm:42'],
      ['task.completed', 'task:42'],
      ['action.completed', 'action:42'],
    ];
    let previous: RappFrame = (await persistence.frames('alice')).frames[0];
    for (const [eventKind, subject] of transitions) {
      const committed = await commitWorkspaceEvidence(persistence, 'alice', {
        eventKind, subject,
        dataHash: rappH(RAPP_PARTICLE_DOMAIN, { observed_result: subject }),
        referenceHashes: [previous.payload_hash],
      });
      expect(committed.seq).toBe(previous.seq + 1);
      expect(committed.prev).toBe(previous.payload_hash);
      expect(committed.payload.reference_hashes).toEqual([previous.payload_hash]);
      previous = committed;
    }
    const scan = await new WorkspaceStore({ rootDir: fixture }).frames('alice');
    expect(scan.frames.slice(1).map((frame) => frame.payload.event_kind)).toEqual(transitions.map(([kind]) => kind));
    expect(scan.frames.every((frame) => frame.spec === 'rapp/1' && frame.kind === 'body.pulse')).toBe(true);
    expect(scan.verification).toMatchObject({ status: 'verified', scannedFrames: transitions.length + 1 });
    const workspace = (await persistence.get('alice'))!;
    expect(await fs.readdir(workspace.tasksDir)).toEqual([]);
    expect((await fs.readdir(workspace.rootDir)).sort()).toEqual(['files', 'identity.json', 'manifest.json', 'streams', 'tasks']);
  });

  it('uses the registered memory tool-call family, not a body event with an invented envelope kind', async () => {
    const workspace = await persistence.ensure('alice');
    const frame = buildRappFrame({
      kind: 'memory.tool-call', streamId: workspace.manifest.streams.memory.streamId,
      utc: new Date().toISOString(), payload: { tool: 'search', result_ref: 'a'.repeat(64) }, head: null,
    }, createRappFrameProfile({ name: 'persistence-tool-call-test', kind: 'memory.tool-call' }));
    expect(await persistence.appendFrame('alice', 'memory', frame)).toEqual(frame);
    expect((await persistence.frames('alice', 'memory')).frames).toEqual([frame]);
    await expect(persistence.appendFrame('alice', 'body', frame)).rejects.toMatchObject({ code: 'integrity' });
    await expect(persistence.appendFrame('alice', 'body', {
      event: 'task.completed', status: 'done', agentId: 'alice',
    })).rejects.toMatchObject({ code: 'integrity' });
    await expect(persistence.appendEvidence('alice', {
      eventKind: WORKSPACE_CREATED_EVENT_KIND, subject: 'replacement', dataHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'invalid-params' });
  });

  it('rejects a valid but unpersisted frame receipt instead of reporting a durable action', async () => {
    const workspace = await persistence.ensure('alice');
    const head = (await persistence.frames('alice')).head;
    const input = { eventKind: 'task.completed', subject: 'task:missing', dataHash: 'a'.repeat(64) };
    const emittedOnly = buildRappEvidenceFrame({
      ...input, streamId: workspace.manifest.streams.body.streamId, utc: new Date().toISOString(), head,
    });
    const disconnected = adapted({ appendEvidence: async () => emittedOnly });
    await expect(commitWorkspaceEvidence(disconnected, 'alice', input))
      .rejects.toMatchObject({ code: 'integrity', message: expect.stringContaining('not found in the persisted frame scan') });
    expect((await persistence.frames('alice')).total).toBe(1);
  });

  it('independently rejects an empty scan even when a backend falsely labels it verified', async () => {
    await persistence.ensure('alice');
    const disconnected = adapted({
      frames: async (id, stream) => ({ ...await store.frames(id, stream), frames: [] }),
    });
    await expect(commitWorkspaceEvidence(disconnected, 'alice', {
      eventKind: 'task.completed', subject: 'task:no-scan', dataHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'integrity', cause: { code: 'empty-chain' } });
  });

  it('accepts concurrent append-only growth but returns the requested committed frame, not a later action', async () => {
    await persistence.ensure('alice');
    const concurrent = adapted({
      frames: async (id, stream) => {
        await store.appendEvidence(id, {
          eventKind: 'task.completed', subject: 'task:concurrent', dataHash: 'b'.repeat(64),
        });
        return store.frames(id, stream);
      },
    });
    const committed = await commitWorkspaceEvidence(concurrent, 'alice', {
      eventKind: 'task.completed', subject: 'task:requested', dataHash: 'a'.repeat(64),
    });
    expect(committed.payload.subject).toBe('task:requested');
    expect((await store.frames('alice')).total).toBe(3);
  });

  it('seals its checkpoint before scanning so a backend cannot mutate it to disguise rollback', async () => {
    await persistence.ensure('alice');
    let metadata: AgentWorkspace | null = null;
    const disconnected = adapted({
      get: async (id) => {
        metadata = await store.get(id);
        return metadata;
      },
      frames: async (id, stream) => {
        const scan = await store.frames(id, stream);
        metadata!.manifest.streams.body.head = {
          streamId: scan.streamId, seq: 0, frameHash: scan.frames[0].frame_hash,
        };
        return { ...scan, frames: scan.frames.slice(0, 1) };
      },
    });
    await expect(commitWorkspaceEvidence(disconnected, 'alice', {
      eventKind: 'task.completed', subject: 'task:rollback', dataHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'integrity', cause: { code: 'rollback' } });
  });

  it('rejects rehashed interior waves from a disconnected scanner even when payload lineage still verifies', async () => {
    const workspace = await persistence.ensure('alice');
    const createdAt = Date.parse(workspace.manifest.identity.createdAt);
    await persistence.appendEvidence('alice', {
      eventKind: 'task.created', subject: 'task:interior', dataHash: 'a'.repeat(64),
      utc: new Date(createdAt + 1000).toISOString(),
    });
    const disconnected = adapted({
      frames: async (id, stream) => {
        const scan = await store.frames(id, stream);
        const frames: RappFrame[] = JSON.parse(JSON.stringify(scan.frames));
        frames[1].utc = frames[0].utc;
        frames[1].frame_hash = rappFrameDigest(frames[1]);
        return { ...scan, frames };
      },
    });
    await expect(commitWorkspaceEvidence(disconnected, 'alice', {
      eventKind: 'task.completed', subject: 'task:interior', dataHash: 'b'.repeat(64),
      utc: new Date(createdAt + 2000).toISOString(),
    })).rejects.toThrow(/committed frame address/);
  });

  it('rejects lost lifecycle evidence on ensure and every durable stream operation', async () => {
    const workspace = await persistence.ensure('alice');
    const directory = path.join(workspace.rootDir, 'streams', 'body');
    await fs.unlink(path.join(directory, (await fs.readdir(directory))[0]));
    await expect(persistence.ensure('alice')).rejects.toMatchObject({ code: 'integrity' });
    await expect(persistence.appendEvidence('alice', {
      eventKind: 'task.completed', subject: 'task:42', dataHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'integrity' });
    const frame = buildRappFrame({
      kind: 'memory.save', streamId: workspace.manifest.streams.memory.streamId,
      utc: new Date().toISOString(), payload: { fact: 'must not persist' }, head: null,
    }, createRappFrameProfile({ name: 'missing-lifecycle-test', kind: 'memory.save' }));
    await expect(persistence.appendFrame('alice', 'memory', frame)).rejects.toMatchObject({ code: 'integrity' });
    await expect(persistence.frames('alice', 'memory')).rejects.toMatchObject({ code: 'integrity' });
    expect((await persistence.get('alice'))!.verification.status).toBe('not-scanned');
    expect(await fs.readdir(path.join(workspace.rootDir, 'streams', 'memory'))).toEqual([]);
  });

  it('refuses an unframed legacy manifest without inventing or backdating a migration event', async () => {
    const workspace = await persistence.ensure('alice');
    const manifest = workspace.manifest;
    manifest.streams.body = { streamId: manifest.streams.body.streamId, frameHashes: [], genesis: null, head: null };
    const manifestPath = path.join(workspace.rootDir, 'manifest.json');
    const bytes = JSON.stringify(manifest);
    await fs.writeFile(manifestPath, bytes);
    await expect(persistence.ensure('alice')).rejects.toThrow(/explicit migration/);
    await expect(persistence.frames('alice')).rejects.toMatchObject({ code: 'integrity' });
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(bytes);
    expect((await persistence.get('alice'))!.verification.status).toBe('not-scanned');
  });

  it('detects coordinated metadata changes that lack a corresponding lifecycle frame', async () => {
    const workspace = await persistence.ensure('alice');
    const identityPath = path.join(workspace.rootDir, 'identity.json');
    const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    const changedTime = new Date(Date.parse(identity.createdAt) + 1000).toISOString();
    identity.createdAt = changedTime;
    workspace.manifest.identity.createdAt = changedTime;
    await fs.writeFile(identityPath, JSON.stringify(identity));
    await fs.writeFile(path.join(workspace.rootDir, 'manifest.json'), JSON.stringify(workspace.manifest));
    await expect(persistence.frames('alice')).rejects.toThrow(/creation is not bound/);
    await expect(persistence.ensure('alice')).rejects.toMatchObject({ code: 'integrity' });
  });
});
