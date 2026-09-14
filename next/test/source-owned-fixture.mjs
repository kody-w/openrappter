import assert from 'node:assert/strict';
import { canonicalJson, contentHash } from '../dist/canonical.js';
import { ProjectionStreams } from '../dist/ai-stream.js';
import { memoryCursor, memoryFrames, sourceChain, sourceReference } from '../dist/source-memory.js';
import { TestProjectionConsumer } from './projection-consumer.mjs';
import { CatchUpPlayer } from './catch-up-player.mjs';
import { allowPair, harness, inventory } from './harness.mjs';
import { issue, publish, view } from './ai-fixture.mjs';

export async function sourceOwnedProof() {
  const h = await harness();
  const bot = await h.create(), peer = await h.create(1);
  const root = bot.root;
  const client = await issue(h, root, 'Source Observer');
  const scoped = await issue(h, root, 'Monorepo Reader', ['projection.read'], 'monorepo');
  const streams = new ProjectionStreams(h.runtime.ai);
  const subscription = await streams.subscribe(root, client.capability);
  const consumer = new TestProjectionConsumer(root);
  const events = [];
  const drain = async () => {
    await streams.poll();
    const updates = await streams.take(subscription.subscription, 8);
    for (const event of updates) { assert.notEqual(event.type, 'resync-required'); consumer.accept(event); events.push(event); }
  };
  await drain();
  const markers = ['EXACT-LOCAL-WORLD-EXHAUST', 'EXACT-MONOREPO-WORLD-EXHAUST'];
  const originals = [];
  for (const [index, scope] of ['local-estate', 'monorepo'].entries()) {
    await h.runtime.conversation.recordProgress(root, scope, markers[index], [], `source-progress-${index}`);
    const original = sourceChain(await h.runtime.bots.repository.root(root), scope).at(-1);
    originals.push(original);
    await h.runtime.ai.publish(root, client.capability, { ...publish('activity', {
      summary: `Source ${scope} evidence is available by canonical reference.`, status: 'complete', completed: 1, total: 1,
      evidence: [original.frame_hash],
    }), scope }, `source-activity-${index}`);
    await drain();
  }
  const references = originals.map(sourceReference);
  let parents = [];
  for (const focus of ['global-estate', 'librarian']) {
    const receipt = await h.runtime.ai.publish(root, client.capability,
      publish('view', {}, view(focus, 'evidence', references.map(ref => ({ kind: 'evidence', ref: ref.frame_hash }))), parents,
        references.map(ref => ref.frame_hash)), `reference-view-${focus}`);
    parents = [receipt.receipt.frame_hash];
    await drain();
    assert.equal(consumer.state.focus, focus);
    assert.deepEqual(consumer.state.visibleCards.map(c => c.ref), references.map(ref => ref.frame_hash));
  }
  assert.equal(consumer.state.activity.length, 2);
  for (const activity of consumer.state.activity) {
    const original = originals.find(f => f.frame_hash === activity.content.evidence[0]);
    assert.equal(activity.origin.scope, original.payload.scope);
    assert.equal(activity.origin.guid, root);
  }
  const source = await h.runtime.bots.repository.root(root);
  const alternative = sourceChain(source, 'local-estate')[0];
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(root, 'memory', [alternative]));
  await drain();
  assert(events.some(e => e.reason === 'retained-source-branches-changed'));
  const branchBytes = canonicalJson(alternative);
  const latest = await h.runtime.ai.read(root, client.capability);
  assert.equal(latest.activity.length, 2);
  const scopedProjection = await h.runtime.ai.read(root, scoped.capability);
  assert(!canonicalJson(scopedProjection).includes('local-estate'));
  assert(!canonicalJson(scopedProjection).includes(markers[0]));

  await allowPair(h, root, peer.root);
  const exchange = await h.runtime.collaboration.ask(root, peer.root, 'Review source ownership without retrieving private world content.', 'source-peer-review');
  assert(h.transport.requests.slice(-2).every(r => markers.every(marker => !canonicalJson(r).includes(marker))));
  const peerRoot = await h.runtime.bots.repository.root(peer.root);
  const peerTurn = peerRoot.streams.swarm.find(f => f.kind === 'swarm.echo');
  const own = await h.runtime.bots.repository.root(root);
  const synthesis = memoryFrames(own).find(f => f.payload.event === 'collaboration.synthesized');
  assert.deepEqual(JSON.parse(canonicalJson(synthesis.payload.data.responseRef)), sourceReference(peerTurn));
  assert(!canonicalJson(own).includes(peerTurn.payload.public.disagreements[0]));
  assert(exchange.transcript.some(t => t.source.frame_hash === peerTurn.frame_hash && t.origin.guid === peer.root));
  await h.runtime.channels.bind(root, 'a'.repeat(64), 'b'.repeat(64), true, 'source-channel-binding');
  const queued = await h.runtime.channels.queueRecap(root, 'source-recap');
  const snapshot = await h.runtime.bots.repository.root(root);
  const queue = memoryFrames(snapshot).find(f => f.frame_hash === queued.deliveryId);
  assert.equal(queue.payload.data.summary, undefined);
  assert.equal(queue.payload.data.format, 'rapp-work.recap-references/1');
  for (const ref of references) assert(queue.payload.data.sourceRefs.some(r => canonicalJson(r) === canonicalJson(ref)));
  assert(markers.every(marker => queued.summary.includes(marker)));
  assert.equal((await h.runtime.channels.deliver(root, queued.deliveryId, 'source-outage')).status, 'unavailable');
  await drain();
  const finalRoot = await h.runtime.bots.repository.root(root);
  const projection = await h.runtime.bots.project(root);
  const current = await h.runtime.ai.read(root, client.capability);
  const where = await h.runtime.bots.whereWereWe(root);
  const recap = await h.runtime.channels.recap(root);
  assert(where.evidence.every(ref => ref.guid === root && ref.scope && ref.frame_hash));
  assert.equal(projection.progress.length, 2);
  for (const progress of projection.progress) assert(references.some(ref => canonicalJson(progress.origin) === canonicalJson(ref)));
  const frameText = canonicalJson(memoryFrames(finalRoot));
  for (const marker of markers) {
    assert.equal(frameText.split(marker).length - 1, 1);
    assert(!canonicalJson(finalRoot.streams.memory).includes(marker));
  }
  assert.equal(new Set(memoryFrames(finalRoot).map(f => f.frame_hash)).size, memoryFrames(finalRoot).length);
  assert.equal(projection.branches.length, 1);
  assert.equal(projection.attention.find(a => a.kind === 'preserved-branches').origin.scope, 'local-estate');
  const before = await inventory(h.directory);
  const modelCalls = h.transport.requests.length;
  const pages = [];
  const player = new CatchUpPlayer(root, 'root');
  let from = null, more = true;
  while (more) {
    const page = await h.runtime.ai.catchUp(root, client.capability, { from, to: current.cursor });
    player.load(page, page.timelineDigest); player.forward(page.steps.length);
    pages.push(page); from = page.next; more = page.more;
  }
  for (const ref of references) assert(pages.flatMap(p => p.steps).some(s => canonicalJson(s.origin) === canonicalJson(ref)));
  assert.equal(canonicalJson(player.state.projection), canonicalJson(current));
  assert.equal(pages.flatMap(p => p.steps).filter(step => step.origin?.frame_hash === alternative.frame_hash).length, 1);
  const restarted = await h.restart();
  assert.equal(canonicalJson(await restarted.bots.project(root)), canonicalJson(projection));
  assert.equal(canonicalJson(await restarted.ai.read(root, client.capability)), canonicalJson(current));
  assert.equal(canonicalJson(await restarted.bots.whereWereWe(root)), canonicalJson(where));
  assert.equal(canonicalJson(await restarted.channels.recap(root)), canonicalJson(recap));
  assert.equal(canonicalJson(await restarted.collaboration.transcript(root)), canonicalJson(exchange.transcript));
  const reconstructed = await restarted.bots.repository.root(root);
  assert.equal(canonicalJson(reconstructed.sources.find(s => s.scope === 'local-estate').branches[0].frames[0]), branchBytes);
  for (const page of pages) assert.equal(canonicalJson(await restarted.ai.catchUp(root, client.capability, { from: page.from, to: page.to })), canonicalJson(page));
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(h.transport.requests.length, modelCalls);
  const resumed = new ProjectionStreams(restarted.ai);
  const secondConsumer = new TestProjectionConsumer(root);
  const second = await resumed.subscribe(root, client.capability);
  for (const event of await resumed.take(second.subscription)) secondConsumer.accept(event);
  assert.equal(canonicalJson(secondConsumer.state), canonicalJson(consumer.state));
  assert.equal(canonicalJson(secondConsumer.cursor), canonicalJson(consumer.cursor));
  streams.close(); resumed.close();
  return {
    h, pages, events,
    report: {
      schema: 'rapp-work.source-ownership-gate/1', root, peer: peer.root, status: 'passed',
      sourceIdentity: 'original full root RAPPID + exact internal scope + original canonical stream',
      references, sources: projection.sources, cursor: memoryCursor(finalRoot),
      selectedMemoryOccurrences: memoryFrames(finalRoot).length, preservedBranches: 1,
      markerOccurrences: Object.fromEntries(markers.map(marker => [marker, 1])),
      copiedRootActivityOccurrences: 0, copiedRecapPayloads: 0, copiedPeerDissent: 0,
      retainedBranchMeaning: 'byte-identical original ancestry prefix; conflicting forks are separately tested and fenced',
      referenceSurfaces: ['Global Estate', 'Workspaces Librarian', 'collaboration', 'iMessage recap', 'Where were we', 'Catch me up'],
      observedEvents: events.length, framesOnlyRestart: true, originalBranchBytesPreserved: true,
      replayPages: pages.length, stateDigest: contentHash(current), replayStateDigest: player.stateDigest,
      replayModelCalls: 0, replayToolExecutions: 0, replayMutations: 0,
      aggregateDurableStore: false, uiImplemented: false, liveProfilesTouched: false,
    },
  };
}
