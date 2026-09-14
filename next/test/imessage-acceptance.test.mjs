import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, lstat, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../dist/canonical.js';
import { DEFAULT_CHANNEL_POLICY, isQuiet, questionPending } from '../dist/channel-contract.js';
import { PrivateChannelBindings } from '../dist/channel-runtime.js';
import { sourceChain, memoryFrames } from '../dist/source-memory.js';
import { AiEndpoint } from '../dist/ai-endpoint.js';
import { harness, inventory, durableText, deferred } from './harness.mjs';
import { issue } from './ai-fixture.mjs';

const contact = 'PRIVATE-CONTACT-SENTINEL', permission = 'PRIVATE-PERMISSION-SENTINEL';
const policy = extra => ({ ...DEFAULT_CHANNEL_POLICY, automaticQuestions: true, ...extra });
const report = (id, text = 'Which reviewed option should we use?', kind = 'gauntlet') => ({
  text, clarify: { schema: 'rapp-work.clarify/1', kind, turnId: id, requires: 'copilot-cli',
    questions: [{ id: 'decision', reason: 'human-authority', text }] },
});
async function configured(extra = {}) {
  const h = await harness(), bot = await h.create();
  const bound = await h.runtime.channels.bind(bot.root, contact, permission, true, 'private-channel-binding', policy(extra),
    { shortcut: 'PRIVATE-SHORTCUT-SENTINEL', credential: 'PRIVATE-CREDENTIAL-SENTINEL' });
  h.channel.available = true;
  return { ...h, bot, bound };
}
async function question(h, id, text) {
  const result = await h.runtime.dispatch('conversation.report', { root: h.bot.root, report: report(id, text) }, id);
  await h.runtime.channels.drain();
  const root = await h.runtime.bots.repository.root(h.bot.root);
  const queue = memoryFrames(root).find(f => f.payload.event === 'channel.queued' && f.payload.data.sourceRefs.some(r => r.frame_hash === result.receipt.frame_hash));
  assert(queue);
  return { source: result.receipt.frame_hash, queue: queue.frame_hash, result };
}
const envelope = (messageId, text) => ({ contactRef: contact, messageId, text, fixtureAuthenticated: true });

test('private transport material is same-user sibling custody, never canonical frames, projections or Egg', async () => {
  const h = await configured();
  const directory = h.runtime.channels.bindings.directory;
  assert.equal(path.dirname(directory), path.dirname(h.directory));
  assert(!directory.startsWith(h.directory + path.sep));
  const stat = await lstat(directory);
  assert.equal(stat.mode & 0o777, 0o700); assert.equal(stat.uid, process.getuid());
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const filename = path.join(directory, files[0]);
  assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  const privateData = await readFile(filename, 'utf8');
  const publicData = (await durableText(h.directory)) + canonicalJson(await h.runtime.bots.project(h.bot.root))
    + canonicalJson(await h.runtime.egg.atRest(h.bot.root));
  for (const secret of [contact, permission, 'PRIVATE-SHORTCUT-SENTINEL', 'PRIVATE-CREDENTIAL-SENTINEL']) {
    assert(privateData.includes(secret));
    assert(!publicData.includes(secret));
  }
  assert(!publicData.includes('"contactRef"'));
  assert(!publicData.includes('"permissionRef"'));
  await chmod(filename, 0o644);
  await assert.rejects(h.runtime.channels.bindings.get(h.bot.root, h.bound.bindingId), { code: 'channel-runtime-private' });
  assert.equal((await lstat(filename)).mode & 0o777, 0o644);
});

