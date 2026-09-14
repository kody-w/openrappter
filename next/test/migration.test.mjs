import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson, contentHash, createFrameSigner, frameHead, keyedIdentity, rootTail, selectSignaturePolicy, sha256,
} from '../dist/canonical.js';
import {
  CONTROLLED_MIGRATION_AUTHORITY_SCHEMA, CONTROLLED_MIGRATION_HIVE_SCHEMA,
} from '../dist/migration-authority.js';
import { openMigrationService } from '../dist/migration-bootstrap.js';
import { MIGRATION_LIMITS, migrationPlan, verifyMigrationApproval, verifyRootFiles } from '../dist/migration-contract.js';
import { fixtureSigners, sameTailFixtureSigners } from '../dist/fixtures.js';
import { nativeMetadataPointer } from '../dist/native-metadata.js';
import { migrationFixture, minimalRootMigrationFixture, sourceInventory } from './migration-fixture.mjs';
import { runObservedCapacityMigration, runObservedMigration } from './migration-harness.mjs';
import { migrationReplayHtml } from '../scripts/migration-replay.mjs';
import { rootStorageKey } from '../dist/repository.js';
import { memoryFrames } from '../dist/source-memory.js';

const base = fileURLToPath(new URL('../.test-scratch/migration-unit/', import.meta.url));
await mkdir(base, { recursive: true, mode: 0o700 });
let id = 0;
const openFixtureMigration = (directory, source, migrationFault) => openMigrationService({
  directory,
  plan: source.plan,
  approvalBytes: canonicalJson(source.approval),
  authority: { registry: source.keys.registry, signers: source.keys.signers },
  capabilityHash: sha256('a'.repeat(43)),
  ...(migrationFault ? { migrationFault } : {}),
});
async function fixture(options = {}) {
  const { keys, migrationFault } = options;
  const folder = path.join(base, `case-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const source = await migrationFixture(path.join(folder, 'source'), keys ? { keys } : {});
  const { runtime, service } = await openFixtureMigration(path.join(folder, 'destination'), source, migrationFault);
  return { folder, source, runtime, service };
}
async function stageCanonicalRoot(f, batch, item) {
  for (const descriptor of item.files) {
    const bytes = await readFile(path.join(f.source.sourceByItem.get(item.id).directory, descriptor.path));
    for (let index = 0; index < Math.ceil(bytes.length / MIGRATION_LIMITS.chunkBytes); index++) {
      const chunk = bytes.subarray(index * MIGRATION_LIMITS.chunkBytes, (index + 1) * MIGRATION_LIMITS.chunkBytes);
      await f.service.stage({ batch, item: item.id, path: descriptor.path, index, base64: chunk.toString('base64') },
        `stage-${sha256(`${batch}\n${item.id}\n${descriptor.path}\n${index}`)}`);
    }
  }
}

function syntheticOperatorKeys(count = 2) {
  const registry = [];
  const signers = [];
  for (let index = 0; index < count; index++) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const root = keyedIdentity('operator-test', `root-${String(index + 1).padStart(2, '0')}`, publicKey);
    registry.push({
      kid: root,
      spki_der_b64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      revoked_utc: null,
      superseded_utc: null,
    });
    signers.push({ root, signer: createFrameSigner({ kid: root, privateKey }) });
  }
  return { registry, signers, signatures: selectSignaturePolicy(registry) };
}

function controlledAuthority(overrides = {}) {
  return {
    async verify(request) {
      const hive = {
        schema: CONTROLLED_MIGRATION_HIVE_SCHEMA,
        hive: request.rootSelection.at(-1),
        owner: request.owner,
        acceptedPlanHash: request.planHash,
        registrySeq: 17,
        registryCommitment: sha256('synthetic-external-hive-registry'),
        acceptanceWave: sha256('synthetic-external-hive-acceptance'),
        checkpointWave: sha256('synthetic-external-hive-checkpoint'),
        ...(overrides.hive ?? {}),
      };
      return {
        schema: CONTROLLED_MIGRATION_AUTHORITY_SCHEMA,
        owner: request.owner,
        planHash: request.planHash,
        approvalWave: request.approvalWave,
        registryCommitment: request.registryCommitment,
        closureCommitment: request.closureCommitment,
        rootSelection: request.rootSelection,
        ownerAnchorWave: sha256('synthetic-external-owner-anchor'),
        domain: 'both',
        domainDeclarationWave: sha256('synthetic-external-domain-declaration'),
        closureWave: sha256('synthetic-external-closure-acceptance'),
        ...overrides,
        hive,
      };
    },
  };
}

async function importMinimalRoots(service, source, batch = 'controlled-roots') {
  await service.begin(`${batch}-bind`);
  await service.startBatch(batch, source.plan.items.map(item => item.id), `${batch}-start`);
  for (const [itemIndex, item] of source.plan.items.entries()) {
    for (const [fileIndex, descriptor] of item.files.entries()) {
      const bytes = source.sourceByItem.get(item.id).files.get(descriptor.path);
      for (let index = 0; index < Math.ceil(bytes.length / MIGRATION_LIMITS.chunkBytes); index++) {
        const chunk = bytes.subarray(index * MIGRATION_LIMITS.chunkBytes, (index + 1) * MIGRATION_LIMITS.chunkBytes);
        await service.stage({
          batch, item: item.id, path: descriptor.path, index, base64: chunk.toString('base64'),
        }, `${batch}-stage-${itemIndex}-${fileIndex}-${index}`);
      }
    }
    await service.prepare(batch, item.id, `${batch}-prepare-${itemIndex}`);
    await service.commit(batch, item.id);
  }
  return service.finish();
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
  assert.equal(result.evidence.wholeRootLostAcknowledgementRecovered, true);
  assert.equal(result.evidence.wholeRootRetryCursorUnchanged, true);
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

test('an observed migration admits all 64 roots, including hidden roots, and survives restart', async () => {
  const result = await runObservedCapacityMigration();
  assert.deepEqual(result, {
    roots: 64,
    hiddenRoots: 32,
    observedRoots: 64,
    sourceReadOnly: true,
    restartIdentical: true,
    destinationWritesByHarness: 0,
  });
});

test('migration requires the exact signed selection and independently supplied capability', async () => {
  const f = await fixture();
  assert.throws(() => f.service.authenticate(f.source.plan.owner, 'skill.md'), { code: 'migration-unauthorized' });
  assert.throws(() => f.service.authenticate(f.source.roots[1], 'a'.repeat(43)), { code: 'migration-unauthorized' });
  const modified = migrationPlan({ ...f.source.plan, expected: { ...f.source.plan.expected, roots: 3 } });
  assert.throws(() => verifyMigrationApproval(modified, canonicalJson(f.source.approval), f.source.keys.signatures), { code: 'migration-authority' });
  assert.equal(verifyMigrationApproval(f.source.plan, canonicalJson(f.source.approval), f.source.keys.signatures).frame_hash,
    f.source.approval.frame_hash);
  assert.equal((await f.runtime.bots.list()).length, 0);
});

test('controlled-local migration accepts only an injected exact registry, signer and domain/closure/Hive authority', async () => {
  const folder = path.join(base, `controlled-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const keys = syntheticOperatorKeys();
  const sourceDirectory = path.join(folder, 'source');
  const destination = path.join(folder, 'destination');
  const source = await minimalRootMigrationFixture(sourceDirectory, { count: 2, mode: 'controlled-local', keys });
  const before = await sourceInventory(sourceDirectory, true);
  await assert.rejects(access(destination), { code: 'ENOENT' });
  let verifiedRequest;
  const verifier = controlledAuthority();
  const authority = {
    registry: keys.registry,
    signers: keys.signers,
    controlledLocal: { verify: async request => {
      verifiedRequest = request;
      return verifier.verify(request);
    } },
  };
  const { service } = await openMigrationService({
    directory: destination,
    plan: source.plan,
    approvalBytes: canonicalJson(source.approval),
    authority,
    capabilityHash: sha256('b'.repeat(43)),
  });
  const completed = await importMinimalRoots(service, source);
  assert.equal(completed.fixtureMigrationComplete, false);
  assert.equal(completed.controlledLocalMigrationComplete, true);
  assert.equal(completed.releaseEligible, false);
  assert.equal(completed.projection.authority.mode, 'controlled-local');
  assert.equal(completed.projection.authority.domain, 'both');
  assert.equal(completed.projection.authority.hive.acceptedPlanHash, verifiedRequest.planHash);
  assert.equal(completed.projection.counts.roots, 2);
  assert.equal(completed.projection.roots.filter(root => root.hidden).length, 1);
  assert.deepEqual(await sourceInventory(sourceDirectory, true), before);
  const cursor = completed.projection.cursorHash;
  assert.equal((await service.commit('controlled-roots', source.plan.items[0].id)).duplicate, true);
  assert.equal((await service.projection()).cursorHash, cursor);
  const { service: restarted } = await openMigrationService({
    directory: destination,
    plan: source.plan,
    approvalBytes: canonicalJson(source.approval),
    authority,
    capabilityHash: sha256('b'.repeat(43)),
  });
  assert.equal(canonicalJson(await restarted.projection()), canonicalJson(completed.projection));
  const { service: rebound } = await openMigrationService({
    directory: destination,
    plan: source.plan,
    approvalBytes: canonicalJson(source.approval),
    authority: {
      registry: keys.registry,
      signers: keys.signers,
      controlledLocal: controlledAuthority({ ownerAnchorWave: sha256('different-owner-anchor') }),
    },
    capabilityHash: sha256('b'.repeat(43)),
  });
  await assert.rejects(rebound.projection(), { code: 'migration-plan-binding' });
  assert.equal(canonicalJson(await restarted.projection()), canonicalJson(completed.projection));
});

