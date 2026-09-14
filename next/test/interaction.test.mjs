import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../dist/canonical.js';
import { findRoot } from '../dist/bots.js';
import { canonicalContext } from '../dist/conversation.js';
import { foldState } from '../dist/state.js';
import { harness, inventory, durableText, readFixture } from './harness.mjs';
import { memoryFrames, sourceChain } from '../dist/source-memory.js';

test('incomplete thought -> complete public review -> atomic confirmed organization -> restart without model replay', async () => {
  const h = await harness();
  const bot = await h.create();
  const result = await h.runtime.conversation.converse(bot.root, 'I need a place to build the Copilot bridge', 'builder-thought');
  assert.equal(result.status, 'review');
  assert(!result.projection.scopes.some(s => s.id === 'copilot-builder'));
  assert.match(result.text, /Tradeoff/);
  assert.equal(h.transport.requests.length, 1);
  const confirmed = await h.runtime.conversation.confirm(bot.root, result.proposalWave, 'confirm-builder');
  assert(confirmed.scopes.some(s => s.id === 'copilot-builder'));
  assert.equal(confirmed.artifacts[0].name, 'Builder brief');
  assert.equal(confirmed.proposals[0].status, 'applied');
  assert.equal((await h.runtime.bots.repository.snapshot()).frameCount, 4);
  const before = await inventory(h.directory);
  const restarted = await h.restart();
  assert.deepEqual(await restarted.bots.project(bot.root), confirmed);
  await restarted.conversation.confirm(bot.root, result.proposalWave, 'confirm-builder');
  const replay = await restarted.conversation.converse(bot.root, 'I need a place to build the Copilot bridge', 'builder-thought');
  assert.equal(replay.proposalWave, result.proposalWave);
  assert.equal(h.transport.requests.length, 1);
  assert.deepEqual(await inventory(h.directory), before);
});

test('one natural conversation accepts contextual confirmation and clear/restore without model replays', async () => {
  const h = await harness();
  const a = await h.create();
  const proposal = await h.runtime.conversation.converse(a.root, 'I need a Builder world', 'natural-thought');
  const confirmed = await h.runtime.conversation.converse(a.root, 'Yes, do that.', 'natural-confirm');
  assert.equal(confirmed.status, 'complete');
  assert.equal(confirmed.proposalWave, proposal.proposalWave);
  assert(confirmed.projection.scopes.some(s => s.id === 'copilot-builder'));
  await h.runtime.conversation.converse(a.root, 'Yes, do that.', 'natural-confirm');
  const cleared = await h.runtime.conversation.converse(a.root, 'Clear this bot', 'natural-clear');
  assert.equal(cleared.projection.hidden, true);
  assert.match(cleared.text, /nothing was deleted/);
  const restored = await h.runtime.conversation.converse(a.root, 'Restore this bot', 'natural-restore');
  assert.equal(restored.projection.hidden, false);
  assert.equal(restored.projection.root, a.root);
  assert.equal(h.transport.requests.length, 1);
  await assert.rejects(h.runtime.conversation.converse(a.root, 'yes', 'ambiguous-confirm'), { code: 'confirmation-context' });
});

test('irreducible human authority questions prevent confirmation, not ordinary context inference', async () => {
  const h = await harness();
  const bot = await h.create();
  h.transport.responses.push({
    summary: 'The external destination requires your authority.',
    tradeoffs: ['Keep internal preparation reversible; delivery remains outside authority.'],
    questions: [{ reason: 'human-authority', question: 'Which recipient is authorized to receive the completed brief?' }],
    actions: [],
  });
  const result = await h.runtime.conversation.converse(bot.root, 'Prepare a private handoff', 'human-question');
  assert.equal(result.status, 'review');
  assert.equal(result.projection.attention[0].kind, 'human-question');
  await assert.rejects(h.runtime.conversation.confirm(bot.root, result.proposalWave, 'confirm-ambiguous'), { code: 'human-question' });
  assert.equal((await h.runtime.bots.repository.root(bot.root)).streams.memory.length, 2);
});