test('runtime sibling symlinks and wrong-root private binding borrowing refuse', async () => {
  const h = await configured();
  await assert.rejects(h.runtime.channels.bindings.get(h.keys.signers[1].root, h.bound.bindingId), { code: 'channel-runtime-binding' });
  const isolated = path.join(path.dirname(h.directory), `linked-profile-${process.pid}-${Date.now()}`);
  const bindings = new PrivateChannelBindings(isolated);
  await symlink(h.runtime.channels.bindings.directory, bindings.directory);
  await assert.rejects(bindings.get(h.bot.root, h.bound.bindingId), { code: 'channel-runtime-private' });
  const foreign = path.join(path.dirname(h.directory), `open-profile-${process.pid}-${Date.now()}`);
  const openBindings = new PrivateChannelBindings(foreign);
  await mkdir(openBindings.directory, { mode: 0o755 });
  await assert.rejects(openBindings.put(h.bot.root, { contactRef: contact, permissionRef: permission, shortcut: null, credential: null }, 'no-chmod'),
    { code: 'channel-runtime-private' });
});

test('external yes is attributed user inbox data, not confirmation, CLI answer, gauntlet settlement or model work', async () => {
  const h = await configured();
  const proposal = await h.runtime.conversation.converse(h.bot.root, 'Create a Builder world', 'review-builder');
  const clarification = await question(h, 'owner-gauntlet');
  const calls = h.transport.requests.length;
  const input = await h.runtime.channels.receive(h.bot.root, envelope('yes-input', 'yes, confirm it'));
  assert.equal(input.status, 'pending');
  assert.equal(input.confirmationAccepted, false);
  assert.equal(input.proposalWave, null);
  assert.equal(input.attribution.origin, 'external');
  assert.equal(h.transport.requests.length, calls);
  const root = await h.runtime.bots.repository.root(h.bot.root);
  const event = memoryFrames(root).find(f => f.frame_hash === input.receipt.frame_hash);
  assert.equal(event.payload.event, 'turn.user');
  assert.equal(event.payload.data.origin, 'external-imessage');
  assert.equal(event.payload.data.role, 'user');
  assert.equal(event.payload.data.proposalId, null);
  assert.equal(event.payload.data.replyTo, undefined);
  assert.equal(event.payload.data.answerTo, undefined);
  assert(questionPending(root, clarification.source));
  assert((await h.runtime.bots.project(h.bot.root)).proposals.some(p => p.wave === proposal.proposalWave && p.status === 'review'));
  assert((await h.runtime.bots.project(h.bot.root)).attention.some(a => a.kind === 'external-inbox'));
  assert.equal((await h.runtime.channels.recap(h.bot.root)).inbox.length, 1);
  const transcript = await h.runtime.collaboration.transcript(h.bot.root);
  assert.equal(transcript.find(t => t.source.frame_hash === input.receipt.frame_hash).attribution.origin, 'external');
  const before = await inventory(h.directory);
  const restarted = await h.restart();
  const repeat = await restarted.channels.receive(h.bot.root, envelope('yes-input', 'yes, confirm it'));
  assert.equal(repeat.receipt.frame_hash, input.receipt.frame_hash);
  assert.deepEqual(await inventory(h.directory), before);
  await assert.rejects(restarted.channels.receive(h.bot.root, envelope('yes-input', 'Changed same transport message')), { code: 'idempotency-conflict' });
  await h.runtime.dispatch('conversation.answer', { root: h.bot.root, sourceWave: clarification.source, text: 'Use the first bounded option.' }, 'actual-cli-answer');
  assert(!questionPending(await h.runtime.bots.repository.root(h.bot.root), clarification.source));
  assert.equal((await h.runtime.channels.recap(h.bot.root)).pending.length, 0);
  assert((await h.runtime.channels.recap(h.bot.root)).resolvedQuestions.includes(clarification.queue));
  await h.runtime.channels.reviewInbound(h.bot.root, input.receipt.frame_hash, 'review-external-inbox');
  assert(!(await h.runtime.bots.project(h.bot.root)).attention.some(a => a.kind === 'external-inbox'));
  assert.equal((await h.runtime.channels.recap(h.bot.root)).inbox.length, 0);
});

