import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureSigners } from '../dist/fixtures.js';
import { request } from '../dist/cli.js';
import { HeadlessRuntime } from '../dist/runtime.js';
import { base, harness, inventory } from './harness.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
test('the machine-readable passive projection contract matches the complete headless view', async () => {
  const h = await harness();
  const a = await h.create();
  await h.runtime.conversation.converse(a.root, 'A Builder thought', 'schema-thought');
  const projection = await h.runtime.dispatch('projection.get', { root: a.root });
  const schema = JSON.parse(await readFile(new URL('../contracts/projection.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.readOnly, true);
  assert.equal(schema.$id, projection.schema);
  assert.deepEqual(Object.keys(projection).sort(), schema.required.slice().sort());
  assert.equal(projection.authority.factualTruth, false);
  assert.equal(projection.authority.externalAdoption, false);
  for (const turn of projection.turns) {
    assert.deepEqual(Object.keys(turn).sort(), schema.$defs.turn.required.slice().sort());
    assert.deepEqual(Object.keys(turn.source).sort(), schema.$defs.reference.required.slice().sort());
  }
});

test('the executable CLI creates, converses, confirms, inspects and reconstructs a canonical bot across processes', async () => {
  const directory = path.join(base, `cli-${process.pid}-${Date.now()}`);
  const root = fixtureSigners().signers[0].root;
  const invoke = (method, params, id) => {
    const out = spawnSync(process.execPath, [cli, '--store', directory, '--fixture', '--id', id, method, JSON.stringify(params)], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stderr, /Synthetic fixture/);
    const result = JSON.parse(out.stdout);
    assert.equal(result.interface, 'rapp-work.stdio/1');
    return result.result;
  };
  assert.equal(invoke('bots.create', { name: 'CLI Builder', keyedRoot: root }, 'cli-create').root, root);
  const response = invoke('conversation.say', { root, text: 'Build a Copilot workspace' }, 'cli-thought');
  assert.equal(response.status, 'review');
  const confirmed = invoke('organization.confirm', { root, proposalWave: response.proposalWave }, 'cli-confirm');
  assert.equal(confirmed.artifacts.length, 1);
  assert.match(invoke('conversation.where', { root }, 'cli-where').text, /CLI Builder/);
  assert.equal(invoke('projection.get', { root }, 'cli-projection').schema, 'rapp-work.projection/1');
  assert.equal(invoke('bots.hide', { root }, 'cli-hide').hidden, true);
  assert.equal(invoke('bots.list', {}, 'cli-list').length, 0);
  assert.equal(invoke('bots.restore', { root }, 'cli-restore').root, root);
});

test('actual stdio accepts multiple framed requests, keeps protocol stdout clean, and refuses unsupported effects', async () => {
  const directory = path.join(base, `stdio-${process.pid}-${Date.now()}`);
  const input = [
    { id: 'create-stdio', method: 'bots.create', params: { name: 'Stdio Bot' } },
    { id: 'list-stdio', method: 'bots.list', params: {} },
    { id: 'delete-stdio', method: 'bots.delete', params: {} },
  ].map(r => JSON.stringify(r)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [cli, '--store', directory, 'stdio'], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[1].result.length, 1);
  assert.equal(lines[2].error.code, 'method-unavailable');
  assert(!result.stderr.includes('Synthetic fixture'));
});

test('stdio validation rejects unknown parameters, duplicate JSON keys, oversized input and deleted APIs before mutation', async () => {
  const h = await harness();
  const a = await h.create();
  const before = await inventory(h.directory);
  for (const method of ['bots.delete', 'worlds.delete', 'host.shell', 'native.write', 'providers.switch']) {
    const result = await request(h.runtime, JSON.stringify({ id: 'forbidden', method, params: { root: a.root } }));
    assert.equal(result.error.code, 'method-unavailable');
  }
  const extra = await request(h.runtime, JSON.stringify({ id: 'unknown-param', method: 'bots.hide', params: { root: a.root, delete: true } }));
  assert.equal(extra.error.code, 'contract');
  assert((await request(h.runtime, '{"id":"one","id":"two","method":"bots.list","params":{}}')).error);
  assert.equal((await request(h.runtime, 'x'.repeat(65_537))).error.code, 'request-size');
  await h.runtime.bots.select(a.root);
  assert.equal((await request(h.runtime, JSON.stringify({ id: 'wrong-root-type', method: 'bots.hide', params: { root: 3 } }))).error.code, 'contract');
  assert.equal((await request(h.runtime, JSON.stringify({ id: 'wrong-scope-type', method: 'conversation.say', params: { root: a.root, scope: false, text: 'Never widen scope' } }))).error.code, 'contract');
  assert.deepEqual(await inventory(h.directory), before);
});

test('production defaults fail closed without inference while canonical lifecycle remains usable', async () => {
  const directory = path.join(base, `production-offline-${process.pid}-${Date.now()}`);
  const runtime = await HeadlessRuntime.open({ directory });
  const info = await runtime.dispatch('runtime.info', {});
  assert.equal(info.fixture, false);
  assert.equal(info.externalBrainstemBound, false);
  assert.equal(info.iMessageEnabled, false);
  const a = await runtime.bots.create({ name: 'Offline real root', operationId: 'offline-create' });
  const result = await runtime.conversation.converse(a.root, 'A thought while the provider is unbound', 'offline-thought');
  assert.equal(result.status, 'unavailable');
  assert.match((await runtime.bots.whereWereWe(a.root)).text, /no fallback|No fallback/);
  assert.equal((await runtime.bots.repository.snapshot()).frameCount, 3);
});

test('separate CLI processes serialize and deduplicate the same canonical operation', async () => {
  const directory = path.join(base, `multiprocess-${process.pid}-${Date.now()}`);
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = fixtureSigners().signers[0].root;
  const create = spawnSync(process.execPath, [cli, '--store', directory, '--fixture', '--id', 'process-create',
    'bots.create', JSON.stringify({ name: 'Concurrent', keyedRoot: root })], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stdout + create.stderr);
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--store', directory, '--fixture', '--id', 'process-hide',
      'bots.hide', JSON.stringify({ root })]);
    let output = '', error = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { error += b; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(output + error)));
  })));
  assert.equal(results.length, 4);
  const keys = fixtureSigners();
  const reopened = await HeadlessRuntime.open({ directory, signatures: keys.signatures, signers: keys.signers });
  assert.equal((await reopened.bots.repository.root(root)).streams.memory.length, 1);
});
