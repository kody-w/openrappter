import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_RIGHTS } from '../dist/ai-contract.js';
import { publishedRecords } from '../dist/ai-projector.js';
import { harness, inventory, durableText } from './harness.mjs';
import { issue, view, publish } from './ai-fixture.mjs';

test('six AI-provider labels publish root-signed attributed public work without invoking a model or creating bots', async () => {
  const h = await harness();
  const a = await h.create();
  for (const name of ['Copilot', 'Claude', 'Hermes', 'Scout', 'Grokbot', 'Future Provider']) {
    const client = await issue(h, a.root, name);
    await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: `${name} public perspective` }), 'same-local-id');
  }
  const reader = await issue(h, a.root, 'Reader', ['projection.read']);
  const snapshot = await h.runtime.ai.read(a.root, reader.capability);
  assert.equal(snapshot.schema, 'rapp-work.ai-projection/1');
  assert.equal(snapshot.root, a.root);
  assert.equal(snapshot.turns.length, 6);
  assert.equal(new Set(snapshot.turns.map(t => t.actor.id)).size, 6);
  assert(snapshot.turns.every(t => t.bot === a.root && t.role === 'assistant'));
  assert.equal((await h.runtime.bots.list()).length, 1);
  assert.equal(h.transport.requests.length, 0);
  const canonical = await h.runtime.bots.repository.root(a.root);
  assert(canonical.streams.memory.every(f => f.sig !== null));
  assert(canonical.streams.memory.filter(f => f.payload.event === 'client.conversation').every(f => f.kind === 'memory.chat-turn'));
  assert.match((await h.runtime.bots.whereWereWe(a.root)).text, /Future Provider/);
});

test('a portable skill or claimed identity never substitutes for root/capability authentication', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  const client = await issue(h, a.root, 'Claude');
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.ai.read(a.root, 'skill.md'), { code: 'client-unauthorized' });
  await assert.rejects(h.runtime.ai.read(b.root, client.capability), { code: 'client-unauthorized' });
  await assert.rejects(h.runtime.ai.publish(a.root, client.capability,
    { ...publish('conversation', { text: 'Claim a different identity' }), actor: b.root }, 'spoof'), { code: 'contract' });
  await assert.rejects(h.runtime.ai.publish(a.root, client.capability,
    publish('conversation', { text: 'Claim human authority', role: 'user' }), 'human-spoof'), { code: 'contract' });
  assert.deepEqual(await inventory(h.directory), before);
  const body = await durableText(h.directory);
  assert(!body.includes(client.capability));
});

test('structured proposals require proposal authority, a fresh context revision and an in-scope validated Draft', async () => {
  const h = await harness();
  const a = await h.create();
  const proposer = await issue(h, a.root, 'Arbitrary Provider', ['projection.read', 'proposal.publish']);
  const reader = await issue(h, a.root, 'Read Only', ['projection.read']);
  const context = await h.runtime.ai.context(a.root, proposer.capability);
  assert.equal(context.authority.mutation, 'owner-only');
  const draft = {
    summary: 'Create one scoped artifact.',
    tradeoffs: ['The proposal is inert until exact owner confirmation.'],
    questions: [],
    actions: [{ type: 'artifact.save', id: 'scoped-note', scope: 'root', name: 'Scoped note', content: 'reviewed', mediaType: 'text/plain' }],
    resolves: [],
  };
  const unchanged = await inventory(h.directory);
  await assert.rejects(h.runtime.ai.propose(a.root, reader.capability,
    { contextRevision: context.revision, draft }, 'read-only-proposal'), { code: 'client-unauthorized' });
  await assert.rejects(h.runtime.ai.propose(a.root, proposer.capability,
    { contextRevision: '0'.repeat(64), draft }, 'stale-proposal'), { code: 'stale-head' });
  await assert.rejects(h.runtime.ai.propose(a.root, proposer.capability, {
    contextRevision: context.revision,
    draft: { ...draft, resolves: ['0'.repeat(64)] },
  }, 'claimed-owner-answer'), { code: 'proposal-authority' });
  await assert.rejects(h.runtime.ai.propose(a.root, proposer.capability, {
    contextRevision: context.revision,
    draft: { ...draft, actions: [{ type: 'shell.exec', command: 'whoami' }] },
  }, 'expanded-tool-surface'), { code: 'unauthorized-action' });
  assert.deepEqual(await inventory(h.directory), unchanged);
});

