import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFrame, canonicalJson, frameHead } from '../dist/canonical.js';
import { eventPayload } from '../dist/contract.js';
import { CanonicalRepository } from '../dist/repository.js';
import { projectBot } from '../dist/projection.js';
import { projectAi } from '../dist/ai-projector.js';
import { catchUpTimeline } from '../dist/catch-up.js';
import { foldState } from '../dist/state.js';
import { sourceChain, sourceStream, memoryFrames, memoryPrefix, memoryCursor } from '../dist/source-memory.js';
import { DEFAULT_CHANNEL_POLICY, questionPending } from '../dist/channel-contract.js';
import { harness, inventory, deferred } from './harness.mjs';
import { canonicalForks } from '../dist/canonical-forks.js';

const draft = (id, name = id) => ({
  summary: `Create the ${name} internal scope.`, tradeoffs: ['A reviewed canonical scope is not a native directory.'],
  questions: [], actions: [{ type: 'scope.create', scope: { id, parent: 'root', kind: 'world', name, description: 'Reviewed internal identity.' } }],
});

test('retained same-stream forks fence both interpretations and successors without erasing either occurrence', async () => {
  const h = await harness(), bot = await h.create(), other = await h.create(1);
  await h.runtime.conversation.recordProgress(bot.root, 'monorepo', 'Common ancestor', [], 'fork-base');
  await h.runtime.conversation.recordProgress(bot.root, 'monorepo', 'First successor', [], 'fork-left');
  const root = await h.runtime.bots.repository.root(bot.root);
  const [base, left] = sourceChain(root, 'monorepo');
  const right = buildFrame({ kind: 'memory.tool-call', streamId: sourceStream(bot.root, 'monorepo'), head: frameHead(base),
    utc: left.utc, signer: h.keys.signers[0].signer, signatures: h.keys.signatures,
    payload: { ...eventPayload(bot.root, 'monorepo', 'fork-right', 'work.progress', { summary: 'Conflicting second successor', evidence: [] }),
      parents: [...left.payload.parents] } });
  assert.equal(right.seq, left.seq);
  assert.equal(right.prev, left.prev);
  assert.notEqual(right.frame_hash, left.frame_hash);
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(bot.root, 'memory', [base, right]));
  const preserved = await inventory(h.directory);
  const reopened = await CanonicalRepository.open({ directory: h.directory, signatures: h.keys.signatures });
  const evidence = await reopened.root(bot.root);
  assert.equal(canonicalJson(sourceChain(evidence, 'monorepo')[1]), canonicalJson(left));
  assert.equal(canonicalJson(evidence.sources.find(s => s.scope === 'monorepo').branches[0].frames[1]), canonicalJson(right));
  for (const view of [() => projectBot(evidence), () => projectAi(evidence, 'root'), () => catchUpTimeline(evidence, 'root')]) {
    assert.throws(view, { code: 'canonical-fork-unresolved' });
  }
  assert.throws(() => memoryPrefix(evidence, 0), { code: 'canonical-fork-unresolved' });
  assert.throws(() => memoryCursor(evidence), { code: 'canonical-fork-unresolved' });
  await assert.rejects(h.runtime.collaboration.transcript(bot.root), { code: 'canonical-fork-unresolved' });
  await assert.rejects(h.runtime.channels.recap(bot.root), { code: 'canonical-fork-unresolved' });
  const selectedOtherSide = { ...evidence, sources: evidence.sources.map(s => s.scope === 'monorepo'
    ? { ...s, frames: [base, right], branches: [{ head: left.frame_hash, frames: [base, left] }] } : s) };
  assert.throws(() => projectBot(selectedOtherSide), { code: 'canonical-fork-unresolved' });
  await assert.rejects(h.runtime.conversation.recordProgress(bot.root, 'monorepo', 'Must not follow a folder-selected branch', [], 'after-fork'),
    { code: 'canonical-fork-unresolved' });
  await assert.rejects(reopened.transaction(tx => tx.append({
    root: bot.root, family: 'memory', kind: 'memory.tool-call', utc: left.utc, expectedHead: left.frame_hash,
    signer: h.keys.signers[0].signer, payload: eventPayload(bot.root, 'monorepo', 'raw-after-fork', 'work.progress', { summary: 'No bypass', evidence: [] }),
  })), { code: 'canonical-fork-unresolved' });
  assert.deepEqual(await inventory(h.directory), preserved);
  assert.equal((await h.runtime.bots.project(other.root)).root, other.root);
  const registry = `${h.directory}-fork-registry.json`;
  await writeFile(registry, JSON.stringify(h.keys.registry, null, 2) + '\n');
  const check = spawnSync('python3', [fileURLToPath(new URL('../scripts/reference-check.py', import.meta.url)), h.directory, registry], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const canonical = JSON.parse(check.stdout);
  assert.equal(canonical.signedFrames, 6);
  await writeFile(`${h.directory}-review-fork-proof.json`, JSON.stringify({
    schema: 'rapp-work.review-fork-proof/1', root: bot.root, canonicalDirectory: h.directory,
    canonical, forks: canonicalForks(evidence), individuallyValidChainsAuthorizeNeitherFork: true,
    originalBytesPreserved: true, profileReopenedForEvidence: true, bothProjectionsFenced: true,
    ordinaryAndRawAppendRefused: true, independentOtherRootStillUsable: true, selectedDirectoryGrantsAuthority: false,
  }, null, 2) + '\n');
});

