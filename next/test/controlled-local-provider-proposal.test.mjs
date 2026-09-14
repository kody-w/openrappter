import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  controlledLocalChannelEvidence,
  controlledLocalEnvironment,
  controlledLocalProposalConfig,
  controlledLocalProviderDraft,
} from '../dist/controlled-local-acceptance.js';
import { fixtureSigners } from '../dist/fixtures.js';

const next = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(next, 'scripts/controlled-local-provider-proposal.mjs');
const root = fixtureSigners().signers[0].root;
const command = environment => ({ command: '/usr/bin/false', args: [], cwd: '/tmp', environment });
const rawConfig = {
  schema: 'rapp-work.controlled-local-provider-proposal/1',
  mode: 'controlled-local',
  fixture: false,
  allowLiveSend: false,
  canonicalStore: '/tmp/rapp-work-controlled-local-store',
  evidenceDirectory: '/tmp/rapp-work-controlled-local-evidence',
  root,
  scope: 'root',
  requestId: 'real-provider-proposal',
  request: 'Create one reviewed local artifact.',
  endpoint: command([]),
  provider: {
    name: 'Unlisted Local Provider',
    provider: 'unlisted-local-provider',
    capabilityEnv: 'REAL_PROVIDER_CAPABILITY',
    credentialEnv: ['REAL_PROVIDER_TOKEN'],
    adapter: command([]),
  },
  subscriber: { capabilityEnv: 'PASSIVE_SUBSCRIBER_CAPABILITY' },
  privateChannel: { bindingWave: '1'.repeat(64), probe: command([]) },
};

test('controlled-local config is provider-neutral, explicit and permanently non-sending', () => {
  const config = controlledLocalProposalConfig(rawConfig);
  assert.equal(config.provider.provider, 'unlisted-local-provider');
  assert.equal(config.fixture, false);
  assert.equal(config.allowLiveSend, false);
  assert.throws(() => controlledLocalProposalConfig({ ...rawConfig, allowLiveSend: true }), { code: 'controlled-local-config' });
  assert.throws(() => controlledLocalProposalConfig({
    ...rawConfig,
    endpoint: { ...rawConfig.endpoint, args: ['--fixture'] },
  }), { code: 'controlled-local-config' });
  assert.throws(() => controlledLocalProposalConfig({ ...rawConfig, evidenceDirectory: `${rawConfig.canonicalStore}/evidence` }),
    { code: 'controlled-local-config' });
});

test('controlled-local environment refuses missing opt-in, credentials and distinct subscriber authority', () => {
  const config = controlledLocalProposalConfig(rawConfig);
  const providerCapability = 'a'.repeat(43), subscriberCapability = 'b'.repeat(43);
  assert.throws(() => controlledLocalEnvironment(config, {}), { code: 'controlled-local-opt-in' });
  assert.throws(() => controlledLocalEnvironment(config, {
    RAPP_WORK_CONTROLLED_LOCAL: '1',
    REAL_PROVIDER_CAPABILITY: providerCapability,
    PASSIVE_SUBSCRIBER_CAPABILITY: subscriberCapability,
  }), { code: 'provider-credential-missing' });
  assert.throws(() => controlledLocalEnvironment(config, {
    RAPP_WORK_CONTROLLED_LOCAL: '1',
    REAL_PROVIDER_CAPABILITY: providerCapability,
    PASSIVE_SUBSCRIBER_CAPABILITY: providerCapability,
    REAL_PROVIDER_TOKEN: 'present',
  }), { code: 'subscriber-capability-missing' });
  assert.deepEqual(controlledLocalEnvironment(config, {
    RAPP_WORK_CONTROLLED_LOCAL: '1',
    REAL_PROVIDER_CAPABILITY: providerCapability,
    PASSIVE_SUBSCRIBER_CAPABILITY: subscriberCapability,
    REAL_PROVIDER_TOKEN: 'present',
  }), { providerCapability, subscriberCapability });
});