test('closed view intents validate canonical artifact/activity references and refuse code without losing public work', async () => {
  const h = await harness();
  const a = await h.create();
  const proposal = await h.runtime.conversation.converse(a.root, 'Create a Builder world', 'make-artifact');
  await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'confirm-artifact');
  const client = await issue(h, a.root, 'Copilot');
  const activity = await h.runtime.ai.publish(a.root, client.capability, publish('activity', {
    summary: 'Reading canonical evidence', status: 'working', completed: 1, total: 3, evidence: [proposal.proposalWave],
  }), 'activity');
  const first = await h.runtime.ai.publish(a.root, client.capability, publish('view', {}, view('copilot-builder', 'evidence',
    [{ kind: 'artifact', ref: 'builder-brief' }], { progress: activity.receipt.frame_hash, screenArtifact: 'builder-brief' })), 'first-view');
  const before = await h.runtime.ai.read(a.root, client.capability);
  assert.equal(before.view.effective.emphasis, 'evidence');
  assert.equal(before.view.progress.completed, 1);
  const invalid = await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: 'The useful public work is retained.' },
    { ...view(), html: '<script>PRIVATE-UI-CODE</script>', selector: '#private', x: 17, css: 'body{display:none}' }), 'unsupported-hint');
  assert.equal(invalid.viewAccepted, false);
  assert.equal(invalid.viewRefusal.code, 'view-hint-refused');
  const after = await h.runtime.ai.read(a.root, client.capability);
  assert(after.turns.some(t => t.text === 'The useful public work is retained.'));
  assert.deepEqual(after.view.heads, [first.receipt.frame_hash]);
  assert(!(await durableText(h.directory)).includes('PRIVATE-UI-CODE'));
  const files = await inventory(h.directory);
  await assert.rejects(h.runtime.ai.publish(a.root, client.capability, publish('view', {}, { ...view(), dom: 'html' }), 'only-invalid-hint'),
    { code: 'view-hint-refused' });
  assert.deepEqual(await inventory(h.directory), files);
  await assert.rejects(h.runtime.ai.publish(a.root, client.capability, publish('view', {}, view('root', 'work',
    [{ kind: 'artifact', ref: 'missing-artifact' }])), 'missing-ref'), { code: 'view-hint-refused' });
});

test('concurrent clients retain distinct view heads, causality and explicit resolution instead of last-writer overwrite', async () => {
  const h = await harness();
  const a = await h.create();
  const rights = AI_RIGHTS.filter(r => r !== 'view.resolve');
  const left = await issue(h, a.root, 'Copilot', rights);
  const right = await issue(h, a.root, 'Claude', rights);
  const [l, r] = await Promise.all([
    h.runtime.ai.publish(a.root, left.capability, publish('view', {}, view('root', 'conversation')), 'view-a'),
    h.runtime.ai.publish(a.root, right.capability, publish('view', {}, view('monorepo', 'work')), 'view-b'),
  ]);
  const conflict = await h.runtime.ai.read(a.root, left.capability);
  assert.equal(conflict.view.status, 'conflict');
  assert.equal(conflict.view.effective, null);
  assert.deepEqual(new Set(conflict.view.heads), new Set([l.receipt.frame_hash, r.receipt.frame_hash]));
  await assert.rejects(h.runtime.ai.publish(a.root, left.capability,
    publish('view', {}, view('root', 'review'), conflict.view.heads), 'silent-takeover'), { code: 'view-hint-refused' });
  const resolver = await issue(h, a.root, 'Resolver');
  const resolved = await h.runtime.ai.publish(a.root, resolver.capability,
    publish('view', {}, view('root', 'review'), conflict.view.heads, conflict.view.heads), 'resolve-reviewed-conflict');
  const final = await h.runtime.ai.read(a.root, left.capability);
  assert.equal(final.view.status, 'resolved');
  assert.deepEqual(final.view.heads, [resolved.receipt.frame_hash]);
  assert.equal(publishedRecords(await h.runtime.bots.repository.root(a.root)).filter(p => p.data.view).length, 3);
  assert.equal((await h.runtime.bots.list()).length, 1);
});

test('publication idempotency and projection reconstruction survive restart without inference', async () => {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Hermes');
  const packet = publish('conversation', { text: 'One public statement' }, view());
  const first = await h.runtime.ai.publish(a.root, client.capability, packet, 'once');
  const before = await h.runtime.ai.read(a.root, client.capability);
  const bytes = await inventory(h.directory);
  const restarted = await h.restart();
  const receipt = await restarted.ai.publish(a.root, client.capability, packet, 'once');
  assert.equal(receipt.duplicate, true);
  assert.equal(receipt.receipt.frame_hash, first.receipt.frame_hash);
  assert.deepEqual(await restarted.ai.read(a.root, client.capability), before);
  assert.deepEqual(await inventory(h.directory), bytes);
  await assert.rejects(restarted.ai.publish(a.root, client.capability, publish('conversation', { text: 'Different work' }), 'once'),
    { code: 'idempotency-conflict' });
  assert.equal(h.transport.requests.length, 0);
});

