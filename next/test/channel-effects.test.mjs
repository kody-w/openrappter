import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateChannels, DisabledIMessage } from '../dist/channel.js';
import { ExternalActions } from '../dist/effects.js';
import { foldState } from '../dist/state.js';
import { harness, inventory, durableText } from './harness.mjs';

const contact = 'a'.repeat(64), permission = 'b'.repeat(64);
test('production iMessage stays disabled; synthetic outage recap persists and explicit retry delivers exactly once', async () => {
  const h = await harness();
  const a = await h.create();
  const disabled = new PrivateChannels(h.runtime.bots, h.runtime.conversation, new DisabledIMessage());
  const bound = await disabled.bind(a.root, contact, permission, true, 'bind-imessage');
  assert.equal(bound.transportEnabled, false);
  assert.equal(bound.productionPermissionVerifiedByThisCommand, false);
  const queued = await disabled.queueRecap(a.root, 'queue-recap');
  assert.equal((await disabled.deliver(a.root, queued.deliveryId, 'attempt-offline')).status, 'unavailable');
  assert.equal(h.channel.sent.size, 0);
  const before = await inventory(h.directory);
  const restarted = await h.restart();
  const recap = await restarted.channels.recap(a.root);
  assert.equal(recap.pending.length, 1);
  assert.equal(recap.pending[0].summary, queued.summary);
  assert.deepEqual(await inventory(h.directory), before);
  h.channel.available = true;
  assert.equal((await restarted.channels.deliver(a.root, queued.deliveryId, 'explicit-retry')).status, 'delivered');
  await restarted.channels.deliver(a.root, queued.deliveryId, 'another-retry');
  assert.equal(h.channel.sent.size, 1);
  assert.equal((await restarted.channels.recap(a.root)).pending.length, 0);
});

test('private continuity input is contact-bound, idempotent and enters the same canonical conversation', async () => {
  const h = await harness();
  const a = await h.create();
  await h.runtime.channels.bind(a.root, contact, permission, true, 'bind-contact');
  h.channel.available = true;
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.channels.receive(a.root, { contactRef: 'c'.repeat(64), messageId: 'wrong', text: 'hello', fixtureAuthenticated: true }),
    { code: 'channel-binding' });
  await assert.rejects(h.runtime.channels.receive(a.root, { contactRef: contact, messageId: 'forged', text: 'hello', fixtureAuthenticated: false }),
    { code: 'channel-authentication' });
  assert.deepEqual(await inventory(h.directory), before);
  const orientation = await h.runtime.channels.receive(a.root, { contactRef: contact, messageId: 'where', text: 'Where were we?', fixtureAuthenticated: true });
  assert.equal(orientation.status, 'pending');
  assert.equal(orientation.attribution.origin, 'external');
  assert.equal(h.transport.requests.length, 0);
  assert.notDeepEqual(await inventory(h.directory), before);
  const envelope = { contactRef: contact, messageId: 'message-one', text: 'Create the Builder workspace', fixtureAuthenticated: true };
  const response = await h.runtime.channels.receive(a.root, envelope);
  assert.equal(response.status, 'pending');
  await (await h.restart()).channels.receive(a.root, envelope);
  assert.equal(h.transport.requests.length, 0);
  await assert.rejects(h.runtime.channels.receive(a.root, { ...envelope, text: 'Rebind the same transport message ID' }), { code: 'idempotency-conflict' });
});

test('old contact bindings and hidden roots cannot deliver queued content', async () => {
  const h = await harness();
  const a = await h.create();
  await h.runtime.channels.bind(a.root, contact, permission, true, 'initial-binding');
  const queued = await h.runtime.channels.queueRecap(a.root, 'queued-before-rebind');
  h.channel.available = true;
  await h.runtime.channels.bind(a.root, 'c'.repeat(64), permission, true, 'new-binding');
  await assert.rejects(h.runtime.channels.deliver(a.root, queued.deliveryId, 'wrong-binding-delivery'), { code: 'channel-binding' });
  const second = await h.runtime.channels.queueRecap(a.root, 'queued-before-hide');
  await h.runtime.bots.visibility(a.root, true, 'hide-channel');
  await assert.rejects(h.runtime.channels.deliver(a.root, second.deliveryId, 'hidden-delivery'), { code: 'bot-hidden' });
  assert.equal(h.channel.sent.size, 0);
});

