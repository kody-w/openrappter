import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  ProtocolAuthority,
  RAPP_ACCEPTED_BODY_STREAM_PROFILE,
  RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
  RAPP_FRAME_KEYS,
  buildRappFrame,
  createRappFrameProfile,
  rappFrameDigest,
  rappFrameToJson,
  rappFrameWavePreimage,
  selectRappChainTrustPolicy,
  verifyRappFrameChain,
  verifyRappFrameJson,
  type RappFrame,
  type RappFrameVerification,
} from '../../rapp/index.js';
import { RAPP_PARTICLE_DOMAIN, RAPP_WAVE_DOMAIN, rappCanonicalJson, rappH } from '../../rappids/canonical.js';
import { VmRappEvidence, type VmRappPersistence } from '../rapp-evidence.js';
import { TartVmSupervisor } from '../tart-vm-supervisor.js';
import { HostVmWorkspaces } from '../workspaces.js';
import { BODY_STREAM, FakeRappPersistence, MEMORY_STREAM } from './fake-rapp-persistence.js';
import { deferred, FakeVmCommandRunner, result, testConfig, testHost, testWorkspaces } from './fake-runner.js';

const roots: string[] = [];
const supervisors: TartVmSupervisor[] = [];
const request = { agentId: 'agent-a', workspaceId: 'project-1', argv: ['/usr/bin/pwd'] };

function fixture(persistence?: VmRappPersistence, timeoutMs = 2000) {
  const runner = new FakeVmCommandRunner();
  const evidence = new VmRappEvidence(persistence, Date.now, timeoutMs);
  const supervisor = new TartVmSupervisor({
    config: testConfig, host: testHost, runner, workspaces: testWorkspaces, evidence,
  });
  supervisors.push(supervisor);
  return { runner, evidence, supervisor };
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    // Failure-path tests explicitly assert the rejection before this cleanup.
    await supervisor.shutdown().catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'rapp_verification_failed' });
    });
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = path.join(process.cwd(), '.test-scratch');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'vm-rapp-'));
  roots.push(directory);
  return directory;
}

