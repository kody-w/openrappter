import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../dist/canonical.js';
import { HeadlessRuntime } from '../dist/runtime.js';
import { memoryFrames, sourceReference } from '../dist/source-memory.js';
import { allowPair, harness, inventory } from './harness.mjs';

test('independent reply clocks and immutable receipt replay survive revocation, clock rollback and absent private signers', async () => {
  const h = await harness(), a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const times = ['2026-09-13T20:00:02.000Z', '2026-09-13T20:00:01.000Z', '2026-09-13T20:00:03.000Z', '2026-09-13T20:00:04.000Z'];
  h.runtime.bots.now = () => times.shift() ?? '2026-09-13T20:00:05.000Z';
  const exchange = await h.runtime.collaboration.ask(a.root, b.root, 'A bounded question with independent clocks.', 'clock-exchange');
  const caller = await h.runtime.bots.repository.root(a.root), recipient = await h.runtime.bots.repository.root(b.root);
  assert(recipient.streams.swarm[0].utc < caller.streams.swarm[0].utc);
  assert.equal(recipient.streams.swarm[0].payload.requestWave, caller.streams.swarm[0].frame_hash);
  await h.runtime.collaboration.grant(b.root, a.root, 'No further delegation is authorized.', 'revoke', 'end-peer-grant');
  const bytes = await inventory(h.directory), calls = h.transport.requests.length;
  const reopened = await HeadlessRuntime.open({ ...h.settings, signers: [], clock: () => '2026-09-13T19:00:00.000Z' });
  const replay = await reopened.collaboration.ask(a.root, b.root, 'A bounded question with independent clocks.', 'clock-exchange');
  assert.equal(replay.status, 'recorded-not-replayed');
  assert.equal(canonicalJson(replay.transcript), canonicalJson(exchange.transcript));
  await assert.rejects(reopened.collaboration.ask(a.root, b.root, 'Changed immutable question.', 'clock-exchange'), { code: 'idempotency-conflict' });
  await assert.rejects(reopened.collaboration.ask(a.root, b.root, 'An unauthorized new question.', 'new-after-revocation'), { code: 'collaboration-approval' });
  assert.deepEqual(await inventory(h.directory), bytes);
  assert.equal(h.transport.requests.length, calls);
  const registry = `${h.directory}-multibot-registry.json`;
  await writeFile(registry, JSON.stringify(h.keys.registry, null, 2) + '\n');
  const check = spawnSync('python3', [fileURLToPath(new URL('../scripts/reference-check.py', import.meta.url)), h.directory, registry], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const canonical = JSON.parse(check.stdout);
  assert.equal(canonical.verdict, 'COMPLIANT');
  assert.equal(canonical.signedFrames, 9);
  await writeFile(`${h.directory}-multibot-reference.json`, JSON.stringify({
    schema: 'rapp-work.multibot-reference-proof/1', roots: [a.root, b.root], canonicalDirectory: h.directory,
    canonical, request: sourceReference(caller.streams.swarm[0]), response: sourceReference(recipient.streams.swarm[0]),
    originalClockSkewPreserved: true, originalBytesPreserved: true, revokedGrantAndAbsentPrivateKeysAllowOnlyImmutableReplay: true,
    newUnauthorizedRequestRefused: true, changedReplayRefused: true, replayModelCalls: 0, replayMutations: 0,
    transcript: exchange.transcript,
  }, null, 2) + '\n');
});

test('clearing the caller after a committed peer reply fences a new synthesis computation', async () => {
  const h = await harness(), a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const repository = h.runtime.bots.repository;
  const transact = repository.transaction.bind(repository), append = h.runtime.bots.appendEvent.bind(h.runtime.bots);
  let linked = false;
  h.runtime.bots.appendEvent = async (...args) => {
    const frame = await append(...args);
    if (args[2] === 'collaboration.perspective') linked = true;
    return frame;
  };
  repository.transaction = async operation => {
    const result = await transact(operation);
    if (linked) {
      linked = false;
      await h.runtime.bots.visibility(a.root, true, 'clear-before-synthesis');
    }
    return result;
  };
  const result = await h.runtime.collaboration.ask(a.root, b.root, 'Return one approved public perspective.', 'clear-race');
  assert.equal(h.transport.requests.length, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.responseStatus, 'completed');
  assert.equal(result.synthesisStatus, 'unavailable');
  const own = await repository.root(a.root), peer = await repository.root(b.root);
  assert.equal(peer.streams.swarm.length, 1);
  assert(!memoryFrames(own).some(f => f.payload.event === 'collaboration.synthesized'));
  assert((await h.runtime.bots.project(a.root)).hidden);
});

test('synthesis cannot bind one question to a different signed response even within the same authorized root pair', async () => {
  const h = await harness(), a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const first = await h.runtime.collaboration.ask(a.root, b.root, 'First exact question.', 'question-one');
  const second = await h.runtime.collaboration.ask(a.root, b.root, 'Second exact question.', 'question-two');
  const peer = await h.runtime.bots.repository.root(b.root);
  const unrelated = peer.streams.swarm.find(f => f.frame_hash === second.response);
  await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx,
    tx.snapshot.roots.find(r => r.definition.root === a.root), 'collaboration.synthesized', {
      format: 'rapp-work.synthesis-references/1', responseRef: sourceReference(unrelated),
      requestWave: first.request, responseWave: unrelated.frame_hash,
      public: { summary: 'Wrongly correlated source result.', disagreements: [], unknowns: [] },
      consensus: false, actions: 'review-required',
    }, 'wrong-synthesis-binding'));
  await assert.rejects(h.runtime.collaboration.transcript(a.root), { code: 'collaboration-binding' });
});

