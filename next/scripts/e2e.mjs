import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HeadlessRuntime } from '../dist/runtime.js';
import { CopilotSdkProvider } from '../dist/copilot.js';
import { FixtureBrainstem, FixtureCopilotTransport, fixtureSigners, readFixture, SyntheticIMessage } from '../dist/fixtures.js';
import { discoveryEvidence } from '../dist/estate.js';
import { buildFrame, canonicalJson, contentHash, streamFor } from '../dist/canonical.js';
import { eventPayload } from '../dist/contract.js';
import { foldState } from '../dist/state.js';
import { memoryFrames, sourceChain } from '../dist/source-memory.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.test-scratch', `e2e-${process.pid}-${Date.now()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const keys = fixtureSigners();
const transport = new FixtureCopilotTransport();
const spine = new FixtureBrainstem();
const channel = new SyntheticIMessage();
let time = Date.parse('2026-09-13T20:00:00.000Z');
const options = {
  directory: path.join(directory, 'canonical'), signatures: keys.signatures, signers: keys.signers,
  brainstem: spine, fixture: true, channel, clock: () => new Date(time++).toISOString(),
  provider: new CopilotSdkProvider(transport, { mode: 'empty', sessionStorage: 'memory-only', canonicalContextOnly: true }),
};
const runtime = await HeadlessRuntime.open(options);
const a = await runtime.bots.create({ name: 'Copilot Builder', operationId: 'create-builder', keyedRoot: keys.signers[0].root });
const b = await runtime.bots.create({ name: 'Independent Reviewer', operationId: 'create-reviewer', keyedRoot: keys.signers[1].root });

async function hashes(directory) {
  const entries = {};
  async function walk(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), name);
      else entries[name] = createHash('sha256').update(await readFile(path.join(current, entry.name))).digest('hex');
    }
  }
  await walk(directory);
  return entries;
}
const dormant = await hashes(options.directory);
const oa = runtime.bots.spine.observe(a.root), ob = runtime.bots.spine.observe(b.root);
await runtime.bots.select(a.root);
await runtime.bots.whereWereWe(a.root);
await runtime.bots.spine.unobserve(oa);
assert.equal(runtime.bots.spine.status(b.root).mode, 'observed');
await runtime.bots.spine.unobserve(ob);
assert.deepEqual(await hashes(options.directory), dormant);
assert.equal(transport.requests.length, 0);

const builder = await runtime.conversation.converse(a.root, 'I need a place to build the Copilot bridge', 'builder-thought');
assert.equal(builder.status, 'review');
assert.equal(builder.projection.artifacts.length, 0);
await runtime.conversation.confirm(a.root, builder.proposalWave, 'confirm-builder');
const discoveryBytes = await readFile(path.join(root, 'fixtures/rapp-up.json'));
const discovery = await runtime.estate.discover(a.root, { discover: async () => discoveryEvidence(await readFixture('rapp-up')) }, 'record-discovery');
assert.equal(discovery.nativeWrites, 0);
assert.equal(discovery.createdWorlds, 0);
const up = await runtime.dispatch('estate.rapp-up', { root: a.root }, 'rapp-up-thought');
await runtime.conversation.confirm(a.root, up.proposalWave, 'confirm-rapp-up');
assert.equal((await runtime.bots.project(a.root)).pointers.length, 5);
assert.deepEqual(await readFile(path.join(root, 'fixtures/rapp-up.json')), discoveryBytes);

const recurring = await runtime.conversation.converse(a.root, 'Make this a world and recap progress every Monday', 'weekly-thought');
await runtime.conversation.confirm(a.root, recurring.proposalWave, 'confirm-weekly');
const applied = (await runtime.bots.repository.root(a.root)).streams.memory.at(-1);
await runtime.conversation.recordProgress(a.root, 'weekly-world', 'First internal draft prepared.', [applied.frame_hash], 'first-progress');
const progress = sourceChain(await runtime.bots.repository.root(a.root), 'weekly-world').at(-1);
const progressBytes = canonicalJson(progress);
await runtime.conversation.undo(a.root, progress.frame_hash, 'The draft status needs correction.', 'correct-progress');
assert.equal(canonicalJson(memoryFrames(await runtime.bots.repository.root(a.root)).find(f => f.frame_hash === progress.frame_hash)), progressBytes);
time = Date.parse('2026-09-14T09:00:00.000Z');
const due = await runtime.recurring.due(a.root);
const modelCallsBeforeTick = transport.requests.length;
await runtime.recurring.tick(a.root, due[0].routineId, due[0].occurrence);
assert.equal(transport.requests.length, modelCallsBeforeTick);
assert.equal((await runtime.recurring.due(a.root)).length, 0);

const preserved = (await runtime.bots.repository.root(a.root)).streams.memory.map(f => canonicalJson(f));
const alternative = buildFrame({
  kind: 'memory.save', streamId: streamFor(a.root, 'memory'), head: null, utc: runtime.bots.now(),
  payload: eventPayload(a.root, 'root', 'alternative-visibility', 'root.visibility', { hidden: true }),
  signer: keys.signers[0].signer, signatures: keys.signatures,
});
await runtime.bots.repository.transaction(tx => tx.preserveBranch(a.root, 'memory', [alternative]));
assert.deepEqual((await runtime.bots.repository.root(a.root)).streams.memory.map(f => canonicalJson(f)), preserved);

const bGenesis = (await runtime.bots.repository.root(b.root)).streams.body[0].frame_hash;
await runtime.conversation.recordProgress(b.root, 'root', 'SYNTHETIC_PRIVATE_REVIEWER_NOT_SHARED', [bGenesis], 'private-reviewer-progress');
await runtime.collaboration.grant(a.root, b.root, 'Builder public brief: review the canonical pointer-first organization.', 'allow', 'grant-builder');
await runtime.collaboration.grant(b.root, a.root, 'Reviewer public brief: critique bounded work and native pointer federation.', 'allow', 'grant-reviewer');
const collaboration = await runtime.collaboration.ask(a.root, b.root, 'Review the public plan and preserve disagreement.', 'collaborate-once');
assert.equal(collaboration.status, 'completed');
assert(!JSON.stringify(transport.requests.slice(-2)).includes('SYNTHETIC_PRIVATE_REVIEWER_NOT_SHARED'));
assert(collaboration.transcript.some(t => t.speaker === a.root));
assert(collaboration.transcript.some(t => t.speaker === b.root));

await runtime.channels.bind(a.root, 'a'.repeat(64), 'b'.repeat(64), true, 'bind-synthetic-imessage');
const queued = await runtime.channels.queueRecap(a.root, 'queue-continuity-recap');
assert.equal((await runtime.channels.deliver(a.root, queued.deliveryId, 'offline-delivery')).status, 'unavailable');
const outage = await runtime.channels.recap(a.root);
assert.equal(outage.pending.length, 1);
const outageBytes = await hashes(options.directory);
assert.deepEqual(await runtime.channels.recap(a.root), outage);
assert.deepEqual(await hashes(options.directory), outageBytes);
channel.available = true;
assert.equal((await runtime.channels.deliver(a.root, queued.deliveryId, 'explicit-delivery-retry')).status, 'delivered');
await runtime.channels.deliver(a.root, queued.deliveryId, 'duplicate-delivery');
assert.equal(channel.sent.size, 1);

const external = await runtime.conversation.converse(a.root, 'Prepare an external message request, do not send it', 'external-thought');
await runtime.conversation.confirm(a.root, external.proposalWave, 'confirm-message-preparation');
const effect = foldState(await runtime.bots.repository.root(a.root)).effects.get('message-request');
assert.equal((await runtime.effects.approve(a.root, 'message-request', effect.requestHash, effect.target, 'approve-exact-message')).status, 'unavailable');
await runtime.bots.visibility(a.root, true, 'clear-builder');
assert.equal((await runtime.bots.list()).length, 1);
await runtime.bots.visibility(a.root, false, 'restore-builder');
assert.equal((await runtime.bots.list()).length, 2);

let refusedDomainSelections = 0;
for (const operation of ['inspect', 'export', 'restore']) for (const scope of ['godd', 'dogg', 'both']) {
  await assert.rejects(runtime.egg.transfer(a.root, operation, scope), { code: 'canonical-domain-binding-unavailable' });
  refusedDomainSelections++;
}
await runtime.hive.consent(a.root, b.root, 'taxonomy', '0'.repeat(64), 'allow', 'hive-consent-builder');
await runtime.hive.consent(b.root, a.root, 'taxonomy', '0'.repeat(64), 'allow', 'hive-consent-reviewer');
await assert.rejects(runtime.hive.link(a.root, b.root, 'taxonomy', '0'.repeat(64), 'unbound-hive'), { code: 'hive-binding-unavailable' });
const before = await runtime.bots.repository.snapshot();
const beforeBytes = await hashes(options.directory);
const transcript = await runtime.collaboration.transcript(a.root);
const projection = await runtime.dispatch('projection.get', { root: a.root });
const calls = transport.requests.length;
const restarted = await HeadlessRuntime.open(options);
assert.deepEqual(await restarted.bots.repository.snapshot(), before);
assert.deepEqual(await restarted.collaboration.transcript(a.root), transcript);
assert.deepEqual(await restarted.dispatch('projection.get', { root: a.root }), projection);
await restarted.collaboration.ask(a.root, b.root, 'Review the public plan and preserve disagreement.', 'collaborate-once');
await restarted.conversation.converse(a.root, 'I need a place to build the Copilot bridge', 'builder-thought');
await restarted.recurring.tick(a.root, due[0].routineId, due[0].occurrence);
assert.equal(transport.requests.length, calls);
assert.deepEqual(await hashes(options.directory), beforeBytes);

const registry = path.join(directory, 'explicit-fixture-registry.json');
await writeFile(registry, JSON.stringify(keys.registry, null, 2) + '\n');
const checker = spawnSync('python3', [path.join(root, 'scripts/reference-check.py'), options.directory, registry], {
  encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
assert.equal(checker.status, 0, checker.stdout + checker.stderr);
const canonical = JSON.parse(checker.stdout);
assert(canonical.framesScanned > 0 && canonical.signedFrames > 0);
const result = {
  schema: 'rapp-work.next/headless-parity/1',
  evidenceDirectory: path.relative(root, directory),
  adapterMode: 'explicit-synthetic-fixtures',
  roots: [a.root, b.root],
  oneLibrarianPerRoot: before.roots.every(r => r.definition.scopes.filter(s => s.kind === 'librarian').length === 1),
  observationDurableMutations: 0,
  dormantModelCalls: 0,
  canonical,
  reconstructedFrameCount: before.frameCount,
  preservedBranches: before.roots.reduce((n, r) => n + r.branches.length, 0),
  deterministicRestart: true,
  modelReplayOnRestart: 0,
  fixtureModelCalls: calls,
  liveModelCalls: 0,
  nativeProviderPointers: 5,
  sourceOrNativeStoreWrites: 0,
  externalEffectsExecuted: 0,
  syntheticIMessageDeliveries: channel.sent.size,
  domainSelectionsRefused: refusedDomainSelections,
  hiveUnboundRefused: true,
  transcriptSha256: createHash('sha256').update(canonicalJson(transcript)).digest('hex'),
  projectionParticleHash: contentHash(projection),
  productionReady: false,
  blockers: ['Adopted external root-isolated Brainstem binding', 'Explicit empty memory-only SDK host/auth binding and signer custody',
    'Signed rooted GODD/DOGG closure/transport adoption', 'Fresh signed Private Hive rooted-world adoption',
    'Explicit local iMessage OS permission/contact bridge', 'Independent next release constitution and migration qualification'],
};
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const transcriptFixture = {
  fixture: 'synthetic-canonical-public-turns', canonicalOrdering: 'UTC then wave hash', turns: transcript,
};
const channelFixture = {
  fixture: 'synthetic-private-channel-outage', source: 'canonical channel queue and outcome frames',
  recapDuringOutage: outage, recapAfterExplicitRetry: await runtime.channels.recap(a.root),
};
await writeFile(path.join(directory, 'multi-bot-transcript.json'), JSON.stringify(transcriptFixture, null, 2) + '\n');
await writeFile(path.join(directory, 'imessage-outage-recap.json'), JSON.stringify(channelFixture, null, 2) + '\n');
if (process.argv.includes('--record-source-fixtures')) {
  await mkdir(path.join(root, 'fixtures/source-owned'), { recursive: true });
  await writeFile(path.join(root, 'fixtures/source-owned/multi-bot-transcript.json'), JSON.stringify(transcriptFixture, null, 2) + '\n');
  await writeFile(path.join(root, 'fixtures/source-owned/imessage-outage-recap.json'), JSON.stringify(channelFixture, null, 2) + '\n');
}
assert.equal(canonicalJson(transcriptFixture), canonicalJson(JSON.parse(await readFile(path.join(root, 'fixtures/source-owned/multi-bot-transcript.json'), 'utf8'))));
assert.equal(canonicalJson(channelFixture), canonicalJson(JSON.parse(await readFile(path.join(root, 'fixtures/source-owned/imessage-outage-recap.json'), 'utf8'))));
console.log(JSON.stringify(result, null, 2));
