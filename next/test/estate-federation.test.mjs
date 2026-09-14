import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, contentHash } from '../dist/canonical.js';
import { discoveryEvidence } from '../dist/estate.js';
import { sourceChain } from '../dist/source-memory.js';
import { fixtureSigners } from '../dist/fixtures.js';
import { base, harness, inventory } from './harness.mjs';

const provenance = (mappingState = 'mapped') => ({
  source: 'rapp-workspace-manager', manifestSha256: 'a'.repeat(64), recordSha256: 'b'.repeat(64),
  providerUnion: ['local', 'copilot', 'claude'], mappingState, evidenceSha256: ['c'.repeat(64)],
});
const pointer = () => ({
  id: 'manager-workspace', provider: 'local', title: 'Selected local workspace',
  nativeShape: 'Manager workspace with native Copilot and Claude associations; originals stay in the private manifest.',
  locator: 'local://workspace/opaque-manager-handle', provenance: provenance(),
});
const observation = (mappingState = 'app-only') => ({
  id: `grok-${mappingState}`, provider: 'grokbot', title: 'Grok observation, not a workspace',
  nativeShape: 'Application-only or unresolved selected metadata; no workspace binding.',
  provenance: { ...provenance(mappingState), providerUnion: ['grokbot'] },
});
const evidence = (pointers = [pointer()], observations) => ({
  origin: 'sanitized-fixture', observedUtc: '2026-09-13T20:00:00.000Z', historical: true, pointers,
  ...(observations === undefined ? {} : { observations }),
});

test('one local pointer records original union provenance and an exact-root receipt without registering or computing', async () => {
  const h = await harness(), bot = await h.create();
  const input = evidence();
  const receipt = await h.runtime.dispatch('estate.record', { root: bot.root, evidence: input }, 'manager-record');
  assert.equal(receipt.root, bot.root);
  assert.equal(receipt.scope, 'local-estate');
  assert.equal(receipt.receipt.guid, bot.root);
  assert.equal(receipt.receipt.scope, 'local-estate');
  assert.equal(receipt.receipt.frame_hash, receipt.sourceWave);
  assert.equal(receipt.evidenceHash, contentHash(discoveryEvidence(input)));
  assert.equal(receipt.duplicate, false);
  assert.equal(receipt.createdWorlds, 0);
  assert.equal(receipt.nativeWrites, 0);
  const root = await h.runtime.bots.repository.root(bot.root);
  const frame = sourceChain(root, 'local-estate')[0];
  assert(frame.sig);
  assert.equal(canonicalJson(frame.payload.data.pointers[0]), canonicalJson(input.pointers[0]));
  assert.equal(root.streams.memory.length, 0);
  assert.equal((await h.runtime.bots.project(bot.root)).pointers.length, 0);
  assert.equal(h.transport.requests.length, 0);
  assert.equal(h.brainstem.hotloads.length, 0);
});

test('receipt-driven restart/retry is immutable; changed evidence or observation time never silently overwrites', async () => {
  const h = await harness(), bot = await h.create();
  const input = evidence();
  const first = await h.runtime.dispatch('estate.record', { root: bot.root, evidence: input }, 'stable-manifest-record');
  const before = await inventory(h.directory);
  const reopened = await h.restart();
  const duplicate = await reopened.dispatch('estate.record', { root: bot.root, evidence: input }, 'stable-manifest-record');
  assert.equal(duplicate.duplicate, true);
  assert.equal(canonicalJson(duplicate.receipt), canonicalJson(first.receipt));
  assert.equal(duplicate.sourceWave, first.sourceWave);
  await assert.rejects(reopened.dispatch('estate.record', { root: bot.root,
    evidence: { ...input, observedUtc: '2026-09-13T20:01:00.000Z' } }, 'stable-manifest-record'), { code: 'idempotency-conflict' });
  await assert.rejects(reopened.dispatch('estate.record', { root: bot.root,
    evidence: evidence([{ ...pointer(), title: 'Different observed title' }]) }, 'stable-manifest-record'), { code: 'idempotency-conflict' });
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(h.transport.requests.length, 0);
});

test('unresolved/app-only records remain observations and cannot be promoted through pointer.register', async () => {
  const h = await harness(), bot = await h.create();
  const input = evidence([], [observation(), observation('unresolved')]);
  const recorded = await h.runtime.dispatch('estate.record', { root: bot.root, evidence: input }, 'grok-observations');
  assert.equal(recorded.candidates.length, 0);
  assert.equal(recorded.observations.length, 2);
  assert.equal(recorded.createdWorlds, 0);
  h.transport.responses.push({
    summary: 'An app-only observation must not become a native workspace.', tradeoffs: ['No workspace mapping is established.'],
    tradeoffLinks: [{ actionId: 'must-not-exist', tradeoff: 0 }],
    questions: [], actions: [{ type: 'pointer.register', id: 'must-not-exist', scope: 'local-estate',
      evidenceWave: recorded.sourceWave, pointerId: input.observations[0].id }],
  });
  const rejected = await h.runtime.conversation.converse(bot.root, 'Review the observed native estate', 'no-app-promotion');
  assert.equal(rejected.status, 'unavailable');
  assert(!rejected.projection.scopes.some(s => s.id === 'must-not-exist'));
  assert.equal(rejected.projection.pointers.length, 0);
  assert.equal(h.transport.requests[0].canonicalContext.discovery[0].observations.length, 2);
});

