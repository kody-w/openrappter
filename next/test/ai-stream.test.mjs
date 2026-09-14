import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { canonicalJson } from '../dist/canonical.js';
import { ProjectionStreams } from '../dist/ai-stream.js';
import { boundedLines, BoundedWriter } from '../dist/bounded-stdio.js';
import { AiEndpoint, MCP_PROTOCOL } from '../dist/ai-endpoint.js';
import { TestProjectionConsumer } from './projection-consumer.mjs';
import { harness, inventory } from './harness.mjs';
import { issue, view, publish } from './ai-fixture.mjs';

test('a disposable test consumer transforms in real time from signed work, focus, layout, progress and conflict events', async () => {
  const h = await harness();
  const a = await h.create();
  const writer = await issue(h, a.root, 'Claude');
  const observer = await issue(h, a.root, 'Observer', ['projection.read', 'projection.subscribe']);
  const streams = new ProjectionStreams(h.runtime.ai);
  const before = await inventory(h.directory);
  const sub = await streams.subscribe(a.root, observer.capability);
  const consumer = new TestProjectionConsumer(a.root);
  for (const event of await streams.take(sub.subscription)) consumer.accept(event);
  assert.deepEqual(await inventory(h.directory), before);
  assert.equal(consumer.state.layout, 'conversation');
  const activity = await h.runtime.ai.publish(a.root, writer.capability, publish('activity', {
    summary: 'Checking the bounded canonical plan', status: 'working', completed: 1, total: 4, evidence: [],
  }), 'activity');
  await streams.poll();
  for (const event of await streams.take(sub.subscription)) consumer.accept(event);
  assert.equal(consumer.state.activity[0].content.status, 'working');
  const visual = await h.runtime.ai.publish(a.root, writer.capability, publish('view', {},
    view('monorepo', 'work', [{ kind: 'activity', ref: activity.receipt.frame_hash }], { progress: activity.receipt.frame_hash })), 'view');
  await streams.poll();
  for (const event of await streams.take(sub.subscription)) consumer.accept(event);
  assert.equal(consumer.state.layout, 'work');
  assert.equal(consumer.state.focus, 'monorepo');
  assert.equal(consumer.state.progress.completed, 1);
  await h.runtime.ai.publish(a.root, writer.capability, publish('view', {}, view('root', 'evidence'), []), 'concurrent-view');
  await streams.poll();
  for (const event of await streams.take(sub.subscription)) consumer.accept(event);
  assert.equal(consumer.state.layout, 'conversation');
  assert.equal(consumer.state.conflicts.length, 1);
  assert(consumer.state.conflicts[0].heads.includes(visual.receipt.frame_hash));
  streams.close();
  assert.equal(h.transport.requests.length, 0);
});

test('reconnect replays exact causal cursor transitions and rebuilds byte-identical final state after restart', async () => {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Scout');
  const streams = new ProjectionStreams(h.runtime.ai);
  const sub = await streams.subscribe(a.root, client.capability);
  const initial = (await streams.take(sub.subscription))[0];
  streams.unsubscribe(sub.subscription);
  const first = await h.runtime.ai.publish(a.root, client.capability, publish('view', {}, view('root', 'work')), 'first');
  await h.runtime.ai.publish(a.root, client.capability, publish('view', {}, view('monorepo', 'review'), [first.receipt.frame_hash]), 'second');
  const restarted = await h.restart();
  const reconstructed = new ProjectionStreams(restarted.ai);
  const resumed = await reconstructed.subscribe(a.root, client.capability, initial.cursor);
  const consumer = new TestProjectionConsumer(a.root);
  for (const event of await reconstructed.take(resumed.subscription)) consumer.accept(event);
  await reconstructed.poll();
  const updates = await reconstructed.take(resumed.subscription, 2);
  assert.equal(updates.length, 2);
  assert(updates.every(e => e.replay));
  for (const event of updates) consumer.accept(event);
  const fresh = new TestProjectionConsumer(a.root);
  const current = await reconstructed.subscribe(a.root, client.capability);
  for (const event of await reconstructed.take(current.subscription)) fresh.accept(event);
  assert.equal(canonicalJson(consumer.state), canonicalJson(fresh.state));
  assert.equal(h.transport.requests.length, 0);
  const wrong = { ...initial.cursor, frame_hash: '0'.repeat(64) };
  await assert.rejects(reconstructed.subscribe(a.root, client.capability, wrong), { code: 'cursor-invalid' });
  reconstructed.close();
});