test('retained unique extensions cannot be ignored as inactive-directory data, while exact ancestry prefixes remain usable', async () => {
  const h = await harness(), bot = await h.create();
  await h.runtime.conversation.recordProgress(bot.root, 'monorepo', 'Original source', [], 'retained-base');
  const root = await h.runtime.bots.repository.root(bot.root), first = sourceChain(root, 'monorepo')[0];
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(bot.root, 'memory', [first]));
  assert.equal((await h.runtime.bots.project(bot.root)).progress.length, 1);
  const next = buildFrame({ kind: 'memory.tool-call', streamId: first.stream_id, head: frameHead(first), utc: first.utc,
    signer: h.keys.signers[0].signer, signatures: h.keys.signatures,
    payload: { ...eventPayload(bot.root, 'monorepo', 'retained-extension', 'work.progress', { summary: 'Retained successor', evidence: [] }),
      parents: [first.frame_hash, root.streams.body[0].frame_hash] } });
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(bot.root, 'memory', [first, next]));
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.bots.project(bot.root), { code: 'canonical-head-unresolved' });
  await assert.rejects(h.runtime.conversation.recordProgress(bot.root, 'monorepo', 'Competing successor', [], 'competing-extension'), { code: 'canonical-head-unresolved' });
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal((await h.restart()).bots.repository.directory, h.directory);
});

test('a corrected scope ID cannot be recreated and parent future work to an obsolete creation', async () => {
  const h = await harness(), bot = await h.create();
  h.time('2026-09-13T20:00:00.000Z');
  h.transport.responses.push(draft('retired-world', 'Original world'));
  const first = await h.runtime.conversation.converse(bot.root, 'Create the original world', 'create-retired');
  await h.runtime.conversation.confirm(bot.root, first.proposalWave, 'confirm-retired');
  const original = memoryFrames(await h.runtime.bots.repository.root(bot.root)).find(f => f.payload.operationId === 'confirm-retired');
  h.time('2026-09-13T20:00:01.000Z');
  await h.runtime.conversation.undo(bot.root, original.frame_hash, 'Retire this creation without erasing identity history.', 'retire-world');
  h.time('2026-09-13T20:00:02.000Z');
  h.transport.responses.push(draft('retired-world', 'Recreated world'));
  const reused = await h.runtime.conversation.converse(bot.root, 'Do not reuse a corrected identity', 'reuse-retired');
  assert.equal(reused.status, 'unavailable');
  assert(!reused.projection.scopes.some(s => s.id === 'retired-world'));
  const preserved = await inventory(h.directory);
  h.time('2026-09-13T20:00:00.000Z');
  await assert.rejects(h.runtime.conversation.recordProgress(bot.root, 'retired-world', 'No obsolete creation parent', [], 'obsolete-parent'));
  const reopened = await h.restart();
  assert(!foldState(await reopened.bots.repository.root(bot.root)).scopes.some(s => s.id === 'retired-world'));
  assert.deepEqual(await inventory(h.directory), preserved);
  assert.equal(canonicalJson(memoryFrames(await reopened.bots.repository.root(bot.root)).find(f => f.frame_hash === original.frame_hash)), canonicalJson(original));
});

