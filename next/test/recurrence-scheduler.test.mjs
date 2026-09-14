import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, contentHash, frameHead } from '../dist/canonical.js';
import { eventPayload } from '../dist/contract.js';
import { HeadlessRuntime } from '../dist/runtime.js';
import { RecurrenceScheduler } from '../dist/recurrence-scheduler.js';
import { memoryFrames, sourceChain, sourceStream } from '../dist/source-memory.js';
import { foldState } from '../dist/state.js';
import { harness, inventory, readFixture } from './harness.mjs';

async function installRoutine(h, root, suffix) {
  const fixture = await readFixture('recurring-work');
  const proposal = await h.runtime.conversation.converse(root, fixture.thought, `weekly-thought-${suffix}`);
  await h.runtime.conversation.confirm(root, proposal.proposalWave, `weekly-confirm-${suffix}`);
}

function routineTicks(snapshot) {
  return memoryFrames(snapshot).filter(frame => frame.payload.event === 'routine.tick');
}

function scheduler(runtime, root, holder, options = {}) {
  return new RecurrenceScheduler(runtime.recurring, {
    roots: [root],
    holder,
    leaseMs: 3_000,
    pollMs: 500,
    maxClaimsPerRun: 8,
    ...options,
  });
}

test('running scheduler canonicalizes an occurrence after it becomes due without a caller tick', async () => {
  const h = await harness();
  const bot = await h.create();
  await installRoutine(h, bot.root, 'continuous');
  h.time('2026-09-14T08:59:59.800Z');
  const runner = scheduler(h.runtime, bot.root, 'scheduler-continuous', { leaseMs: 1_000, pollMs: 100 });
  const abort = new AbortController();
  let cycles = 0;
  const timeout = setTimeout(() => abort.abort(), 5_000);

  await runner.run(abort.signal, report => {
    cycles++;
    if (cycles === 1) h.time('2026-09-14T09:00:00.000Z');
    if (report.claims === 1) abort.abort();
  });
  clearTimeout(timeout);

  assert(cycles >= 2);
  assert.equal(routineTicks(await h.runtime.bots.repository.root(bot.root)).length, 1);
});

test('owner scheduler catches up recurring work into canonical source frames without a work.tick request', async () => {
  const h = await harness();
  const bot = await h.create();
  await installRoutine(h, bot.root, 'catch-up');
  const external = await h.runtime.conversation.converse(bot.root, 'Prepare an external message', 'scheduler-external-request');
  await h.runtime.conversation.confirm(bot.root, external.proposalWave, 'scheduler-external-confirm');
  assert(foldState(await h.runtime.bots.repository.root(bot.root)).effects.has('message-request'));
  const providerCalls = h.transport.requests.length;
  h.time('2026-09-28T09:00:00.000Z');

  const report = await scheduler(h.runtime, bot.root, 'scheduler-catch-up').runOnce();

  assert.equal(report.claims, 3);
  assert.equal(report.roots[0].status, 'completed');
  assert.equal(report.roots[0].claims.length, 3);
  const snapshot = await h.runtime.bots.repository.root(bot.root);
  const ticks = routineTicks(snapshot);
  assert.deepEqual(ticks.map(frame => frame.payload.data.occurrence), [
    '2026-09-14T09:00:00.000Z',
    '2026-09-21T09:00:00.000Z',
    '2026-09-28T09:00:00.000Z',
  ]);
  assert(ticks.every(frame => frame.payload.scope === 'weekly-world'
    && frame.stream_id === sourceStream(bot.root, 'weekly-world')));
  assert.equal(h.transport.requests.length, providerCalls);
  assert.equal(h.channel.sent.size, 0);
  assert(!memoryFrames(snapshot).some(frame => frame.payload.event === 'effect.approved'));
  assert.equal((await h.runtime.bots.project(bot.root)).progress.length, 3);
});

test('concurrent schedulers and a later restart retain one canonical occurrence claim', async () => {
  const h = await harness();
  const bot = await h.create();
  await installRoutine(h, bot.root, 'concurrent');
  h.time('2026-09-14T09:00:00.000Z');
  const first = scheduler(h.runtime, bot.root, 'scheduler-one');
  const second = scheduler(h.runtime, bot.root, 'scheduler-two');

  const reports = await Promise.all([first.runOnce(), second.runOnce()]);

  assert.deepEqual(reports.map(report => report.roots[0].status).sort(), ['completed', 'lease-held']);
  const ticks = routineTicks(await h.runtime.bots.repository.root(bot.root));
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].payload.operationId, `tick-${contentHash({
    root: bot.root,
    routineId: 'weekly-recap',
    occurrence: '2026-09-14T09:00:00.000Z',
  })}`);
  const immediateRestart = await h.restart();
  const blocked = await scheduler(immediateRestart, bot.root, 'scheduler-restart-blocked').runOnce();
  assert.equal(blocked.roots[0].status, 'lease-held');
  assert.equal(blocked.roots[0].lease.holder, reports.find(report => report.claims === 1).holder);
  h.time('2026-09-14T09:00:04.000Z');
  const restarted = await h.restart();
  const replay = await scheduler(restarted, bot.root, 'scheduler-restarted').runOnce();
  assert.equal(replay.claims, 0);
  assert.equal(replay.roots[0].status, 'idle');
  assert.equal(routineTicks(await restarted.bots.repository.root(bot.root)).length, 1);
});

