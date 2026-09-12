import { WorkspaceStore } from '../dist/index.js';
import { SecurityAuthority } from '@rapp-work/security';
import { buildFrame, frameHead } from '@rapp-work/rapp1';

const [root, mode, label] = process.argv.slice(2);
const security = new SecurityAuthority({
  authenticate: (credential) => credential === 'test-host' ? { id: 'alice', kind: 'human', expiresAt: Date.now() + 60_000 } : null,
  authorize: (principal, request) => principal.id === 'alice' && request.agentId === 'agent-a' && request.workspaceId === 'workspace-a',
  executionPolicy: () => ({ allowed: false, requiresApproval: true }),
});
const principal = await security.authenticate('test-host');
const capability = await security.authorize(principal, {
  agentId: 'agent-a', workspaceId: 'workspace-a', taskId: null,
  permissions: ['workspace.read', 'workspace.append'],
  resources: ['workspace:workspace-a'], expiresAt: Date.now() + 30_000,
});
const store = await WorkspaceStore.open({
  root, security,
  fault: mode.startsWith('crash:') ? (point) => { if (point === mode.slice(6)) process.exit(86); } : undefined,
});
const workspace = await store.open(capability);
const snapshot = await workspace.scan();
const first = buildFrame({
  kind: 'memory.save', streamId: workspace.identity.memory_stream, head: snapshot.heads.memory,
  utc: '2026-09-11T12:00:00.000Z', payload: { worker: label ?? 'crash', step: 1 },
});
const second = buildFrame({
  kind: 'memory.tool-call', streamId: workspace.identity.memory_stream, head: frameHead(first),
  utc: first.utc, payload: { worker: label ?? 'crash', step: 2 },
});
const body = buildFrame({
  kind: 'body.pulse', streamId: workspace.identity.body_stream, head: snapshot.heads.body,
  utc: first.utc, payload: { worker: label ?? 'crash' },
});
if (mode === 'compete') {
  process.send({ ready: true });
  await new Promise((resolve) => process.once('message', resolve));
}
try {
  await workspace.compareAndAppend({ expectedHeads: snapshot.heads, frames: [first, second, body] });
  process.send?.({ result: 'committed' });
} catch (error) {
  process.send?.({ result: error.code ?? error.message });
}
process.disconnect?.();
