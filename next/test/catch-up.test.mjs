import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, canonicalJson, contentHash } from '../dist/canonical.js';
import { findRoot } from '../dist/bots.js';
import { AiEndpoint } from '../dist/ai-endpoint.js';
import { eventPayload } from '../dist/contract.js';
import { sourceChain } from '../dist/source-memory.js';
import { CatchUpPlayer } from './catch-up-player.mjs';
import { harness, inventory, durableText, allowPair } from './harness.mjs';
import { issue, publish, view } from './ai-fixture.mjs';

function trustedReplay(root, scope, request, page, guestEvidenceDigest = null) {
  const { timelineDigest: _claimed, ...payload } = page;
  const trustedTimelineDigest = contentHash(payload);
  assert.equal(page.timelineDigest, trustedTimelineDigest);
  return {
    schema: 'rapp-work.catch-up-verification-input/1',
    root: root.definition.root,
    scope,
    request,
    guestEvidenceDigest,
    trustedTimelineDigest,
  };
}

async function seeded() {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Catchup');
  await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: 'Public canonical work, not private reasoning.' }), 'work');
  const recorded = await h.runtime.ai.publish(a.root, client.capability, publish('view', {}, view('root', 'work')), 'recorded-view');
  await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: 'Work survives an unavailable hint.' },
    { ...view(), html: 'NEVER-EXPOSE-PRIVATE-UI-CODE' }), 'unavailable-hint');
  return { h, a, client, recorded };
}

test('Catch me up grades recorded intents, reconstructed state and unavailable material with exact source hashes/digests', async () => {
  const { h, a, client, recorded } = await seeded();
  const page = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  assert.equal(page.schema, 'rapp-work.catch-up/1');
  assert(page.grades.recorded > 0 && page.grades.reconstructed > 0 && page.grades.unavailable > 0);
  const stored = page.steps.find(s => s.cursor.frame_hash === recorded.receipt.frame_hash);
  assert.equal(stored.grade, 'recorded');
  assert.equal(stored.stateGrade, 'reconstructed');
  assert.match(stored.reason, /not-screen-recording/);
  assert.deepEqual(stored.sourceFrameHashes[0], recorded.receipt.frame_hash);
  for (const step of page.steps) {
    assert.equal(step.stepKind, 'occurrence');
    assert.equal(step.sourceFrameHashes[0], step.cursor.frame_hash);
    if (step.state !== null) assert.equal(contentHash(step.state), step.stateDigest);
  }
  assert.equal(page.contract.modelCalls, 0);
  assert.equal(page.contract.toolExecutions, 0);
  assert.equal(page.contract.mutations, 0);
  assert(!JSON.stringify(page).includes(client.capability));
  assert(!JSON.stringify(page).includes('tokenHash'));
  assert(!JSON.stringify(page).includes('NEVER-EXPOSE-PRIVATE-UI-CODE'));
});

test('client activity, evidence and attention content references remain in replay provenance', async () => {
  const { h, a, client, recorded } = await seeded();
  const activity = await h.runtime.ai.publish(a.root, client.capability, publish('activity', {
    summary: 'Activity cites its exact recorded work.', status: 'complete', completed: 1, total: 1,
    evidence: [recorded.receipt.frame_hash],
  }), 'provenance-activity');
  const evidence = await h.runtime.ai.publish(a.root, client.capability, publish('evidence', {
    summary: 'Evidence cites both prior canonical occurrences.',
    references: [recorded.receipt.frame_hash, activity.receipt.frame_hash],
  }), 'provenance-evidence');
  const attention = await h.runtime.ai.publish(a.root, client.capability, publish('attention', {
    summary: 'The exact evidence needs review.', reason: 'decision',
    references: [activity.receipt.frame_hash, evidence.receipt.frame_hash],
  }), 'provenance-attention');
  const page = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  const expected = new Map([
    [activity.receipt.frame_hash, [recorded.receipt.frame_hash]],
    [evidence.receipt.frame_hash, [recorded.receipt.frame_hash, activity.receipt.frame_hash]],
    [attention.receipt.frame_hash, [activity.receipt.frame_hash, evidence.receipt.frame_hash]],
  ]);
  for (const [wave, references] of expected) {
    const step = page.steps.find(candidate => candidate.cursor.frame_hash === wave);
    assert(step);
    for (const reference of references) assert(step.sourceFrameHashes.includes(reference));
  }
});

