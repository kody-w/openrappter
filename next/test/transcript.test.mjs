import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../dist/canonical.js';
import { ProjectionStreams } from '../dist/ai-stream.js';
import { harness, allowPair } from './harness.mjs';
import { issue } from './ai-fixture.mjs';

const hashes = turns => turns.map(turn => turn.source.frame_hash);

test('one verified transcript carries peer disagreement through every public surface and restart', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const recipientReader = await issue(h, b.root, 'Recipient observer', ['projection.read', 'projection.subscribe']);
  const streams = new ProjectionStreams(h.runtime.ai);
  const subscription = await streams.subscribe(b.root, recipientReader.capability);
  await streams.take(subscription.subscription);

  const exchange = await h.runtime.collaboration.ask(a.root, b.root,
    'Review the public plan and preserve disagreement.', 'unified-peer-review');
  const expected = hashes(exchange.transcript);
  const peer = exchange.transcript.find(turn => turn.speaker === b.root);
  assert(peer.text.includes('Disagreement: Do not normalize'));

  const owner = await h.runtime.bots.project(a.root);
  const dispatched = await h.runtime.dispatch('projection.get', { root: a.root });
  const reader = await issue(h, a.root, 'Unified reader', ['projection.read']);
  const ai = await h.runtime.ai.read(a.root, reader.capability);
  for (const projection of [owner, dispatched, ai]) {
    assert.deepEqual(hashes(projection.turns), expected);
    assert.equal(projection.transcript.total, expected.length);
    assert.equal(projection.transcript.truncatedBefore, false);
    assert.equal(projection.transcript.truncatedAfter, false);
  }

  await streams.poll();
  const recipientUpdate = (await streams.take(subscription.subscription, 8)).at(-1);
  assert.equal(recipientUpdate.reason, 'transcript-changed');
  assert(recipientUpdate.snapshot.turns.some(turn => turn.speaker === a.root));
  assert(recipientUpdate.snapshot.turns.some(turn => turn.speaker === b.root
    && turn.text.includes('Disagreement: Do not normalize')));

  h.transport.responses.push({
    summary: 'Continue from the complete verified public exchange.',
    tradeoffs: [], tradeoffLinks: [], questions: [], actions: [],
  });
  const next = await h.runtime.conversation.converse(a.root, 'What should we do next?', 'after-peer-review');
  const context = h.transport.requests.at(-1).canonicalContext;
  assert(context.transcript.turns.some(turn => turn.speaker === b.root
    && turn.text.includes('Disagreement: Do not normalize')));
  assert(expected.every(hash => hashes(next.projection.turns).includes(hash)));

  await h.runtime.channels.bind(a.root, 'a'.repeat(64), 'b'.repeat(64), true, 'unified-recap-binding');
  const recap = await h.runtime.channels.queueRecap(a.root, 'unified-recap');
  assert(recap.summary.includes('Disagreement: Do not normalize'));
  assert.equal(recap.transcript.schema, 'rapp-work.transcript-page/1');
  assert.equal(recap.transcript.truncatedBefore, false);
  assert.equal(recap.sourceSelection.truncatedAfter, false);
  assert(recap.truncatedSources.length > 0);
  assert(recap.summary.includes('[truncated]'));

  const beforeRestart = await h.runtime.bots.project(a.root);
  assert.equal(canonicalJson(await (await h.restart()).bots.project(a.root)), canonicalJson(beforeRestart));
  streams.close();
});

test('owner, AI and model-context transcript windows expose deterministic pagination metadata', async () => {
  const h = await harness();
  const bot = await h.create();
  for (let index = 0; index < 70; index++) {
    await h.runtime.conversation.report(bot.root, 'root', { text: `public-context-${index}` }, `public-context-${index}`);
  }
  const latest = await h.runtime.bots.project(bot.root);
  assert.equal(latest.transcript.total, 70);
  assert.equal(latest.transcript.returned, 64);
  assert.equal(latest.transcript.offset, 6);
  assert.equal(latest.transcript.truncatedBefore, true);
  assert.equal(latest.transcript.truncatedAfter, false);
  assert.equal(latest.turns[0].text, 'public-context-6');

  const first = await h.runtime.dispatch('projection.get',
    { root: bot.root, transcriptOffset: 0, transcriptLimit: 10 });
  assert.equal(first.transcript.total, 70);
  assert.equal(first.transcript.offset, 0);
  assert.equal(first.transcript.nextOffset, 10);
  assert.equal(first.transcript.truncatedAfter, true);
  assert.equal(first.turns[0].text, 'public-context-0');

  await h.runtime.channels.bind(bot.root, 'a'.repeat(64), 'b'.repeat(64), true, 'paged-recap-binding');
  const recap = await h.runtime.channels.queueRecap(bot.root, 'paged-recap');
  assert.equal(recap.sourceSelection.total, 70);
  assert.equal(recap.sourceSelection.returned, 6);
  assert.equal(recap.sourceSelection.truncatedBefore, true);

  const collaborationPage = await h.runtime.dispatch('collaboration.transcript',
    { root: bot.root, transcriptOffset: 10, transcriptLimit: 5 });
  assert.equal(collaborationPage.offset, 10);
  assert.equal(collaborationPage.returned, 5);
  assert.equal(collaborationPage.turns[0].text, 'public-context-10');

  const reader = await issue(h, bot.root, 'Paged reader', ['projection.read']);
  const ai = await h.runtime.ai.read(bot.root, reader.capability, undefined, { offset: 0, limit: 8 });
  assert.equal(ai.transcript.total, 70);
  assert.equal(ai.transcript.returned, 8);
  assert.equal(ai.transcript.truncatedAfter, true);
  assert.equal(ai.turns[0].text, 'public-context-0');

  h.transport.responses.push({
    summary: 'Use the visible page and its explicit truncation metadata.',
    tradeoffs: [], tradeoffLinks: [], questions: [], actions: [],
  });
  await h.runtime.conversation.converse(bot.root, 'Use the recent verified context.', 'paged-context');
  const context = h.transport.requests.at(-1).canonicalContext.transcript;
  assert.equal(context.total, 71);
  assert.equal(context.returned, 32);
  assert.equal(context.truncatedBefore, true);
  assert.equal(context.truncatedAfter, false);
  assert(!context.turns.some(turn => turn.text === 'public-context-0'));
  assert(context.turns.some(turn => turn.text === 'public-context-69'));
});

test('a newly signed peer turn invalidates a proposal that did not review that transcript state', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const proposal = await h.runtime.conversation.converse(b.root, 'Create a Builder world', 'recipient-plan');
  await h.runtime.collaboration.ask(a.root, b.root, 'Add a new signed public perspective.', 'later-peer-turn');
  await assert.rejects(h.runtime.conversation.confirm(b.root, proposal.proposalWave, 'stale-recipient-plan'),
    { code: 'stale-head' });
  assert(!(await h.runtime.bots.project(b.root)).scopes.some(scope => scope.id === 'copilot-builder'));
});
