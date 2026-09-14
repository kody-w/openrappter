import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../dist/canonical.js';
import { HeadlessRuntime } from '../dist/runtime.js';
import { request } from '../dist/cli.js';
import { fixtureSigners, SyntheticIMessage } from '../dist/fixtures.js';
import { DEFAULT_CHANNEL_POLICY, questionPending } from '../dist/channel-contract.js';
import { memoryFrames } from '../dist/source-memory.js';

const next = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(next, '.test-scratch', `imessage-headless-${process.pid}-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const directory = path.join(evidence, 'canonical');
const keys = fixtureSigners(), root = keys.signers[0].root;
const contact = 'SYNTHETIC-PRIVATE-CONTACT', permission = 'SYNTHETIC-PRIVATE-PERMISSION';
const reportId = 'cli-gauntlet-publication';
const commands = [
  { id: 'create-channel-root', method: 'bots.create', params: { name: 'Private continuity fixture', keyedRoot: root } },
  { id: 'bind-private-channel', method: 'channels.bind', params: {
    root, contactRef: contact, permissionRef: permission, shortcut: 'SYNTHETIC-PRIVATE-SHORTCUT', credential: 'SYNTHETIC-PRIVATE-CREDENTIAL',
    enabled: true, policy: { ...DEFAULT_CHANNEL_POLICY, automaticQuestions: true },
  } },
  { id: reportId, method: 'conversation.report', params: { root, report: {
    text: 'Which bounded owner-approved option should proceed?',
    clarify: { schema: 'rapp-work.clarify/1', kind: 'gauntlet', turnId: reportId, requires: 'copilot-cli',
      questions: [{ id: 'choice', reason: 'human-authority', text: 'Which bounded owner-approved option should proceed?' }] },
  } } },
];
const cli = spawnSync(process.execPath, [path.join(next, 'dist/cli.js'), '--store', directory, '--fixture', 'stdio'], {
  input: commands.map(c => JSON.stringify(c)).join('\n') + '\n', encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr);
const results = cli.stdout.trim().split('\n').map(line => JSON.parse(line));
assert(results.every(r => r.interface === 'rapp-work.stdio/1' && !r.error));
assert.equal(results[2].result.modelCalls, 0);
assert.equal(results[2].result.guestEffects, 0);
assert.equal(results[2].result.channelEffects, 0);
const question = results[2].result.receipt.frame_hash;
const channel = new SyntheticIMessage();
let modelCalls = 0;
const options = { directory, signatures: keys.signatures, signers: keys.signers, channel,
  provider: { complete: async () => { modelCalls++; throw new Error('This proof must not infer a second report'); } } };
const runtime = await HeadlessRuntime.open(options);
const invoke = async (method, params, id) => {
  const reply = await request(runtime, JSON.stringify({ id, method, params: { root, ...params } }));
  assert(!reply.error, canonicalJson(reply));
  return reply.result;
};
const queued = await invoke('channels.recap', {}, 'read-auto-queue');
assert.equal(queued.pending.length, 1);
const deliveryId = queued.pending[0].deliveryId;
const unavailable = await invoke('channels.deliver', { deliveryId }, 'approved-offline-preflight');
assert.equal(unavailable.status, 'unavailable');
assert.equal(unavailable.generation, 1);
channel.available = true;
const incoming = { contactRef: contact, messageId: 'synthetic-input', text: 'yes', fixtureAuthenticated: true };
const received = await invoke('channels.receive', { envelope: incoming }, 'owner-ingress');
assert.equal(received.attribution.origin, 'external');
assert.equal(received.status, 'pending');
assert.equal(received.confirmationAccepted, false);
assert(questionPending(await runtime.bots.repository.root(root), question));
const delivered = await invoke('channels.deliver', { deliveryId }, 'approved-eligible-preflight');
assert.equal(delivered.status, 'delivered');
assert.equal(delivered.generation, 2);
assert.equal(channel.sent.size, 1);
await invoke('conversation.answer', { sourceWave: question, text: 'Use the first explicitly bounded option.' }, 'genuine-cli-answer');
await invoke('channels.review-inbound', { sourceWave: received.receipt.frame_hash }, 'genuine-inbox-review');
await runtime.channels.drain();
assert(!questionPending(await runtime.bots.repository.root(root), question));
const projection = await runtime.dispatch('projection.get', { root });
const recap = await runtime.channels.recap(root);
async function inventory(folder) {
  const data = {};
  const walk = async (directory, relative = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else data[name] = sha256(await readFile(path.join(directory, entry.name)));
    }
  };
  await walk(folder); return data;
}
const before = await inventory(directory), privateBefore = await inventory(runtime.channels.bindings.directory);
const restarted = await HeadlessRuntime.open(options);
assert.equal(canonicalJson(await restarted.dispatch('projection.get', { root })), canonicalJson(projection));
assert.equal(canonicalJson(await restarted.channels.recap(root)), canonicalJson(recap));
await restarted.channels.receive(root, incoming);
await restarted.channels.deliver(root, deliveryId, 'never-replay-delivered');
assert.equal(channel.sent.size, 1);
assert.equal(modelCalls, 0);
assert.deepEqual(await inventory(directory), before);
assert.deepEqual(await inventory(runtime.channels.bindings.directory), privateBefore);
const state = await restarted.bots.repository.root(root);
const bytes = canonicalJson(state);
for (const secret of [contact, permission, 'SYNTHETIC-PRIVATE-SHORTCUT', 'SYNTHETIC-PRIVATE-CREDENTIAL']) assert(!bytes.includes(secret));
assert.equal(memoryFrames(state).filter(f => f.payload.event === 'channel.queued').length, 1);
await writeFile(path.join(evidence, 'fixture-registry.json'), JSON.stringify(keys.registry, null, 2) + '\n');
const checked = spawnSync('python3', [path.join(next, 'scripts/reference-check.py'), directory, path.join(evidence, 'fixture-registry.json')], {
  encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
assert.equal(checked.status, 0, checked.stdout + checked.stderr);
const canonical = JSON.parse(checked.stdout);
assert(canonical.framesScanned > 0 && canonical.signedFrames === canonical.framesScanned);
const proof = {
  schema: 'rapp-work.private-imessage-proof/1', root, canonical,
  exactOriginalRootAndConversation: true, reportingViaActualOwnerStdio: true, oneSamePublicationGauntletQuestion: true,
  externalAttribution: received.attribution, externalRole: 'user', externalReplyTo: null, externalConfirmationAccepted: false,
  canonicalQuestionSource: question, canonicalQueueSource: deliveryId,
  preflightGenerations: [unavailable.generation, delivered.generation],
  producerModelCalls: 0, producerGuestEffects: 0, producerChannelEffects: 0, modelCalls,
  syntheticDeliveriesAfterSeparateApproval: channel.sent.size, liveDeliveries: 0,
  privateMaterialInCanonicalTree: false, privateRuntimeSibling: path.relative(next, runtime.channels.bindings.directory),
  restartProjectionAndRecapIdentical: true, uncertainOrDeliveredReplay: false,
  ownerTccSetupPerformed: false, sourceOrLiveProfilesTouched: false,
  evidenceDirectory: path.relative(next, evidence), canonicalDirectory: path.relative(next, directory),
};
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(proof, null, 2) + '\n');
await writeFile(path.join(evidence, 'public-projection.json'), JSON.stringify(projection, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
