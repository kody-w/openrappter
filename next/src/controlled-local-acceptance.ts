import path from 'node:path';
import { isBodyStream, isUtc, type JsonObject } from './canonical.js';
import { label, list, object, text } from './contract.js';
import { requireThat } from './errors.js';
import { requireActionTradeoffs, validateDraft, wave, type Draft } from './intent.js';

export const CONTROLLED_LOCAL_PROPOSAL_SCHEMA = 'rapp-work.controlled-local-provider-proposal/1';
export const CONTROLLED_LOCAL_PROVIDER_DRAFT_SCHEMA = 'rapp-work.controlled-local-provider-draft/1';
export const CONTROLLED_LOCAL_CHANNEL_EVIDENCE_SCHEMA = 'rapp-work.controlled-local-private-channel-evidence/1';

export interface ControlledLocalCommand extends JsonObject {
  command: string;
  args: string[];
  cwd: string;
  environment: string[];
}
export interface ControlledLocalProposalConfig extends JsonObject {
  schema: typeof CONTROLLED_LOCAL_PROPOSAL_SCHEMA;
  mode: 'controlled-local';
  fixture: false;
  allowLiveSend: false;
  canonicalStore: string;
  evidenceDirectory: string;
  root: string;
  scope: string;
  requestId: string;
  request: string;
  endpoint: ControlledLocalCommand;
  provider: JsonObject & {
    name: string;
    provider: string;
    capabilityEnv: string;
    credentialEnv: string[];
    adapter: ControlledLocalCommand;
  };
  subscriber: JsonObject & { capabilityEnv: string };
  privateChannel: JsonObject & {
    bindingWave: string;
    probe: ControlledLocalCommand;
  };
}

function environmentName(value: unknown): string {
  const name = text(value, 100);
  requireThat(/^[A-Z][A-Z0-9_]*$/u.test(name), 'controlled-local-config',
    'Environment bindings must be explicit uppercase variable names, never credential values.');
  return name;
}

function absolutePath(value: unknown, field: string): string {
  const selected = text(value, 1_000);
  requireThat(path.isAbsolute(selected), 'controlled-local-config', `${field} must be an absolute local path.`);
  return path.normalize(selected);
}

function command(value: unknown, field: string): ControlledLocalCommand {
  const selected = object(value, ['command', 'args', 'cwd', 'environment']);
  const executable = absolutePath(selected.command, `${field}.command`);
  const args = list(selected.args, 32).map(argument => text(argument, 1_000));
  const cwd = absolutePath(selected.cwd, `${field}.cwd`);
  const environment = list(selected.environment, 32).map(environmentName);
  requireThat(new Set(environment).size === environment.length, 'controlled-local-config',
    `${field}.environment must not repeat bindings.`);
  return { command: executable, args, cwd, environment };
}

