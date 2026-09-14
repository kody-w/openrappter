import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../dist/canonical.js';
import { HeadlessRuntime } from '../dist/runtime.js';
import { MigrationService } from '../dist/migration.js';
import { migrationPlan, verifyMigrationApproval, verifyRootFiles } from '../dist/migration-contract.js';
import { nativeMetadataPointer } from '../dist/native-metadata.js';
import { migrationFixture, sourceInventory } from './migration-fixture.mjs';
import { runObservedMigration } from './migration-harness.mjs';
import { migrationReplayHtml } from '../scripts/migration-replay.mjs';

const base = fileURLToPath(new URL('../.test-scratch/migration-unit/', import.meta.url));
await mkdir(base, { recursive: true, mode: 0o700 });
let id = 0;
async function fixture() {
  const folder = path.join(base, `case-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const source = await migrationFixture(path.join(folder, 'source'));
  const runtime = await HeadlessRuntime.open({ directory: path.join(folder, 'destination'), ...source.keys });
  const service = new MigrationService(runtime.bots, { plan: source.plan, approvalBytes: canonicalJson(source.approval),
    signatures: source.keys.signatures, fixtureAuthority: true, capabilityHash: sha256('a'.repeat(43)) });
  return { folder, source, runtime, service };
}

test('a complete observed estate migration launches the new application and passive client using public operations only', async () => {
  const result = await runObservedMigration();
  assert.equal(result.evidence.fixtureGate, 'passed');
  assert.equal(result.evidence.observedUniqueItems, 23);
  assert.equal(result.evidence.observedWorlds, 10);
  assert.equal(result.evidence.actual.roots, 2);
  assert.equal(result.evidence.actual.scopes, 44);
  assert.equal(result.evidence.actual.pointers, 21);
  assert.equal(result.evidence.destinationWritesByHarness, 0);
  assert.equal(result.evidence.unpublishedMaterializationFaultExercised, true);
  assert.equal(result.evidence.serviceAndProjectionRestartIdentical, true);
  assert.equal(result.evidence.sourceFilesCompared, 45);
  assert.equal(result.evidence.actual.branches, 2);
  assert.equal(result.evidence.originalScopedStreamsPreserved, 2);
  assert.equal(result.evidence.originalSourceBranchesPreserved, 1);
  assert.equal(result.evidence.legacySourceOccurrencesHonestAndUnchanged, 1);
  assert(result.evidence.sourceDirectoriesCompared > 0);
  assert(result.evidence.canonical.framesScanned > 0);
  assert.equal(result.evidence.canonical.verdict, 'COMPLIANT');
  const html = migrationReplayHtml(result.evidence, result.record.displays);
  assert(html.includes('scoutTheme'));
  assert(html.includes('--cp-bg: #f7f4ef;'));
  assert(!/src=["']https?:|href=["']https?:|@import|fetch\(/u.test(html));
});

test('migration requires exact signed selection and refuses controlled-local data under fixture authority', async () => {
  const f = await fixture();
  assert.throws(() => f.service.authenticate(f.source.plan.owner, 'skill.md'), { code: 'migration-unauthorized' });
  assert.throws(() => f.service.authenticate(f.source.roots[1], 'a'.repeat(43)), { code: 'migration-unauthorized' });
  const modified = migrationPlan({ ...f.source.plan, expected: { ...f.source.plan.expected, roots: 3 } });
  assert.throws(() => verifyMigrationApproval(modified, canonicalJson(f.source.approval), f.source.keys.signatures, true), { code: 'migration-authority' });
  assert.throws(() => verifyMigrationApproval(f.source.plan, canonicalJson(f.source.approval), f.source.keys.signatures, false), { code: 'migration-adoption-unavailable' });
  assert.equal((await f.runtime.bots.list()).length, 0);
});

test('incomplete closure, changed chunks, path escape and aborted-batch replay cannot create a root', async () => {
  const f = await fixture();
  const root = f.source.plan.items.find(i => i.kind === 'canonical-root');
  await f.service.begin('bind');
  await f.service.startBatch('partial', [root.id], 'batch');
  const file = root.files[0];
  const bytes = f.source.sourceByItem.get(root.id).files.get(file.path);
  const input = { batch: 'partial', item: root.id, path: file.path, index: 0, base64: bytes.toString('base64') };
  await f.service.stage(input, 'stage');
  assert.equal((await f.service.stage(input, 'retry-stage')).duplicate, true);
  const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1;
  await assert.rejects(f.service.stage({ ...input, base64: changed.toString('base64') }, 'changed'), { code: 'idempotency-conflict' });
  await assert.rejects(f.service.stage({ ...input, path: '../outside' }, 'escape'), { code: 'migration-chunk' });
  await assert.rejects(f.service.prepare('partial', root.id, 'prepare'), { code: 'migration-incomplete' });
  await f.service.rollback('partial', 'Keep inactive evidence; do not create a partial bot.', 'rollback');
  await assert.rejects(f.service.commit('partial', root.id), { code: 'migration-batch' });
  assert.equal((await f.runtime.bots.list()).length, 0);
});

test('source GUID and frame bytes cannot be rewritten or filtered into compatibility', async () => {
  const f = await fixture();
  const root = f.source.plan.items.find(i => i.kind === 'canonical-root');
  const files = f.source.sourceByItem.get(root.id).files;
  assert.throws(() => verifyRootFiles(f.source.roots[1], files, f.source.keys.signatures), { code: 'migration-root' });
  const changed = new Map(files);
  const body = JSON.parse(changed.get('body/frames/000000000000.json'));
  body.payload.name = 'Changed without authority';
  changed.set('body/frames/000000000000.json', Buffer.from(canonicalJson(body)));
  assert.throws(() => verifyRootFiles(root.root, changed, f.source.keys.signatures), { code: 'canonical-integrity' });
  const before = await sourceInventory(path.join(f.folder, 'source'), true);
  assert.equal((await f.service.projection()).counts.roots, 0);
  assert.deepEqual(await sourceInventory(path.join(f.folder, 'source'), true), before);
});

test('native provider adapters accept selected native metadata only and never private content fields', () => {
  const pointer = nativeMetadataPointer('copilot', { session_id: 'selected', title: 'Selected Copilot', cwd_reference: 'opaque-cwd' });
  assert.equal(pointer.locator, 'native://copilot/session/selected');
  assert.throws(() => nativeMetadataPointer('copilot', { session_id: 'selected', title: 'Selected', cwd_reference: 'opaque', transcript: 'PRIVATE' }), { code: 'contract' });
  assert.throws(() => nativeMetadataPointer('claude', { project_key: '../private', session: { uuid: 'session', title: 'Selected' } }), { code: 'native-handle' });
  assert.throws(() => nativeMetadataPointer('hermes', { session: { id: 'selected', title: 'Selected', workspace_reference: 'opaque', content: 'PRIVATE' } }), { code: 'contract' });
});
