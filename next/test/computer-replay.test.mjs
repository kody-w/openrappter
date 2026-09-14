import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessRuntime } from '../dist/runtime.js';
import { CanonicalComputerReplay } from '../dist/computer-replay.js';
import { canonicalJson, contentHash } from '../dist/canonical.js';
import { findRoot } from '../dist/bots.js';
import { harness, inventory } from './harness.mjs';
import { issue } from './ai-fixture.mjs';
import { computerReplayFixture } from './computer-replay-fixture.mjs';

async function seeded() {
  const h = await harness();
  const a = await h.create();
  const source = await computerReplayFixture(h, a.root);
  const runtime = await HeadlessRuntime.open({ ...h.settings, computerReplay: source.replay });
  return { h, a, source, runtime };
}

test('guest replay is default-off and requires explicit GODD/private opt-in plus separate client authority', async () => {
  const { h, a, source, runtime } = await seeded();
  const ordinary = await issue(h, a.root, 'Ordinary', ['projection.read']);
  const privateClient = await issue(h, a.root, 'Private', ['projection.read', 'guest.replay']);
  const off = await runtime.ai.catchUp(a.root, privateClient.capability, { from: null });
  assert(off.steps.every(s => s.guest === null));
  assert(!canonicalJson(off).includes(source.png.toString('base64')));
  await assert.rejects(runtime.ai.catchUp(a.root, ordinary.capability, { from: null, guest: source.option }), { code: 'client-unauthorized' });
  await assert.rejects(runtime.ai.catchUp(a.root, privateClient.capability, { guest: { ...source.option, visibility: 'public' } }), { code: 'guest-opt-in' });
});

test('canonical approved guest pixels are recorded; command/diff visualizations reconstructed; absent display unavailable', async () => {
  const { h, a, source, runtime } = await seeded();
  const client = await issue(h, a.root, 'Guest Reader', ['projection.read', 'guest.replay']);
  const page = await runtime.ai.catchUp(a.root, client.capability, { from: null, guest: source.option });
  const steps = page.steps.filter(s => s.guest !== null);
  assert.deepEqual(steps.map(s => s.grade), ['recorded', 'reconstructed', 'reconstructed', 'unavailable']);
  assert.equal(steps[0].guest.image.base64, source.png.toString('base64'));
  assert.equal(steps[0].guest.image.sha256, source.binding.approvedGuestArtifacts[0].sha256);
  assert.equal(steps[1].guest.command.rawCommand, 'excluded');
  assert.equal(steps[2].guest.diff.addedLines, 7);
  assert.equal(steps[3].guest.image, null);
  for (const step of steps) {
    assert.equal(step.guest.execution, false);
    if (step.state) assert.equal(contentHash(step.state), step.stateDigest);
  }
  const text = canonicalJson(page);
  for (const marker of ['EXCLUDED-SECRET-ARGUMENT', 'EXCLUDED-SECRET-STDOUT', 'EXCLUDED-SECRET-STDERR', 'EXCLUDED-KEYSTROKES', '/workspaces/fixture-workspace']) {
    assert(!text.includes(marker));
  }
});

test('guest replay and restart perform no model, VM, command, capture, tool or canonical mutation', async () => {
  const { h, a, source, runtime } = await seeded();
  const client = await issue(h, a.root, 'Private Reader', ['projection.read', 'guest.replay']);
  runtime.bots.spine.compute = async () => { throw new Error('Must not infer during replay'); };
  runtime.effects.port.execute = async () => { throw new Error('Must not execute during replay'); };
  const before = await inventory(h.directory);
  const first = await runtime.ai.catchUp(a.root, client.capability, { from: null, guest: source.option });
  const restarted = await HeadlessRuntime.open({ ...h.settings, computerReplay: new CanonicalComputerReplay(source.binding) });
  const second = await restarted.ai.catchUp(a.root, client.capability, { from: null, to: first.to, guest: source.option });
  assert.equal(canonicalJson(second), canonicalJson(first));
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(h.transport.requests.length, 0);
  assert.equal(typeof source.replay.execute, 'undefined');
  assert.equal(typeof source.replay.capture, 'undefined');
});

test('host screen, unapproved bytes, unsupported producer signatures and absent binding fail closed', async () => {
  const { h, a, source } = await seeded();
  assert.throws(() => new CanonicalComputerReplay({ ...source.binding,
    approvedGuestArtifacts: [{ ...source.binding.approvedGuestArtifacts[0], surface: 'host-screen' }] }), { code: 'guest-capture-approval' });
  const altered = Buffer.from(source.png); altered[altered.length - 1] ^= 1;
  assert.throws(() => new CanonicalComputerReplay({ ...source.binding,
    approvedGuestArtifacts: [{ ...source.binding.approvedGuestArtifacts[0], bytes: altered }] }), { code: 'guest-capture-approval' });
  assert.throws(() => new CanonicalComputerReplay({ ...source.binding, producer: h.keys.signers[1].root }), { code: 'guest-producer' });
  const client = await issue(h, a.root, 'Missing Binding Reader', ['projection.read', 'guest.replay']);
  const unavailable = await h.runtime.ai.catchUp(a.root, client.capability, { from: null, guest: source.option });
  assert(unavailable.steps.filter(s => s.guest).every(s => s.guest.grade === 'unavailable'));
});

test('guest replay does not turn a stored origin claim into trusted capture approval', async () => {
  const { h, a, source } = await seeded();
  const unapproved = new CanonicalComputerReplay({ ...source.binding, approvedGuestArtifacts: [] });
  const runtime = await HeadlessRuntime.open({ ...h.settings, computerReplay: unapproved });
  const client = await issue(h, a.root, 'Unapproved', ['projection.read', 'guest.replay']);
  const page = await runtime.ai.catchUp(a.root, client.capability, { from: null, guest: source.option });
  const capture = page.steps.find(s => s.cursor.frame_hash === source.capture.linked.frame_hash);
  assert.equal(capture.grade, 'unavailable');
  assert.equal(capture.guest.image, null);
});

test('revoked/private policy and a wrong canonical owner cannot reveal guest display', async () => {
  const { h, a, source, runtime } = await seeded();
  const client = await issue(h, a.root, 'Revoked Reader', ['projection.read', 'guest.replay']);
  await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, findRoot(tx, a.root), 'computer.replay.policy',
    { ...source.policy.payload.data, enabled: false }, 'disable-private-replay'));
  const page = await runtime.ai.catchUp(a.root, client.capability, { from: null, guest: source.option });
  assert(page.steps.filter(s => s.guest).every(s => s.guest.grade === 'unavailable'));
  assert(!canonicalJson(page).includes(source.png.toString('base64')));
  const wrongOwner = new CanonicalComputerReplay({ ...source.binding, owner: { agentId: 'different', workspaceId: 'different' } });
  const wrong = await HeadlessRuntime.open({ ...h.settings, computerReplay: wrongOwner });
  assert((await wrong.ai.catchUp(a.root, client.capability, { from: null, guest: source.option })).steps.filter(s => s.guest).every(s => s.guest.grade === 'unavailable'));
});
