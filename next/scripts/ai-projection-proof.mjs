import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HeadlessRuntime } from '../dist/runtime.js';
import { fixtureSigners, FixtureCopilotTransport, FixtureBrainstem } from '../dist/fixtures.js';
import { CopilotSdkProvider } from '../dist/copilot.js';
import { AI_RIGHTS, VIEW_SCHEMA } from '../dist/ai-contract.js';
import { AiEndpoint } from '../dist/ai-endpoint.js';
import { ProjectionStreams } from '../dist/ai-stream.js';
import { canonicalJson } from '../dist/canonical.js';
import { TestProjectionConsumer } from '../test/projection-consumer.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(directory, '.test-scratch', `ai-projection-${process.pid}-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const keys = fixtureSigners();
const transport = new FixtureCopilotTransport();
let time = Date.parse('2026-09-13T21:30:00.000Z');
const options = {
  directory: path.join(evidence, 'canonical'), signers: keys.signers, signatures: keys.signatures,
  brainstem: new FixtureBrainstem(), clock: () => new Date(time++).toISOString(),
  provider: new CopilotSdkProvider(transport, { mode: 'empty', sessionStorage: 'memory-only', canonicalContextOnly: true }),
};
const runtime = await HeadlessRuntime.open(options);
const bot = await runtime.bots.create({ name: 'Provider-neutral RAPP Work Bot', operationId: 'create-root', keyedRoot: keys.signers[0].root });
const providers = ['copilot', 'claude', 'hermes', 'scout', 'grokbot', 'future-provider'];
const clients = {};
for (const provider of [...providers, 'observer', 'resolver']) {
  const rights = provider === 'observer' ? ['projection.read', 'projection.subscribe']
    : provider === 'resolver' ? [...AI_RIGHTS] : AI_RIGHTS.filter(r => r !== 'view.resolve');
  clients[provider] = await runtime.ai.authority.grant(bot.root,
    { name: provider, provider, scope: 'root', rights, ttlSeconds: 3_600 }, `grant-${provider}`);
}
const streams = new ProjectionStreams(runtime.ai);
const countBefore = (await runtime.bots.repository.snapshot()).frameCount;
const subscription = await streams.subscribe(bot.root, clients.observer.capability);
const consumer = new TestProjectionConsumer(bot.root);
for (const event of await streams.take(subscription.subscription)) consumer.accept(event);
assert.equal((await runtime.bots.repository.snapshot()).frameCount, countBefore);
const publish = (provider, id, kind, content, hint, parents = [], causes = []) => runtime.ai.publish(bot.root,
  clients[provider].capability, { kind, content, causes, ...(hint ? { view: hint, viewParents: parents } : {}) }, id);
const view = (focus, emphasis, cards = [], progress = null) =>
  ({ schema: VIEW_SCHEMA, focus, emphasis, cards, progress, screenArtifact: null });
for (const provider of providers) {
  await publish(provider, 'public-turn', 'conversation', { text: `${provider} contributes an independently attributed public turn to the same bot.` });
}
await streams.poll();
for (const event of await streams.take(subscription.subscription, 8)) consumer.accept(event);
assert.equal(consumer.state.turns.length, 6);
const activity = await publish('claude', 'activity', 'activity', {
  summary: 'Inspecting permitted canonical work', status: 'working', completed: 1, total: 3, evidence: [],
});
const first = await publish('claude', 'view', 'view', {}, view('monorepo', 'work', [{ kind: 'activity', ref: activity.receipt.frame_hash }], activity.receipt.frame_hash));
await streams.poll();
for (const event of await streams.take(subscription.subscription, 8)) consumer.accept(event);
assert.equal(consumer.state.layout, 'work');
assert.equal(consumer.state.progress.completed, 1);
const second = await publish('copilot', 'parallel-view', 'view', {}, view('root', 'evidence'));
await streams.poll();
for (const event of await streams.take(subscription.subscription, 8)) consumer.accept(event);
assert.equal(consumer.state.conflicts.length, 1);
await publish('scout', 'evidence', 'evidence', { summary: 'Canonical activity evidence', references: [activity.receipt.frame_hash] });
await publish('grokbot', 'attention', 'attention', {
  summary: 'Resolve the public projection disagreement explicitly.', reason: 'decision',
  references: [first.receipt.frame_hash, second.receipt.frame_hash],
});
await publish('resolver', 'resolve', 'view', {}, view('root', 'review'), [first.receipt.frame_hash, second.receipt.frame_hash],
  [first.receipt.frame_hash, second.receipt.frame_hash]);