test('only same-publication clarification markers queue automatic questions; native and CLI producers need no second model', async () => {
  const h = await configured();
  let preflights = 0;
  const preflight = h.channel.preflight.bind(h.channel);
  h.channel.preflight = async input => { preflights++; return preflight(input); };
  await h.runtime.conversation.report(h.bot.root, 'root', { text: 'Ordinary assistant text asks: need anything?' }, 'ordinary-report');
  await h.runtime.conversation.recordProgress(h.bot.root, 'root', 'Progress asks a question, but is not a clarify marker.', [], 'ordinary-progress');
  await h.runtime.channels.drain();
  assert.equal((await h.runtime.channels.recap(h.bot.root)).pending.length, 0);
  await assert.rejects(h.runtime.conversation.report(h.bot.root, 'root', report('wrong-turn-id'), 'different-turn-id'), { code: 'clarify-binding' });
  const first = await question(h, 'cli-question');
  assert.equal(first.result.modelCalls, 0);
  assert.equal(first.result.channelEffects, 0);
  const reported = (await h.runtime.bots.project(h.bot.root)).turns.find(t => t.source.frame_hash === first.source);
  assert.equal(reported.role, 'assistant');
  assert.equal(reported.attribution.origin, 'copilot-cli');
  assert.equal(reported.attribution.approvalAuthority, false);
  h.transport.responses.push({ summary: 'One irreducible decision is required.', tradeoffs: [], actions: [],
    questions: [{ reason: 'human-authority', question: 'Which owner-approved option?',
      dependsOn: '/authority/approvedOption' }] });
  const native = await h.runtime.conversation.converse(h.bot.root, 'Ask the needed owner decision', 'native-question');
  await h.runtime.channels.drain();
  const root = await h.runtime.bots.repository.root(h.bot.root);
  const source = memoryFrames(root).find(f => f.frame_hash === native.proposalWave);
  assert.equal(source.payload.data.clarify.turnId, source.payload.operationId);
  assert.equal((await h.runtime.channels.recap(h.bot.root)).pending.length, 2);
  assert.equal(h.transport.requests.length, 1);
  assert.equal(preflights, 0);
  assert.equal(h.channel.sent.size, 0);
  await h.runtime.channels.consider(h.bot.root);
  assert.equal((await h.runtime.channels.recap(h.bot.root)).pending.length, 2);
});

test('publication callback failure cannot alter a committed report or create notification feedback', async () => {
  const h = await configured();
  const remove = h.runtime.bots.repository.onPublication(() => { throw new Error('PRIVATE-CALLBACK-ERROR'); });
  const published = await question(h, 'callback-question');
  assert(published.result.receipt.frame_hash);
  assert.equal((await h.runtime.channels.recap(h.bot.root)).pending.length, 1);
  remove();
  await h.runtime.channels.deliver(h.bot.root, published.queue, 'approved-callback-question');
  await h.runtime.channels.drain();
  assert.equal(h.channel.sent.size, 1);
  assert.equal((await h.runtime.channels.recap(h.bot.root)).pending.length, 0);
  assert(!(await durableText(h.directory)).includes('PRIVATE-CALLBACK-ERROR'));
  assert.equal(h.transport.requests.length, 0);
});

test('quiet hours honor local DST, and deferral consumes no physical attempt before a fresh eligible generation', async () => {
  const p = policy({ timezone: 'America/New_York', quietHours: { startMinute: 22 * 60, endMinute: 8 * 60 } });
  assert(isQuiet(p, '2026-11-01T05:30:00.000Z'));
  assert(isQuiet(p, '2026-11-01T06:30:00.000Z'));
  assert(!isQuiet(p, '2026-11-01T14:00:00.000Z'));
  const h = await configured({ quietHours: { startMinute: 22 * 60, endMinute: 8 * 60 } });
  const q = await question(h, 'quiet-question');
  h.time('2026-09-13T23:00:00.000Z');
  const blocked = await h.runtime.channels.deliver(h.bot.root, q.queue, 'quiet-approval');
  assert.equal(blocked.status, 'deferred'); assert.equal(blocked.reason, 'quiet-hours');
  assert.equal(blocked.generation, 1);
  assert(!memoryFrames(await h.runtime.bots.repository.root(h.bot.root)).some(f => f.payload.event === 'channel.attempt'));
  h.time('2026-09-14T09:00:00.000Z');
  const sent = await (await h.restart()).channels.deliver(h.bot.root, q.queue, 'eligible-approval');
  assert.equal(sent.status, 'delivered'); assert.equal(sent.generation, 2);
  assert.equal(h.channel.sent.size, 1);
});