test('concurrent explicit channel attempts retain canonical receipts but one idempotent transport effect', async () => {
  const h = await harness();
  const a = await h.create();
  await h.runtime.channels.bind(a.root, contact, permission, true, 'bind-concurrent-channel');
  h.channel.available = true;
  const queue = await h.runtime.channels.queueRecap(a.root, 'queue-concurrent');
  await Promise.all([
    h.runtime.channels.deliver(a.root, queue.deliveryId, 'attempt-one'),
    h.runtime.channels.deliver(a.root, queue.deliveryId, 'attempt-two'),
  ]);
  assert.equal(h.channel.sent.size, 1);
  assert.equal((await h.runtime.channels.recap(a.root)).pending.length, 0);
});

test('reviewing an external request has zero effects until exact separate approval, and approval cannot replay', async () => {
  const sent = [];
  const h = await harness({ effects: { available: true, execute: async input => { sent.push(input); return { receipt: 'fixture-receipt' }; } } });
  const a = await h.create();
  const proposal = await h.runtime.conversation.converse(a.root, 'Prepare an external message', 'external-proposal');
  await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'external-review-confirmed');
  assert.equal(sent.length, 0);
  const effect = foldState(await h.runtime.bots.repository.root(a.root)).effects.get('message-request');
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.effects.approve(a.root, 'message-request', '0'.repeat(64), effect.target, 'wrong-digest'), { code: 'approval-binding' });
  await assert.rejects(h.runtime.effects.approve(a.root, 'message-request', effect.requestHash, 'wrong-contact', 'wrong-target'), { code: 'approval-binding' });
  assert.deepEqual(await inventory(h.directory), before);
  const outcome = await h.runtime.effects.approve(a.root, 'message-request', effect.requestHash, effect.target, 'exact-external-approval');
  assert.equal(outcome.status, 'completed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].root, a.root);
  assert.equal(sent[0].idempotencyKey, outcome.approval);
  await (await h.restart()).effects.approve(a.root, 'message-request', effect.requestHash, effect.target, 'exact-external-approval');
  assert.equal(sent.length, 1);
  await assert.rejects(h.runtime.conversation.undo(a.root, outcome.approval, 'Cannot undo external authority', 'invalid-external-undo'), { code: 'correction' });
});

test('unavailable and uncertain external ports preserve public outcome and never leak errors or retry', async () => {
  const h = await harness();
  const a = await h.create();
  const proposal = await h.runtime.conversation.converse(a.root, 'Prepare an external request', 'unavailable-external');
  await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'confirm-unavailable-external');
  const effect = foldState(await h.runtime.bots.repository.root(a.root)).effects.get('message-request');
  const unavailable = await h.runtime.effects.approve(a.root, 'message-request', effect.requestHash, effect.target, 'unavailable-approved');
  assert.equal(unavailable.status, 'unavailable');
  const port = new ExternalActions(h.runtime.bots, { available: true, execute: async () => { throw new Error('SECRET-PRIVATE-EXTERNAL-DIAGNOSTIC'); } });
  assert.equal((await port.approve(a.root, 'message-request', effect.requestHash, effect.target, 'unavailable-approved')).replayed, false);
  assert(!(await durableText(h.directory)).includes('SECRET-PRIVATE-EXTERNAL-DIAGNOSTIC'));
});

test('lost external acknowledgement stays uncertain, visible and non-replayable', async () => {
  let attempted = 0;
  const h = await harness({ effects: { available: true, execute: async () => {
    attempted++;
    throw new Error('SECRET-EXTERNAL-ACK-DETAIL');
  } } });
  const a = await h.create();
  const proposal = await h.runtime.conversation.converse(a.root, 'Prepare an external message', 'uncertain-message');
  await h.runtime.conversation.confirm(a.root, proposal.proposalWave, 'confirm-uncertain-message');
  const effect = foldState(await h.runtime.bots.repository.root(a.root)).effects.get('message-request');
  assert.equal((await h.runtime.effects.approve(a.root, 'message-request', effect.requestHash, effect.target, 'uncertain-approval')).status, 'uncertain');
  assert((await h.runtime.bots.project(a.root)).attention.some(a => a.kind === 'external-uncertain'));
  await (await h.restart()).effects.approve(a.root, 'message-request', effect.requestHash, effect.target, 'uncertain-approval');
  assert.equal(attempted, 1);
  assert(!(await durableText(h.directory)).includes('SECRET-EXTERNAL-ACK-DETAIL'));
});