await streams.poll();
for (const event of await streams.take(subscription.subscription, 8)) consumer.accept(event);
assert.equal(consumer.state.layout, 'review');
assert.equal(consumer.state.conflicts.length, 0);
const refused = await publish('hermes', 'unsupported-hint', 'conversation', { text: 'My useful work survives an unsupported projection hint.' },
  { ...view('root', 'work'), html: '<script>REJECTED-EXECUTABLE-UI</script>' });
assert.equal(refused.viewAccepted, false);
assert.equal(refused.viewRefusal.code, 'view-hint-refused');
await streams.poll();
for (const event of await streams.take(subscription.subscription, 8)) consumer.accept(event);
const proposalContext = await runtime.ai.context(bot.root, clients['future-provider'].capability);
const proposalDraft = {
  summary: 'Create one durable provider-neutral proposal artifact.',
  tradeoffs: ['The external client publishes review data; only the exact owner confirmation may apply it.'],
  questions: [],
  actions: [{
    type: 'artifact.save', id: 'provider-neutral-proposal-proof', scope: 'root',
    name: 'Provider neutral proposal proof', content: 'Applied after exact owner confirmation.', mediaType: 'text/plain',
  }],
  resolves: [],
};
const proposal = await runtime.ai.propose(bot.root, clients['future-provider'].capability,
  { contextRevision: proposalContext.revision, draft: proposalDraft }, 'provider-neutral-proposal');
assert.equal(proposal.status, 'review');
assert.equal(proposal.confirmationAuthority, 'owner-only');
assert.equal(proposal.mutationApplied, false);
const deniedMessages = [];
const restricted = new AiEndpoint(runtime.ai, bot.root, clients['future-provider'].capability,
  'stdio', message => deniedMessages.push(message));
await restricted.handle(JSON.stringify({
  id: 'self-confirm', method: 'rapp_work_confirm',
  params: { root: bot.root, proposalWave: proposal.proposalWave },
}));
assert.equal(deniedMessages.at(-1).error.code, 'method-unavailable');
assert(!(await runtime.ai.read(bot.root, clients.observer.capability)).artifacts.some(a => a.id === 'provider-neutral-proposal-proof'));
await assert.rejects(runtime.conversation.confirm(bot.root, '0'.repeat(64), 'wrong-owner-confirmation'), { code: 'proposal' });
await runtime.conversation.confirm(bot.root, proposal.proposalWave, 'exact-owner-confirmation');
await streams.poll();
for (const event of await streams.take(subscription.subscription, 8)) consumer.accept(event);
assert.equal(consumer.state.root, bot.root);
const lastApplied = consumer.cursor;
streams.unsubscribe(subscription.subscription);
const slow = new ProjectionStreams(runtime.ai, { queuedEvents: 2, queuedBytes: 262_144 });
const slowSub = await slow.subscribe(bot.root, clients.observer.capability);
await slow.take(slowSub.subscription);
for (let i = 0; i < 3; i++) await publish('future-provider', `later-${i}`, 'conversation', { text: `Retained future-provider work ${i}` });
await slow.poll();
await slow.poll();
assert.equal((await slow.take(slowSub.subscription))[0].reason, 'backpressure');
const expected = await runtime.ai.read(bot.root, clients.observer.capability);
const before = await runtime.bots.repository.snapshot();
const restarted = await HeadlessRuntime.open(options);
assert.deepEqual(await restarted.bots.repository.snapshot(), before);
assert.deepEqual(await restarted.ai.read(bot.root, clients.observer.capability), expected);
const restartedProposal = (await restarted.ai.read(bot.root, clients.observer.capability)).proposals
  .find(candidate => candidate.wave === proposal.proposalWave);
