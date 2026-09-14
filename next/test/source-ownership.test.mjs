import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildFrame, canonicalJson, frameHead, streamFor } from '../dist/canonical.js';
import { eventPayload } from '../dist/contract.js';
import { projectBot } from '../dist/projection.js';
import { ProjectionStreams } from '../dist/ai-stream.js';
import { publishedRecords } from '../dist/ai-projector.js';
import { sourceChain, sourceStream, sourceKey, sourceReference, memoryFrames, memoryCursor, memoryAtCursor } from '../dist/source-memory.js';
import { verifyRootFiles } from '../dist/migration-contract.js';
import { foldState } from '../dist/state.js';
import { CanonicalRepository } from '../dist/repository.js';
import { Bots } from '../dist/bots.js';
import { harness, inventory } from './harness.mjs';
import { issue, publish } from './ai-fixture.mjs';
import { sourceOwnedProof } from './source-owned-fixture.mjs';

test('all aggregate surfaces reference unique source-owned exhaust and rebuild from original frames only', async () => {
  const result = await sourceOwnedProof();
  assert.equal(result.report.status, 'passed');
  assert(result.report.observedEvents > 0 && result.report.replayPages > 0);
  const schema = JSON.parse(await readFile(new URL('../contracts/source-reference.schema.json', import.meta.url), 'utf8'));
  for (const ref of result.report.references) assert.deepEqual(Object.keys(ref).sort(), schema.required.slice().sort());
  const timeline = JSON.parse(await readFile(new URL('../contracts/catch-up.schema.json', import.meta.url), 'utf8'));
  for (const page of result.pages) for (const step of page.steps) {
    assert.deepEqual(Object.keys(step).sort(), timeline.properties.steps.items.required.slice().sort());
    assert(step.sourceFrameHashes.every(hash => /^[0-9a-f]{64}$/.test(hash)));
  }
});

test('source-vector replay and subscriptions never skip a newly observed earlier-clock source', async () => {
  const h = await harness(), bot = await h.create();
  const client = await issue(h, bot.root, 'Independent Clocks');
  h.time('2026-09-13T20:00:20.000Z');
  const a = await h.runtime.ai.publish(bot.root, client.capability,
    { ...publish('conversation', { text: 'World A was observed first.' }), scope: 'local-estate' }, 'later-clock');
  const first = await h.runtime.ai.read(bot.root, client.capability);
  const streams = new ProjectionStreams(h.runtime.ai);
  const subscription = await streams.subscribe(bot.root, client.capability, first.cursor);
  await streams.take(subscription.subscription);
  h.time('2026-09-13T20:00:10.000Z');
  const b = await h.runtime.ai.publish(bot.root, client.capability,
    { ...publish('conversation', { text: 'World B arrived later with an earlier independent clock.' }), scope: 'monorepo' }, 'earlier-clock');
  const history = await h.runtime.ai.history(bot.root, client.capability, first.cursor);
  assert.deepEqual(history.records.map(r => r.source.frame_hash), [b.receipt.frame_hash]);
  const reconstructed = await h.runtime.ai.read(bot.root, client.capability, history.cursor);
  assert.deepEqual(new Set(reconstructed.turns.map(t => t.source.frame_hash)), new Set([a.receipt.frame_hash, b.receipt.frame_hash]));
  const replay = await h.runtime.ai.catchUp(bot.root, client.capability, { from: first.cursor });
  assert.equal(replay.steps.length, 1);
  assert.equal(replay.steps[0].origin.frame_hash, b.receipt.frame_hash);
  assert.equal(canonicalJson(replay.steps[0].state.projection), canonicalJson(reconstructed));
  await streams.poll();
  const updates = await streams.take(subscription.subscription, 8);
  assert.equal(updates.length, 1);
  assert.equal(canonicalJson(updates[0].previous), canonicalJson(first.cursor));
  assert.equal(canonicalJson(updates[0].snapshot), canonicalJson(reconstructed));
  streams.close();
});