export function controlledLocalProposalConfig(value: unknown): ControlledLocalProposalConfig {
  const selected = object(value, [
    'schema', 'mode', 'fixture', 'allowLiveSend', 'canonicalStore', 'evidenceDirectory',
    'root', 'scope', 'requestId', 'request', 'endpoint', 'provider', 'subscriber', 'privateChannel',
  ]);
  requireThat(selected.schema === CONTROLLED_LOCAL_PROPOSAL_SCHEMA && selected.mode === 'controlled-local'
    && selected.fixture === false && selected.allowLiveSend === false,
  'controlled-local-config', 'Controlled-local proposal acceptance must be explicit, non-fixture and non-sending.');
  requireThat(isBodyStream(selected.root), 'controlled-local-config', 'Use the exact existing canonical root RAPPID.');
  const canonicalStore = absolutePath(selected.canonicalStore, 'canonicalStore');
  const evidenceDirectory = absolutePath(selected.evidenceDirectory, 'evidenceDirectory');
  const relative = path.relative(canonicalStore, evidenceDirectory);
  requireThat(relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative)),
    'controlled-local-config', 'Acceptance evidence must be outside the canonical store.');
  const provider = object(selected.provider, ['name', 'provider', 'capabilityEnv', 'credentialEnv', 'adapter']);
  const credentialEnv = list(provider.credentialEnv, 16).map(environmentName);
  requireThat(credentialEnv.length > 0 && new Set(credentialEnv).size === credentialEnv.length,
    'controlled-local-config', 'A real provider adapter must declare at least one distinct credential environment binding.');
  const subscriber = object(selected.subscriber, ['capabilityEnv']);
  const privateChannel = object(selected.privateChannel, ['bindingWave', 'probe']);
  const endpoint = command(selected.endpoint, 'endpoint');
  requireThat(!endpoint.args.includes('--fixture'), 'controlled-local-config',
    'A controlled-local real-binding endpoint cannot use the fixture bootstrap.');
  return {
    schema: CONTROLLED_LOCAL_PROPOSAL_SCHEMA,
    mode: 'controlled-local',
    fixture: false,
    allowLiveSend: false,
    canonicalStore,
    evidenceDirectory,
    root: String(selected.root),
    scope: label(selected.scope),
    requestId: label(selected.requestId),
    request: text(selected.request, 4_000),
    endpoint,
    provider: {
      name: text(provider.name, 80),
      provider: label(provider.provider),
      capabilityEnv: environmentName(provider.capabilityEnv),
      credentialEnv,
      adapter: command(provider.adapter, 'provider.adapter'),
    },
    subscriber: { capabilityEnv: environmentName(subscriber.capabilityEnv) },
    privateChannel: {
      bindingWave: wave(privateChannel.bindingWave),
      probe: command(privateChannel.probe, 'privateChannel.probe'),
    },
  };
}

export interface ControlledLocalEnvironment {
  providerCapability: string;
  subscriberCapability: string;
}

function requiredValue(environment: NodeJS.ProcessEnv, name: string, code: string, message: string): string {
  const value = environment[name];
  requireThat(typeof value === 'string' && value.length > 0, code, message);
  return value;
}

export function controlledLocalEnvironment(config: ControlledLocalProposalConfig,
  environment: NodeJS.ProcessEnv): ControlledLocalEnvironment {
  requireThat(environment.RAPP_WORK_CONTROLLED_LOCAL === '1', 'controlled-local-opt-in',
    'Set RAPP_WORK_CONTROLLED_LOCAL=1 only for an explicitly approved isolated local acceptance run.');
  const providerCapability = requiredValue(environment, config.provider.capabilityEnv, 'provider-capability-missing',
    `The provider capability environment binding ${config.provider.capabilityEnv} is absent.`);
  const subscriberCapability = requiredValue(environment, config.subscriber.capabilityEnv, 'subscriber-capability-missing',
    `The passive subscriber capability environment binding ${config.subscriber.capabilityEnv} is absent.`);
  requireThat(/^[A-Za-z0-9_-]{43}$/u.test(providerCapability), 'provider-capability-missing',
    'The provider capability binding is not a valid independently issued capability.');
  requireThat(/^[A-Za-z0-9_-]{43}$/u.test(subscriberCapability), 'subscriber-capability-missing',
    'The passive subscriber capability binding is not a valid independently issued capability.');
  requireThat(providerCapability !== subscriberCapability, 'subscriber-capability-missing',
    'The passive subscriber must use a distinct read/subscribe capability.');
  for (const name of config.endpoint.environment) requiredValue(environment, name, 'endpoint-binding-missing',
    `The trusted endpoint environment binding ${name} is absent.`);
  for (const name of config.provider.credentialEnv) requiredValue(environment, name, 'provider-credential-missing',
    `The real provider credential environment binding ${name} is absent.`);
  for (const name of config.provider.adapter.environment) requiredValue(environment, name, 'provider-binding-missing',
    `The provider adapter environment binding ${name} is absent.`);
  for (const name of config.privateChannel.probe.environment) requiredValue(environment, name, 'channel-probe-binding-missing',
    `The private-channel probe environment binding ${name} is absent.`);
  return { providerCapability, subscriberCapability };
}

