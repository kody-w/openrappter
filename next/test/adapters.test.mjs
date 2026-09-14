import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotSdkProvider, sdkTransport } from '../dist/copilot.js';
import { SharedBrainstem, targetCapability } from '../dist/spine.js';
import { FixtureBrainstem, fixtureSigners } from '../dist/fixtures.js';
import { harness, deferred, durableText, inventory } from './harness.mjs';

test('the real SDK transport boundary receives max/long Astra and deny-all tools, skills and ambient context', async () => {
  const h = await harness();
  const a = await h.create();
  await h.runtime.conversation.converse(a.root, 'Build a workspace', 'sdk-contract');
  const c = h.transport.configs[0];
  assert.equal(c.model, 'gpt-6-astra');
  assert.equal(c.reasoningEffort, 'max');
  assert.equal(c.contextTier, 'long_context');
  assert.equal(c.reasoningSummary, 'none');
  assert.deepEqual(c.availableTools, []);
  assert.deepEqual(c.excludedTools, ['*']);
  assert.deepEqual(c.tools, []);
  assert.deepEqual(c.mcpServers, {});
  assert.deepEqual(c.customAgents, []);
  assert.deepEqual(c.pluginDirectories, []);
  assert.deepEqual(c.infiniteSessions, { enabled: false });
  for (const property of ['enableConfigDiscovery', 'enableSkills', 'enableFileHooks', 'enableOnDemandInstructionDiscovery',
    'enableHostGitOperations', 'enableSessionStore', 'enableSessionTelemetry']) assert.equal(c[property], false);
  assert.equal(c.remoteSession, 'off');
  assert.equal(c.embeddingCacheStorage, 'in-memory');
  assert.equal(c.onEvent, undefined);
  assert.equal((await c.onPermissionRequest({ kind: 'shell', command: 'do-not-run' }, { sessionId: 'fixture' })).kind, 'denied-by-rules');
  assert.equal(c.provider, undefined);
  assert.equal(c.providers, undefined);
  assert.equal(h.transport.disconnects, 1);
  let selected;
  const transport = sdkTransport({ createSession: async options => { selected = options; return { marker: true }; } });
  assert.deepEqual(await transport.createSession(c), { marker: true });
  assert.equal(selected, c);
});

test('ambient SDK binding and non-public model events fail closed', async () => {
  assert.throws(() => new CopilotSdkProvider({}, { mode: 'copilot-cli', sessionStorage: 'disk', canonicalContextOnly: false }),
    { code: 'sdk-binding' });
  let disconnected = 0;
  const provider = new CopilotSdkProvider({
    createSession: async () => ({
      sendAndWait: async () => ({ type: 'assistant.reasoning', data: { content: 'HIDDEN-REASONING' } }),
      abort: async () => {}, disconnect: async () => { disconnected++; },
    }),
  }, { mode: 'empty', sessionStorage: 'memory-only', canonicalContextOnly: true });
  const abort = new AbortController();
  await assert.rejects(provider.complete({ root: fixtureSigners().signers[0].root, scope: 'root', thought: 'Public task',
    context: {}, purpose: 'organization', signal: abort.signal }), { code: 'provider-unavailable' });
  assert.equal(disconnected, 1);
});

test('two roots hotload on one spine with separate context and observation lifetimes', async () => {
  const capability = await targetCapability();
  const binding = new FixtureBrainstem();
  const spine = new SharedBrainstem(binding, [capability]);
  const [a, b] = fixtureSigners().signers.map(s => s.root);
  const oa = spine.observe(a), ob = spine.observe(b);
  const ready = deferred();
  const finishB = deferred();
  let starts = 0;
  const provider = { complete: request => {
    assert.equal(request.context.root, request.root);
    if (++starts === 2) ready.resolve();
    return request.root === a
      ? new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      : finishB.promise;
  } };
  const pa = spine.compute(oa, capability.reference, { root: a, scope: 'root', thought: 'A', context: { root: a }, purpose: 'organization' }, provider);
  const rejectedA = assert.rejects(pa);
  const pb = spine.compute(ob, capability.reference, { root: b, scope: 'root', thought: 'B', context: { root: b }, purpose: 'organization' }, provider);
  await ready.promise;
  await spine.unobserve(oa);
  await rejectedA;
  assert.equal(spine.status(b).mode, 'observed');
  finishB.resolve({ summary: 'B public output' });
  assert.equal((await pb).summary, 'B public output');
  await spine.unobserve(ob);
  assert.deepEqual(new Set(binding.hotloads), new Set([a, b]));
  assert.equal(spine.status(a).mode, 'dormant');
  assert.equal(spine.status(b).mode, 'dormant');
});

test('non-cooperative transport cannot hang the core or permit a replacement while cancellation is pending', async () => {
  const capability = await targetCapability();
  const spine = new SharedBrainstem(new FixtureBrainstem(), [capability]);
  const root = fixtureSigners().signers[0].root;
  const pending = deferred();
  const observed = spine.observe(root, 25);
  await assert.rejects(spine.compute(observed, capability.reference, { root, scope: 'root', thought: 'Bounded',
    context: {}, purpose: 'organization' }, { complete: () => pending.promise }), { code: 'observation-ended' });
  await spine.unobserve(observed);
  assert.equal(spine.status(root).mode, 'quiescing');
  const retry = spine.observe(root);
  await assert.rejects(spine.compute(retry, capability.reference, { root, scope: 'root', thought: 'No replacement',
    context: {}, purpose: 'organization' }, { complete: async () => ({}) }), { code: 'spine-busy' });
  pending.resolve({ summary: 'Late output is discarded' });
  await new Promise(resolve => setImmediate(resolve));
  await spine.unobserve(retry);
  assert.equal(spine.status(root).mode, 'dormant');
});

test('provider unavailability records a public bounded outcome without retry or private diagnostics', async () => {
  const h = await harness();
  const a = await h.create();
  h.transport.unavailable = true;
  const result = await h.runtime.conversation.converse(a.root, 'A task while provider is offline', 'provider-offline');
  assert.equal(result.status, 'unavailable');
  assert.equal(h.transport.requests.length, 1);
  const before = await inventory(h.directory);
  h.transport.unavailable = false;
  const runtime = await h.restart();
  await runtime.conversation.converse(a.root, 'A task while provider is offline', 'provider-offline');
  assert.equal(h.transport.requests.length, 1);
  assert.deepEqual(await inventory(h.directory), before);
  assert(!(await durableText(h.directory)).includes('fixture provider unavailable'));
});

test('all GODD/DOGG scope transfer variants refuse without changing rooted bytes or history', async () => {
  const h = await harness();
  const a = await h.create();
  const bytes = await inventory(h.directory);
  const resting = await h.runtime.egg.atRest(a.root);
  assert.equal(resting.root, a.root);
  assert.equal(resting.transformation, false);
  for (const operation of ['inspect', 'export', 'restore']) for (const scope of ['godd', 'dogg', 'both']) {
    await assert.rejects(h.runtime.egg.transfer(a.root, operation, scope), { code: 'canonical-domain-binding-unavailable' });
  }
  assert.deepEqual(await inventory(h.directory), bytes);
  assert.deepEqual(await (await h.restart()).egg.atRest(a.root), resting);
});