test('slow consumers receive bounded resync, not unbounded queues or lost canonical work', async () => {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Hermes');
  const streams = new ProjectionStreams(h.runtime.ai, { queuedEvents: 2, queuedBytes: 262_144, replayEvents: 4 });
  const sub = await streams.subscribe(a.root, client.capability);
  const cursor = (await streams.take(sub.subscription))[0].cursor;
  for (let i = 0; i < 3; i++) await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: `Retained ${i}` }), `slow-${i}`);
  await streams.poll();
  assert.equal(streams.status(sub.subscription).events, 2);
  await streams.poll();
  const terminal = (await streams.take(sub.subscription))[0];
  assert.equal(terminal.type, 'resync-required');
  assert.equal(terminal.reason, 'backpressure');
  assert.deepEqual(terminal.cursor, cursor);
  const page = await h.runtime.ai.history(a.root, client.capability, cursor);
  assert.equal(page.records.filter(r => r.event === 'client.conversation').length, 3);
  for (let i = 3; i < 6; i++) await h.runtime.ai.publish(a.root, client.capability, publish('conversation', { text: `Retained ${i}` }), `slow-${i}`);
  await assert.rejects(streams.subscribe(a.root, client.capability, cursor), { code: 'resync-required' });
  assert.equal((await h.runtime.ai.read(a.root, client.capability)).history.conversationRecords, 6);
});

test('revocation fences queued data and subscriptions themselves never append frames', async () => {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Reader', ['projection.read', 'projection.subscribe']);
  const streams = new ProjectionStreams(h.runtime.ai);
  const before = await inventory(h.directory);
  const sub = await streams.subscribe(a.root, client.capability);
  await streams.poll();
  assert.deepEqual(await inventory(h.directory), before);
  await h.runtime.ai.authority.revoke(a.root, client.client, 'End this view', 'revoke-view');
  const terminal = (await streams.take(sub.subscription))[0];
  assert.equal(terminal.type, 'resync-required');
  assert.equal(terminal.reason, 'authority-ended');
  assert.equal(terminal.snapshot, null);
});

test('bounded stdio handles Unicode splits, output backpressure and a finite drain deadline', async () => {
  const bytes = Buffer.from('{"text":"世界"}\n');
  const input = Readable.from([bytes.subarray(0, 11), bytes.subarray(11, 13), bytes.subarray(13)]);
  const lines = [];
  for await (const line of boundedLines(input)) lines.push(line);
  assert.equal(lines[0], '{"text":"世界"}');
  await assert.rejects(async () => { for await (const _ of boundedLines(Readable.from(['x'.repeat(2_000)]), 1_024)) {} }, { code: 'transport-size' });
  let captured = '';
  const output = new Writable({ write(chunk, _encoding, done) { captured += chunk; done(); } });
  const writer = new BoundedWriter(output);
  writer.send({ n: 1 }); writer.send({ n: 2 }); writer.send({ n: 3 });
  await writer.flush();
  assert.deepEqual(captured.trim().split('\n').map(JSON.parse), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  const slow = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _done) {} });
  const bounded = new BoundedWriter(slow, 1_024, 20);
  bounded.send({ data: 'x'.repeat(500) });
  assert.throws(() => bounded.send({ data: 'x'.repeat(600) }), { code: 'transport-backpressure' });
  await assert.rejects(bounded.flush(), { code: 'transport-backpressure' });
  slow.destroy();
});

test('restricted MCP negotiates lifecycle and standard resource updates without exposing owner authority', async () => {
  const h = await harness();
  const a = await h.create();
  const client = await issue(h, a.root, 'Claude');
  const sent = [];
  const endpoint = new AiEndpoint(h.runtime.ai, a.root, client.capability, 'mcp', message => sent.push(message));
  const call = message => endpoint.handle(JSON.stringify(message));
  await call({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert(sent.at(-1).error);
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unsupported-future-version', capabilities: {}, clientInfo: { name: 'Not-The-Granted-Identity', version: '1' } } });
  assert.equal(sent.at(-1).result.protocolVersion, MCP_PROTOCOL);
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(sent.at(-1).result.tools.length, 9);
  assert(!sent.at(-1).result.tools.some(t => /grant|shell|approve|delete/.test(t.name)));
  await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rapp_work_subscribe', arguments: { root: a.root } } });
  const sub = sent.at(-1).result.structuredContent;
  await call({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: sub.uri } });
  assert.equal(JSON.parse(sent.at(-1).result.contents[0].text).events[0].type, 'snapshot');
  await call({ jsonrpc: '2.0', id: 5, method: 'resources/subscribe', params: { uri: sub.uri } });
  await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'rapp_work_publish', arguments: {
    root: a.root, requestId: 'mcp-turn', publication: publish('conversation', { text: 'Claude public work through MCP' }, view('root', 'work')),
  } } });
  assert.equal(sent.at(-1).result.structuredContent.attribution.name, 'Claude');
  await endpoint.tick();
  assert.equal(sent.at(-1).method, 'notifications/resources/updated');
  const count = sent.length;
  await endpoint.tick();
  assert.equal(sent.length, count);
  await call({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: sub.uri } });
  const update = JSON.parse(sent.at(-1).result.contents[0].text).events[0];
  assert.equal(update.type, 'update');
  assert.equal(update.snapshot.view.effective.emphasis, 'work');
  await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'clients.grant', arguments: { root: a.root } } });
  assert.equal(sent.at(-1).result.isError, true);
  assert(!JSON.stringify(sent).includes(client.capability));
  endpoint.close();
});
