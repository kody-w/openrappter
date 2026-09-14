#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { canonicalJson, parseJson } from '../dist/canonical.js';
import { object } from '../dist/contract.js';
import { publicError, Refusal, requireThat } from '../dist/errors.js';
import {
  CONTROLLED_LOCAL_PROPOSAL_SCHEMA,
  controlledLocalChannelEvidence,
  controlledLocalEnvironment,
  controlledLocalProposalConfig,
  controlledLocalProviderDraft,
} from '../dist/controlled-local-acceptance.js';

const TIMEOUT_MS = 30_000;
const OUTPUT_BYTES = 1_048_576;

function selectedEnvironment(names, extra = {}) {
  const environment = {};
  for (const name of names) environment[name] = process.env[name];
  return { ...environment, ...extra };
}

function runJsonCommand(spec, environmentNames, input, code) {
  const result = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    env: selectedEnvironment(environmentNames),
    input: canonicalJson(input) + '\n',
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: OUTPUT_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  requireThat(!result.error && result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0,
    code, 'The configured local adapter did not return one bounded JSON result; no acceptance evidence was written.');
  return parseJson(result.stdout.trim());
}

function launchEndpoint(config, capability) {
  const child = spawn(config.endpoint.command, config.endpoint.args, {
    cwd: config.endpoint.cwd,
    env: selectedEnvironment(config.endpoint.environment, { RAPP_WORK_CAPABILITY: capability }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = new Set();
  let stdout = '', stderrBytes = 0, exited = false, failure = null;
  const fail = error => {
    if (failure) return;
    failure = error instanceof Refusal ? error
      : new Refusal('endpoint-unavailable', 'The trusted endpoint returned invalid or unavailable output.');
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiters.clear();
    if (!exited) child.kill('SIGTERM');
  };
  child.on('error', fail);
  const exit = new Promise(resolve => child.on('exit', (code, signal) => {
    exited = true;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure ?? new Refusal('endpoint-unavailable', 'The trusted endpoint exited before returning the requested result.'));
    }
    waiters.clear();
    resolve({ code, signal });
  }));
  child.stderr.on('data', bytes => {
    stderrBytes += bytes.length;
    if (stderrBytes > OUTPUT_BYTES) fail(new Refusal('endpoint-output-bound',
      'The trusted endpoint exceeded the bounded diagnostic output.'));
  });
  child.stdout.on('data', bytes => {
    try {
      stdout += bytes.toString();
      requireThat(Buffer.byteLength(stdout) <= OUTPUT_BYTES, 'endpoint-output-bound',
        'The trusted endpoint exceeded the bounded acceptance output.');
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        const message = parseJson(line);
        messages.push(message);
        for (const waiter of [...waiters]) if (waiter.match(message)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    } catch (error) { fail(error); }
  });
  let id = 0;
  const wait = match => {
    if (failure) return Promise.reject(failure);
    const existing = messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Refusal('endpoint-timeout', 'The trusted endpoint did not return a bounded response in time.'));
        }, TIMEOUT_MS),
      };
      waiters.add(waiter);
    });
  };
  const request = async (method, params) => {
    if (failure) throw failure;
    requireThat(!exited, 'endpoint-unavailable', 'The trusted endpoint is not running.');
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    const response = await wait(message => object(message).id === requestId);
    const selected = object(response);
    requireThat(selected.error === undefined, 'endpoint-error',
      'The trusted endpoint refused the controlled-local request; inspect its local operator logs.');
    return selected.result;
  };
  const tool = async (name, args, allowError = false) => {
    const result = object(await request('tools/call', { name, arguments: args }));
    if (!allowError) requireThat(result.isError === false, 'endpoint-tool-refused',
      'The trusted endpoint refused a required controlled-local tool call.');
    return result;
  };
  return {
    async initialize() {
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'rapp-work-controlled-local-acceptance', version: '1' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    tool,
    request,
    async close() {
      if (!exited) child.stdin.end();
      const result = await exit;
      requireThat(!failure && result.code === 0, 'endpoint-unavailable',
        'The trusted endpoint did not close cleanly; no successful acceptance result is claimed.');
    },
    stop() {
      if (!exited) child.kill('SIGTERM');
    },
  };
}

function structured(result) {
  const value = object(result);
  requireThat(value.isError === false && value.structuredContent !== undefined,
    'endpoint-tool-refused', 'The trusted endpoint did not return structured content.');
  return object(value.structuredContent);
}

function toolRefusal(result) {
  const value = object(result);
  requireThat(value.isError === true && Array.isArray(value.content) && value.content.length > 0,
    'owner-boundary-failed', 'The restricted provider endpoint unexpectedly accepted an owner-only operation.');
  const content = object(value.content[0]);
  return object(parseJson(content.text));
}

