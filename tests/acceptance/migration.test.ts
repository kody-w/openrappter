import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileInertLegacyReader, LegacyMigration } from '@rapp-work/migration';
import { validateMigrationPlan } from '../../packages/release/src/migration-contract.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = path.resolve('tests/.test-scratch', randomUUID());
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'agents.json'), JSON.stringify([{ name: 'Imported analyst', instructions: 'Review selected records.', enabled: true, tools: ['host.shell'], workspaceId: 'forged', code: 'throw new Error("must not run")' }]), { mode: 0o600 });
  await writeFile(path.join(root, 'tasks.json'), JSON.stringify([{ title: 'Imported task', description: 'Unverified source data.', status: 'completed' }]), { mode: 0o600 });
  await writeFile(path.join(root, 'memories.json'), JSON.stringify([{ content: 'Imported note', trusted: true }]), { mode: 0o600 });
  const migration = new LegacyMigration(new FileInertLegacyReader());
  const inventory = await migration.inventory([root]);
  return { root, migration, inventory };
}

it('real migration plans satisfy the sanitized contract without restoring executable or completed state', async () => {
  const { root, migration, inventory } = await setup();
  const before = await readFile(path.join(root, 'agents.json'), 'utf8');
  const plan = await migration.plan(inventory, inventory.records.map(record => record.id), { agentId: 'agent-a', workspaceId: 'workspace-a' });
  const checked = validateMigrationPlan(plan);
  expect(checked.authoritative).toBe(false);
  expect(checked.requiresAuthorization).toBe(true);
  const imported = checked.items.map(item => JSON.parse(item.content));
  expect(imported.find(item => item.kind === 'agent').data).toEqual({
    kind: 'agent', name: 'Imported analyst', instructions: 'Review selected records.', enabled: false, policyReviewRequired: true,
  });
  expect(imported.find(item => item.kind === 'task').data.status).toBe('draft');
  expect(imported.find(item => item.kind === 'memory').data.trusted).toBe(false);
  expect(await readFile(path.join(root, 'agents.json'), 'utf8')).toBe(before);
});

it('real migration refuses changed sources and its contract rejects credentials before import', async () => {
  const { root, migration, inventory } = await setup();
  await writeFile(path.join(root, 'memories.json'), JSON.stringify([{ content: `api_key=${'x'.repeat(24)}` }]), { mode: 0o600 });
  await expect(migration.plan(inventory, inventory.records.map(record => record.id), { agentId: 'agent-a', workspaceId: 'workspace-a' })).rejects.toThrow('review_source_changed');
  const refreshed = await migration.inventory([root]);
  const plan = await migration.plan(refreshed, refreshed.records.map(record => record.id), { agentId: 'agent-a', workspaceId: 'workspace-a' });
  expect(() => validateMigrationPlan(plan)).toThrow('unredacted credential');
});