test('root 65 is rejected before directories/genesis; hidden roots count and all 64 remain readable', async () => {
  const h = await harness();
  const roots = [];
  for (let i = 0; i < 64; i++) roots.push(await h.runtime.bots.create({ name: `Bounded root ${i}`, operationId: `bounded-root-${i}` }));
  await h.runtime.bots.visibility(roots[0].root, true, 'hide-but-count');
  await h.runtime.channels.drain();
  const before = await inventory(h.directory);
  const names = (await readdir(path.join(h.directory, 'bots'))).sort();
  await assert.rejects(h.runtime.bots.create({ name: 'Must not publish root 65', operationId: 'root-over-capacity' }), { code: 'root-capacity' });
  assert.deepEqual(await inventory(h.directory), before);
  assert.deepEqual((await readdir(path.join(h.directory, 'bots'))).sort(), names);
  const reopened = await h.restart();
  assert.equal((await reopened.bots.list(true)).length, 64);
  assert.equal((await reopened.bots.list()).length, 63);
  assert.equal((await reopened.bots.create({ name: 'Bounded root 1', operationId: 'bounded-root-1' })).root, roots[1].root);
  assert.deepEqual(await inventory(h.directory), before);
  await writeFile(`${h.directory}-review-capacity-proof.json`, JSON.stringify({
    schema: 'rapp-work.review-capacity-proof/1', canonicalDirectory: h.directory,
    existingRoots: 64, hiddenRootsCounted: 1, rejectedRoot: 65, rejection: 'root-capacity',
    filesUnchanged: true, rootDirectoriesUnchanged: true, restartReadableRoots: 64, exactCreationRetryStable: true,
  }, null, 2) + '\n');
});

async function queued() {
  const h = await harness(), bot = await h.create();
  await h.runtime.channels.bind(bot.root, 'PRIVATE-REVIEW-CONTACT', 'PRIVATE-REVIEW-PERMISSION', true, 'review-binding',
    { ...DEFAULT_CHANNEL_POLICY, automaticQuestions: true });
  h.channel.available = true;
  const id = 'review-deadline-question';
  const report = await h.runtime.conversation.report(bot.root, 'root', { text: 'Which bounded choice?',
    clarify: { schema: 'rapp-work.clarify/1', kind: 'gauntlet', turnId: id, requires: 'copilot-cli',
      questions: [{ id: 'choice', reason: 'human-authority', text: 'Which bounded choice?' }] } }, id);
  await h.runtime.channels.drain();
  return { ...h, bot, question: report.receipt.frame_hash, queue: (await h.runtime.channels.recap(bot.root)).pending[0].deliveryId };
}

test('private binding retrieval consumes the original preflight deadline and cannot reach transport after expiry', async () => {
  const h = await queued();
  const reached = deferred(), release = deferred(), get = h.runtime.channels.bindings.get.bind(h.runtime.channels.bindings);
  let preflights = 0;
  h.runtime.channels.bindings.get = async (...args) => { reached.resolve(); await release.promise; return get(...args); };
  h.channel.preflight = async () => { preflights++; return { status: 'ready' }; };
  const delivery = h.runtime.channels.deliver(h.bot.root, h.queue, 'binding-consumes-deadline');
  await reached.promise;
  h.time('2026-09-13T20:00:31.000Z'); release.resolve();
  const result = await delivery;
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'preflight-expired');
  assert.equal(preflights, 0); assert.equal(h.channel.sent.size, 0);
  assert(!memoryFrames(await h.runtime.bots.repository.root(h.bot.root)).some(f => f.payload.event === 'channel.attempt'));
  const retried = await (await h.restart()).channels.deliver(h.bot.root, h.queue, 'fresh-after-binding-expiry');
  assert.equal(retried.status, 'delivered');
  assert.equal(retried.generation, 2);
});