export interface ControlledLocalProviderDraft extends JsonObject {
  schema: typeof CONTROLLED_LOCAL_PROVIDER_DRAFT_SCHEMA;
  fixture: false;
  provider: string;
  model: string;
  credentialBinding: 'environment';
  liveEffectsPerformed: false;
  draft: Draft;
}

export function controlledLocalProviderDraft(value: unknown, provider: string): ControlledLocalProviderDraft {
  const selected = object(value, ['schema', 'fixture', 'provider', 'model', 'credentialBinding', 'liveEffectsPerformed', 'draft']);
  requireThat(selected.schema === CONTROLLED_LOCAL_PROVIDER_DRAFT_SCHEMA && selected.provider === provider
    && selected.fixture === false && selected.credentialBinding === 'environment' && selected.liveEffectsPerformed === false,
  'provider-binding-invalid', 'The provider adapter did not return exact non-effecting evidence for the configured provider label.');
  const draft = validateDraft(selected.draft);
  if (draft.actions.length) requireActionTradeoffs(draft);
  requireThat(draft.actions.length > 0 || draft.questions.length > 0, 'proposal-empty',
    'The real provider must return a reviewable structured Draft, not a no-op summary.');
  requireThat(draft.resolves.length === 0, 'proposal-authority',
    'A provider adapter cannot claim that it supplied or settled an owner answer.');
  return {
    schema: CONTROLLED_LOCAL_PROVIDER_DRAFT_SCHEMA,
    fixture: false,
    provider,
    model: text(selected.model, 160),
    credentialBinding: 'environment',
    liveEffectsPerformed: false,
    draft,
  };
}

export interface ControlledLocalChannelEvidence extends JsonObject {
  schema: typeof CONTROLLED_LOCAL_CHANNEL_EVIDENCE_SCHEMA;
  fixture: false;
  root: string;
  bindingWave: string;
  channel: 'imessage';
  tcc: 'authorized';
  contact: 'bound';
  passiveOnly: true;
  liveSendPerformed: false;
  observedUtc: string;
  evidenceRef: string;
}

export function controlledLocalChannelEvidence(value: unknown, root: string,
  bindingWave: string): ControlledLocalChannelEvidence {
  const selected = object(value, [
    'schema', 'fixture', 'root', 'bindingWave', 'channel', 'tcc', 'contact',
    'passiveOnly', 'liveSendPerformed', 'observedUtc', 'evidenceRef',
  ]);
  requireThat(selected.liveSendPerformed === false && selected.passiveOnly === true,
    'live-send-forbidden', 'Controlled-local proposal acceptance is inspect-only and refuses any live send evidence.');
  requireThat(selected.schema === CONTROLLED_LOCAL_CHANNEL_EVIDENCE_SCHEMA && selected.fixture === false && selected.root === root
    && selected.bindingWave === bindingWave && selected.channel === 'imessage',
  'channel-binding-missing', 'The private-channel probe is not bound to the exact configured root and canonical binding wave.');
  requireThat(selected.tcc === 'authorized', 'tcc-binding-missing',
    'The non-sending private-channel probe did not observe authorized local TCC access.');
  requireThat(selected.contact === 'bound', 'contact-binding-missing',
    'The non-sending private-channel probe did not observe the exact private contact binding.');
  requireThat(isUtc(selected.observedUtc), 'channel-binding-missing', 'Private-channel evidence needs an exact UTC observation time.');
  return {
    schema: CONTROLLED_LOCAL_CHANNEL_EVIDENCE_SCHEMA,
    fixture: false,
    root,
    bindingWave,
    channel: 'imessage',
    tcc: 'authorized',
    contact: 'bound',
    passiveOnly: true,
    liveSendPerformed: false,
    observedUtc: String(selected.observedUtc),
    evidenceRef: text(selected.evidenceRef, 500),
  };
}
