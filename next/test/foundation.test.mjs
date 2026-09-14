import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITY, buildFrame, canonicalJson, createFrameSigner, frameHead, keyedIdentity,
  selectSignaturePolicy, streamFor, verifySelectedAuthority,
} from '../dist/canonical.js';
import { CanonicalRepository } from '../dist/repository.js';
import { Bots } from '../dist/bots.js';
import { SharedBrainstem, targetCapability, UnavailableBrainstem } from '../dist/spine.js';
import { eventPayload } from '../dist/contract.js';

const base = fileURLToPath(new URL('../.test-scratch/foundation/', import.meta.url));
await mkdir(base, { recursive: true, mode: 0o700 });
const run = path.join(base, `run-${process.pid}-${Date.now()}`);
await mkdir(run, { mode: 0o700 });
const utc = '2026-09-13T20:00:00.000Z';
const capability = await targetCapability();
let counter = 0;

async function fixture(options = {}) {
  const directory = path.join(run, `store-${counter++}`);
  const repository = await CanonicalRepository.open({ directory, ...options });
  const spine = new SharedBrainstem(new UnavailableBrainstem(), [capability]);
  return { directory, repository, spine, bots: new Bots({ repository, spine, capability: capability.reference, clock: () => utc }) };
}

async function inventory(directory) {
  const result = {};
  async function walk(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), name);
      else result[name] = createHash('sha256').update(await readFile(path.join(current, entry.name))).digest('hex');
    }
  }
  await walk(directory);
  return result;
}

test('rev-15 exact accepted chain reconstructs sixteen nonzero authority frames', async () => {
  assert.deepEqual(await verifySelectedAuthority(), { revision: 'rev-15', frames: 16 });
  assert.equal(AUTHORITY.commit, 'dda32d741c7218f41443a5bd17eebfe0eae82cb7');
});

test('mint once, full GUID, recursive scopes, hidden organs and canonical restart', async () => {
  const f = await fixture();
  const bot = await f.bots.create({ name: 'Copilot Builder', operationId: 'create-builder' });
  assert.match(bot.root, /^rappid:@local\/bot:[a-f0-9]{64}$/);
  assert.equal(bot.scopes.filter(s => s.kind === 'librarian').length, 1);
  assert.deepEqual(bot.scopes.filter(s => s.parent === 'root' && s.kind === 'world').map(s => s.name),
    ['RAPP Global Estate', 'Local AI estate', 'RAPP Monorepo']);
  assert.equal((await f.bots.create({ name: 'Copilot Builder', operationId: 'create-builder' })).root, bot.root);
  const before = await inventory(f.directory);
  const repository = await CanonicalRepository.open({ directory: f.directory });
  const restarted = new Bots({ repository, spine: f.spine, capability: capability.reference, clock: () => utc });
  assert.deepEqual(await restarted.project(bot.root), bot);
  assert.equal((await repository.snapshot()).frameCount, 1);
  assert.deepEqual(await inventory(f.directory), before);
  assert.equal((await restarted.list()).length, 1);
});

test('observation, selection and where-were-we do not append or compute; clear is hide only', async () => {
  const f = await fixture();
  const bot = await f.bots.create({ name: 'Dormant', operationId: 'create-dormant' });
  const before = await inventory(f.directory);
  const lease = f.spine.observe(bot.root);
  await f.bots.select(bot.root);
  assert.equal(f.spine.status(bot.root).mode, 'observed');
  assert.match((await f.bots.whereWereWe(bot.root)).text, /no conversation/);
  await f.spine.unobserve(lease);
  assert.equal(f.spine.status(bot.root).mode, 'dormant');
  assert.deepEqual(await inventory(f.directory), before);
  await f.bots.visibility(bot.root, true, 'hide-dormant');
  assert.equal((await f.bots.list()).length, 0);
  assert.equal((await f.bots.list(true))[0].root, bot.root);
  await assert.rejects(f.bots.select(bot.root), { code: 'bot-hidden' });
  await f.bots.visibility(bot.root, false, 'restore-dormant');
  assert.equal((await f.bots.select(bot.root)).root, bot.root);
  assert.equal((await f.repository.root(bot.root)).streams.memory.length, 2);
  assert.equal(typeof f.bots.delete, 'undefined');
  assert.equal(typeof f.repository.delete, 'undefined');
});

test('concurrent instances deduplicate creation and reject operation rebinding', async () => {
  const f = await fixture();
  const second = new Bots({ repository: await CanonicalRepository.open({ directory: f.directory }),
    spine: f.spine, capability: capability.reference, clock: () => utc });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? f.bots : second).create({ name: 'Same thought', operationId: 'create-once' })));
  assert.equal(new Set(results.map(r => r.root)).size, 1);
  assert.equal((await f.repository.snapshot()).frameCount, 1);
  await assert.rejects(second.create({ name: 'Different', operationId: 'create-once' }), { code: 'idempotency-conflict' });
});