test('mapped candidates require human review and cannot produce duplicate registered source identities', async () => {
  const h = await harness(), bot = await h.create();
  const recorded = await h.runtime.dispatch('estate.record', { root: bot.root, evidence: evidence() }, 'mapped-record');
  const plan = id => ({ summary: 'Register this one reviewed pointer only.', tradeoffs: ['The native source stays external and historical.'],
    tradeoffLinks: [{ actionId: id, tradeoff: 0 }],
    questions: [], actions: [{ type: 'pointer.register', id, scope: 'local-estate', evidenceWave: recorded.sourceWave, pointerId: pointer().id }] });
  h.transport.responses.push(plan('reviewed-local-pointer'));
  const proposal = await h.runtime.conversation.converse(bot.root, 'Review one local pointer', 'local-pointer-review');
  assert.equal(proposal.status, 'review');
  assert.equal(proposal.projection.pointers.length, 0);
  const confirmed = await h.runtime.conversation.confirm(bot.root, proposal.proposalWave, 'confirm-local-pointer');
  assert.equal(confirmed.pointers.length, 1);
  assert.equal(canonicalJson(confirmed.pointers[0].pointer), canonicalJson(pointer()));
  h.transport.responses.push(plan('duplicate-local-pointer'));
  const duplicate = await h.runtime.conversation.converse(bot.root, 'Do not register this source twice', 'duplicate-review');
  assert.equal(duplicate.status, 'unavailable');
  assert.equal(duplicate.projection.pointers.length, 1);
  assert(!duplicate.projection.scopes.some(s => s.id === 'duplicate-local-pointer'));
});

test('historical app-root claims remain byte-identical evidence, never a newly activated workspace mapping', async () => {
  const h = await harness(), bot = await h.create();
  const legacy = evidence([{ id: 'old-app-root', provider: 'grokbot', title: 'Historical app claim',
    nativeShape: 'Historical unsupported app-root claim', locator: 'native://grokbot/app/opaque' }]);
  const captured = await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, tx.snapshot.roots[0],
    'discovery.recorded', { ...legacy, evidenceHash: contentHash(legacy) }, 'legacy-app-observation', 'local-estate'));
  const bytes = canonicalJson(captured);
  h.transport.responses.push({ summary: 'Do not activate an old app-root claim.', tradeoffs: ['Historical bytes are not mapping authority.'],
    tradeoffLinks: [{ actionId: 'invalid-legacy-workspace', tradeoff: 0 }],
    questions: [], actions: [{ type: 'pointer.register', id: 'invalid-legacy-workspace', scope: 'local-estate',
      evidenceWave: captured.frame_hash, pointerId: 'old-app-root' }] });
  const result = await h.runtime.conversation.converse(bot.root, 'Inspect the historical candidate', 'inspect-legacy-mapping');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.projection.pointers.length, 0);
  assert.equal(canonicalJson(sourceChain(await h.runtime.bots.repository.root(bot.root), 'local-estate')[0]), bytes);
});

test('closed provenance/observation contracts refuse private fields, alias types and false Grok app-root mappings', async () => {
  const h = await harness(), bot = await h.create();
  const local = pointer();
  const invalid = [
    evidence([{ ...local, locator: 'file:///private/source' }]),
    evidence([{ ...local, locator: 'local://workspace/../private' }]),
    evidence([{ ...local, provenance: undefined }]),
    evidence([{ ...local, provenance: { ...provenance(), mappingState: 'app-only' } }]),
    evidence([{ ...local, provenance: { ...provenance(), rawNative: 'PRIVATE-NATIVE-CONTENT' } }]),
    evidence([{ ...local, provenance: { ...provenance(), providerUnion: [['copilot']] } }]),
    evidence([{ ...local, provenance: { ...provenance(), evidenceSha256: ['0'.repeat(64), '0'.repeat(64)] } }]),
    evidence([{ ...local, provider: 'grokbot', locator: 'native://grokbot/application-root/opaque' }]),
    evidence([{ ...local, provider: 'new-provider', locator: 'native://new-provider/workspace/opaque' }]),
    evidence([], [{ ...observation(), locator: 'native://grokbot/workspace/fabricated' }]),
    evidence([], [{ ...observation(), provenance: { ...provenance(), mappingState: 'mapped' } }]),
    evidence([], [{ ...observation(), provider: ['grokbot'] }]),
    evidence([], Array.from({ length: 33 }, (_, i) => ({ ...observation(), id: `observed-${i}` }))),
    evidence([local, { ...local, id: 'duplicate-context' }]),
    { ...evidence(), canonicalClosureAvailable: true },
  ];
  const before = await inventory(h.directory);
  for (const [index, value] of invalid.entries()) await assert.rejects(
    h.runtime.dispatch('estate.record', { root: bot.root, evidence: value }, `bad-evidence-${index}`));
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(h.transport.requests.length, 0);
});