test('a reviewed human answer supersedes its exact question without erasing the public decision history', async () => {
  const h = await harness();
  const a = await h.create();
  h.transport.responses.push({
    summary: 'Choose the authorized recipient.', tradeoffs: ['No external effect is authorized.'],
    questions: [{ reason: 'human-authority', question: 'Which recipient may receive the handoff?' }], actions: [],
  });
  const question = await h.runtime.conversation.converse(a.root, 'Prepare a handoff', 'handoff-question');
  h.transport.responses.push({
    summary: 'Record your answer: the fixture operator is the intended recipient; delivery is still separately gated.',
    tradeoffs: ['Confirming records the public decision only; it does not send a message.'],
    questions: [], actions: [], resolves: [question.proposalWave],
  });
  const answer = await h.runtime.conversation.converse(a.root, 'The fixture operator is the recipient', 'handoff-answer');
  assert.equal(answer.status, 'review');
  assert(answer.projection.attention.some(a => a.kind === 'human-question'));
  const confirmed = await h.runtime.conversation.confirm(a.root, answer.proposalWave, 'confirm-human-answer');
  assert(!confirmed.attention.some(a => a.kind === 'human-question'));
  assert.equal(confirmed.proposals.find(p => p.wave === question.proposalWave).status, 'superseded');
  assert(confirmed.turns.some(t => t.text.includes('Which recipient')));
  assert.deepEqual(await (await h.restart()).bots.project(a.root), confirmed);
});

test('unknown model tools, hidden reasoning and provider errors never persist raw output or execute', async () => {
  const h = await harness();
  const bot = await h.create();
  for (const [i, response] of [
    { ...(await readFixture('copilot-builder')), reasoning: 'DO-NOT-PERSIST-HIDDEN-ANALYSIS' },
    { summary: '<thinking>DO-NOT-PERSIST-HIDDEN-ANALYSIS</thinking>', tradeoffs: [], questions: [], actions: [] },
    { summary: 'Execute', tradeoffs: ['No authority'], questions: [], actions: [{ type: 'host.shell', command: 'PRIVATE-NATIVE-COMMAND' }] },
    new Error('PRIVATE-PROVIDER-TOKEN diagnostic'),
  ].entries()) {
    h.transport.responses.push(response);
    assert.equal((await h.runtime.conversation.converse(bot.root, 'A bounded safe thought', `bad-response-${i}`)).status, 'unavailable');
  }
  const stored = await durableText(h.directory);
  assert(!stored.includes('DO-NOT-PERSIST-HIDDEN-ANALYSIS'));
  assert(!stored.includes('PRIVATE-PROVIDER-TOKEN'));
  assert(!stored.includes('PRIVATE-NATIVE-COMMAND'));
  assert.equal((await h.runtime.bots.project(bot.root)).scopes.length, 10);
});

test('stale proposals cannot apply over newer canonical context', async () => {
  const h = await harness();
  const bot = await h.create();
  const proposal = await h.runtime.conversation.converse(bot.root, 'Plan the builder world', 'make-proposal');
  const head = (await h.runtime.bots.repository.root(bot.root)).streams.body[0].frame_hash;
  await h.runtime.conversation.recordProgress(bot.root, 'root', 'New information arrived.', [head], 'new-information');
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.conversation.confirm(bot.root, proposal.proposalWave, 'stale-confirm'), { code: 'stale-head' });
  assert.deepEqual(await inventory(h.directory), before);
});