test('a second signed echo with a different operation identity is not another authorized reply to the same request', async () => {
  const h = await harness(), a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  await h.runtime.collaboration.ask(a.root, b.root, 'One request, one original response.', 'single-request');
  const original = (await h.runtime.bots.repository.root(b.root)).streams.swarm[0];
  await h.runtime.bots.repository.transaction(tx => tx.append({
    root: b.root, family: 'swarm', kind: 'swarm.echo', utc: h.runtime.bots.now(), expectedHead: original.frame_hash,
    signer: h.keys.signers[1].signer, payload: { ...original.payload, operationId: 'duplicate-response-alias' },
  }));
  await assert.rejects(h.runtime.collaboration.transcript(a.root), { code: 'collaboration-binding' });
});

test('the bounded interpreter context measures UTF-8 bytes before hotload or inference', async () => {
  const h = await harness(), bot = await h.create();
  const before = await inventory(h.directory), handle = h.runtime.bots.spine.observe(bot.root);
  let calls = 0;
  try {
    await assert.rejects(h.runtime.bots.spine.compute(handle, h.runtime.bots.capability, {
      root: bot.root, scope: 'root', thought: 'Do not exceed the byte bound.', purpose: 'perspective',
      context: { root: bot.root, scope: 'root', publicText: '雪'.repeat(32_000) },
    }, { complete: async () => { calls++; return { summary: 'Must not run', disagreements: [], unknowns: [] }; } }), { code: 'root-isolation' });
  } finally { await h.runtime.bots.spine.unobserve(handle); }
  assert.equal(calls, 0);
  assert.equal(h.brainstem.hotloads.length, 0);
  assert.deepEqual(await inventory(h.directory), before);
});

test('negated consensus and peer dissent remain verbatim source-owned perspectives, not copied caller memory', async () => {
  const h = await harness(), a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const perspective = { summary: 'We do not all agree. No consensus has been reached.',
    disagreements: ['Do not merge the native histories.'], unknowns: ['The adopted runtime binding is still unavailable.'] };
  const synthesis = { summary: 'No consensus. Keep the separate public perspectives.', disagreements: [], unknowns: [] };
  h.transport.responses.push(perspective, synthesis);
  const result = await h.runtime.collaboration.ask(a.root, b.root, 'Preserve disagreement without copying private history.', 'negated-consensus');
  const own = await h.runtime.bots.repository.root(a.root), peer = await h.runtime.bots.repository.root(b.root);
  assert.equal(canonicalJson(peer.streams.swarm[0].payload.public), canonicalJson(perspective));
  assert.equal(canonicalJson(memoryFrames(own).find(f => f.payload.event === 'collaboration.synthesized').payload.data.public), canonicalJson(synthesis));
  assert(!canonicalJson(own).includes(perspective.disagreements[0]));
  assert(result.transcript.some(t => t.speaker === b.root && t.text.includes(perspective.summary) && t.text.includes(perspective.disagreements[0])));
  assert(result.transcript.some(t => t.speaker === a.root && t.text === synthesis.summary));
});