describe('mandatory host RAPP persistence integration', () => {
  it('labels unwired status explicitly and performs no VM or workspace side effect', async () => {
    const { supervisor, runner } = fixture();
    expect(await supervisor.status()).toMatchObject({
      state: 'unavailable', error: { code: 'rapp_not_wired' },
      verification: { status: 'not-wired', scannedFrames: 0, trust: null },
    });
    for (const work of [() => supervisor.start(), () => supervisor.stop(), () => supervisor.restart(), () => supervisor.exec(request)]) {
      await expect(work()).rejects.toMatchObject({ code: 'rapp_not_wired' });
    }
    expect(runner.calls).toEqual([]);
    expect(supervisor.getFrames()).toEqual([]);
    const directory = await scratch();
    const registry = new HostVmWorkspaces(directory, testConfig.workspaces);
    await expect(registry.resolve(testConfig.workspaces[0])).rejects.toMatchObject({ code: 'rapp_not_wired' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('will not accept a zero-artifact acknowledgement as durable frame evidence', async () => {
    const port = new FakeRappPersistence();
    port.acknowledgeWithoutWrite = true;
    const { supervisor, runner } = fixture(port);
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.calls).toEqual([]);
    expect(supervisor.getFrames()).toEqual([]);
    expect((await supervisor.status()).verification).toMatchObject({ status: 'failed' });
  });

  it('refuses a written frame whose owner did not advance its durable head checkpoint', async () => {
    const port = new FakeRappPersistence();
    const pinned = await port.selectStream('body', null, new AbortController().signal);
    port.selectStream = async () => pinned;
    const { supervisor, runner } = fixture(port);
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(port.appended).toHaveLength(1);
    expect(runner.calls).toEqual([]);
  });

  it('refuses append failures before launching Tart or materializing a workspace', async () => {
    const port = new FakeRappPersistence();
    port.appendError = new Error('disk unavailable');
    const { supervisor, runner, evidence } = fixture(port);
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.calls).toEqual([]);
    const directory = await scratch();
    const registry = new HostVmWorkspaces(directory, testConfig.workspaces, evidence);
    await expect(registry.resolve(testConfig.workspaces[0])).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(['authority', 'missing-head', 'wrong-genesis'] as const)('rejects an invalid selected %s binding', async (variant) => {
    const port = new FakeRappPersistence();
    const select = port.selectStream.bind(port);
    port.selectStream = async (family, identity, signal) => {
      const original = await select(family, identity, signal);
      return selectRappChainTrustPolicy({
        authority: variant === 'authority' ? ProtocolAuthority.acceptedRev13 : ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        trustedGenesis: variant === 'wrong-genesis'
          ? { ...original.trustedGenesis, frameHash: '0'.repeat(64) } : original.trustedGenesis,
        persistedHead: variant === 'missing-head' ? null : original.persistedHead,
      });
    };
    const { supervisor, runner } = fixture(port);
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.calls).toEqual([]);
  });

  it('never writes tool-call events to a body stream selected for the wrong family', async () => {
    const port = new FakeRappPersistence();
    const select = port.selectStream.bind(port);
    port.selectStream = (_family, identity, signal) => select('body', identity, signal);
    const { supervisor, runner } = fixture(port);
    await supervisor.start();
    const before = runner.calls.length;
    await expect(supervisor.exec(request)).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.calls).toHaveLength(before);
    await expect(supervisor.shutdown()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.children[0].finished).toBe(true);
  });

  it('exposes persistence failure after a guest action, does not retry it, and still releases its owned child', async () => {
    const port = new FakeRappPersistence();
    const { supervisor, runner } = fixture(port);
    await supervisor.start();
    port.beforeAppend = async (frame) => {
      if (frame.payload.event_kind === 'tool.completed') throw new Error('lost durable storage');
    };
    await expect(supervisor.exec(request)).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.calls.filter((call) => call.file === '/usr/bin/ssh' && call.argv.at(-1) !== '/usr/bin/true')).toHaveLength(1);
    expect(port.appended.some((frame) => frame.payload.event_kind === 'tool.requested')).toBe(true);
    expect(port.appended.some((frame) => frame.payload.event_kind === 'tool.completed')).toBe(false);
    expect((await supervisor.status()).verification.status).toBe('failed');
    await expect(supervisor.shutdown()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.children[0].signals).toEqual(['SIGINT']);
    expect(runner.calls.some((call) => call.argv[0] === 'stop')).toBe(false);
  });

  it('cleans up a just-spawned owned VM if its outcome cannot be committed', async () => {
    const port = new FakeRappPersistence();
    port.beforeAppend = async (frame) => {
      if (frame.payload.event_kind === 'vm.spawned') throw new Error('commit failed');
    };
    const { supervisor, runner } = fixture(port);
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.children).toHaveLength(1);
    expect(runner.children[0].finished).toBe(true);
    expect(port.appended[0].payload.event_kind).toBe('vm.requested');
    expect((await supervisor.status()).verification.status).toBe('failed');
  });

  it('preserves known guest results in the terminal frame when shutdown interrupts an execution', async () => {
    const port = new FakeRappPersistence();
    const { supervisor, runner } = fixture(port);
    await supervisor.start();
    const entered = deferred<void>();
    runner.intercept = async (call) => {
      if (call.file === '/usr/bin/ssh') {
        entered.resolve();
        return new Promise((resolve) => call.options!.signal!.addEventListener('abort', () => resolve(
          result({ aborted: true, exitCode: null, signal: 'SIGKILL', stdout: 'partial guest result' }),
        ), { once: true }));
      }
    };
    const execution = supervisor.exec(request);
    const rejected = expect(execution).rejects.toMatchObject({
      code: 'shutting_down', evidence: { kind: 'memory.tool-call', payload: {
        event_kind: 'tool.failed', details: { aborted: true, exit_code: null, signal: 'SIGKILL' },
      } },
    });
    await entered.promise;
    await supervisor.shutdown();
    await rejected;
    const terminal = port.appended.filter((frame) => frame.payload.event_kind === 'tool.failed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].payload.details).toMatchObject({ result_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(terminal)).not.toContain('partial guest result');
  });

  it('bounds a stalled persistence owner and never waits forever before owned shutdown', async () => {
    const port = new FakeRappPersistence();
    const { supervisor, runner } = fixture(port, 50);
    await supervisor.start();
    port.beforeAppend = async () => new Promise<void>(() => {});
    await expect(supervisor.shutdown()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
    expect(runner.children[0].finished).toBe(true);
    expect((await supervisor.status()).verification.status).toBe('failed');
  });
});

describe('real stored RAPP/1 frame scan and append contract', () => {
  it('scans nonzero real on-disk VM, workspace and tool frames with correct hashes, family, lineage and selected authority', async () => {
    const directory = await scratch();
    const port = new FakeRappPersistence(path.join(directory, 'canonical-frames'));
    const evidence = new VmRappEvidence(port);
    const runner = new FakeVmCommandRunner();
    const supervisor = new TartVmSupervisor({
      config: testConfig, host: testHost, runner, evidence,
      workspaces: new HostVmWorkspaces(path.join(directory, 'host'), testConfig.workspaces, evidence),
    });
    supervisors.push(supervisor);
    await supervisor.start();
    const executed = await supervisor.exec({ ...request, argv: ['/usr/bin/pwd', 'sensitive-test-argument'] });
    await supervisor.stop();
    await supervisor.shutdown();

    let scannedFrames = 0;
    for (const [streamId, stream] of port.streams) {
      const signal = new AbortController().signal;
      const sources = await port.readStream(streamId, signal);
      const profile = stream.family === 'body' ? RAPP_ACCEPTED_BODY_STREAM_PROFILE : RAPP_ACCEPTED_MEMORY_STREAM_PROFILE;
      const frames: RappFrame[] = [];
      let head: RappFrame | null = null;
      for (const source of sources) {
        const checked: RappFrameVerification<RappFrame> = verifyRappFrameJson(source, profile, { head, streamIdOfRecord: streamId });
        expect(checked.ok).toBe(true);
        if (!checked.ok) throw checked.error;
        const frame: RappFrame = checked.frame;
        scannedFrames++;
        expect(Object.keys(frame).sort()).toEqual([...RAPP_FRAME_KEYS].sort());
        expect(source).toBe(rappCanonicalJson(rappFrameToJson(frame)));
        expect(frame.seq).toBe(head ? head.seq + 1 : 0);
        expect(frame.prev).toBe(head?.payload_hash ?? null);
        expect(frame.prev_wave).toBeNull();
        expect(frame.sig).toBeNull();
        const hash = (domain: string, value: string) => createHash('sha256').update(`${domain}\n${value}`, 'utf8').digest('hex');
        expect(frame.payload_hash).toBe(hash(RAPP_PARTICLE_DOMAIN, rappCanonicalJson(frame.payload)));
        expect(frame.frame_hash).toBe(hash(RAPP_WAVE_DOMAIN, rappCanonicalJson(rappFrameWavePreimage(frame))));
        if (frame.payload.component === 'rapp-work.omarchy') {
          expect(frame.payload.protocol_revision).toEqual(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.identity());
          expect(frame.kind).toBe(stream.family === 'body' ? 'body.pulse' : 'memory.tool-call');
        }
        frames.push(frame);
        head = frame;
      }
      const policy = await port.selectStream(stream.family, null, signal);
      expect(verifyRappFrameChain(frames, profile, policy)).toMatchObject({
        ok: true, trust: { classification: 'integrity-only', promotionGrade: false, genesis: 'trusted', persistedHead: 'matched' },
      });
    }
    expect(scannedFrames).toBeGreaterThan(10);
    expect(port.appended.map((frame) => frame.payload.event_kind)).toEqual(expect.arrayContaining([
      'vm.requested', 'vm.state', 'vm.spawned', 'vm.ready', 'vm.completed',
      'workspace.requested', 'workspace.resolved', 'tool.requested', 'tool.completed', 'vm.shutdown',
    ]));
    const toolIntent = port.appended.find((frame) => frame.payload.event_kind === 'tool.requested')!;
    expect(toolIntent.payload.details).toMatchObject({
      request_hash: rappH(RAPP_PARTICLE_DOMAIN, {
        agentId: request.agentId, workspaceId: request.workspaceId,
        argv: ['/usr/bin/pwd', 'sensitive-test-argument'], cwd: '.', timeoutMs: testConfig.execTimeoutMs,
      }),
    });
    expect(executed.evidence.stream_id).toBe(MEMORY_STREAM);
    expect(executed.evidence.payload.details).toMatchObject({
      request_frame: { frame_hash: toolIntent.frame_hash, payload_hash: toolIntent.payload_hash, stream_id: MEMORY_STREAM },
      result_hash: rappH(RAPP_PARTICLE_DOMAIN, { ...runner.execResult }),
    });
    expect(executed.verification).toMatchObject({ status: 'verified', trust: { promotionGrade: false } });
    expect(JSON.stringify(supervisor.getFrames())).not.toContain('sensitive-test-argument');
    expect(JSON.stringify(supervisor.getFrames())).not.toContain('guest output');

    const count = port.appended.length;
    const persisted = port.streams.get(MEMORY_STREAM)!;
    const terminal = executed.evidence;
    const previous = JSON.parse(persisted.sources[terminal.seq - 1]) as RappFrame;
    await port.appendFrame(rappCanonicalJson(rappFrameToJson(terminal)), previous, new AbortController().signal);
    expect(port.appended).toHaveLength(count);
  });

  it('rejects real file tampering and rollback instead of repairing history or trusting an empty scan', async () => {
    const port = new FakeRappPersistence(path.join(await scratch(), 'frames'));
    const { supervisor } = fixture(port);
    await supervisor.start();
    await supervisor.stop();
    const stream = port.streams.get(BODY_STREAM)!;
    const file = port.frameFile('body', stream.head.seq);
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original.replace('"component":"rapp-work.omarchy"', '"component":"tampered"'));
    expect((await supervisor.status()).verification.status).toBe('failed');
    expect(await fs.readFile(file, 'utf8')).toContain('tampered');

    const rollback = new FakeRappPersistence();
    const verifier = new VmRappEvidence(rollback);
    await verifier.record(testConfig.name, 'vm.requested', { operation: 'start' });
    rollback.streams.get(BODY_STREAM)!.sources.pop();
    await expect(verifier.prepare()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
  });

  it('refuses rehashed application authority drift even under a fresh valid chain pin', async () => {
    const port = new FakeRappPersistence();
    const writer = new VmRappEvidence(port);
    await writer.record(testConfig.name, 'vm.requested', { operation: 'start' });
    const stream = port.streams.get(BODY_STREAM)!;
    const frame = JSON.parse(stream.sources[1]) as RappFrame;
    frame.payload.protocol_revision = { ...ProtocolAuthority.acceptedRev13.identity() };
    frame.payload_hash = rappH(RAPP_PARTICLE_DOMAIN, frame.payload);
    frame.frame_hash = rappFrameDigest(frame);
    stream.sources[1] = rappCanonicalJson(rappFrameToJson(frame));
    stream.head = frame;
    await expect(new VmRappEvidence(port).prepare()).rejects.toMatchObject({ code: 'rapp_verification_failed' });
  });

  it('uses compare-and-append across competing supervisors, never overwriting the winning frame', async () => {
    const port = new FakeRappPersistence();
    const gate = deferred<void>();
    let waiting = 0;
    port.beforeAppend = async () => { if (++waiting === 2) gate.resolve(); await gate.promise; };
    const left = new VmRappEvidence(port);
    const right = new VmRappEvidence(port);
    const outcomes = await Promise.allSettled([
      left.record(testConfig.name, 'vm.requested', { operation: 'start' }),
      right.record(testConfig.name, 'vm.requested', { operation: 'stop' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(port.appended).toHaveLength(1);
    expect(port.streams.get(BODY_STREAM)!.sources).toHaveLength(2);
  });

  it('refreshes selected head pins and refuses a replay below an externally advanced checkpoint', async () => {
    const port = new FakeRappPersistence();
    const evidence = new VmRappEvidence(port);
    const identity = { agentId: 'agent-a', workspaceId: 'project-1' };
    await evidence.prepare(identity);
    const stream = port.streams.get(MEMORY_STREAM)!;
    const appended = buildRappFrame({
      kind: 'memory.save', streamId: MEMORY_STREAM, head: stream.head,
      utc: '2026-09-11T00:00:01.000Z', payload: { external: 'durable owner append' },
    }, createRappFrameProfile({ name: 'vm-external-memory-test', kind: 'memory.save' }));
    await port.appendFrame(rappCanonicalJson(rappFrameToJson(appended)), stream.head, new AbortController().signal);
    stream.sources.pop();
    await expect(evidence.prepare(identity)).rejects.toMatchObject({ code: 'rapp_verification_failed' });
  });

  it('returns defensive verification views that cannot manufacture promotion trust', async () => {
    const evidence = new VmRappEvidence(new FakeRappPersistence());
    await evidence.record(testConfig.name, 'vm.requested', { operation: 'start' });
    const view = evidence.verification();
    Object.assign(view.trust!, { promotionGrade: true, classification: 'invented' });
    expect(evidence.verification().trust).toMatchObject({ classification: 'integrity-only', promotionGrade: false });
  });
});
