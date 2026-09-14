import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TestProjectionConsumer } from './projection-consumer.mjs';
import { harness, inventory } from './harness.mjs';
import { issue, view, publish } from './ai-fixture.mjs';

const cli = fileURLToPath(new URL('../dist/ai-cli.js', import.meta.url));
function connection(h, root, capability, mode = '--stdio') {
  const child = spawn(process.execPath, [cli, '--store', h.directory, '--root', root, mode, '--fixture'], {
    env: { ...process.env, RAPP_WORK_CAPABILITY: capability },
  });
  const messages = [], waiting = new Set();
  let buffer = '', errors = '';
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve(code));
  });
  child.stderr.on('data', bytes => { errors += bytes.toString(); });
  child.stdout.on('data', bytes => {
    buffer += bytes.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of [...waiting]) if (waiter.match(message)) {
        waiting.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message);
      }
    }
  });
  return {
    child, messages, exit,
    send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
    wait(match) {
      const existing = messages.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { waiting.delete(waiter); reject(new Error(`No matching event; stderr: ${errors}`)); }, 8_000) };
        waiting.add(waiter);
      });
    },
    async close() { child.stdin.end(); assert.equal(await exit, 0, errors); },
  };
}

test('the actual restricted stdio process streams another writer’s canonical changes and reconnects without a model', async t => {
  const h = await harness({ clock: () => new Date().toISOString() });
  const a = await h.create();
  const publisher = await issue(h, a.root, 'Publisher');
  const observer = await issue(h, a.root, 'Consumer', ['projection.read', 'projection.subscribe']);
  const pipe = connection(h, a.root, observer.capability);
  t.after(() => { if (pipe.child.exitCode === null) pipe.child.kill('SIGTERM'); });
  const unchanged = await inventory(h.directory);
  pipe.send({ id: 'subscribe', method: 'rapp_work_subscribe', params: { root: a.root } });
  await pipe.wait(m => m.id === 'subscribe');
  const initial = await pipe.wait(m => m.event?.type === 'snapshot');
  assert.deepEqual(await inventory(h.directory), unchanged);
  const consumer = new TestProjectionConsumer(a.root);
  consumer.accept(initial.event);
  const work = await h.runtime.ai.publish(a.root, publisher.capability,
    publish('conversation', { text: 'External AI public work' }, view('monorepo', 'work')), 'outside-process');
  const changed = await pipe.wait(m => m.event?.cursor?.frame_hash === work.receipt.frame_hash);
  consumer.accept(changed.event);
  assert.equal(consumer.state.layout, 'work');
  assert.equal(consumer.state.focus, 'monorepo');
  assert.equal(consumer.state.turns.at(-1).text, 'External AI public work');
  await pipe.close();
  const resumed = connection(h, a.root, observer.capability);
  t.after(() => { if (resumed.child.exitCode === null) resumed.child.kill('SIGTERM'); });
  resumed.send({ id: 'resume', method: 'rapp_work_subscribe', params: { root: a.root, cursor: initial.event.cursor } });
  await resumed.wait(m => m.event?.type === 'snapshot');
  const replay = await resumed.wait(m => m.event?.cursor?.frame_hash === work.receipt.frame_hash);
  assert.equal(replay.event.replay, true);
  await resumed.close();
  assert(!JSON.stringify(pipe.messages).includes(observer.capability));
  assert.equal(h.transport.requests.length, 0);
});

test('the actual MCP stdio executable negotiates and reads the authenticated root without trusting clientInfo', async t => {
  const h = await harness({ clock: () => new Date().toISOString() });
  const a = await h.create();
  const client = await issue(h, a.root, 'Hermes');
  const pipe = connection(h, a.root, client.capability, '--mcp');
  t.after(() => { if (pipe.child.exitCode === null) pipe.child.kill('SIGTERM'); });
  pipe.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Grokbot', version: 'future' } } });
  assert.equal((await pipe.wait(m => m.id === 1)).result.protocolVersion, '2025-11-25');
  pipe.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  pipe.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rapp_work_publish', arguments: {
    root: a.root, requestId: 'mcp-write', publication: publish('conversation', { text: 'Hermes through portable MCP' }),
  } } });
  const publication = (await pipe.wait(m => m.id === 2)).result.structuredContent;
  assert.equal(publication.attribution.name, 'Hermes');
  assert.equal(publication.attribution.provider, 'hermes');
  pipe.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rapp_work_read', arguments: { root: a.root } } });
  assert.equal((await pipe.wait(m => m.id === 3)).result.structuredContent.turns.at(-1).text, 'Hermes through portable MCP');
  await pipe.close();
});