test('controlled-local authority failures refuse before creating a destination', async () => {
  const folder = path.join(base, `controlled-refusal-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const keys = syntheticOperatorKeys();
  const source = await minimalRootMigrationFixture(path.join(folder, 'source'),
    { count: 2, mode: 'controlled-local', keys });
  const common = {
    plan: source.plan,
    approvalBytes: canonicalJson(source.approval),
    capabilityHash: sha256('c'.repeat(43)),
  };
  const cases = [
    {
      name: 'missing-authority',
      authority: { registry: keys.registry, signers: keys.signers },
      code: 'migration-adoption-unavailable',
    },
    {
      name: 'missing-registry-owner',
      authority: { registry: keys.registry.slice(1), signers: keys.signers, controlledLocal: controlledAuthority() },
      code: 'migration-registry-authority',
    },
    {
      name: 'missing-owner-signer',
      authority: { registry: keys.registry, signers: keys.signers.slice(1), controlledLocal: controlledAuthority() },
      code: 'migration-signer-authority',
    },
    {
      name: 'invalid-domain',
      authority: { registry: keys.registry, signers: keys.signers, controlledLocal: controlledAuthority({ domain: 'neutral' }) },
      code: 'migration-domain-authority',
    },
    {
      name: 'invalid-closure',
      authority: {
        registry: keys.registry,
        signers: keys.signers,
        controlledLocal: controlledAuthority({ closureCommitment: '0'.repeat(64) }),
      },
      code: 'migration-closure-authority',
    },
    {
      name: 'invalid-hive',
      authority: {
        registry: keys.registry,
        signers: keys.signers,
        controlledLocal: controlledAuthority({ hive: { acceptedPlanHash: '0'.repeat(64) } }),
      },
      code: 'migration-hive-authority',
    },
  ];
  for (const entry of cases) {
    const destination = path.join(folder, entry.name);
    await assert.rejects(openMigrationService({ directory: destination, ...common, authority: entry.authority }),
      { code: entry.code });
    await assert.rejects(access(destination), { code: 'ENOENT' });
  }
});

test('fixture history cannot become controlled-local authority by relabeling its plan', async () => {
  const folder = path.join(base, `relabel-refusal-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const source = await migrationFixture(path.join(folder, 'source'));
  const classifications = source.plan.items.map(item => item.classification);
  const relabeled = migrationPlan({ ...source.plan, mode: 'controlled-local' });
  const destination = path.join(folder, 'destination');
  await assert.rejects(openMigrationService({
    directory: destination,
    plan: relabeled,
    approvalBytes: canonicalJson(source.approval),
    authority: {
      registry: source.keys.registry,
      signers: source.keys.signers,
      controlledLocal: controlledAuthority(),
    },
    capabilityHash: sha256('d'.repeat(43)),
  }), { code: 'migration-authority' });
  assert.deepEqual(source.plan.items.map(item => item.classification), classifications);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('a 65-root migration plan refuses before the destination is created', async () => {
  const folder = path.join(base, `capacity-refusal-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const roots = fixtureSigners(MIGRATION_LIMITS.roots + 1).signers.map(entry => entry.root);
  const manifest = path.join(folder, 'plan.json');
  const approval = path.join(folder, 'approval.json');
  const destination = path.join(folder, 'destination');
  await writeFile(manifest, canonicalJson({
    schema: 'rapp-work.migration-plan/1',
    mode: 'sanitized-fixture',
    owner: roots[0],
    roots,
    items: [],
    expected: {},
  }));
  await writeFile(approval, '{}');
  const app = fileURLToPath(new URL('../dist/migration-app.js', import.meta.url));
  const result = spawnSync(process.execPath, [
    app, '--fixture', '--store', destination, '--manifest', manifest, '--approval', approval,
  ], {
    encoding: 'utf8',
    env: { ...process.env, RAPP_WORK_MIGRATION_CAPABILITY: 'e'.repeat(43) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"root-capacity"/u);
  assert.match(result.stderr, /at most 64 roots/u);
  await assert.rejects(access(destination), { code: 'ENOENT' });
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

test('same-tail migration owners receive distinct full-RAPPID ledger locators', async () => {
  const keys = sameTailFixtureSigners();
  const folder = path.join(base, `same-tail-ledgers-${process.pid}-${Date.now()}-${id++}`);
  await mkdir(folder, { mode: 0o700 });
  const source = await migrationFixture(path.join(folder, 'source'), { keys });
  const directory = path.join(folder, 'destination');
  const { runtime } = await openFixtureMigration(directory, source);
  for (const [index, selected] of keys.signers.entries()) {
    await runtime.bots.repository.migrationTransaction(selected.root, selected.signer, tx =>
      tx.appendControl({ schema: 'rapp-work.test-ledger/1', owner: selected.root },
        `2026-09-13T20:00:0${index}.000Z`));
  }
  assert.deepEqual((await readdir(path.join(directory, 'migration'))).sort(),
    keys.signers.map(selected => rootStorageKey(selected.root)).sort());
  for (const selected of keys.signers) {
    const snapshot = await runtime.bots.repository.migrationSnapshot(selected.root);
    assert.equal(snapshot.ledger.length, 1);
    assert.equal(snapshot.ledger[0].stream_id, `${selected.root}:migration`);
  }
});

test('same-tail full RAPPIDs use distinct staging and root locators through migration and restart', async () => {
  const keys = sameTailFixtureSigners();
  const secondRoot = keys.signers[1].root;
  let interrupted = true;
  const f = await fixture({ keys, migrationFault: (point, root) => {
    if (interrupted && point === 'before-root-publish' && root === secondRoot) {
      interrupted = false;
      throw new Error('same-tail staging interruption');
    }
  } });
  const roots = f.source.plan.items.filter(item => item.kind === 'canonical-root');
  assert.equal(roots.length, 2);
  assert.notEqual(roots[0].root, roots[1].root);
  assert.equal(rootTail(roots[0].root), rootTail(roots[1].root));
  await f.service.begin('same-tail-bind');
  await f.service.startBatch('same-tail-roots', roots.map(root => root.id), 'same-tail-batch');
  for (const root of roots) {
    await stageCanonicalRoot(f, 'same-tail-roots', root);
    await f.service.prepare('same-tail-roots', root.id, `prepare-${root.id}`);
  }
  await f.service.commit('same-tail-roots', roots[0].id);
  await assert.rejects(f.service.commit('same-tail-roots', roots[1].id), /same-tail staging interruption/);
  const publication = contentHash({ plan: f.service.planHash, batch: 'same-tail-roots', item: roots[1].id });
  const staged = path.join(f.folder, 'destination', 'migration', 'materialized', publication, rootStorageKey(roots[1].root));
  assert.deepEqual((await readdir(staged)).sort(), ['body', 'branches', 'memory', 'scopes', 'swarm']);
  await f.service.commit('same-tail-roots', roots[1].id);
  assert.deepEqual((await readdir(path.join(f.folder, 'destination', 'bots'))).sort(),
    roots.map(root => rootStorageKey(root.root)).sort());
  assert((await readdir(path.join(f.folder, 'destination', 'migration'))).includes(rootStorageKey(f.source.plan.owner)));
  const { runtime: restarted } = await openFixtureMigration(path.join(f.folder, 'destination'), f.source);
  assert.deepEqual((await restarted.bots.list(true)).map(root => root.root).sort(), roots.map(root => root.root).sort());
  for (const root of roots) assert.equal((await restarted.bots.project(root.root)).root, root.root);
});

test('whole-root publication lost acknowledgement retries the identical receipt without duplicate frames or cursor movement', async () => {
  let failAfterPublish = true;
  const f = await fixture({ migrationFault: point => {
    if (failAfterPublish && point === 'after-root-publish') {
      failAfterPublish = false;
      throw new Error('lost whole-root acknowledgement');
    }
  } });
  const rootItem = f.source.plan.items.find(item => item.kind === 'canonical-root');
  await f.service.begin('lost-root-ack-bind');
  await f.service.startBatch('lost-root-ack', [rootItem.id], 'lost-root-ack-batch');
  await stageCanonicalRoot(f, 'lost-root-ack', rootItem);
  await f.service.prepare('lost-root-ack', rootItem.id, 'lost-root-ack-prepare');
  await assert.rejects(f.service.commit('lost-root-ack', rootItem.id), /lost whole-root acknowledgement/);

  const { runtime: restarted, service: resumed } = await openFixtureMigration(path.join(f.folder, 'destination'), f.source);
  const beforeRetry = await resumed.projection();
  assert.equal(beforeRetry.counts.roots, 1);
  const committedRoot = await restarted.bots.repository.root(rootItem.root);
  const receipts = memoryFrames(committedRoot).filter(frame => frame.payload.event === 'migration.root.imported');
  assert.equal(receipts.length, 1);
  const frameCount = (await restarted.bots.repository.snapshot()).frameCount;

  const retry = await resumed.commit('lost-root-ack', rootItem.id);
  assert.equal(retry.duplicate, true);
  assert.equal(canonicalJson(retry.source), canonicalJson(frameHead(receipts[0])));
  const afterRetry = await resumed.projection();
  assert.equal(afterRetry.cursorHash, beforeRetry.cursorHash);
  assert.equal(canonicalJson(afterRetry), canonicalJson(beforeRetry));
  assert.equal((await restarted.bots.repository.snapshot()).frameCount, frameCount);
  assert.equal(memoryFrames(await restarted.bots.repository.root(rootItem.root))
    .filter(frame => frame.payload.event === 'migration.root.imported').length, 1);
});

test('native provider adapters accept selected native metadata only and never private content fields', () => {
  const pointer = nativeMetadataPointer('copilot', { session_id: 'selected', title: 'Selected Copilot', cwd_reference: 'opaque-cwd' });
  assert.equal(pointer.locator, 'native://copilot/session/selected');
  assert.throws(() => nativeMetadataPointer('copilot', { session_id: 'selected', title: 'Selected', cwd_reference: 'opaque', transcript: 'PRIVATE' }), { code: 'contract' });
  assert.throws(() => nativeMetadataPointer('claude', { project_key: '../private', session: { uuid: 'session', title: 'Selected' } }), { code: 'native-handle' });
  assert.throws(() => nativeMetadataPointer('hermes', { session: { id: 'selected', title: 'Selected', workspace_reference: 'opaque', content: 'PRIVATE' } }), { code: 'contract' });
});