test('final dispatch rechecks the selected canonical preflight expiry after a ready response', async () => {
  const h = await queued();
  h.channel.preflight = async () => { h.time('2026-09-13T20:00:31.000Z'); return { status: 'ready' }; };
  const result = await h.runtime.channels.deliver(h.bot.root, h.queue, 'readiness-consumes-deadline');
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'preflight-expired');
  assert.equal(h.channel.sent.size, 0);
  const root = await h.runtime.bots.repository.root(h.bot.root);
  assert(!memoryFrames(root).some(f => f.payload.event === 'channel.attempt'));
  assert(memoryFrames(root).some(f => f.payload.event === 'channel.preflight.outcome' && f.payload.data.submitted === false));
});

test('a blocked private binding read times out inside the original preflight lease without reaching transport', { timeout: 5_000 }, async () => {
  const h = await queued();
  await h.runtime.channels.bind(h.bot.root, 'PRIVATE-REVIEW-CONTACT', 'PRIVATE-REVIEW-PERMISSION', true, 'short-binding-lease',
    { ...DEFAULT_CHANNEL_POLICY, automaticQuestions: true, preflightSeconds: 1 });
  await h.runtime.channels.consider(h.bot.root);
  const queue = (await h.runtime.channels.recap(h.bot.root)).pending.at(-1).deliveryId;
  const release = deferred(), get = h.runtime.channels.bindings.get.bind(h.runtime.channels.bindings);
  h.runtime.channels.bindings.get = async (...args) => { await release.promise; return get(...args); };
  let preflights = 0;
  h.channel.preflight = async () => { preflights++; return { status: 'ready' }; };
  try {
    const result = await h.runtime.channels.deliver(h.bot.root, queue, 'bounded-private-read');
    assert.equal(result.status, 'deferred');
    assert.equal(result.reason, 'preflight-expired');
    assert.equal(preflights, 0);
    assert.equal(h.channel.sent.size, 0);
  } finally { release.resolve(); }
});

test('confirmed CLI draft.resolves settles the same canonical question and prevents duplicate notification delivery', async () => {
  const h = await harness(), bot = await h.create();
  await h.runtime.channels.bind(bot.root, 'PRIVATE-SETTLEMENT-CONTACT', 'PRIVATE-SETTLEMENT-PERMISSION', true, 'settlement-binding',
    { ...DEFAULT_CHANNEL_POLICY, automaticQuestions: true });
  h.channel.available = true;
  h.transport.responses.push({ summary: 'An owner decision is needed.', tradeoffs: [], actions: [],
    questions: [{ reason: 'human-authority', question: 'Which scope should be used?' }] });
  const original = await h.runtime.conversation.converse(bot.root, 'Ask the owner', 'ask-settlement');
  await h.runtime.channels.drain();
  const queue = (await h.runtime.channels.recap(bot.root)).pending[0].deliveryId;
  h.transport.responses.push({ summary: 'The genuine CLI answer chooses the existing scope.', tradeoffs: ['No new identity is required.'],
    actions: [], questions: [], resolves: [original.proposalWave] });
  const answer = await h.runtime.conversation.converse(bot.root, 'Use the existing monorepo scope.', 'cli-settlement-answer');
  assert.equal(questionPending(await h.runtime.bots.repository.root(bot.root), original.proposalWave), true);
  await h.runtime.conversation.confirm(bot.root, answer.proposalWave, 'confirm-settlement');
  const root = await h.runtime.bots.repository.root(bot.root);
  assert.equal(foldState(root).proposals.get(original.proposalWave).status, 'superseded');
  assert.equal(questionPending(root, original.proposalWave), false);
  const before = await inventory(h.directory), calls = h.transport.requests.length;
  const result = await h.runtime.channels.deliver(bot.root, queue, 'never-send-settled-question');
  assert.equal(result.status, 'resolved');
  assert.equal(h.channel.sent.size, 0);
  assert.equal((await (await h.restart()).channels.recap(bot.root)).pending.length, 0);
  assert.equal(h.transport.requests.length, calls);
  assert.deepEqual(await inventory(h.directory), before);
});