test('replay and natural Catch me up never invoke models/tools or mutate canonical files', async () => {
  const { h, a, client } = await seeded();
  h.runtime.bots.spine.compute = async () => { throw new Error('Replay invoked a model'); };
  h.runtime.effects.port.execute = async () => { throw new Error('Replay invoked a tool'); };
  h.runtime.channels.port.send = async () => { throw new Error('Replay invoked delivery'); };
  const before = await inventory(h.directory);
  const calls = h.transport.requests.length;
  const result = await h.runtime.conversation.converse(a.root, 'Catch me up!', 'no-replay-write');
  assert.equal(result.status, 'orientation');
  assert(result.catchUp);
  await h.runtime.dispatch('conversation.catch-up', { root: a.root, from: null });
  await h.runtime.ai.catchUp(a.root, client.capability);
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(h.transport.requests.length, calls);
});

test('fixed end cursors reconstruct identical pages after restart and after later canonical appends', async () => {
  const { h, a, client } = await seeded();
  const first = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  const restarted = await h.restart();
  assert.equal(canonicalJson(await restarted.ai.catchUp(a.root, client.capability, { from: null, to: first.to })), canonicalJson(first));
  await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: 'Later work must not change a pinned replay.' }), 'later');
  const pinned = await restarted.ai.catchUp(a.root, client.capability, { from: null, to: first.to });
  assert.equal(canonicalJson(pinned), canonicalJson(first));
});

test('a pinned replay is unchanged by later signed peer transcript state', async () => {
  const { h, a, client } = await seeded();
  const b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const first = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  await h.runtime.collaboration.ask(a.root, b.root,
    'Add a later signed public disagreement.', 'later-replay-collaboration');
  const live = await h.runtime.ai.read(a.root, client.capability);
  assert(live.turns.some(turn => turn.speaker === b.root && turn.text.includes('Disagreement:')));
  const pinned = await h.runtime.ai.catchUp(a.root, client.capability, { from: null, to: first.to });
  assert.equal(canonicalJson(pinned), canonicalJson(first));
});

test('bounded pages and a passive fast-forward player preserve state digests without last-position authority', async () => {
  const { h, a, client } = await seeded();
  const canonicalRoot = await h.runtime.bots.repository.root(a.root);
  const whole = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  const wholeTrust = trustedReplay(canonicalRoot, 'root', { from: null }, whole);
  const fast = new CatchUpPlayer(canonicalRoot, 'root');
  fast.load(whole, wholeTrust); fast.forward(whole.steps.length);
  const slow = new CatchUpPlayer(canonicalRoot, 'root');
  let cursor = null, more = true;
  while (more) {
    const request = { from: cursor, to: whole.to, limit: 1 };
    const page = await h.runtime.ai.catchUp(a.root, client.capability, request);
    assert(page.steps.length <= 1);
    slow.load(page, trustedReplay(canonicalRoot, 'root', request, page)); slow.forward(page.steps.length);
    cursor = page.next; more = page.more;
  }
  assert.equal(slow.stateDigest, fast.stateDigest);
  assert.equal(canonicalJson(slow.state), canonicalJson(fast.state));
  const altered = JSON.parse(JSON.stringify(whole));
  altered.steps[0].grade = 'recorded';
  const { timelineDigest: _claimed, ...alteredPayload } = altered;
  altered.timelineDigest = contentHash(alteredPayload);
  assert.throws(() => new CatchUpPlayer(canonicalRoot, 'root').load(altered, wholeTrust));
  await assert.rejects(h.runtime.ai.catchUp(a.root, client.capability, { limit: 17 }), { code: 'replay-bound' });
});