test('provider and private-channel evidence fail honestly without real bindings or when a send occurred', () => {
  const draft = {
    summary: 'Create one reviewed artifact.',
    tradeoffs: ['Owner confirmation remains separate.'],
    tradeoffLinks: [{ actionId: 'real-note', tradeoff: 0 }],
    questions: [],
    actions: [{ type: 'artifact.save', id: 'real-note', scope: 'root', name: 'Real note', content: 'review', mediaType: 'text/plain' }],
    resolves: [],
  };
  assert.equal(controlledLocalProviderDraft({
    schema: 'rapp-work.controlled-local-provider-draft/1',
    fixture: false,
    provider: 'unlisted-local-provider',
    model: 'operator-selected-model',
    credentialBinding: 'environment',
    liveEffectsPerformed: false,
    draft,
  }, 'unlisted-local-provider').draft.summary, draft.summary);
  const base = {
    schema: 'rapp-work.controlled-local-private-channel-evidence/1',
    fixture: false,
    root,
    bindingWave: '1'.repeat(64),
    channel: 'imessage',
    tcc: 'authorized',
    contact: 'bound',
    passiveOnly: true,
    liveSendPerformed: false,
    observedUtc: '2026-09-14T03:00:00.000Z',
    evidenceRef: 'local-non-sending-probe',
  };
  assert.throws(() => controlledLocalChannelEvidence({ ...base, tcc: 'missing' }, root, base.bindingWave),
    { code: 'tcc-binding-missing' });
  assert.throws(() => controlledLocalChannelEvidence({ ...base, contact: 'missing' }, root, base.bindingWave),
    { code: 'contact-binding-missing' });
  assert.throws(() => controlledLocalChannelEvidence({ ...base, liveSendPerformed: true }, root, base.bindingWave),
    { code: 'live-send-forbidden' });
  assert.equal(controlledLocalChannelEvidence(base, root, base.bindingWave).liveSendPerformed, false);
});

test('the opt-in harness stops before launching adapters when a provider credential is absent', async () => {
  const directory = path.join(next, '.test-scratch', `controlled-local-contract-${process.pid}-${Date.now()}`);
  const store = path.join(directory, 'store');
  const evidence = path.join(directory, 'evidence');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...rawConfig, canonicalStore: store, evidenceDirectory: evidence }));
  const result = spawnSync(process.execPath, [script, '--config', configPath], {
    cwd: next,
    env: {
      RAPP_WORK_CONTROLLED_LOCAL: '1',
      REAL_PROVIDER_CAPABILITY: 'a'.repeat(43),
      PASSIVE_SUBSCRIBER_CAPABILITY: 'b'.repeat(43),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr.trim()).code, 'provider-credential-missing');
  await assert.rejects(access(evidence), { code: 'ENOENT' });
});

test('the opt-in harness writes no evidence when the real TCC or contact probe is missing', async () => {
  for (const [field, value, code] of [
    ['tcc', 'missing', 'tcc-binding-missing'],
    ['contact', 'missing', 'contact-binding-missing'],
  ]) {
    const directory = path.join(next, '.test-scratch', `controlled-local-channel-${field}-${process.pid}-${Date.now()}`);
    const store = path.join(directory, 'store');
    const evidence = path.join(directory, 'evidence');
    await mkdir(store, { recursive: true, mode: 0o700 });
    const probe = path.join(directory, 'probe.mjs');
    const channel = {
      schema: 'rapp-work.controlled-local-private-channel-evidence/1',
      fixture: false,
      root,
      bindingWave: '1'.repeat(64),
      channel: 'imessage',
      tcc: 'authorized',
      contact: 'bound',
      passiveOnly: true,
      liveSendPerformed: false,
      observedUtc: '2026-09-14T03:00:00.000Z',
      evidenceRef: 'local-non-sending-probe',
      [field]: value,
    };
    await writeFile(probe, `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(channel))}));\n`);
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      ...rawConfig,
      canonicalStore: store,
      evidenceDirectory: evidence,
      privateChannel: {
        ...rawConfig.privateChannel,
        probe: { command: process.execPath, args: [probe], cwd: directory, environment: [] },
      },
    }));
    const result = spawnSync(process.execPath, [script, '--config', configPath], {
      cwd: next,
      env: {
        RAPP_WORK_CONTROLLED_LOCAL: '1',
        REAL_PROVIDER_CAPABILITY: 'a'.repeat(43),
        PASSIVE_SUBSCRIBER_CAPABILITY: 'b'.repeat(43),
        REAL_PROVIDER_TOKEN: 'present',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr.trim()).code, code);
    await assert.rejects(access(evidence), { code: 'ENOENT' });
  }
});
