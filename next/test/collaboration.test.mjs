import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LocalHive } from '../dist/hive.js';
import { canonicalJson } from '../dist/canonical.js';
import { harness, allowPair, inventory, deferred } from './harness.mjs';

test('no peer delegation before bilateral explicit root authority, and no self-identity merging', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.collaboration.ask(a.root, b.root, 'Unapproved exchange', 'not-approved'), { code: 'collaboration-approval' });
  assert.deepEqual(await inventory(h.directory), before);
  await h.runtime.collaboration.grant(a.root, b.root, 'A public brief', 'allow', 'grant-only-a');
  await assert.rejects(h.runtime.collaboration.ask(a.root, b.root, 'Still unapproved', 'still-not-approved'), { code: 'collaboration-approval' });
  await assert.rejects(h.runtime.collaboration.ask(a.root, a.root, 'Self merge', 'self'), { code: 'collaboration-scope' });
  assert.equal(h.transport.requests.length, 0);
});

test('two signed public perspectives use exact canonical streams, preserve disagreements, and never leak private memory', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  for (const [bot, marker, id] of [[a, 'PRIVATE-BUILDER-MEMORY', 'private-a'], [b, 'PRIVATE-REVIEWER-MEMORY', 'private-b']]) {
    const genesis = (await h.runtime.bots.repository.root(bot.root)).streams.body[0].frame_hash;
    await h.runtime.conversation.recordProgress(bot.root, 'root', marker, [genesis], id);
  }
  await allowPair(h, a.root, b.root);
  const result = await h.runtime.collaboration.ask(a.root, b.root, 'Review the public pointer-federation plan.', 'public-review');
  assert.equal(result.status, 'completed');
  assert.equal(h.transport.requests.length, 2);
  assert.deepEqual(h.transport.requests.map(r => r.root), [b.root, a.root]);
  const requests = JSON.stringify(h.transport.requests);
  assert(!requests.includes('PRIVATE-BUILDER-MEMORY'));
  assert(!requests.includes('PRIVATE-REVIEWER-MEMORY'));
  assert(new Set(result.transcript.map(t => t.speaker)).has(a.root));
  assert(new Set(result.transcript.map(t => t.speaker)).has(b.root));
  const state = await h.runtime.bots.repository.snapshot();
  const guidance = state.roots.find(r => r.definition.root === a.root).streams.swarm[0];
  const echo = state.roots.find(r => r.definition.root === b.root).streams.swarm[0];
  assert(guidance.sig && echo.sig);
  assert.equal(echo.payload.requestWave, guidance.frame_hash);
  assert.equal(echo.payload.requestParticle, guidance.payload_hash);
  const synthesis = state.roots.find(r => r.definition.root === a.root).streams.memory.find(f => f.payload.event === 'collaboration.synthesized');
  assert.equal(synthesis.payload.data.consensus, false);
  assert.equal(synthesis.payload.data.actions, 'review-required');
  assert(synthesis.payload.data.public.disagreements.includes(echo.payload.public.disagreements[0]));
  for (let i = 1; i < result.transcript.length; i++) {
    const x = result.transcript[i - 1].source, y = result.transcript[i].source;
    assert(x.utc < y.utc || (x.utc === y.utc && x.frame_hash < y.frame_hash));
  }
  const registry = path.join(path.dirname(h.directory), `${path.basename(h.directory)}-registry.json`);
  await writeFile(registry, JSON.stringify(h.keys.registry));
  const checker = fileURLToPath(new URL('../scripts/reference-check.py', import.meta.url));
  const checked = spawnSync('python3', [checker, h.directory, registry], { encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const verdict = JSON.parse(checked.stdout);
  assert.equal(verdict.verdict, 'COMPLIANT');
  assert(verdict.framesScanned > 0 && verdict.signedFrames > 0);
  assert.equal(verdict.authorityFrames, 16);
});

test('restart reconstructs the exact multibot transcript and never replays request or synthesis inference', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const exchange = await h.runtime.collaboration.ask(a.root, b.root, 'Give an independent public perspective', 'exchange-once');
  const before = await inventory(h.directory);
  const calls = h.transport.requests.length;
  const restarted = await h.restart();
  assert.deepEqual(await restarted.collaboration.transcript(a.root), exchange.transcript);
  assert.deepEqual((await restarted.collaboration.ask(a.root, b.root, 'Give an independent public perspective', 'exchange-once')).transcript, exchange.transcript);
  assert.equal(h.transport.requests.length, calls);
  assert.deepEqual(await inventory(h.directory), before);
});