test('restart after a lost scheduler acknowledgement catches up without duplicating the committed occurrence', async () => {
  let failAfterPublish = false;
  const h = await harness({
    fault: point => {
      if (failAfterPublish && point === 'after-publish') {
        failAfterPublish = false;
        throw new Error('lost scheduler acknowledgement');
      }
    },
  });
  const bot = await h.create();
  await installRoutine(h, bot.root, 'lost-ack');
  h.time('2026-09-14T09:00:00.000Z');
  failAfterPublish = true;

  await assert.rejects(scheduler(h.runtime, bot.root, 'scheduler-before-crash').runOnce(),
    /lost scheduler acknowledgement/);
  assert.equal(routineTicks(await h.runtime.bots.repository.root(bot.root)).length, 1);

  h.time('2026-09-14T09:00:04.000Z');
  const restarted = await h.restart();
  const report = await scheduler(restarted, bot.root, 'scheduler-after-crash').runOnce();
  assert.equal(report.claims, 0);
  assert.equal(report.roots[0].status, 'idle');
  assert.equal(routineTicks(await restarted.bots.repository.root(bot.root)).length, 1);
});

test('scheduler fences hidden and forked roots without changing canonical bytes', async () => {
  const h = await harness();
  const hidden = await h.create();
  const forked = await h.create(1);
  await installRoutine(h, hidden.root, 'hidden');
  await installRoutine(h, forked.root, 'forked');
  await h.runtime.conversation.recordProgress(forked.root, 'monorepo', 'Common ancestor', [], 'scheduler-fork-base');
  await h.runtime.conversation.recordProgress(forked.root, 'monorepo', 'Selected successor', [], 'scheduler-fork-left');
  const root = await h.runtime.bots.repository.root(forked.root);
  const [base, left] = sourceChain(root, 'monorepo');
  const right = buildFrame({
    kind: 'memory.tool-call',
    streamId: sourceStream(forked.root, 'monorepo'),
    head: frameHead(base),
    utc: left.utc,
    signer: h.keys.signers[1].signer,
    signatures: h.keys.signatures,
    payload: {
      ...eventPayload(forked.root, 'monorepo', 'scheduler-fork-right', 'work.progress',
        { summary: 'Conflicting scheduler source successor', evidence: [] }),
      parents: [...left.payload.parents],
    },
  });
  await h.runtime.bots.repository.transaction(tx => tx.preserveBranch(forked.root, 'memory', [base, right]));
  await h.runtime.bots.visibility(hidden.root, true, 'hide-before-scheduler');
  h.time('2026-09-14T09:00:00.000Z');
  const before = await inventory(h.directory);
  const runner = new RecurrenceScheduler(h.runtime.recurring, {
    roots: [hidden.root, forked.root],
    holder: 'scheduler-fences',
    leaseMs: 3_000,
    pollMs: 500,
  });

  const report = await runner.runOnce();

  const byRoot = new Map(report.roots.map(entry => [entry.root, entry]));
  assert.equal(byRoot.get(hidden.root).status, 'hidden');
  assert.equal(byRoot.get(forked.root).status, 'fenced');
  assert.equal(byRoot.get(forked.root).error.code, 'canonical-fork-unresolved');
  assert.deepEqual(await inventory(h.directory), before);
});

test('signed roots require explicitly injected owner signer custody before unattended work', async () => {
  const h = await harness();
  const bot = await h.create();
  await installRoutine(h, bot.root, 'authority');
  h.time('2026-09-14T09:00:00.000Z');
  const observer = await HeadlessRuntime.open({
    directory: h.directory,
    signatures: h.keys.signatures,
    clock: () => '2026-09-14T09:00:00.000Z',
  });

  await assert.rejects(scheduler(observer, bot.root, 'scheduler-without-owner').runOnce(),
    { code: 'scheduler-owner-authority' });
  assert.equal(routineTicks(await observer.bots.repository.root(bot.root)).length, 0);
});
