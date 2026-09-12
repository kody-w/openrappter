import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_IDENTITY, buildEvidenceFrame, buildFrame, canonicalJson, frameHead, hashValue, PARTICLE_DOMAIN,
  scanChain, selectChainTrust, type JsonObject, type RappFrame, type VerifiedChain,
} from '@rapp-work/rapp1';
import {
  approvalFromFrames, artifactPath, operationHash, SecurityAuthority, validateOperation,
  type CapabilityRequest, type FrameProof, type OperationRequest, type PermitReservation,
} from '../src/index.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const UTC = new Date(NOW).toISOString();
const BODY = `rappid:@alice/worker:${'a'.repeat(64)}`, MEMORY = `${BODY}:work`;
const scope = { agentId: 'agent-a', workspaceId: 'workspace-a', taskId: 'task-a' };
const resources = ['computer:omarchy', 'guest-path:reports/output.txt'];
const request: OperationRequest = {
  schema: 'rapp-work/operation/1', operation_id: 'operation-a', principal_id: 'alice',
  agent_id: scope.agentId, workspace_id: scope.workspaceId, task_id: 'task-a', run_id: 'run-a',
  operation: 'guest.files.write', resources, params: { path: 'reports/output.txt', text: 'report' },
  expires_utc: new Date(NOW + 30_000).toISOString(),
};
function scan(frames: RappFrame[]): VerifiedChain {
  const first = frames[0]!, last = frames.at(-1)!;
  const result = scanChain(frames, selectChainTrust({
    genesis: { stream_id: first.stream_id, payload_hash: first.payload_hash, frame_hash: first.frame_hash },
    persistedHead: frameHead(last), requireCommittedHead: true,
  }));
  if (!result.ok) throw result.error;
  return result;
}
class History {
  memory: RappFrame[] = [];
  body: RappFrame[] = [];
  writes = 0;
  add(data: JsonObject, references: string[] = [], evidence = true) {
    const subject = data.type === 'approval.requested' || data.type === 'approval.decided'
      ? `approval:${data.agent_id}/${data.approval_id}` : `intent:${data.agent_id}/${data.task_id}/${data.run_id}/${data.intent_id}`;
    const payload = { subject, data, protocol_revision: AUTHORITY_IDENTITY };
    return this.append(payload, references, evidence);
  }
  append(payload: JsonObject, references: string[], emitEvidence = true) {
    const data = payload.data as JsonObject;
    const source = buildFrame({
      kind: data.type === 'approval.requested' ? 'memory.save' : 'memory.tool-call', streamId: MEMORY, utc: UTC,
      head: this.memory.length ? frameHead(this.memory.at(-1)!) : null, payload,
    });
    this.memory.push(source);
    if (emitEvidence) {
      const evidence = buildEvidenceFrame({
        streamId: BODY, utc: UTC, head: this.body.length ? frameHead(this.body.at(-1)!) : null,
        subject: payload.subject as string, eventKind: data.type as string, dataHash: hashValue(PARTICLE_DOMAIN, data),
        referenceHashes: [...new Set([source.frame_hash, source.payload_hash, ...references])].sort(),
      });
      this.body.push(evidence);
    }
    return source;
  }
  proof(source: RappFrame): FrameProof {
    const evidence = this.body.find((frame) => (frame.payload.reference_hashes as string[]).includes(source.frame_hash))!;
    return { body: scan(this.body), memory: scan(this.memory), sourceFrameHash: source.frame_hash, evidenceFrameHash: evidence.frame_hash };
  }
  commit = async (reservation: PermitReservation): Promise<FrameProof> => {
    if (canonicalJson(reservation.expectedBodyHead) !== canonicalJson(frameHead(this.body.at(-1)!))
      || canonicalJson(reservation.expectedMemoryHead) !== canonicalJson(frameHead(this.memory.at(-1)!))) throw new Error('cas-conflict');
    const data = reservation.payload.data as JsonObject;
    const intent = this.memory.find((frame) => frame.frame_hash === data.intent_frame_hash)!;
    const source = this.append(reservation.payload, [intent.frame_hash, intent.payload_hash, data.operation_hash as string]);
    this.writes++;
    return this.proof(source);
  };
}
async function fixture(options: {
  approval?: boolean; requiresApproval?: boolean; decision?: 'approved' | 'denied'; missingDecisionEvidence?: boolean;
} = {}) {
  let clock = NOW;
  const security = new SecurityAuthority({
    authenticate: (credential) => credential === 'authenticated' ? { id: 'alice', kind: 'human', expiresAt: NOW + 120_000 } : null,
    authorize: (principal, value) => principal.id === 'alice' && value.agentId === 'agent-a' && value.workspaceId === 'workspace-a',
    executionPolicy: () => ({ allowed: true, requiresApproval: options.requiresApproval ?? true }),
    now: () => clock,
  });
  const principal = await security.authenticate('authenticated');
  const grant: CapabilityRequest = { ...scope, permissions: ['run.execute', 'workspace.read'], resources, expiresAt: NOW + 60_000 };
  const capability = await security.authorize(principal, grant);
  const history = new History();
  const approvalId = options.approval === false ? null : 'approval-a';
  if (approvalId !== null) {
    history.add({
      type: 'approval.requested', agent_id: scope.agentId, workspace_id: scope.workspaceId, task_id: 'task-a',
      approval_id: approvalId, principal_id: 'alice', operation_hash: operationHash(request), resources,
      expires_utc: new Date(NOW + 15_000).toISOString(),
    });
    history.add({
      type: 'approval.decided', agent_id: scope.agentId, workspace_id: scope.workspaceId, task_id: 'task-a',
      approval_id: approvalId, decision: options.decision ?? 'approved', decided_by: 'alice',
    }, [], !options.missingDecisionEvidence);
  }
  const intent = history.add({
    type: 'intent.accepted', agent_id: scope.agentId, workspace_id: scope.workspaceId, task_id: 'task-a',
    run_id: 'run-a', intent_id: 'intent-a', request, approval_id: approvalId,
  }, [operationHash(request)]);
  return {
    security, principal, capability, grant, history, intent, approvalId,
    input: { request, intent: history.proof(intent), approvalId, commit: history.commit },
    setClock(value: number) { clock = value; },
  };
}

