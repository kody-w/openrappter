import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/common.mjs';
import { readMigrationPlan, validateMigrationPlan, verifySelectedImport } from '../src/migration-contract.mjs';
import { negative, put, scratch } from './helpers.mjs';

function planFixture() {
  const bytes = Buffer.from('[{"content":"Reviewed source data"}]');
  const sourceId = sha256('synthetic-source');
  const sourceHash = sha256(bytes);
  const content = JSON.stringify({
    schema: 'rapp-work.inert-import/v1', sourceHash, sourceModifiedAt: '2026-09-11T12:00:00.000Z',
    kind: 'memory', data: { kind: 'memory', content: 'Reviewed source data', tags: [], trusted: false },
  });
  const targetPath = `imports/${sourceHash}-${sha256(sourceId)}-0.json`;
  const item = {
    recordId: `${sourceId}:0`, targetPath, content, sha256: sha256(content),
    proposedEvent: {
      type: 'migration.import.proposed', sourceHash, sourceModifiedAt: '2026-09-11T12:00:00.000Z',
      plannedAt: '2026-09-11T12:30:00.000Z', targetPath, artifactHash: sha256(content), kind: 'memory', reviewRequired: true,
    },
  };
  return {
    plan: { schema: 'rapp-work.import-plan/v1', mode: 'review-only', authoritative: false, requiresAuthorization: true, target: { agentId: 'agent-a', workspaceId: 'workspace-a' }, items: [item], sourceDisposition: 'leave-unchanged' },
    sources: new Map([[sourceId, bytes]]),
  };
}

function editContent(plan, update) {
  const modified = structuredClone(plan);
  const content = JSON.parse(modified.items[0].content);
  update(content);
  modified.items[0].content = JSON.stringify(content);
  modified.items[0].sha256 = sha256(modified.items[0].content);
  modified.items[0].proposedEvent.artifactHash = modified.items[0].sha256;
  return modified;
}

test('an inert review-only plan binds exact selected bytes and never grants authority', () => {
  const { plan, sources } = planFixture();
  assert.deepEqual(verifySelectedImport(plan, sources), plan);
  sources.set([...sources.keys()][0], Buffer.from('changed after review'));
  assert.throws(() => verifySelectedImport(plan, sources), /changed after review/u);
});

test('execution, approvals, schedules, capabilities and claimed authority are rejected', () => {
  const { plan } = planFixture();
  for (const field of ['principal', 'capability', 'command', 'approval', 'schedule', 'providerConfig']) {
    assert.throws(() => validateMigrationPlan({ ...plan, [field]: 'untrusted' }), /unexpected or missing fields/u);
    assert.throws(() => validateMigrationPlan(editContent(plan, content => { content.data[field] = 'untrusted'; })), /unexpected or missing fields/u);
  }
  for (const [field, value] of [['authoritative', true], ['requiresAuthorization', false], ['sourceDisposition', 'delete'], ['mode', 'execute']]) {
    assert.throws(() => validateMigrationPlan({ ...plan, [field]: value }), /review-only proposals/u);
  }
  assert.throws(() => validateMigrationPlan(editContent(plan, content => { content.data.trusted = true; })), /remain untrusted/u);
});

test('executable, credential, hidden and traversal destinations cannot become import paths', () => {
  const { plan } = planFixture();
  for (const targetPath of negative.unsupportedSources) {
    const invalid = structuredClone(plan);
    invalid.items[0].targetPath = targetPath;
    assert.throws(() => validateMigrationPlan(invalid), /import path|Path traversal|Absolute paths|Unsafe relative/u, targetPath);
  }
});

test('credentials, malformed dates, duplicate records and unbound events are rejected', () => {
  const { plan } = planFixture();
  for (const text of [`api_key=${'x'.repeat(24)}`, `Authorization: Bearer ${'x'.repeat(24)}`, `sk-${'x'.repeat(24)}`]) {
    assert.throws(() => validateMigrationPlan(editContent(plan, content => { content.data.content = text; })), /unredacted credential/u);
  }
  assert.throws(() => validateMigrationPlan(editContent(plan, content => { content.sourceModifiedAt = '2026-02-30T12:00:00.000Z'; })), /exact UTC instant/u);
  assert.throws(() => validateMigrationPlan({ ...plan, items: [...plan.items, ...plan.items] }), /IDs must be unique/u);
  const unbound = structuredClone(plan);
  unbound.items[0].proposedEvent.reviewRequired = false;
  assert.throws(() => validateMigrationPlan(unbound), /exact reviewed data/u);
  assert.throws(() => verifySelectedImport(plan, new Map()), /selection must match/u);
});

test('only an explicitly selected regular plan file is read and sources are retained', async t => {
  const root = await scratch(t);
  const { plan } = planFixture();
  const filename = await put(root, 'plan.json', plan);
  assert.deepEqual(await readMigrationPlan(filename), plan);
  const link = path.join(root, 'linked.json');
  await symlink(filename, link);
  await assert.rejects(readMigrationPlan(link), /ELOOP/u);
  assert.deepEqual(await readMigrationPlan(filename), plan);
});
