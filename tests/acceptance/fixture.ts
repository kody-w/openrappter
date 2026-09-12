import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import {
  buildFrame, frameHead, hashValue, PARTICLE_DOMAIN, type JsonObject, type RappFrame,
} from '@rapp-work/rapp1';
import { PERMISSIONS, SecurityAuthority, type Capability } from '@rapp-work/security';
import { isWorkspaceSnapshot, WorkspaceStore, type AgentWorkspace, type WorkspaceSnapshot } from '@rapp-work/workspace-store';
import {
  WorkService, type CanonicalPort, type WorkAuthorizationPort, type WorkspaceHistoryPort, type WorkspaceScope,
} from '@rapp-work/work-service';

export const scopeA = { agentId: 'agent-a', workspaceId: 'workspace-a' };
export const scopeB = { agentId: 'agent-b', workspaceId: 'workspace-b' };
export const computerScope = { agentId: 'computer-agent', workspaceId: 'computer-history' };
const owners = new Map([scopeA, scopeB, computerScope].map(scope => [scope.agentId, scope.workspaceId]));

export async function workspaceFixture() {
  const root = path.resolve('tests/.test-scratch', randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const security = new SecurityAuthority({
    authenticate: credential => credential === 'test-owner'
      ? { id: 'test-owner', kind: 'human', expiresAt: Date.now() + 180_000 } : null,
    authorize: (principal, request) => principal.id === 'test-owner' && owners.get(request.agentId) === request.workspaceId,
    executionPolicy: () => ({ allowed: false, requiresApproval: true }),
  });
  const principal = await security.authenticate('test-owner');
  const store = await WorkspaceStore.open({ root: path.join(root, 'store'), security });
  const capabilities = new Map<string, Capability>();
  const workspaces = new Map<string, AgentWorkspace>();
  for (const scope of [scopeA, scopeB, computerScope]) {
    const resources = new Set([
      `agent:${scope.agentId}`, `workspace:${scope.workspaceId}`, 'task:task-1', 'run:run-1',
    ]);
    if (scope === computerScope) {
      for (const resource of ['computer:work-computer', `agent:${scopeA.agentId}`, `workspace:${scopeA.workspaceId}`]) resources.add(resource);
    }
    const capability = await security.authorize(principal, {
      ...scope, taskId: null, permissions: [...PERMISSIONS],
      resources: [...resources].sort(), expiresAt: Date.now() + 120_000,
    });
    capabilities.set(scope.workspaceId, capability);
    workspaces.set(scope.workspaceId, await store.create(capability, { owner: 'test-owner', slug: scope.agentId }));
  }
  const faults = { writes: false, rejectedWrites: 0 };
  const createWork = (selectedStore: WorkspaceStore) => {
    const canonical: CanonicalPort = {
      digest: value => hashValue(PARTICLE_DOMAIN, value),
      scan(raw, scope) {
        if (!isWorkspaceSnapshot(raw)) throw new Error('Acceptance requires real scanned workspace frames');
        if (raw.identity.agent_id !== scope.agentId || raw.identity.workspace_id !== scope.workspaceId) throw new Error('Wrong frame owner');
        return {
          scope,
          heads: { body: raw.heads.body?.frame_hash ?? null, memory: raw.heads.memory?.frame_hash ?? null, swarm: raw.heads.swarm?.frame_hash ?? null },
          frames: (['body', 'memory', 'swarm'] as const).flatMap(stream => raw.streams[stream].frames.map(frame => ({
            ref: frame.frame_hash, stream, value: frame.payload,
          }))),
        };
      },
    };
    const queues = new Map<string, Promise<unknown>>();
    const history: WorkspaceHistoryPort = {
      withExclusive(capability, scope, action) {
        security.assertCapability(capability as Capability, 'workspace.read', { ...scope, taskId: null });
        const pending = (queues.get(scope.workspaceId) ?? Promise.resolve()).then(async () => {
          const workspace = await selectedStore.open(capability as Capability);
          return action({
            readCommitted: () => workspace.scan(),
            async append(events, heads) {
              if (faults.writes) {
                faults.rejectedWrites += 1;
                throw new Error('Injected persistence unavailable');
              }
              const before = await workspace.scan();
              expect({ body: before.heads.body?.frame_hash ?? null, memory: before.heads.memory?.frame_hash ?? null, swarm: before.heads.swarm?.frame_hash ?? null }).toEqual(heads);
              let head = before.heads.body;
              const frames: RappFrame[] = [];
              for (const event of events) {
                const frame = buildFrame({
                  kind: 'body.pulse', streamId: before.identity.body_stream, head,
                  utc: new Date().toISOString(), payload: event as JsonObject,
                });
                frames.push(frame);
                head = frameHead(frame);
              }
              await workspace.compareAndAppend({ expectedHeads: before.heads, frames });
            },
          });
        });
        queues.set(scope.workspaceId, pending.then(() => undefined, () => undefined));
        return pending;
      },
    };
    const authorization: WorkAuthorizationPort = {
      async authorizeRead(capability, scope) {
        security.assertCapability(capability as Capability, 'workspace.read', { ...scope, taskId: null });
      },
      async authorizeCommand(capability, request) {
        const grant = security.assertCapability(capability as Capability, 'workspace.append', { ...request.command.scope, taskId: null },
          request.command.resources.map(resource => `${resource.kind}:${resource.id}`));
        return { principalId: grant.principal.id };
      },
      async issuePermit(capability, request) {
        security.assertCapability(capability as Capability, 'workspace.append', { ...request.command.scope, taskId: null });
        const committed: WorkspaceSnapshot = await (await selectedStore.open(capability as Capability)).scan();
        if (!committed.streams.body.frames.some(frame => frame.frame_hash === request.intentRef)) throw new Error('No durable write-ahead frame');
        // This test port authorizes inert data effects, never a real guest or host executor.
        return Object.freeze({ intentRef: request.intentRef });
      },
    };
    return new WorkService({ history, canonical, authorization });
  };
  return {
    root, store, security, capabilities, workspaces, faults, work: createWork(store),
    async rebuild() {
      const recoveredRoot = path.join(root, 'recovered');
      await mkdir(recoveredRoot, { mode: 0o700 });
      for (const scope of [scopeA, scopeB, computerScope]) {
        const source = path.join(root, 'store', scope.workspaceId);
        const destination = path.join(recoveredRoot, scope.workspaceId);
        await mkdir(destination, { mode: 0o700 });
        for (const name of ['identity.json', 'manifest.json', 'frames']) await cp(path.join(source, name), path.join(destination, name), { recursive: true });
        for (const name of ['artifacts', 'imports']) await mkdir(path.join(destination, name), { mode: 0o700 });
      }
      return createWork(await WorkspaceStore.open({ root: recoveredRoot, security }));
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