test('wrong occurrence binding cannot replay even a correctly signed peer echo', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  await h.runtime.collaboration.ask(a.root, b.root, 'One bounded question', 'bound-question');
  const original = (await h.runtime.bots.repository.root(b.root)).streams.swarm[0];
  await h.runtime.bots.repository.transaction(tx => tx.append({
    root: b.root, family: 'swarm', kind: 'swarm.echo', utc: h.runtime.bots.now(),
    expectedHead: original.frame_hash, signer: h.keys.signers[1].signer,
    payload: { ...original.payload, operationId: 'forged-echo', requestParticle: '0'.repeat(64) },
  }));
  await assert.rejects(h.runtime.collaboration.transcript(a.root), { code: 'collaboration-binding' });
  assert.equal(canonicalJson((await h.runtime.bots.repository.root(b.root)).streams.swarm[0]), canonicalJson(original));
});

test('grant revocation while recipient works prevents publication and caller synthesis', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const reached = deferred(), release = deferred();
  const originalCreate = h.transport.createSession.bind(h.transport);
  h.transport.createSession = async config => {
    const session = await originalCreate(config);
    const original = session.sendAndWait;
    return { ...session, sendAndWait: async (...args) => {
      reached.resolve();
      await release.promise;
      return original(...args);
    } };
  };
  const request = h.runtime.collaboration.ask(a.root, b.root, 'Hold this public exchange', 'revoked-exchange');
  const refused = assert.rejects(request, { code: 'collaboration-approval' });
  await reached.promise;
  await h.runtime.collaboration.grant(b.root, a.root, 'Revoke the relationship', 'revoke', 'revoke-peer');
  release.resolve();
  await refused;
  assert.equal((await h.runtime.bots.repository.root(b.root)).streams.swarm.length, 0);
  assert.equal(h.transport.requests.length, 1);
  assert((await h.runtime.bots.project(a.root)).attention.some(a => a.kind === 'collaboration-pending'));
});

test('recipient provider outage keeps a signed unavailable perspective, with no fallback or invented synthesis', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  h.transport.unavailable = true;
  const result = await h.runtime.collaboration.ask(a.root, b.root, 'Public question during outage', 'peer-outage');
  assert.equal(result.status, 'unavailable');
  assert.equal(h.transport.requests.length, 1);
  assert(result.transcript.some(t => t.speaker === b.root && t.text.includes('unavailable')));
  assert(!(await h.runtime.bots.repository.root(a.root)).streams.memory.some(f => f.payload.event === 'collaboration.synthesized'));
});

test('Local Hive refuses unbound canonical authority; adopted-port references never merge roots or copy memory', async () => {
  const h = await harness();
  const a = await h.create(), b = await h.create(1);
  await allowPair(h, a.root, b.root);
  const before = await inventory(h.directory);
  await assert.rejects(h.runtime.hive.link(a.root, b.root, 'taxonomy', '1'.repeat(64), 'public-grant-is-not-hive'), { code: 'hive-consent' });
  assert.deepEqual(await inventory(h.directory), before);
  await h.runtime.hive.consent(a.root, b.root, 'taxonomy', '1'.repeat(64), 'allow', 'hive-consent-a');
  await h.runtime.hive.consent(b.root, a.root, 'taxonomy', '1'.repeat(64), 'allow', 'hive-consent-b');
  const consented = await inventory(h.directory);
  await assert.rejects(h.runtime.hive.link(a.root, b.root, 'taxonomy', '1'.repeat(64), 'hive-unbound'), { code: 'hive-binding-unavailable' });
  assert.deepEqual(await inventory(h.directory), consented);
  let acceptedInput;
  const boundaryFixture = new LocalHive(h.runtime.bots, {
    available: true,
    verifyExistingSharedObject: async input => {
      acceptedInput = input;
      return { hive: a.root, registrySeq: 7, registryCommitment: '2'.repeat(64),
        declarationWave: '3'.repeat(64), acceptedObjectWave: input.objectWave, checkpointWave: '4'.repeat(64) };
    },
  });
  const linked = await boundaryFixture.link(a.root, b.root, 'taxonomy', '1'.repeat(64), 'fixture-hive-link');
  assert.equal(linked.identitiesMerged, false);
  assert.equal(acceptedInput.root, a.root);
  assert.equal(acceptedInput.peer, b.root);
  assert.equal((await h.runtime.bots.list()).length, 2);
  assert.equal((await h.runtime.bots.repository.root(b.root)).streams.memory.length, 2);
});
