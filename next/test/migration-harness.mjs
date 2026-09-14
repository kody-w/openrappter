import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson, contentHash, sha256 } from '../dist/canonical.js';
import { MIGRATION_LIMITS } from '../dist/migration-contract.js';
import { migrationFixture, sourceInventory } from './migration-fixture.mjs';

const nextRoot = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(nextRoot, 'dist/migration-app.js');
const consumerProgram = path.join(nextRoot, 'test/migration-consumer.mjs');

function processLines(child, onMessage) {
  let buffer = '';
  child.stdout.on('data', bytes => {
    buffer += bytes.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) onMessage(JSON.parse(line));
    }
  });
}
function waitFor(predicate, entries, waiters, description) {
  const existing = entries.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out: ${typeof description === 'function' ? description() : description}`)); }, 15_000) };
    waiters.add(waiter);
  });
}
function deliver(value, entries, waiters) {
  entries.push(value);
  for (const waiter of [...waiters]) if (waiter.predicate(value)) {
    waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value);
  }
}

function launch(destination, fixture, capability, record, run) {
  const consumer = spawn(process.execPath, [consumerProgram], { stdio: ['pipe', 'pipe', 'pipe'] });
  const service = spawn(process.execPath, [app, '--fixture', '--store', destination, '--manifest', fixture.manifestPath, '--approval', fixture.approvalPath,
    ...(run === 1 ? ['--fixture-interrupt-root', fixture.roots[1]] : [])],
    { env: { ...process.env, RAPP_WORK_MIGRATION_CAPABILITY: capability }, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = [], displays = [], events = [], responseWaiters = new Set(), displayWaiters = new Set();
  let serviceLog = '', displayLog = '';
  const serviceExit = new Promise(resolve => service.on('exit', (code, signal) => resolve({ code, signal })));
  const consumerExit = new Promise(resolve => consumer.on('exit', (code, signal) => resolve({ code, signal })));
  service.stderr.on('data', bytes => { serviceLog += bytes.toString(); });
  consumer.stderr.on('data', bytes => { displayLog += bytes.toString(); });
  service.on('exit', () => {
    for (const waiter of responseWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error(`Application exited while a public request was pending: ${serviceLog}`)); }
    responseWaiters.clear();
  });
  processLines(consumer, row => {
    record.displays.push({ run, ...row });
    deliver(row, displays, displayWaiters);
  });
  processLines(service, message => {
    if (message.event) {
      events.push(message.event);
      record.events.push({ run, ...message.event });
      consumer.stdin.write(canonicalJson(message.event) + '\n');
    } else deliver(message, responses, responseWaiters);
  });
  const request = async (method, params = {}, id = `${method.slice(10).replaceAll('_', '-')}-${responses.length}-${Date.now()}`) => {
    record.calls.push({ run, method, id, item: params.item ?? params.stage?.item ?? null, batch: params.batch ?? params.stage?.batch ?? null });
    service.stdin.write(JSON.stringify({ id, method, params: { root: fixture.plan.owner, ...params } }) + '\n');
    const response = await waitFor(r => r.id === id, responses, responseWaiters, () => `${method}; service ${serviceLog}`);
    if (response.error) {
      const error = new Error(response.error.message); error.code = response.error.code; throw error;
    }
    return response.result;
  };
  const displayed = cursorHash => waitFor(d => d.cursorHash === cursorHash, displays, displayWaiters, `display cursor ${cursorHash}`);
  return {
    request, displayed, events, displays, service, consumer,
    async checkpoint() { const snapshot = await request('rapp_work_migration_read'); await displayed(snapshot.cursorHash); return snapshot; },
    async stop(interrupt = false) {
      if (interrupt) service.kill('SIGTERM');
      else service.stdin.end();
      const serviceResult = await serviceExit;
      consumer.stdin.end();
      const consumerResult = await consumerExit;
      assert.equal(consumerResult.code, 0, displayLog);
      if (!interrupt) assert.equal(serviceResult.code, 0, serviceLog);
      record.processes.push({ run, applicationEntrypoint: 'next/dist/migration-app.js', service: serviceResult, consumer: consumerResult, displayLog, serviceLog });
    },
  };
}

export async function runObservedMigration(options = {}) {
  const base = options.directory ?? path.join(nextRoot, '.test-scratch', `migration-observed-${process.pid}-${Date.now()}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const sourceDirectory = path.join(base, 'source');
  const destination = path.join(base, 'destination');
  // The fixture builder writes only source/. Every destination mutation below
  // belongs to the separately launched application and its public API.
  const fixture = await migrationFixture(sourceDirectory);
  const before = await sourceInventory(sourceDirectory, true);
  await assert.rejects(access(destination), { code: 'ENOENT' });
  const capability = randomBytes(32).toString('base64url');
  const record = { events: [], displays: [], calls: [], processes: [] };
  let connection = launch(destination, fixture, capability, record, 1);
  let requestCounter = 0;
  const call = (method, params, id) => connection.request(method, params, id ?? `migration-request-${requestCounter++}`);
  const stageRoot = async (batch, item, onlyFirst = false) => {
    let staged = 0, duplicate = 0;
    for (const descriptor of item.files) {
      const filename = path.join(fixture.sourceByItem.get(item.id).directory, descriptor.path);
      const bytes = await readFile(filename);
      assert.equal(sha256(bytes), descriptor.sha256);
      for (let index = 0; index < Math.ceil(bytes.length / MIGRATION_LIMITS.chunkBytes); index++) {
        const chunk = bytes.subarray(index * MIGRATION_LIMITS.chunkBytes, (index + 1) * MIGRATION_LIMITS.chunkBytes);
        const result = await call('rapp_work_migration_stage', {
          stage: { batch, item: item.id, path: descriptor.path, index, base64: chunk.toString('base64') },
        }, `stage-${contentHash({ batch, item: item.id, path: descriptor.path, index })}`);
        staged++; if (result.duplicate) duplicate++;
        if (onlyFirst) return { staged, duplicate };
      }
    }
    return { staged, duplicate };
  };
  try {
    const empty = await call('rapp_work_migration_read');
    assert.equal(empty.counts.roots, 0);
    assert.equal(empty.counts.controlFrames, 0);
    await call('rapp_work_migration_subscribe');
    await connection.displayed(empty.cursorHash);
    await call('rapp_work_migration_begin', {}, 'bind-approved-plan');
    const first = fixture.plan.items.find(i => i.kind === 'canonical-root');
    const second = fixture.plan.items.filter(i => i.kind === 'canonical-root')[1];
    await call('rapp_work_migration_start_batch', { batch: 'first-root', items: [first.id] }, 'first-root-batch');
    await stageRoot('first-root', first);
    await call('rapp_work_migration_prepare', { batch: 'first-root', item: first.id }, 'prepare-first-root');
    await call('rapp_work_migration_commit', { batch: 'first-root', item: first.id });
    const appeared = await connection.checkpoint();
    assert.equal(appeared.counts.roots, 1);
    assert(connection.displays.some(d => d.additions.some(a => a.kind === 'root' && a.id === first.root)));

    await call('rapp_work_migration_start_batch', { batch: 'rollback-incomplete', items: [second.id] }, 'rollback-batch');
    await stageRoot('rollback-incomplete', second, true);
    await assert.rejects(call('rapp_work_migration_prepare', { batch: 'rollback-incomplete', item: second.id }, 'prepare-incomplete'), { code: 'migration-incomplete' });
    await stageRoot('rollback-incomplete', second);
    await call('rapp_work_migration_prepare', { batch: 'rollback-incomplete', item: second.id }, 'prepare-unpublished-root');
    await assert.rejects(call('rapp_work_migration_commit', { batch: 'rollback-incomplete', item: second.id }),
      { code: 'fixture-materialization-interrupted' });
    assert.equal((await connection.checkpoint()).counts.roots, 1);
    const rolled = await call('rapp_work_migration_rollback', { batch: 'rollback-incomplete', reason: 'Exercise rollback before any root publication.' }, 'rollback-incomplete');
    assert.equal(rolled.activeItemsRemoved, 0);
    const rolledProjection = await connection.checkpoint();
    assert.equal(rolledProjection.counts.roots, 1);
    assert(rolledProjection.batches.some(b => b.id === 'rollback-incomplete' && b.status === 'rolled-back'));
    await assert.rejects(call('rapp_work_migration_commit', { batch: 'rollback-incomplete', item: second.id }), { code: 'migration-batch' });

    const remaining = fixture.plan.items.filter(i => i.id !== first.id).map(i => i.id);
    await call('rapp_work_migration_start_batch', { batch: 'resume-estate', items: remaining }, 'resume-batch');
    await stageRoot('resume-estate', second, true);
    const interrupted = await connection.checkpoint();
    await connection.stop(true);
    connection = launch(destination, fixture, capability, record, 2);
    const restored = await call('rapp_work_migration_read');
    assert.equal(canonicalJson(restored), canonicalJson(interrupted));
    await call('rapp_work_migration_subscribe', { cursorHash: interrupted.cursorHash });
    await connection.displayed(restored.cursorHash);
    const resumed = await stageRoot('resume-estate', second);
    assert(resumed.duplicate > 0);
    await call('rapp_work_migration_prepare', { batch: 'resume-estate', item: second.id }, 'prepare-second-root');
    await call('rapp_work_migration_commit', { batch: 'resume-estate', item: second.id });
    await connection.checkpoint();

    for (const item of fixture.plan.items.filter(i => i.kind === 'estate-pointer')) {
      await call('rapp_work_migration_stage', { stage: { batch: 'resume-estate', item: item.id, pointer: item.pointer } },
        `stage-pointer-${item.id}`);
      await call('rapp_work_migration_prepare', { batch: 'resume-estate', item: item.id }, `prepare-pointer-${item.id}`);
      await call('rapp_work_migration_commit', { batch: 'resume-estate', item: item.id });
      const projection = await connection.checkpoint();
      assert(projection.imported.some(p => p.id === item.id));
      assert(connection.displays.some(d => d.additions.some(a => a.id === item.id)));
    }
    const complete = await call('rapp_work_migration_finish');
    assert.equal(complete.fixtureMigrationComplete, true);
    assert.equal(complete.releaseEligible, false);
    const final = await connection.checkpoint();
    for (const key of ['roots', 'items', 'pointers', 'scopes', 'artifacts', 'branches']) assert.equal(final.counts[key], fixture.plan.expected[key]);
    assert.equal(new Set(final.imported.map(i => `${i.root}:${i.sourceIdentity}`)).size, fixture.plan.items.length);
    for (const original of fixture.snapshots) {
      const migrated = final.roots.find(r => r.root === original.definition.root);
      assert.equal(migrated.name, original.definition.name);
      assert.equal(migrated.capability.sha256, original.definition.capability.sha256);
      for (const source of original.sources ?? []) {
        const preserved = migrated.sources.find(s => s.scope === source.scope && s.guid === original.definition.root && s.stream_id === source.stream);
        assert(preserved, 'An original scoped stream disappeared from the public projection');
        assert.equal(preserved.head.frame_hash, source.frames.at(-1).frame_hash);
        for (const branch of source.branches) assert(preserved.branches.some(b => b.head === branch.head && b.frames === branch.frames.length));
      }
      for (const [relative, originalBytes] of fixture.sourceByItem.get(fixture.plan.items.find(i => i.kind === 'canonical-root' && i.root === original.definition.root).id).files) {
        const actual = await readFile(path.join(destination, 'bots', original.definition.root.split(':').at(-1), relative));
        assert(actual.equals(originalBytes), `Source occurrence bytes changed: ${relative}`);
      }
    }
    assert.equal(final.roots.find(r => r.root === fixture.roots[1]).hidden, true);
    assert.equal(final.roots.reduce((n, r) => n + r.sourceOwnership.legacyRootStream, 0), 1);
    assert(final.roots.every(r => r.sourceOwnership.copiedCentralActivity === false));
    const visibleAdds = record.displays.flatMap(d => d.additions);
    assert.equal(new Set(visibleAdds.filter(a => a.kind === 'root').map(a => a.id)).size, 2);
    assert.equal(new Set(visibleAdds.filter(a => a.kind === 'world').map(a => a.id)).size, fixture.plan.expected.forms.world);
    const beforeDuplicate = final.cursorHash;
    assert.equal((await call('rapp_work_migration_rollback', { batch: 'rollback-incomplete', reason: 'Exercise rollback before any root publication.' }, 'rollback-retry-after-resume')).duplicate, true);
    for (const item of fixture.plan.items) {
      const batch = item.id === first.id ? 'first-root' : 'resume-estate';
      assert.equal((await call('rapp_work_migration_commit', { batch, item: item.id })).duplicate, true);
    }
    assert.equal((await call('rapp_work_migration_read')).cursorHash, beforeDuplicate);
    await connection.stop();
    connection = launch(destination, fixture, capability, record, 3);
    const restarted = await call('rapp_work_migration_read');
    assert.equal(canonicalJson(restarted), canonicalJson(final));
    await call('rapp_work_migration_subscribe', { cursorHash: final.cursorHash });
    const displayed = await connection.displayed(final.cursorHash);
    const previousDisplay = record.displays.find(d => d.run === 2 && d.cursorHash === final.cursorHash);
    assert.equal(canonicalJson(displayed.state), canonicalJson(previousDisplay.state));
    await connection.stop();
    const after = await sourceInventory(sourceDirectory, true);
    assert.deepEqual(after, before);
    const destinationInventory = await sourceInventory(destination);
    for (const relative of Object.keys(destinationInventory)) {
      const bytes = await readFile(path.join(destination, relative), 'utf8');
      assert(!bytes.includes('PRIVATE-NATIVE-'), 'Private native transcript content entered destination');
    }
    const writeEvidence = async (name, data) => {
      const filename = path.join(base, name);
      assert(!filename.startsWith(destination + path.sep));
      await writeFile(filename, data);
    };
    await writeEvidence('events.jsonl', record.events.map(canonicalJson).join('\n') + '\n');
    await writeEvidence('passive-display.jsonl', record.displays.map(canonicalJson).join('\n') + '\n');
    await writeEvidence('source-before.json', JSON.stringify(before, null, 2) + '\n');
    await writeEvidence('source-after.json', JSON.stringify(after, null, 2) + '\n');
    await writeEvidence('public-api-calls.json', JSON.stringify(record.calls, null, 2) + '\n');
    await writeEvidence('processes.json', JSON.stringify(record.processes, null, 2) + '\n');
    await writeEvidence('registry.json', JSON.stringify(fixture.keys.registry, null, 2) + '\n');
    const checker = spawnSync('python3', [path.join(nextRoot, 'scripts/reference-check.py'), destination, path.join(base, 'registry.json')],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(checker.status, 0, checker.stdout + checker.stderr);
    const canonical = JSON.parse(checker.stdout);
    const evidence = {
      schema: 'rapp-work.observed-migration-gate/1', fixtureGate: 'passed', releaseGate: 'pending-approved-controlled-local-run',
      application: 'NEW next/dist/migration-app.js', initialProfileEmpty: true,
      destinationWritesByHarness: 0, populationChannel: 'public provider-neutral stdio migration API only',
      passiveClient: 'separately launched next/test/migration-consumer.mjs', providerModelCalls: 0, uiImplemented: false,
      expected: fixture.plan.expected, actual: final.counts, rootGuids: fixture.roots, canonical,
      exactOriginalFrameBytesPreserved: true, hiddenRootPreserved: true, fullHiddenScopesAndForms: true,
      originalScopedStreamsPreserved: fixture.snapshots.reduce((n, r) => n + (r.sources?.length ?? 0), 0),
      originalSourceBranchesPreserved: fixture.snapshots.reduce((n, r) => n + (r.sources ?? []).reduce((n, s) => n + s.branches.length, 0), 0),
      legacySourceOccurrencesHonestAndUnchanged: 1, copiedCentralActivity: false,
      sourceWrites: 0, sourceMoves: 0, sourceDeletes: 0,
      sourceFilesCompared: Object.values(before).filter(e => e.type === 'file').length,
      sourceDirectoriesCompared: Object.values(before).filter(e => e.type === 'directory').length,
      nativePrivateContentImported: false, historicalUnavailableItems: 2, duplicateImports: 0,
      interruptionResume: true, interruptionMode: 'SIGTERM with filesystem critical-section drain; no stale-lock stealing', replayedChunksDeduplicated: resumed.duplicate,
      incompleteTransactionRollback: true, unpublishedMaterializationFaultExercised: true, rollbackDeletesCommittedData: false,
      serviceAndProjectionRestartIdentical: true, observedEvents: record.events.length,
      observedUniqueItems: new Set(visibleAdds.filter(a => ['canonical-root', 'estate-pointer'].includes(a.kind)).map(a => a.id)).size,
      observedWorlds: new Set(visibleAdds.filter(a => a.kind === 'world').map(a => a.id)).size,
      finalCursorHash: final.cursorHash, planHash: contentHash(fixture.plan),
      evidenceDirectory: path.relative(nextRoot, base), sourceDirectory: path.relative(nextRoot, sourceDirectory),
      destinationDirectory: path.relative(nextRoot, destination),
      liveCurrentProfilesTouched: false, liveCanonicalAdoptionPerformed: false,
    };
    await writeEvidence('result.json', JSON.stringify(evidence, null, 2) + '\n');
    return { evidence, fixture, record, base, final };
  } finally {
    if (connection.service.exitCode === null && connection.service.signalCode === null) connection.service.kill('SIGTERM');
    if (connection.consumer.exitCode === null && connection.consumer.signalCode === null) connection.consumer.kill('SIGTERM');
  }
}
