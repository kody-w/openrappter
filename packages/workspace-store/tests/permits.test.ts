import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHORITY_IDENTITY, buildEvidenceFrame, buildFrame, frameHead, hashValue, isVerifiedChain, PARTICLE_DOMAIN,
  type JsonObject, type RappFrame,
} from '@rapp-work/rapp1';
import { SecurityAuthority, operationHash, type FrameProof, type OperationRequest, type PermitReservation } from '@rapp-work/security';
import { WorkspaceStore, type CrashPoint, type WorkspaceSnapshot } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const NOW = Date.parse('2026-09-11T12:00:00.000Z'), UTC = new Date(NOW).toISOString();
function proof(snapshot: WorkspaceSnapshot, source: RappFrame, evidence: RappFrame): FrameProof {
  if (!isVerifiedChain(snapshot.streams.body) || !isVerifiedChain(snapshot.streams.memory)) throw new Error('Missing full scans');
  return { body: snapshot.streams.body, memory: snapshot.streams.memory, sourceFrameHash: source.frame_hash, evidenceFrameHash: evidence.frame_hash };
}
async function setup(faultPoint?: CrashPoint) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../.test-scratch', randomUUID());
  roots.push(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const createAuthority = () => new SecurityAuthority({
    authenticate: () => ({ id: 'alice', kind: 'human', expiresAt: NOW + 120_000 }),
    authorize: (_principal, scope) => scope.agentId === 'agent-a' && scope.workspaceId === 'workspace-a',
    executionPolicy: () => ({ allowed: true, requiresApproval: true }), now: () => NOW,
  });
  const security = createAuthority();
  const principal = await security.authenticate('fixture-host');
  const grant = {
    agentId: 'agent-a', workspaceId: 'workspace-a', taskId: null,
    permissions: ['workspace.create', 'workspace.read', 'workspace.append', 'approval.decide', 'run.execute'] as const,
    resources: ['computer:omarchy', 'guest-path:reports/output.txt', 'workspace:workspace-a'], expiresAt: NOW + 60_000,
  };
  const capability = await security.authorize(principal, grant);
  let faultEnabled = false;
  const store = await WorkspaceStore.open({
    root: resolve(root, 'store'), security,
    fault: (point) => { if (faultEnabled && point === faultPoint) throw new Error('Injected persistence fault'); },
  });
  const workspace = await store.create(capability, { owner: 'alice', slug: 'worker' });
  const request: OperationRequest = {
    schema: 'rapp-work/operation/1', operation_id: 'operation-a', principal_id: 'alice',
    agent_id: 'agent-a', workspace_id: 'workspace-a', task_id: 'task-a', run_id: 'run-a',
    operation: 'guest.files.write', resources: ['computer:omarchy', 'guest-path:reports/output.txt'],
    params: { path: 'reports/output.txt', text: 'report' }, expires_utc: new Date(NOW + 60_000).toISOString(),
  };
  async function append(data: JsonObject, refs: string[] = []) {
    const snapshot = await workspace.scan();
    const source = buildFrame({
      kind: data.type === 'approval.requested' ? 'memory.save' : 'memory.tool-call', streamId: workspace.identity.memory_stream,
      utc: UTC, head: snapshot.heads.memory,
      payload: { subject: `${data.type === 'approval.requested' || data.type === 'approval.decided' ? 'approval' : 'intent'}:agent-a/item`,
        data, protocol_revision: AUTHORITY_IDENTITY },
    });
    const evidence = buildEvidenceFrame({
      streamId: workspace.identity.body_stream, utc: UTC, head: snapshot.heads.body,
      subject: source.payload.subject as string, eventKind: data.type as string, dataHash: hashValue(PARTICLE_DOMAIN, data),
      referenceHashes: [...new Set([source.frame_hash, source.payload_hash, ...refs])].sort(),
    });
    const after = await workspace.compareAndAppend({ expectedHeads: snapshot.heads, frames: [source, evidence] });
    return { source, evidence, proof: proof(after, source, evidence) };
  }
  const scope = { agent_id: 'agent-a', workspace_id: 'workspace-a', task_id: 'task-a' };
  await append({ type: 'approval.requested', ...scope, approval_id: 'approval-a', principal_id: 'alice',
    operation_hash: operationHash(request), resources: request.resources, expires_utc: request.expires_utc });
  await append({ type: 'approval.decided', ...scope, approval_id: 'approval-a', decision: 'approved', decided_by: 'alice' });
  const intent = await append({ type: 'intent.accepted', ...scope, run_id: 'run-a', intent_id: 'intent-a',
    request, approval_id: 'approval-a' }, [operationHash(request)]);
  async function commit(reservation: PermitReservation): Promise<FrameProof> {
    const snapshot = await workspace.scan();
    const data = reservation.payload.data as JsonObject;
    const source = buildFrame({ kind: 'memory.tool-call', streamId: workspace.identity.memory_stream,
      utc: UTC, head: reservation.expectedMemoryHead, payload: reservation.payload });
    const evidence = buildEvidenceFrame({
      streamId: workspace.identity.body_stream, utc: UTC, head: reservation.expectedBodyHead,
      subject: reservation.payload.subject as string, eventKind: 'intent.permitted', dataHash: hashValue(PARTICLE_DOMAIN, data),
      referenceHashes: [source.frame_hash, source.payload_hash, intent.source.frame_hash, intent.source.payload_hash, operationHash(request)].sort(),
    });
    const committed = await workspace.compareAndAppend({
      expectedHeads: { ...snapshot.heads, body: reservation.expectedBodyHead, memory: reservation.expectedMemoryHead },
      frames: [source, evidence],
    });
    return proof(committed, source, evidence);
  }
  return {
    root, security, capability, workspace, store, request, intent, commit, createAuthority, grant,
    enableFault(value = true) { faultEnabled = value; },
  };
}