test('source vectors refuse omitted causal ancestry, unknown scopes, forged heads and duplicate scope keys', async () => {
  const h = await harness(), bot = await h.create();
  await h.runtime.conversation.recordProgress(bot.root, 'local-estate', 'Source A', [], 'a');
  await h.runtime.conversation.recordProgress(bot.root, 'monorepo', 'Source B', [], 'b');
  await h.runtime.bots.visibility(bot.root, true, 'observe-and-hide');
  const root = await h.runtime.bots.repository.root(bot.root);
  const cursor = memoryCursor(root);
  assert.equal(cursor.schema, 'rapp-work.source-cursor/1');
  const bad = [
    { ...cursor, guid: h.keys.signers[1].root },
    { ...cursor, sources: cursor.sources.slice(1) },
    { ...cursor, sources: [...cursor.sources, cursor.sources[0]] },
    { ...cursor, sources: [{ ...cursor.sources[0], key: '0'.repeat(64) }, ...cursor.sources.slice(1)] },
    { ...cursor, sources: [{ ...cursor.sources[0], head: { ...cursor.sources[0].head, payload_hash: '0'.repeat(64) } }, ...cursor.sources.slice(1)] },
    cursor.root,
  ];
  for (const value of bad) assert.throws(() => memoryAtCursor(root, value), { code: 'cursor-invalid' });
  assert.equal(canonicalJson(memoryCursor(memoryAtCursor(root, cursor))), canonicalJson(cursor));
});

test('unknown source parents, uncreated scopes and cross-scope operation rebinding refuse before any durable write', async () => {
  const h = await harness(), bot = await h.create();
  const append = (scope, operationId, extra = {}) => h.runtime.bots.repository.transaction(tx => tx.append({
    root: bot.root, family: 'memory', kind: 'memory.tool-call', utc: h.runtime.bots.now(), expectedHead: null,
    signer: h.keys.signers[0].signer,
    payload: { ...eventPayload(bot.root, scope, operationId, 'work.progress', { summary: 'An exact bounded outcome', evidence: [] }), ...extra },
  }));
  const before = await inventory(h.directory);
  await assert.rejects(append('local-estate', 'unknown-parent', { parents: ['f'.repeat(64)] }), { code: 'source-lineage' });
  await assert.rejects(append('uncreated-world', 'unknown-scope'), { code: 'source-scope' });
  assert.deepEqual(await inventory(h.directory), before);
  await append('local-estate', 'one-receipt');
  const selected = await inventory(h.directory);
  await assert.rejects(append('monorepo', 'one-receipt'), { code: 'idempotency-conflict' });
  assert.deepEqual(await inventory(h.directory), selected);
});

test('malformed source graphs and path reassignment cannot masquerade as exact retained source ownership', async () => {
  const h = await harness(), bot = await h.create();
  for (const scope of ['local-estate', 'monorepo']) await h.runtime.conversation.recordProgress(bot.root, scope, scope, [], `work-${scope}`);
  const root = await h.runtime.bots.repository.root(bot.root);
  const [left, right] = root.sources;
  const cyclic = { ...root, sources: [
    { ...left, frames: [{ ...left.frames[0], payload: { ...left.frames[0].payload, parents: [...left.frames[0].payload.parents, right.frames[0].frame_hash] } }] },
    { ...right, frames: [{ ...right.frames[0], payload: { ...right.frames[0].payload, parents: [...right.frames[0].payload.parents, left.frames[0].frame_hash] } }] },
  ] };
  assert.throws(() => memoryFrames(cyclic), { code: 'source-lineage' });
  assert.throws(() => memoryFrames({ ...root, streams: { ...root.streams, memory: [left.frames[0]] } }), { code: 'source-duplication' });
  const files = new Map([
    ['body/frames/000000000000.json', Buffer.from(canonicalJson(root.streams.body[0]))],
    [`scopes/${sourceKey(bot.root, right.scope)}/frames/000000000000.json`, Buffer.from(canonicalJson(left.frames[0]))],
  ]);
  assert.throws(() => verifyRootFiles(bot.root, files, h.keys.signatures), { code: 'migration-source' });
});