async function subscriberSnapshot(endpoint, uri, proposalWave) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = object(await endpoint.request('resources/read', { uri }));
    const contents = result.contents;
    requireThat(Array.isArray(contents) && contents.length === 1, 'subscriber-evidence-missing',
      'The passive subscriber did not return one bounded projection resource.');
    const payload = object(parseJson(object(contents[0]).text));
    const events = payload.events;
    requireThat(Array.isArray(events), 'subscriber-evidence-missing', 'The passive resource did not contain projection events.');
    for (const event of events) {
      const selected = object(event);
      if (selected.snapshot === null) continue;
      const snapshot = object(selected.snapshot);
      const proposals = snapshot.proposals;
      if (Array.isArray(proposals) && proposals.some(proposal => object(proposal).wave === proposalWave)) return snapshot;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Refusal('subscriber-evidence-missing', 'The passive subscriber did not observe the exact proposal wave.');
}

async function writeEvidence(directory, prefix, requestId, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${prefix}-${requestId}-${Date.now()}.json`);
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return filename;
}

async function runInitial(config, bindings, channel) {
  const providerEndpoint = launchEndpoint(config, bindings.providerCapability);
  const subscriberEndpoint = launchEndpoint(config, bindings.subscriberCapability);
  try {
    await Promise.all([providerEndpoint.initialize(), subscriberEndpoint.initialize()]);
    const subscribed = structured(await subscriberEndpoint.tool('rapp_work_subscribe', { root: config.root }));
    await subscriberEndpoint.request('resources/subscribe', { uri: subscribed.uri });
    await subscriberEndpoint.request('resources/read', { uri: subscribed.uri });
    const context = structured(await providerEndpoint.tool('rapp_work_context', {
      root: config.root,
      scope: config.scope,
    }));
    requireThat(context.schema === 'rapp-work.proposal-context/1' && context.root === config.root
      && context.scope === config.scope, 'proposal-context-invalid',
    'The trusted endpoint did not return the configured canonical proposal context.');
    const providerOutput = runJsonCommand(config.provider.adapter,
      [...new Set([...config.provider.credentialEnv, ...config.provider.adapter.environment])], {
        schema: 'rapp-work.controlled-local-provider-request/1',
        mode: 'proposal-only',
        root: config.root,
        scope: config.scope,
        request: config.request,
        context,
        allowLiveEffects: false,
      }, 'provider-binding-unavailable');
    const generated = controlledLocalProviderDraft(providerOutput, config.provider.provider);
    const proposed = structured(await providerEndpoint.tool('rapp_work_propose', {
      root: config.root,
      requestId: config.requestId,
      proposal: { scope: config.scope, contextRevision: context.revision, draft: generated.draft },
    }));
    const attribution = object(proposed.attribution);
    requireThat(proposed.status === 'review' && proposed.confirmationAuthority === 'owner-only'
      && proposed.mutationApplied === false && attribution.name === config.provider.name
      && attribution.provider === config.provider.provider, 'owner-boundary-failed',
    'The client proposal did not retain the configured attribution in owner-only review state.');
    const denied = toolRefusal(await providerEndpoint.tool('rapp_work_confirm', {
      root: config.root,
      proposalWave: proposed.proposalWave,
    }, true));
    requireThat(denied.code === 'method-unavailable', 'owner-boundary-failed',
      'The restricted provider endpoint did not explicitly refuse self-confirmation.');
    const observed = await subscriberSnapshot(subscriberEndpoint, String(subscribed.uri), String(proposed.proposalWave));
    const proposal = observed.proposals.find(value => object(value).wave === proposed.proposalWave);
    const observedProposal = object(proposal);
    const observedActor = object(observedProposal.actor);
    requireThat(observedProposal.status === 'review' && observedActor.name === config.provider.name
      && observedActor.provider === config.provider.provider, 'owner-boundary-failed',
      'The passive subscriber did not observe the proposal awaiting owner confirmation.');
    const evidence = {
      schema: 'rapp-work.controlled-local-provider-proposal-evidence/1',
      status: 'awaiting-owner-confirmation',
      authoritative: false,
      mode: config.mode,
      fixture: config.fixture,
      root: config.root,
      scope: config.scope,
      provider: {
        name: config.provider.name,
        provider: config.provider.provider,
        model: generated.model,
        credentialEnvironmentPresent: true,
      },
      contextRevision: context.revision,
      proposalWave: proposed.proposalWave,
      draftHash: observedProposal.draftHash,
      draft: generated.draft,
      passiveSubscriber: {
        distinctCapability: true,
        observedProposal: true,
        cursor: observed.cursor,
      },
      selfConfirmation: { attempted: true, refused: true, code: denied.code },
      ownerConfirmation: {
        performedByHarness: false,
        observed: false,
        requiredProposalWave: proposed.proposalWave,
      },
      privateChannel: channel,
      liveSends: 0,
      next: 'The owner must confirm this exact proposal wave through the owner-only CLI, then rerun with --verify <pending-evidence>.',
      generatedUtc: new Date().toISOString(),
    };
    await Promise.all([providerEndpoint.close(), subscriberEndpoint.close()]);
    const filename = await writeEvidence(config.evidenceDirectory, 'pending', config.requestId, evidence);
    return { ...evidence, evidenceFile: filename };
  } finally {
    providerEndpoint.stop();
    subscriberEndpoint.stop();
  }
}

async function runVerify(config, bindings, channel, pendingPath) {
  const pending = object(parseJson(await readFile(pendingPath)), [
    'schema', 'status', 'authoritative', 'mode', 'fixture', 'root', 'scope', 'provider',
    'contextRevision', 'proposalWave', 'draftHash', 'draft', 'passiveSubscriber',
    'selfConfirmation', 'ownerConfirmation', 'privateChannel', 'liveSends', 'next', 'generatedUtc',
  ]);
  requireThat(pending.schema === 'rapp-work.controlled-local-provider-proposal-evidence/1'
    && pending.status === 'awaiting-owner-confirmation' && pending.root === config.root
    && pending.scope === config.scope && object(pending.provider).provider === config.provider.provider,
  'controlled-local-evidence-invalid', 'The pending evidence does not match this exact controlled-local configuration.');
  const subscriberEndpoint = launchEndpoint(config, bindings.subscriberCapability);
  try {
    await subscriberEndpoint.initialize();
    const subscribed = structured(await subscriberEndpoint.tool('rapp_work_subscribe', { root: config.root }));
    await subscriberEndpoint.request('resources/subscribe', { uri: subscribed.uri });
    const snapshot = await subscriberSnapshot(subscriberEndpoint, String(subscribed.uri), String(pending.proposalWave));
    const proposal = object(snapshot.proposals.find(value => object(value).wave === pending.proposalWave));
    const actor = object(proposal.actor);
    requireThat(proposal.status === 'applied' && proposal.draftHash === pending.draftHash
      && canonicalJson(proposal.draft) === canonicalJson(pending.draft)
      && actor.name === object(pending.provider).name && actor.provider === object(pending.provider).provider,
    'owner-confirmation-missing', 'The exact proposal is not canonically applied; no final acceptance evidence was written.');
    const result = {
      ...pending,
      status: 'passed',
      authoritative: false,
      controlledLocalObserved: true,
      passiveSubscriber: {
        ...object(pending.passiveSubscriber),
        restartReconstruction: true,
        appliedProposalObserved: true,
        cursor: snapshot.cursor,
      },
      ownerConfirmation: {
        performedByHarness: false,
        observed: true,
        exactProposalWave: pending.proposalWave,
      },
      privateChannel: channel,
      liveSends: 0,
      next: 'Submit this evidence for owner review; the harness did not perform a live send.',
      verifiedUtc: new Date().toISOString(),
    };
    await subscriberEndpoint.close();
    const filename = await writeEvidence(config.evidenceDirectory, 'result', config.requestId, result);
    return { ...result, evidenceFile: filename };
  } finally {
    subscriberEndpoint.stop();
  }
}

async function main(args) {
  let configPath, verifyPath;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--config') configPath = args.shift();
    else if (flag === '--verify') verifyPath = args.shift();
    else throw new Refusal('controlled-local-cli', 'Use --config <absolute-config.json> and optional --verify <pending-evidence.json>.');
  }
  requireThat(configPath && path.isAbsolute(configPath), 'controlled-local-cli',
    'An absolute controlled-local config path is required.');
  const config = controlledLocalProposalConfig(parseJson(await readFile(configPath)));
  requireThat(config.schema === CONTROLLED_LOCAL_PROPOSAL_SCHEMA, 'controlled-local-config',
    'The controlled-local configuration schema is unsupported.');
  await access(config.canonicalStore);
  const bindings = controlledLocalEnvironment(config, process.env);
  const channelOutput = runJsonCommand(config.privateChannel.probe, config.privateChannel.probe.environment, {
    schema: 'rapp-work.controlled-local-private-channel-probe/1',
    mode: 'inspect-only',
    root: config.root,
    bindingWave: config.privateChannel.bindingWave,
    allowLiveSend: false,
  }, 'channel-probe-unavailable');
  const channel = controlledLocalChannelEvidence(channelOutput, config.root, config.privateChannel.bindingWave);
  const result = verifyPath === undefined
    ? await runInitial(config, bindings, channel)
    : await runVerify(config, bindings, channel, path.resolve(verifyPath));
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify(publicError(error)));
  process.exitCode = 1;
});