test('retained branch-catalogue-only changes emit a state-only step and conflicting branches still refuse', async () => {
  const { h, a, client } = await seeded();
  await h.runtime.conversation.recordProgress(a.root, 'monorepo', 'Branch catalogue source.', [], 'branch-catalogue-source');
  const before = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  const source = await h.runtime.bots.repository.root(a.root);
  const first = sourceChain(source, 'monorepo')[0];
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(a.root, 'memory', [first]));
  const canonicalRoot = await h.runtime.bots.repository.root(a.root);
  const request = { from: before.to };
  const page = await h.runtime.ai.catchUp(a.root, client.capability, request);
  assert.equal(page.steps.length, 1);
  const [step] = page.steps;
  assert.equal(step.stepKind, 'state-only');
  assert.equal(step.event, 'retained-source-branches-changed');
  assert.equal(step.workGrade, 'unavailable');
  assert.equal(step.stateGrade, 'reconstructed');
  assert.equal(step.origin, null);
  assert.deepEqual(step.sourceFrameHashes, [first.frame_hash]);
  assert.deepEqual(step.previousCursor, before.to);
  assert.deepEqual(step.cursor, page.to);
  assert.deepEqual(page.next, page.to);
  assert.equal(page.more, false);
  const player = new CatchUpPlayer(canonicalRoot, 'root');
  player.load(page, trustedReplay(canonicalRoot, 'root', request, page));
  player.forward(page.steps.length);
  assert.deepEqual(player.cursor, page.to);

  const conflict = buildFrame({
    kind: first.kind, streamId: first.stream_id, head: null, utc: first.utc,
    signer: h.keys.signers[0].signer, signatures: h.keys.signatures,
    payload: {
      ...eventPayload(a.root, 'monorepo', 'branch-catalogue-conflict', 'work.progress',
        { summary: 'Conflicting retained interpretation.', evidence: [] }),
      parents: [...first.payload.parents],
    },
  });
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(a.root, 'memory', [conflict]));
  await assert.rejects(h.runtime.ai.catchUp(a.root, client.capability, { from: null }),
    { code: 'canonical-fork-unresolved' });
});

test('bad/cross-root/reversed cursors refuse rather than inventing missing timeline state', async () => {
  const { h, a, client } = await seeded();
  const b = await h.create(1);
  const other = await issue(h, b.root, 'Other Replay');
  await h.runtime.ai.publish(b.root, other.capability, publish('conversation', { text: 'Other root' }), 'other');
  const one = await h.runtime.ai.catchUp(a.root, client.capability, { from: null });
  const two = await h.runtime.ai.catchUp(b.root, other.capability, { from: null });
  await assert.rejects(h.runtime.ai.catchUp(a.root, client.capability, { from: two.to }), { code: 'cursor-invalid' });
  await assert.rejects(h.runtime.ai.catchUp(a.root, client.capability, { from: { ...one.to, frame_hash: '0'.repeat(64) } }), { code: 'cursor-invalid' });
  await assert.rejects(h.runtime.ai.catchUp(a.root, client.capability, { from: one.to, to: one.steps[0].cursor }), { code: 'replay-range' });
});

test('scope filtering and public projection never export private metadata or chain-of-thought fields', async () => {
  const { h, a } = await seeded();
  await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, findRoot(tx, a.root),
    'turn.assistant', { text: 'Only this public summary may replay.', analysis: 'PRIVATE-CHAIN-OF-THOUGHT-FIELD' }, 'legacy-public-with-private-metadata'));
  const reader = await issue(h, a.root, 'Root Reader', ['projection.read']);
  const rootPage = await h.runtime.ai.catchUp(a.root, reader.capability, { from: null });
  assert(!canonicalJson(rootPage).includes('PRIVATE-CHAIN-OF-THOUGHT-FIELD'));
  assert((await durableText(h.directory)).includes('PRIVATE-CHAIN-OF-THOUGHT-FIELD'));
  const scoped = await issue(h, a.root, 'Scoped Reader', ['projection.read'], 'monorepo');
  const scopedPage = await h.runtime.ai.catchUp(a.root, scoped.capability, { from: null });
  assert(!canonicalJson(scopedPage).includes('Only this public summary'));
  assert(scopedPage.steps.some(s => s.grade === 'unavailable' && s.reason === 'outside-authorized-scope'));
});

test('restricted MCP/stdio Catch me up uses the same authenticated read-only timeline', async () => {
  const { h, a, client } = await seeded();
  const output = [];
  const endpoint = new AiEndpoint(h.runtime.ai, a.root, client.capability, 'stdio', message => output.push(message));
  const before = await inventory(h.directory);
  await endpoint.handle(JSON.stringify({ id: 'catch-up', method: 'rapp_work_catch_up', params: { root: a.root, from: null } }));
  assert.equal(output[0].result.schema, 'rapp-work.catch-up/1');
  assert.equal(canonicalJson(output[0].result), canonicalJson(await h.runtime.ai.catchUp(a.root, client.capability, { from: null })));
  assert.deepEqual(await inventory(h.directory), before);
  endpoint.close();
});