test('internal scope contexts exclude sibling and cross-bot memory and reject escaped actions', async () => {
  const h = await harness();
  const a = await h.create();
  const b = await h.create(1);
  h.transport.responses.push({
    summary: 'Two independent internal workspaces.', tradeoffs: ['They share a root but have separate scoped context.'],
    questions: [], actions: ['scope-a', 'scope-b'].map(id => ({ type: 'scope.create',
      scope: { id, parent: 'monorepo', kind: 'workspace', name: id, description: 'An explicitly scoped workspace.' } })),
  });
  const proposed = await h.runtime.conversation.converse(a.root, 'Organize two workspaces', 'two-scopes');
  await h.runtime.conversation.confirm(a.root, proposed.proposalWave, 'confirm-scopes');
  const rootFrame = (await h.runtime.bots.repository.root(a.root)).streams.body[0].frame_hash;
  await h.runtime.conversation.recordProgress(a.root, 'scope-a', 'SIBLING-PRIVATE-MARKER', [rootFrame], 'private-progress');
  await h.runtime.conversation.recordProgress(b.root, 'root', 'OTHER-BOT-PRIVATE-MARKER',
    [(await h.runtime.bots.repository.root(b.root)).streams.body[0].frame_hash], 'other-private');
  h.transport.responses.push({ summary: 'Scope B orientation.', tradeoffs: [], questions: [], actions: [] });
  await h.runtime.conversation.converse(a.root, 'Orient only this scope', 'scope-b-thought', 'scope-b');
  const context = JSON.stringify(h.transport.requests.at(-1).canonicalContext);
  assert(!context.includes('SIBLING-PRIVATE-MARKER'));
  assert(!context.includes('OTHER-BOT-PRIVATE-MARKER'));
  assert.deepEqual(canonicalContext(await h.runtime.bots.repository.root(a.root), 'scope-b').scopes.map(s => s.id), ['scope-b']);
  h.transport.responses.push({
    summary: 'Try to escape.', tradeoffs: ['Should be refused.'], questions: [],
    actions: [{ type: 'scope.create', scope: { id: 'escape', parent: 'scope-a', kind: 'workspace', name: 'escape', description: 'Not authorized.' } }],
  });
  assert.equal((await h.runtime.conversation.converse(a.root, 'Keep scope B bounded', 'scope-escape', 'scope-b')).status, 'unavailable');
  assert(!(await h.runtime.bots.project(a.root)).scopes.some(s => s.id === 'escape'));
  await assert.rejects(h.runtime.conversation.recordProgress(a.root, 'root', 'Wrong evidence',
    [(await h.runtime.bots.repository.root(b.root)).streams.body[0].frame_hash], 'foreign-evidence'), { code: 'evidence-isolation' });
});

test('RAPP Up reviews a complete pointer-federated world without native scanning, copying or writes', async () => {
  const h = await harness();
  const a = await h.create();
  const recorded = await h.discover(a.root);
  assert.equal(recorded.createdWorlds, 0);
  assert.equal(recorded.nativeWrites, 0);
  const proposal = await h.runtime.dispatch('estate.rapp-up', { root: a.root }, 'rapp-up');
  assert.equal(proposal.status, 'review');
  assert.equal(proposal.projection.pointers.length, 0);
  const result = await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'confirm-rapp-up');
  assert.equal(result.pointers.length, 5);
  const native = (await readFixture('rapp-up')).pointers;
  for (const p of result.pointers) {
    assert.deepEqual(p.pointer, native.find(n => n.id === p.pointer.id));
    assert.equal(p.evidenceWave, recorded.sourceWave);
  }
  assert.equal((await h.runtime.bots.list()).length, 1);
  assert(result.scopes.find(s => s.id === 'global-estate').description.includes('Historical/derived'));
  assert.equal((await h.restart()).options.fixture, true);
});