test('immutable historical centralized scope frames remain byte-identical and explicitly legacy, never reminted', async () => {
  const h = await harness(), bot = await h.create();
  const original = await h.runtime.bots.repository.root(bot.root);
  const legacy = buildFrame({ kind: 'memory.tool-call', streamId: streamFor(bot.root, 'memory'), head: null, utc: h.runtime.bots.now(),
    signer: h.keys.signers[0].signer, signatures: h.keys.signatures,
    payload: eventPayload(bot.root, 'monorepo', 'historical-exhaust', 'work.progress', { summary: 'Original legacy activity', evidence: [] }) });
  const bytes = Buffer.from(canonicalJson(legacy));
  const root = verifyRootFiles(bot.root, new Map([
    ['body/frames/000000000000.json', Buffer.from(canonicalJson(original.streams.body[0]))], ['memory/frames/000000000000.json', bytes],
  ]), h.keys.signatures);
  const ref = sourceReference(root.streams.memory[0]);
  assert.equal(ref.guid, bot.root);
  assert.equal(ref.scope, 'monorepo');
  assert.equal(ref.ownership, 'legacy-root-stream');
  assert.equal(canonicalJson(root.streams.memory[0]), bytes.toString());
  assert.equal(projectBot(root).progress[0].origin.frame_hash, legacy.frame_hash);
  assert.equal(root.sources, undefined);
  assert.equal(canonicalJson(memoryCursor(root)), canonicalJson(frameHead(legacy)));
  const correction = buildFrame({ kind: 'memory.save', streamId: sourceStream(bot.root, 'monorepo'), head: null, utc: h.runtime.bots.now(),
    signer: h.keys.signers[0].signer, signatures: h.keys.signatures,
    payload: { ...eventPayload(bot.root, 'monorepo', 'correct-historical', 'state.corrected', { targetWave: legacy.frame_hash, reason: 'A source-owned correction, not a rewrite.' }),
      parents: [root.streams.body[0].frame_hash] } });
  const corrected = { ...root, sources: [{ scope: 'monorepo', stream: correction.stream_id, frames: [correction], branches: [] }] };
  assert.equal(foldState(corrected).progress.length, 0);
  assert.equal(canonicalJson(corrected.streams.memory[0]), bytes.toString());
  assert.equal(sourceReference(correction).ownership, 'source-owned');
});

test('scoped client renewal/revocation preserves prior publication causality even with equal UTC timestamps', async () => {
  const h = await harness(), bot = await h.create();
  const client = await issue(h, bot.root, 'Root Author');
  const work = await h.runtime.ai.publish(bot.root, client.capability,
    { ...publish('conversation', { text: 'Authorized before revocation' }), scope: 'monorepo' }, 'prior');
  const renewed = await h.runtime.ai.authority.grant(bot.root, { client: client.client, name: 'Root Author', provider: 'root-author',
    scope: 'local-estate', rights: ['projection.read'], ttlSeconds: 3_600 }, 'renew-in-another-permitted-scope');
  await h.runtime.ai.authority.revoke(bot.root, client.client, 'Explicit local revocation', 'end-authority');
  const root = await h.runtime.bots.repository.root(bot.root);
  assert(publishedRecords(root).some(r => r.frame.frame_hash === work.receipt.frame_hash));
  await assert.rejects(h.runtime.ai.read(bot.root, client.capability), { code: 'client-unauthorized' });
  await assert.rejects(h.runtime.ai.read(bot.root, renewed.capability), { code: 'client-unauthorized' });
  const reader = await issue(h, bot.root, 'Later Observer', ['projection.read']);
  assert((await h.runtime.ai.read(bot.root, reader.capability)).turns.some(t => t.source.frame_hash === work.receipt.frame_hash));
});