assert.equal(restartedProposal.status, 'applied');
assert((await restarted.ai.read(bot.root, clients.observer.capability)).artifacts
  .some(artifact => artifact.id === 'provider-neutral-proposal-proof'));
const replay = new ProjectionStreams(restarted.ai);
const resumed = await replay.subscribe(bot.root, clients.observer.capability, lastApplied);
const rebuilt = new TestProjectionConsumer(bot.root);
for (const event of await replay.take(resumed.subscription)) rebuilt.accept(event);
await replay.poll();
for (const event of await replay.take(resumed.subscription, 8)) rebuilt.accept(event);
const freshSub = await replay.subscribe(bot.root, clients.observer.capability);
const fresh = new TestProjectionConsumer(bot.root);
for (const event of await replay.take(freshSub.subscription)) fresh.accept(event);
assert.equal(canonicalJson(rebuilt.state), canonicalJson(fresh.state));
const retry = await publish('copilot', 'public-turn', 'conversation',
  { text: 'copilot contributes an independently attributed public turn to the same bot.' });
assert.equal(retry.duplicate, true);
assert.equal(transport.requests.length, 0);
assert.equal((await runtime.bots.list()).length, 1);
let allBytes = '';
async function scan(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await scan(path.join(directory, item.name));
    else allBytes += await readFile(path.join(directory, item.name), 'utf8');
  }
}
await scan(options.directory);
assert(!allBytes.includes('REJECTED-EXECUTABLE-UI'));
for (const client of Object.values(clients)) assert(!allBytes.includes(client.capability));
await writeFile(path.join(evidence, 'registry.json'), JSON.stringify(keys.registry, null, 2) + '\n');
const checked = spawnSync('python3', [path.join(directory, 'scripts/reference-check.py'), options.directory, path.join(evidence, 'registry.json')],
  { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
assert.equal(checked.status, 0, checked.stdout + checked.stderr);
const canonical = JSON.parse(checked.stdout);
assert(canonical.framesScanned > 0 && canonical.signedFrames === canonical.framesScanned);
const skill = await readFile(path.join(directory, 'skills/rapp-work-bot/SKILL.md'));
const result = {
  schema: 'rapp-work.ai-projection-evidence/1', authoritative: false,
  root: bot.root, rootCount: 1, providers, clientCount: Object.keys(clients).length,
  canonical, observationFrameMutations: 0, modelCalls: 0, modelReplayOnRestart: 0,
  exactRestartProjection: true, realTimeTestConsumer: true, causalConflictObserved: true,
  explicitResolutionVerified: true, unsupportedHintWorkRetained: true, backpressureResync: true,
  reconnectReplayEquivalent: true, credentialPlaintextPersisted: false, uiImplemented: false,
  providerNeutralProposal: {
    provider: 'future-provider', contextRead: true, structuredDraftValidated: true,
    proposalWave: proposal.proposalWave, selfConfirmationRefused: true,
    exactOwnerConfirmationRequired: true, mutationBeforeConfirmation: false,
    appliedResultReconstructedAfterRestart: true,
  },
  attribution: 'root-signed scoped-capability attribution; not vendor/client-key non-repudiation',
  protocols: ['MCP stdio 2025-11-25', 'bounded native stdio events'],
  evidenceDirectory: path.relative(directory, evidence),
  skillSha256: createHash('sha256').update(skill).digest('hex'),
  productionCredentialBindingPerformed: false,
  controlledLocalAcceptance: 'not-run; real provider credentials and TCC/contact evidence were not supplied',
};
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(path.join(evidence, 'consumer-state.json'), JSON.stringify(rebuilt.state, null, 2) + '\n');
const outputIndex = process.argv.indexOf('--write-verification');
if (outputIndex >= 0) {
  const target = process.argv[outputIndex + 1];
  assert(target, '--write-verification requires a destination');
  const resolved = path.resolve(target);
  assert(resolved.startsWith(path.join(directory, 'verification') + path.sep), 'Verification output must stay under next/verification.');
  await writeFile(resolved, JSON.stringify(result, null, 2) + '\n');
}
streams.close(); slow.close(); replay.close();
console.log(JSON.stringify(result, null, 2));