describe('real filesystem-backed approval/permit commit integration', () => {
  it('permits one effect only after atomic reservation readback; reopening never reissues it', async () => {
    const f = await setup();
    let executions = 0;
    const input = { request: f.request, intent: f.intent.proof, approvalId: 'approval-a', commit: f.commit };
    const results = await Promise.allSettled([
      f.security.issuePermit(f.capability, input), f.security.issuePermit(f.capability, input),
    ]);
    const won = results.find((result) => result.status === 'fulfilled');
    if (!won || won.status !== 'fulfilled') throw new Error('No permit committed');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(executions).toBe(0);
    const claims = f.security.consumePermit(won.value, f.request);
    expect(claims.executionLocation).toBe('guest');
    executions++;
    expect(() => f.security.consumePermit(won.value, f.request)).toThrow();
    expect(executions).toBe(1);
    const scan = await f.workspace.scan();
    expect(scan.streams.memory.frames.filter((frame) => (frame.payload.data as JsonObject).type === 'intent.permitted')).toHaveLength(1);
    const freshAuthority = f.createAuthority();
    const principal = await freshAuthority.authenticate(null);
    const capability = await freshAuthority.authorize(principal, f.grant);
    const reopened = await (await WorkspaceStore.open({ root: resolve(f.root, 'store'), security: freshAuthority })).open(capability);
    const latest = proof(await reopened.scan(), f.intent.source, f.intent.evidence);
    await expect(freshAuthority.issuePermit(capability, { ...input, intent: latest })).rejects.toMatchObject({ code: 'already-reserved' });
    expect(executions).toBe(1);
    expect(scan.heads.memory?.frame_hash).not.toBe(frameHead(f.intent.source).frame_hash);
  });
  it.each(['before-commit', 'manifest-written'] as CrashPoint[])('releases zero executable permits if persistence fails at %s', async (point) => {
    const f = await setup(point);
    let executions = 0;
    f.enableFault();
    await expect(f.security.issuePermit(f.capability, {
      request: f.request, intent: f.intent.proof, approvalId: 'approval-a', commit: f.commit,
    }).then((permit) => { f.security.consumePermit(permit, f.request); executions++; })).rejects.toBeDefined();
    expect(executions).toBe(0);
    f.enableFault(false);
    const scanned = await (await f.store.open(f.capability)).scan();
    const permitted = scanned.streams.memory.frames.filter((frame) => (frame.payload.data as JsonObject).type === 'intent.permitted');
    expect(permitted).toHaveLength(point === 'manifest-written' ? 1 : 0);
    if (point === 'manifest-written') {
      await expect(f.security.issuePermit(f.capability, {
        request: f.request, intent: proof(scanned, f.intent.source, f.intent.evidence), approvalId: 'approval-a', commit: f.commit,
      })).rejects.toMatchObject({ code: 'already-reserved' });
    }
    expect(executions).toBe(0);
  });
});