test('external receipts and correction successors belong to their original source world, not the organizing root', async () => {
  const h = await harness(), bot = await h.create();
  h.transport.responses.push({ summary: 'Review one request only.', tradeoffs: ['This records a bounded request; separate exact approval is required for any effect.'], questions: [], actions: [
    { type: 'external.request', id: 'world-request', scope: 'local-estate', operation: 'send-message', target: 'fixture:operator', content: 'Public bounded request.' },
  ], tradeoffLinks: [{ actionId: 'world-request', tradeoff: 0 }] });
  const proposal = await h.runtime.conversation.converse(bot.root, 'Review a bounded world action', 'review-world');
  await h.runtime.conversation.confirm(bot.root, proposal.proposalWave, 'confirm-world');
  const effect = foldState(await h.runtime.bots.repository.root(bot.root)).effects.get('world-request');
  await h.runtime.effects.approve(bot.root, effect.id, effect.requestHash, effect.target, 'world-approval');
  await h.runtime.conversation.recordProgress(bot.root, 'local-estate', 'A reversible result', [], 'world-result');
  let root = await h.runtime.bots.repository.root(bot.root);
  const outcome = sourceChain(root, 'local-estate').at(-1);
  await h.runtime.conversation.undo(bot.root, outcome.frame_hash, 'Append the correction here', 'world-correction');
  root = await h.runtime.bots.repository.root(bot.root);
  assert(!root.streams.memory.some(f => ['effect.approved', 'effect.outcome', 'state.corrected'].includes(f.payload.event)));
  const source = sourceChain(root, 'local-estate');
  assert.deepEqual(source.map(f => f.payload.event), ['effect.approved', 'effect.outcome', 'work.progress', 'state.corrected']);
  assert.equal(source[0].payload.data.requestWave, effect.source);
  assert.equal(source[1].payload.data.approval, source[0].frame_hash);
  assert.equal(foldState(root).progress.length, 0);
  assert.equal(canonicalJson(source[2]), canonicalJson(outcome));
  assert.equal(source.at(-1).stream_id, sourceStream(bot.root, 'local-estate'));
});

test('first-source publication failures retain canonical atomicity and lost acknowledgements deduplicate', async () => {
  const h = await harness(), bot = await h.create();
  let fault = 'before-publish';
  const repository = await CanonicalRepository.open({ directory: h.directory, signatures: h.keys.signatures,
    fault: point => { if (point === fault) { fault = ''; throw new Error('Synthetic publication fault'); } } });
  const bots = new Bots({ repository, spine: h.runtime.bots.spine, capability: h.runtime.bots.capability,
    signers: h.keys.signers, clock: () => '2026-09-13T20:00:00.000Z' });
  const publish = () => repository.transaction(tx => bots.appendEvent(tx, tx.snapshot.roots[0], 'work.progress',
    { summary: 'One durable source occurrence', evidence: [] }, 'first-source-write', 'local-estate'));
  const before = await inventory(h.directory);
  await assert.rejects(publish(), /Synthetic publication fault/);
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal((await repository.root(bot.root)).sources, undefined);
  fault = 'after-publish';
  await assert.rejects(publish(), /Synthetic publication fault/);
  const committed = await inventory(h.directory);
  const retry = await publish();
  assert.equal(sourceChain(await repository.root(bot.root), 'local-estate').length, 1);
  assert.equal(retry.frame_hash, sourceChain(await repository.root(bot.root), 'local-estate')[0].frame_hash);
  assert.deepEqual(await inventory(h.directory), committed);
});

test('organization review binds all permitted source context without serializing unrelated sibling worlds', async () => {
  const h = await harness(), bot = await h.create();
  const rootProposal = await h.runtime.conversation.converse(bot.root, 'Review a Builder world', 'root-review');
  await h.runtime.conversation.recordProgress(bot.root, 'local-estate', 'Relevant new source evidence', [], 'source-changed');
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.conversation.confirm(bot.root, rootProposal.proposalWave, 'stale-source-confirm'), { code: 'stale-head' });
  assert.deepEqual(await inventory(h.directory), before);
  h.transport.responses.push({ summary: 'Create one nested world.', tradeoffs: ['Only this source subtree is reorganized.'], questions: [], actions: [
    { type: 'scope.create', scope: { id: 'nested-world', parent: 'monorepo', kind: 'world', name: 'Nested world', description: 'Source-scoped review.' } },
  ], tradeoffLinks: [{ actionId: 'nested-world', tradeoff: 0 }] });
  const scoped = await h.runtime.conversation.converse(bot.root, 'Organize this subtree', 'scoped-review', 'monorepo');
  await h.runtime.conversation.recordProgress(bot.root, 'local-estate', 'Unrelated sibling evidence', [], 'sibling-changed');
  const confirmed = await h.runtime.conversation.confirm(bot.root, scoped.proposalWave, 'scoped-confirm');
  assert(confirmed.scopes.some(s => s.id === 'nested-world' && s.parent === 'monorepo'));
});