test('correction appends a successor, retains original bytes, and refuses dependent-scope undo', async () => {
  const h = await harness();
  const a = await h.create();
  const proposal = await h.runtime.conversation.converse(a.root, 'Builder world', 'builder-world');
  await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'builder-confirm');
  const applied = (await h.runtime.bots.repository.root(a.root)).streams.memory.at(-1);
  await h.runtime.conversation.recordProgress(a.root, 'copilot-builder', 'Draft completed.', [applied.frame_hash], 'draft-progress');
  const progress = sourceChain(await h.runtime.bots.repository.root(a.root), 'copilot-builder').at(-1);
  const original = canonicalJson(progress);
  await assert.rejects(h.runtime.conversation.undo(a.root, applied.frame_hash, 'Would orphan dependent work', 'invalid-undo'), { code: 'scope-dependency' });
  const projection = await h.runtime.conversation.undo(a.root, progress.frame_hash, 'Correct the draft status', 'undo-progress');
  assert.equal(projection.progress.length, 0);
  assert(projection.outcomes.find(o => o.source.frame_hash === progress.frame_hash).corrected);
  const snapshot = await h.runtime.bots.repository.root(a.root);
  assert.equal(canonicalJson(memoryFrames(snapshot).find(f => f.frame_hash === progress.frame_hash)), original);
  assert.equal(sourceChain(snapshot, 'copilot-builder').at(-1).payload.event, 'state.corrected');
  assert.deepEqual(await (await h.restart()).bots.project(a.root), projection);
  await assert.rejects(h.runtime.conversation.undo(a.root, proposal.proposalWave, 'Cannot erase dialogue', 'undo-turn'), { code: 'correction' });
});

test('interrupted public turn reconstructs as attention without automatic model replay', async () => {
  const h = await harness();
  const a = await h.create();
  await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, findRoot(tx, a.root),
    'turn.user', { text: 'Persisted before interruption' }, 'interrupted-thought'));
  const before = await inventory(h.directory);
  const restarted = await h.restart();
  const result = await restarted.conversation.converse(a.root, 'Persisted before interruption', 'interrupted-thought');
  assert.equal(result.status, 'incomplete');
  assert(result.projection.attention.some(a => a.kind === 'incomplete-turn'));
  assert.equal(h.transport.requests.length, 0);
  assert.deepEqual(await inventory(h.directory), before);
  const orientation = await restarted.conversation.converse(a.root, 'Where were we?', 'orientation-only');
  assert.equal(orientation.status, 'orientation');
  assert(orientation.text.includes('Persisted before interruption'));
  assert.deepEqual(await inventory(h.directory), before);
});

test('reusing a root creation ID for a later command cannot poison canonical reconstruction', async () => {
  const h = await harness();
  const a = await h.create();
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.bots.visibility(a.root, true, 'create-builder'), { code: 'idempotency-conflict' });
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal((await (await h.restart()).bots.project(a.root)).hidden, false);
});

test('one complete recurring intent runs a bounded canonical recap once, without a model', async () => {
  const h = await harness();
  const a = await h.create();
  const fixture = await readFixture('recurring-work');
  const proposal = await h.runtime.conversation.converse(a.root, fixture.thought, 'weekly-thought');
  assert.match(proposal.text, /2026-09-14T09:00:00.000Z/);
  assert.equal((await h.runtime.recurring.due(a.root)).length, 0);
  await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'weekly-confirm');
  h.time('2026-09-14T09:00:00.000Z');
  const due = await h.runtime.recurring.due(a.root);
  assert.equal(due.length, 1);
  const calls = h.transport.requests.length;
  const outcomes = await Promise.all([h.runtime.recurring.tick(a.root, due[0].routineId, due[0].occurrence),
    h.runtime.recurring.tick(a.root, due[0].routineId, due[0].occurrence)]);
  assert.equal(outcomes[0].source, outcomes[1].source);
  assert.equal(h.transport.requests.length, calls);
  assert.equal((await h.runtime.recurring.due(a.root)).length, 0);
  assert.equal((await h.runtime.bots.project(a.root)).progress.length, 1);
  assert.equal(foldState(await h.runtime.bots.repository.root(a.root)).routines.size, 1);
  const restarted = await h.restart();
  assert.equal((await restarted.recurring.due(a.root)).length, 0);
  await restarted.recurring.tick(a.root, due[0].routineId, due[0].occurrence);
  assert.equal(h.transport.requests.length, calls);
  assert.match((await restarted.bots.whereWereWe(a.root)).text, /Monday 09:00 UTC/);
});