test('full canonical body-stream identity is mandatory and unavailable rooted-estate bindings stay false', async () => {
  const h = await harness(), bot = await h.create();
  const before = await inventory(h.directory);
  for (const root of [bot.name, bot.root.split(':').at(-1), '00000000-0000-4000-8000-000000000000', 'manager-workspace']) {
    await assert.rejects(h.runtime.dispatch('estate.record', { root, evidence: evidence() }, 'no-identity-alias'), { code: 'root-not-found' });
  }
  await assert.rejects(h.runtime.dispatch('estate.record', { root: bot.root, agentId: 'alias', evidence: evidence() }, 'no-agent-id'), { code: 'contract' });
  const egg = await h.runtime.dispatch('egg.at-rest', { root: bot.root });
  assert.equal(egg.identity.body_stream, bot.root);
  assert.equal(egg.identity.body_stream, (await h.runtime.bots.repository.root(bot.root)).streams.body[0].stream_id);
  for (const key of ['canonicalClosureAvailable', 'domainBinding', 'codeLoading', 'sharedRuntime', 'transferAuthority', 'transformation']) assert.equal(egg[key], false);
  assert.equal(h.brainstem.available, true);
  for (const scope of ['godd', 'dogg', 'both']) await assert.rejects(
    h.runtime.dispatch('egg.transfer', { root: bot.root, operation: 'export', scope }), { code: 'canonical-domain-binding-unavailable' });
  await assert.rejects(h.runtime.dispatch('egg.transfer', { root: bot.root, operation: 'export', scope: 'both', ownerActivation: true }), { code: 'contract' });
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(h.transport.requests.length, 0);
});

test('real owner stdio accepts one record per request and resumes only through matching root-bound receipts', async () => {
  const directory = path.join(base, `federation-stdio-${process.pid}-${Date.now()}`);
  const root = fixtureSigners().signers[0].root;
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const packet = { id: 'manifest-item-one', method: 'estate.record', params: { root, evidence: evidence() } };
  const invoke = requests => {
    const result = spawnSync(process.execPath, [cli, '--store', directory, '--fixture', 'stdio'], {
      input: requests.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  const first = invoke([{ id: 'create-federated-root', method: 'bots.create', params: { name: 'Federated fixture root', keyedRoot: root } }, packet]);
  const second = invoke([packet, { id: 'manifest-app-observation', method: 'estate.record', params: { root, evidence: evidence([], [observation()]) } }]);
  assert.equal(first[1].interface, 'rapp-work.stdio/1');
  assert.equal(first[1].result.root, root);
  assert.equal(second[0].result.duplicate, true);
  assert.equal(second[0].result.sourceWave, first[1].result.sourceWave);
  assert.equal(canonicalJson(second[0].result.receipt), canonicalJson(first[1].result.receipt));
  assert.equal(second[1].result.candidates.length, 0);
  assert.equal(second[1].result.observations.length, 1);
  const projection = invoke([{ id: 'inspect-federation', method: 'projection.get', params: { root } }])[0].result;
  assert.equal(projection.outcomes.filter(o => o.event === 'discovery.recorded').length, 2);
  assert.equal(projection.pointers.length, 0);
  const registry = `${directory}-registry.json`;
  await writeFile(registry, JSON.stringify(fixtureSigners().registry, null, 2) + '\n');
  const checked = spawnSync('python3', [fileURLToPath(new URL('../scripts/reference-check.py', import.meta.url)), directory, registry], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const canonical = JSON.parse(checked.stdout);
  assert.equal(canonical.verdict, 'COMPLIANT');
  assert.equal(canonical.framesScanned, 3);
  assert.equal(canonical.signedFrames, 3);
  await writeFile(`${directory}-result.json`, JSON.stringify({
    schema: 'rapp-work.native-federation-proof/1', root, canonicalDirectory: directory,
    publicApi: 'owner rapp-work.stdio/1 estate.record', requests: [packet.id, 'manifest-app-observation'],
    receipts: [first[1].result, second[1].result], duplicateReceipt: second[0].result,
    canonical, registeredWorkspaces: 0, modelCalls: 0, nativeWrites: 0,
    destinationPopulationByHarness: false, originalPrivateManifestImported: false,
  }, null, 2) + '\n');
  const schema = JSON.parse(await readFile(new URL('../contracts/estate-evidence.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(evidence()).sort(), schema.required.slice().sort());
  assert.deepEqual(Object.keys(provenance()).sort(), schema.$defs.provenance.required.slice().sort());
});