test('a non-Copilot client proposes from canonical context but only the exact owner confirmation applies it across restart', async t => {
  const h = await harness({ clock: () => new Date().toISOString() });
  const a = await h.create();
  const client = await issue(h, a.root, 'Atlas Local', ['projection.read', 'proposal.publish']);
  const observer = await issue(h, a.root, 'Passive Observer', ['projection.read', 'projection.subscribe']);
  const provider = connection(h, a.root, client.capability);
  const subscriber = connection(h, a.root, observer.capability);
  t.after(() => {
    if (provider.child.exitCode === null) provider.child.kill('SIGTERM');
    if (subscriber.child.exitCode === null) subscriber.child.kill('SIGTERM');
  });
  subscriber.send({ id: 'subscribe', method: 'rapp_work_subscribe', params: { root: a.root } });
  await subscriber.wait(message => message.id === 'subscribe');
  await subscriber.wait(message => message.event?.type === 'snapshot');
  provider.send({ id: 'context', method: 'rapp_work_context', params: { root: a.root } });
  const context = (await provider.wait(message => message.id === 'context')).result;
  assert.equal(context.schema, 'rapp-work.proposal-context/1');
  assert.equal(context.root, a.root);
  assert.equal(context.scope, 'root');
  assert.equal(context.authority.confirmation, 'owner-only');
  const draft = {
    summary: 'Create a durable provider-neutral handoff artifact.',
    tradeoffs: ['The external client may propose inert canonical data, while only the owner may apply it.'],
    questions: [],
    actions: [{
      type: 'artifact.save',
      id: 'provider-neutral-handoff',
      scope: 'root',
      name: 'Provider neutral handoff',
      content: 'Applied only after exact owner confirmation.',
      mediaType: 'text/plain',
    }],
    resolves: [],
  };
  provider.send({ id: 'propose', method: 'rapp_work_propose', params: {
    root: a.root,
    requestId: 'atlas-proposal',
    proposal: { contextRevision: context.revision, draft },
  } });
  const proposed = (await provider.wait(message => message.id === 'propose')).result;
  assert.equal(proposed.attribution.name, 'Atlas Local');
  assert.equal(proposed.attribution.provider, 'atlas-local');
  assert.equal(proposed.status, 'review');
  assert.equal(proposed.confirmationAuthority, 'owner-only');
  assert.equal(proposed.mutationApplied, false);
  const observedReview = await subscriber.wait(message =>
    message.event?.snapshot?.proposals?.some(proposal => proposal.wave === proposed.proposalWave));
  assert.equal(observedReview.event.snapshot.proposals.find(proposal => proposal.wave === proposed.proposalWave).status, 'review');
  assert(!observedReview.event.snapshot.artifacts.some(artifact => artifact.id === 'provider-neutral-handoff'));
  const beforeSelfConfirm = await inventory(h.directory);
  provider.send({ id: 'self-confirm', method: 'rapp_work_confirm', params: {
    root: a.root,
    proposalWave: proposed.proposalWave,
  } });
  assert.equal((await provider.wait(message => message.id === 'self-confirm')).error.code, 'method-unavailable');
  assert.deepEqual(await inventory(h.directory), beforeSelfConfirm);
  await assert.rejects(h.runtime.dispatch('organization.confirm', {
    root: a.root,
    proposalWave: '0'.repeat(64),
  }, 'wrong-owner-confirmation'), { code: 'proposal' });
  assert(!(await h.runtime.bots.project(a.root)).artifacts.some(artifact => artifact.id === 'provider-neutral-handoff'));
  await h.runtime.dispatch('organization.confirm', {
    root: a.root,
    proposalWave: proposed.proposalWave,
  }, 'exact-owner-confirmation');
  const observedApplied = await subscriber.wait(message =>
    message.event?.snapshot?.proposals?.some(proposal =>
      proposal.wave === proposed.proposalWave && proposal.status === 'applied'));
  assert(observedApplied.event.snapshot.artifacts.some(artifact => artifact.id === 'provider-neutral-handoff'));
  await Promise.all([provider.close(), subscriber.close()]);
  const restarted = await h.restart();
  const rebuilt = await restarted.ai.read(a.root, client.capability);
  assert.equal(rebuilt.proposals.find(proposal => proposal.wave === proposed.proposalWave).status, 'applied');
  assert(rebuilt.artifacts.some(artifact => artifact.id === 'provider-neutral-handoff'));
  assert.equal(h.transport.requests.length, 0);
});

test('uncredentialed or wrong-root startup refuses rather than loading arbitrary profiles or authority from a skill', async () => {
  const h = await harness({ clock: () => new Date().toISOString() });
  const a = await h.create(), b = await h.create(1);
  const client = await issue(h, a.root, 'Copilot');
  const before = await inventory(h.directory);
  const env = { ...process.env };
  delete env.RAPP_WORK_CAPABILITY;
  const missing = spawnSync(process.execPath, [cli, '--store', h.directory, '--root', a.root, '--fixture'], { env, input: '', encoding: 'utf8' });
  assert.equal(missing.status, 1);
  const wrong = spawnSync(process.execPath, [cli, '--store', h.directory, '--root', b.root, '--fixture'], {
    env: { ...env, RAPP_WORK_CAPABILITY: client.capability }, input: '', encoding: 'utf8',
  });
  assert.equal(wrong.status, 1);
  assert(!wrong.stderr.includes(client.capability));
  assert.deepEqual(await inventory(h.directory), before);
});