test('two-question late deferral finalizes the entire batch and reconstructs compatible retry generations', async () => {
  const h = await configured({ quietHours: { startMinute: 22 * 60, endMinute: 8 * 60 }, maxBatch: 2 });
  const one = await question(h, 'batch-one', 'First distinct owner decision?');
  const two = await question(h, 'batch-two', 'Second distinct owner decision?');
  h.time('2026-09-13T21:59:50.000Z');
  h.channel.preflight = async () => { h.time('2026-09-13T22:00:00.000Z'); return { status: 'ready' }; };
  const ids = [one.queue, two.queue];
  const late = await h.runtime.channels.flush(h.bot.root, ids, 'batch-late-approval');
  assert.equal(late.status, 'deferred');
  assert.equal(late.reason, 'quiet-hours');
  const restarted = await h.restart();
  const recap = await restarted.channels.recap(h.bot.root);
  assert.equal(recap.pending.length, 2);
  assert(recap.pending.every(q => q.preflightGeneration === 1 && q.preflightOutcome === 'deferred'));
  assert.equal(h.channel.sent.size, 0);
  h.time('2026-09-14T09:00:00.000Z');
  h.channel.preflight = async () => ({ status: 'ready' });
  const done = await restarted.channels.flush(h.bot.root, ids, 'batch-resumed-approval');
  assert.equal(done.status, 'delivered'); assert.equal(done.generation, 2);
  assert.equal(h.channel.sent.size, 1);
  const text = [...h.channel.sent.values()][0].text;
  assert(text.includes('First distinct') && text.includes('Second distinct'));
  assert.equal((await restarted.channels.recap(h.bot.root)).pending.length, 0);
});

test('cancellation fences dispatch before awaiting private-runtime readiness and remains reconstructible', async () => {
  const h = await configured();
  const q = await question(h, 'cancel-before-readiness');
  const reached = deferred(), release = deferred();
  const get = h.runtime.channels.bindings.get.bind(h.runtime.channels.bindings);
  let preflights = 0;
  h.channel.preflight = async () => { preflights++; return { status: 'ready' }; };
  h.runtime.channels.bindings.get = async (...args) => { reached.resolve(); await release.promise; return get(...args); };
  const delivery = h.runtime.channels.deliver(h.bot.root, q.queue, 'waiting-for-private-binding');
  await reached.promise;
  const cancellation = h.runtime.channels.cancel(h.bot.root, q.queue, 'cancel-synchronously');
  release.resolve();
  const [result] = await Promise.all([delivery, cancellation]);
  assert.equal(result.status, 'cancelled');
  assert.equal(preflights, 0); assert.equal(h.channel.sent.size, 0);
  const restarted = await h.restart();
  assert.equal((await restarted.channels.deliver(h.bot.root, q.queue, 'no-cancelled-replay')).status, 'cancelled');
  assert.equal((await restarted.channels.recap(h.bot.root)).pending.length, 0);
});