describe('authenticated principals and opaque least-privilege capabilities', () => {
  it('never treats a claimed identity, resource ID or serialized handle as authority', async () => {
    const f = await fixture();
    await expect(f.security.authenticate('alice')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(() => f.security.inspectPrincipal({ id: 'alice' } as never)).toThrow();
    expect(() => f.security.inspectPrincipal({ ...f.principal })).toThrow();
    expect(() => f.security.inspectCapability({ ...f.capability })).toThrow();
    expect(() => f.security.assertCapability(f.capability, 'run.execute', { ...scope, agentId: 'agent-b' }, resources)).toThrow();
    expect(() => f.security.assertCapability(f.capability, 'run.execute', { ...scope, workspaceId: 'workspace-b' }, resources)).toThrow();
    expect(() => f.security.assertCapability(f.capability, 'run.execute', { ...scope, taskId: 'task-b' }, resources)).toThrow();
    expect(() => f.security.assertCapability(f.capability, 'artifact.write', scope, resources)).toThrow();
    expect(() => f.security.assertCapability(f.capability, 'run.execute', scope, ['computer:other'])).toThrow();
    const other = await fixture();
    expect(() => other.security.inspectCapability(f.capability)).toThrow();
  });
  it('only attenuates scopes and cascades parent/principal revocation', async () => {
    const f = await fixture();
    const child = await f.security.attenuate(f.capability, { ...f.grant, permissions: ['run.execute'], resources: [resources[0]!], expiresAt: NOW + 1000 });
    expect(f.security.inspectCapability(child).permissions).toEqual(['run.execute']);
    for (const patch of [
      { permissions: ['workspace.append'] }, { resources: ['guest-path:another'] }, { taskId: null },
      { agentId: 'other' }, { workspaceId: 'other' }, { expiresAt: NOW + 70_000 },
    ]) await expect(f.security.attenuate(f.capability, { ...f.grant, ...patch } as CapabilityRequest)).rejects.toThrow();
    f.security.revokeCapability(f.capability);
    expect(() => f.security.inspectCapability(child)).toThrow();
    const g = await fixture();
    g.security.revokePrincipal(g.principal);
    expect(() => g.security.inspectCapability(g.capability)).toThrow();
  });
  it('refuses expired identities/grants and a regressing authorization clock', async () => {
    const f = await fixture();
    await expect(f.security.authorize(f.principal, { ...f.grant, expiresAt: NOW })).rejects.toThrow();
    await expect(f.security.authorize(f.principal, { ...f.grant, expiresAt: NOW + 200_000 })).rejects.toThrow();
    f.setClock(NOW + 60_000);
    expect(() => f.security.inspectCapability(f.capability)).toThrow();
    f.setClock(NOW);
    expect(() => f.security.inspectPrincipal(f.principal)).toThrow(/clock/i);
  });
  it('refuses malformed, inherited and accessor options without calling getters', async () => {
    const f = await fixture();
    let called = 0;
    const hostile = Object.defineProperty({ ...f.grant }, 'permissions', { get() { called++; return ['run.execute']; } });
    await expect(f.security.authorize(f.principal, hostile)).rejects.toThrow();
    await expect(f.security.authorize(f.principal, { ...f.grant, resources: ['*'] })).rejects.toThrow();
    await expect(f.security.authorize(f.principal, { ...f.grant, permissions: ['host.shell'] } as never)).rejects.toThrow();
    expect(() => new SecurityAuthority(Object.create({ authenticate() {}, authorize() {} }))).toThrow();
    expect(called).toBe(0);
  });
});

describe('exact operation and approval consumption contracts', () => {
  it.each([
    { operation: 'host.shell' }, { operation: 'shell' }, { agent_id: '' }, { expires_utc: UTC.replace('Z', '+00:00') },
    { resources: ['*'] }, { resources: ['z', 'a'] }, { resources: ['same', 'same'] }, { resources: [] },
    { params: [] }, { params: null }, { extra: true },
  ])('refuses malformed operation %j', (patch) => expect(() => validateOperation({ ...request, ...patch })).toThrow());
  it('binds approved data to the exact principal, agent, workspace, task, run, operation and resources', async () => {
    for (const patch of [
      { principal_id: 'bob' }, { agent_id: 'agent-b' }, { workspace_id: 'workspace-b' },
      { task_id: 'task-b' }, { run_id: 'run-b' }, { operation_id: 'other' },
      { operation: 'guest.shell' }, { params: { path: 'elsewhere', text: 'same?' } },
      { resources: ['computer:omarchy', 'guest-path:another'] },
    ]) {
      const f = await fixture();
      await expect(f.security.issuePermit(f.capability, { ...f.input, request: { ...request, ...patch } as OperationRequest })).rejects.toThrow();
      expect(f.history.writes).toBe(0);
    }
  });
  it('requires real unexpired approval/evidence instead of wire booleans', async () => {
    const absent = await fixture({ approval: false });
    await expect(absent.security.issuePermit(absent.capability, absent.input)).rejects.toMatchObject({ code: 'approval-required' });
    const denied = await fixture({ decision: 'denied' });
    await expect(denied.security.issuePermit(denied.capability, denied.input)).rejects.toMatchObject({ code: 'approval-binding' });
    const missingEvidence = await fixture({ missingDecisionEvidence: true });
    await expect(missingEvidence.security.issuePermit(missingEvidence.capability, missingEvidence.input)).rejects.toMatchObject({ code: 'approval-evidence' });
    const expired = await fixture();
    expired.setClock(NOW + 15_000);
    await expect(expired.security.issuePermit(expired.capability, expired.input)).rejects.toMatchObject({ code: 'approval-binding' });
    expect(expired.history.writes).toBe(0);
  });
  it('rebuilds the approval from frames alone and consumes it in exactly one canonical receipt', async () => {
    const f = await fixture();
    const before = approvalFromFrames(scan(f.history.memory), scan(f.history.body), 'approval-a');
    expect(before).toMatchObject({ decision: 'approved', consumedBy: null, operationHash: operationHash(request) });
    const permit = await f.security.issuePermit(f.capability, f.input);
    const after = approvalFromFrames(scan(f.history.memory), scan(f.history.body), 'approval-a');
    const claims = f.security.consumePermit(permit, request);
    expect(after.consumedBy).toBe(claims.permitId);
    expect(claims.expiresAt).toBe(NOW + 15_000);
    expect(claims).toMatchObject({ computer: 'omarchy', executionLocation: 'guest', intentFrameHash: f.intent.frame_hash });
    expect(() => f.security.consumePermit(permit, request)).toThrow();
    expect(() => f.security.consumePermit({ ...permit }, request)).toThrow();
    expect(f.history.memory.filter((frame) => (frame.payload.data as JsonObject).type === 'intent.permitted')).toHaveLength(1);
    await expect(f.security.issuePermit(f.capability, { ...f.input, intent: f.history.proof(f.intent) })).rejects.toMatchObject({ code: 'already-reserved' });
  });
  it('refuses decision replay and approvals lacking a canonical request', async () => {
    const f = await fixture();
    f.history.add({
      type: 'approval.decided', agent_id: scope.agentId, workspace_id: scope.workspaceId, task_id: 'task-a',
      approval_id: 'approval-a', decision: 'approved', decided_by: 'alice',
    });
    expect(() => approvalFromFrames(scan(f.history.memory), scan(f.history.body), 'approval-a')).toThrow();
    const fresh = await fixture({ approval: false, requiresApproval: false });
    expect(() => approvalFromFrames(scan(fresh.history.memory), scan(fresh.history.body), 'made-up')).toThrow();
  });
});

describe('execution permits fail closed around every async boundary', () => {
  it('may waive an approval only via explicit host execution policy, never the request', async () => {
    const f = await fixture({ approval: false, requiresApproval: false });
    const permit = await f.security.issuePermit(f.capability, f.input);
    expect(f.security.consumePermit(permit, request).expiresAt).toBe(NOW + 30_000);
  });
  it('rejects a foreign/unscanned intent or changed source with zero writes', async () => {
    const f = await fixture();
    await expect(f.security.issuePermit(f.capability, {
      ...f.input, intent: { ...f.input.intent, memory: { ...f.input.intent.memory } },
    })).rejects.toMatchObject({ code: 'untrusted-intent' });
    await expect(f.security.issuePermit(f.capability, {
      ...f.input, intent: { ...f.input.intent, sourceFrameHash: '0'.repeat(64) },
    })).rejects.toMatchObject({ code: 'intent-missing' });
    expect(f.history.writes).toBe(0);
  });
  it('does not mint on persistence error, unscanned readback or a substituted receipt', async () => {
    const f = await fixture();
    await expect(f.security.issuePermit(f.capability, { ...f.input, commit: async () => { throw new Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
    await expect(f.security.issuePermit(f.capability, { ...f.input, commit: async () => f.input.intent })).rejects.toMatchObject({ code: 'commit-binding' });
    await expect(f.security.issuePermit(f.capability, {
      ...f.input, commit: async () => ({ ...f.input.intent, body: { ...f.input.intent.body } }),
    })).rejects.toMatchObject({ code: 'commit-proof' });
    expect(f.history.writes).toBe(0);
  });
  it('rechecks revocation and expiry after persistence, without releasing an executable handle', async () => {
    const f = await fixture();
    await expect(f.security.issuePermit(f.capability, {
      ...f.input, commit: async (reservation) => {
        const result = await f.history.commit(reservation); f.setClock(NOW + 15_000); return result;
      },
    })).rejects.toMatchObject({ code: 'expired' });
    expect(f.history.writes).toBe(1);
    const g = await fixture();
    await expect(g.security.issuePermit(g.capability, {
      ...g.input, commit: async (reservation) => {
        const result = await g.history.commit(reservation); g.security.revokeCapability(g.capability); return result;
      },
    })).rejects.toMatchObject({ code: 'capability' });
  });
  it('clamps permit expiry and checks it at the single-use consume boundary', async () => {
    const f = await fixture();
    const permit = await f.security.issuePermit(f.capability, f.input);
    expect(() => f.security.consumePermit(permit, { ...request, params: { changed: true } })).toThrow();
    f.setClock(NOW + 15_000);
    expect(() => f.security.consumePermit(permit, request)).toThrow();
  });
  it('uses a single CAS receipt for two competing permit issuers', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.security.issuePermit(f.capability, f.input), f.security.issuePermit(f.capability, f.input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.history.writes).toBe(1);
  });
  it('uses strict capability paths consistently with workspace and domain contracts', () => {
    expect(artifactPath('reports/2026-09.txt')).toBe('reports/2026-09.txt');
    for (const path of ['../x', '/x', 'a//b', 'a\\b', '%2e%2e/x', 'C:/host']) expect(() => artifactPath(path)).toThrow();
  });
});