test('canonical corruption, scope escape and source/native directory writes fail closed', async () => {
  const f = await fixture();
  const a = await f.bots.create({ name: 'A', operationId: 'create-a' });
  const b = await f.bots.create({ name: 'B', operationId: 'create-b' });
  await assert.rejects(f.repository.transaction(async tx => tx.append({
    root: a.root, family: 'memory', kind: 'memory.save', utc, expectedHead: null,
    payload: eventPayload(b.root, 'root', 'escape', 'root.visibility', { hidden: true }),
  })), { code: 'root-isolation' });
  const source = path.join(run, 'source');
  await mkdir(source, { mode: 0o700 });
  await writeFile(path.join(source, 'source.ts'), 'untouched');
  await assert.rejects(CanonicalRepository.open({ directory: source }), { code: 'source-directory' });
  assert.equal(await readFile(path.join(source, 'source.ts'), 'utf8'), 'untouched');
  const native = path.join(run, '.copilot');
  await mkdir(native, { mode: 0o700 });
  await assert.rejects(CanonicalRepository.open({ directory: path.join(native, 'sessions') }), { code: 'native-store' });
  const linkPath = path.join(run, 'linked');
  await symlink(f.directory, linkPath);
  await assert.rejects(CanonicalRepository.open({ directory: linkPath }), { code: 'path-boundary' });
  const frameFile = path.join(f.directory, 'bots', a.root.split(':').at(-1), 'body/frames/000000000000.json');
  const frame = JSON.parse(await readFile(frameFile, 'utf8'));
  frame.payload.name = 'tampered';
  await writeFile(frameFile, canonicalJson(frame));
  await assert.rejects(f.repository.snapshot(), { code: 'canonical-integrity' });
});

test('byte-identical conflicting branch survives restart while both state interpretations remain fenced', async () => {
  const f = await fixture();
  const a = await f.bots.create({ name: 'Branches', operationId: 'create-branches' });
  await f.bots.visibility(a.root, true, 'hide-main');
  const original = (await f.repository.root(a.root)).streams.memory[0];
  const alternative = buildFrame({ kind: 'memory.save', streamId: streamFor(a.root, 'memory'), head: null, utc,
    payload: eventPayload(a.root, 'root', 'alternative', 'root.visibility', { hidden: false }) });
  await f.repository.transaction(tx => tx.preserveBranch(a.root, 'memory', [alternative]));
  const before = await inventory(f.directory);
  const reopened = await CanonicalRepository.open({ directory: f.directory });
  const state = await reopened.root(a.root);
  assert.equal(state.streams.memory[0].frame_hash, original.frame_hash);
  assert.equal(canonicalJson(state.branches[0].frames[0]), canonicalJson(alternative));
  assert.deepEqual(await inventory(f.directory), before);
  await assert.rejects(f.bots.project(a.root), { code: 'canonical-fork-unresolved' });
});

test('independent keyed root signatures cannot be substituted across roots', async () => {
  const keys = ['a', 'b'].map(name => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const root = keyedIdentity('fixture', name, publicKey);
    return { root, signer: createFrameSigner({ kid: root, privateKey }),
      registry: { kid: root, spki_der_b64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        revoked_utc: null, superseded_utc: null } };
  });
  const f = await fixture({ signatures: selectSignaturePolicy(keys.map(k => k.registry)) });
  const bots = new Bots({ repository: f.repository, spine: f.spine, capability: capability.reference, signers: keys, clock: () => utc });
  const a = await bots.create({ name: 'Signed A', keyedRoot: keys[0].root, operationId: 'signed-a' });
  await bots.create({ name: 'Signed B', keyedRoot: keys[1].root, operationId: 'signed-b' });
  await assert.rejects(f.repository.transaction(tx => tx.append({
    root: a.root, family: 'swarm', kind: 'swarm.guidance', payload: { public: 'wrong signer' },
    utc, expectedHead: null, signer: keys[1].signer,
  })), { code: 'root-signature' });
  assert.equal((await f.repository.root(a.root)).streams.swarm.length, 0);
});

test('published canonical receipt survives lost acknowledgement; no overwrite retry', async () => {
  let fail = false;
  const f = await fixture({ fault: point => { if (fail && point === 'after-publish') throw new Error('lost acknowledgement'); } });
  const a = await f.bots.create({ name: 'Receipt', operationId: 'receipt-root' });
  fail = true;
  await assert.rejects(f.bots.visibility(a.root, true, 'hide-once'));
  fail = false;
  assert.equal((await f.bots.visibility(a.root, true, 'hide-once')).hidden, true);
  const frames = (await f.repository.root(a.root)).streams.memory;
  assert.equal(frames.length, 1);
  const forged = { ...frameHead(frames[0]), frame_hash: '0'.repeat(64) };
  await assert.rejects(f.repository.transaction(tx => tx.append({
    root: a.root, family: 'memory', kind: 'memory.save', utc,
    expectedHead: forged.frame_hash, payload: eventPayload(a.root, 'root', 'restore-bad-head', 'root.visibility', { hidden: false }),
  })), { code: 'stale-head' });
});

test('external Brainstem missing seam and forged capability references refuse before inference', async () => {
  const f = await fixture();
  const a = await f.bots.create({ name: 'Closed', operationId: 'closed-root' });
  const handle = f.spine.observe(a.root);
  let calls = 0;
  const provider = { complete: async () => { calls++; return {}; } };
  const request = { root: a.root, scope: 'root', thought: 'hello', context: {}, purpose: 'organization' };
  await assert.rejects(f.spine.compute(handle, { ...capability.reference, sha256: '0'.repeat(64) }, request, provider),
    { code: 'capability-unverified' });
  await assert.rejects(f.spine.compute(handle, capability.reference, request, provider), { code: 'brainstem-binding-unavailable' });
  await f.spine.unobserve(handle);
  await assert.rejects(f.spine.compute(handle, capability.reference, request, provider), { code: 'unobserved' });
  assert.equal(calls, 0);
});