test('cancellation fences a queued preflight before either command acquires the canonical lock', async () => {
  const h = await configured();
  const q = await question(h, 'cancel-before-lock');
  const reached = deferred(), release = deferred();
  const held = h.runtime.bots.repository.transaction(async () => { reached.resolve(); await release.promise; });
  await reached.promise;
  let preflights = 0;
  h.channel.preflight = async () => { preflights++; return { status: 'ready' }; };
  const delivery = h.runtime.channels.deliver(h.bot.root, q.queue, 'waiting-for-canonical-lock');
  const cancel = h.runtime.channels.cancel(h.bot.root, q.queue, 'fenced-before-lock');
  release.resolve();
  const [, result] = await Promise.all([held, delivery, cancel]);
  assert.equal(result.status, 'cancelled');
  assert.equal(preflights, 0);
  assert.equal(h.channel.sent.size, 0);
  assert.equal((await (await h.restart()).channels.recap(h.bot.root)).pending.length, 0);
});

test('uncertain send and non-cooperative cancellation cannot replay across a fresh request or restart', async () => {
  const h = await configured({ preflightSeconds: 1 });
  const q = await question(h, 'uncertain-question');
  const reached = deferred(), release = deferred();
  let sends = 0;
  h.channel.send = async () => { sends++; reached.resolve(); await release.promise; return { receipt: 'late-opaque-receipt' }; };
  const delivery = h.runtime.channels.deliver(h.bot.root, q.queue, 'one-irreversible-approval');
  await reached.promise;
  const result = await delivery;
  assert.equal(result.status, 'uncertain');
  assert.equal((await h.runtime.channels.deliver(h.bot.root, q.queue, 'busy-no-replacement')).status, 'busy');
  const restarted = await h.restart();
  assert.equal((await restarted.channels.deliver(h.bot.root, q.queue, 'restart-no-uncertain-replay')).status, 'uncertain');
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sends, 1);
  assert.equal((await restarted.channels.recap(h.bot.root)).pending[0].status, 'uncertain');
});

test('expired abandoned no-send preflight gets a fresh generation, while rate bounds survive restart', async () => {
  const h = await configured({ maxPerHour: 1 });
  const q = await question(h, 'abandoned-preflight');
  await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, tx.snapshot.roots[0], 'channel.preflight', {
    deliveryIds: [q.queue], bindingWave: h.bound.source, generation: 1, actor: 'local-operator', expiresUtc: '2026-09-13T20:00:30.000Z',
  }, 'interrupted-before-readiness'));
  h.time('2026-09-13T20:00:31.000Z');
  const restarted = await h.restart();
  const done = await restarted.channels.deliver(h.bot.root, q.queue, 'new-preflight-generation');
  assert.equal(done.status, 'delivered'); assert.equal(done.generation, 2);
  const second = await question(h, 'rate-limited-question');
  const limited = await restarted.channels.deliver(h.bot.root, second.queue, 'rate-bounded-approval');
  assert.equal(limited.status, 'deferred'); assert.equal(limited.reason, 'rate-bound');
  assert.equal(h.channel.sent.size, 1);
});

test('owner-only exact-root ingress cannot be reached by a restricted AI endpoint or an identity alias', async () => {
  const h = await configured();
  const before = await inventory(h.directory);
  for (const root of [h.bot.root.split(':').at(-1), '00000000-0000-4000-8000-000000000000', 'root']) {
    await assert.rejects(h.runtime.dispatch('channels.receive', { root, envelope: envelope('alias', 'hello') }), { code: 'root-not-found' });
  }
  await assert.rejects(h.runtime.dispatch('channels.receive', { root: h.bot.root, agentId: 'root', envelope: envelope('alias', 'hello') }), { code: 'contract' });
  assert.deepEqual(await inventory(h.directory), before);
  const grant = await issue(h, h.bot.root, 'Restricted Inbox Reader');
  const output = [], endpoint = new AiEndpoint(h.runtime.ai, h.bot.root, grant.capability, 'stdio', value => output.push(value));
  await endpoint.handle(JSON.stringify({ id: 'not-owner-ingress', method: 'channels.receive', params: { root: h.bot.root, envelope: envelope('no-permission', 'confirm') } }));
  assert.equal(output[0].error.code, 'method-unavailable');
  endpoint.close();
  assert.equal(h.transport.requests.length, 0);
});