test('scope isolation rejects sibling/foreign evidence and keeps native or credential data out of projections', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  const own = await issue(h, a.root, 'Scoped', AI_RIGHTS, 'monorepo');
  const peer = await issue(h, b.root, 'Other');
  const privateTurn = await h.runtime.ai.publish(b.root, peer.capability,
    publish('conversation', { text: 'OTHER-ROOT-PRIVATE-CONTENT' }), 'peer-private');
  const rootTurn = await h.runtime.conversation.converse(a.root, 'ROOT-ONLY-PRIVATE-CONTENT', 'root-private');
  await assert.rejects(h.runtime.ai.publish(a.root, own.capability,
    { ...publish('conversation', { text: 'Escaped' }), scope: 'root' }, 'escape'), { code: 'client-scope' });
  await assert.rejects(h.runtime.ai.publish(a.root, own.capability,
    publish('evidence', { summary: 'Foreign evidence', references: [privateTurn.receipt.frame_hash] }), 'foreign-evidence'),
  { code: 'client-scope' });
  await assert.rejects(h.runtime.ai.publish(a.root, own.capability,
    publish('evidence', { summary: 'Ancestor evidence', references: [rootTurn.proposalWave] }), 'ancestor-evidence'),
  { code: 'client-scope' });
  const encoded = JSON.stringify(await h.runtime.ai.read(a.root, own.capability));
  assert(!encoded.includes('OTHER-ROOT-PRIVATE-CONTENT'));
  assert(!encoded.includes('ROOT-ONLY-PRIVATE-CONTENT'));
  assert(!encoded.includes('tokenHash'));
});

test('revocation, expiry and read-only grants fence clients without deleting their signed history', async () => {
  const h = await harness();
  const a = await h.create();
  const writer = await issue(h, a.root, 'Writer');
  const reader = await issue(h, a.root, 'Reader', ['projection.read']);
  await h.runtime.ai.publish(a.root, writer.capability, publish('conversation', { text: 'Keep this public history' }), 'history');
  await assert.rejects(h.runtime.ai.publish(a.root, reader.capability, publish('conversation', { text: 'No write right' }), 'read-only'),
    { code: 'client-unauthorized' });
  await h.runtime.ai.authority.revoke(a.root, writer.client, 'Owner revoked this client.', 'revoke-writer');
  await assert.rejects(h.runtime.ai.read(a.root, writer.capability), { code: 'client-unauthorized' });
  assert((await h.runtime.ai.read(a.root, reader.capability)).turns.some(t => t.text === 'Keep this public history'));
  h.time('2026-09-13T21:00:01.000Z');
  await assert.rejects(h.runtime.ai.read(a.root, reader.capability), { code: 'client-unauthorized' });
  assert.match((await h.runtime.bots.whereWereWe(a.root)).text, /Keep this public history/);
});

test('view references invalidate on canonical correction rather than executing stale artifact hints', async () => {
  const h = await harness();
  const a = await h.create();
  const plan = await h.runtime.conversation.converse(a.root, 'Builder', 'builder-plan');
  await h.runtime.conversation.confirm(a.root, plan.proposalWave, 'apply-builder');
  const outcome = (await h.runtime.bots.repository.root(a.root)).streams.memory.at(-1).frame_hash;
  const client = await issue(h, a.root, 'Viewer');
  await h.runtime.ai.publish(a.root, client.capability, publish('view', {}, view('root', 'evidence', [
    { kind: 'artifact', ref: 'builder-brief' },
  ])), 'artifact-view');
  await h.runtime.conversation.undo(a.root, outcome, 'Correct the unused world plan', 'undo-world');
  const projection = await h.runtime.ai.read(a.root, client.capability);
  assert.equal(projection.view.status, 'invalidated');
  assert.equal(projection.view.effective, null);
  assert.equal(projection.artifacts.length, 0);
});

test('durable per-client rate and byte bounds survive restart; bounded paging retains all work', async () => {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Bounded');
  for (let i = 0; i < 60; i++) await h.runtime.ai.publish(a.root, client.capability,
    publish('conversation', { text: `Published work ${i}` }), `work-${i}`);
  const restarted = await h.restart();
  await assert.rejects(restarted.ai.publish(a.root, client.capability, publish('conversation', { text: 'Rate overflow' }), 'over-rate'),
    { code: 'client-rate' });
  const snapshot = await restarted.ai.read(a.root, client.capability);
  assert.equal(snapshot.turns.length, 16);
  assert.equal(snapshot.history.truncated, true);
  let cursor = null, total = 0, more = true;
  while (more) {
    const page = await restarted.ai.history(a.root, client.capability, cursor);
    total += page.records.filter(r => r.event === 'client.conversation').length;
    cursor = page.cursor;
    more = page.more;
  }
  assert.equal(total, 60);
  await assert.rejects(restarted.ai.history(a.root, client.capability, { ...snapshot.cursor, frame_hash: '0'.repeat(64) }), { code: 'cursor-invalid' });
  await assert.rejects(restarted.ai.publish(a.root, client.capability, publish('conversation', { text: 'x'.repeat(40_000) }), 'over-bytes'),
    { code: 'publication-size' });
});
