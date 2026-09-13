import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadlessRuntime } from '../dist/runtime.js';
import { CopilotSdkProvider } from '../dist/copilot.js';
import { FixtureBrainstem, FixtureCopilotTransport, fixtureSigners, SyntheticIMessage, readFixture } from '../dist/fixtures.js';
import { discoveryEvidence } from '../dist/estate.js';

export { readFixture };
export const base = fileURLToPath(new URL('../.test-scratch/use-cases/', import.meta.url));
await mkdir(base, { recursive: true, mode: 0o700 });
let index = 0;
export async function harness(options = {}) {
  const directory = path.join(base, `store-${process.pid}-${Date.now()}-${index++}`);
  const transport = new FixtureCopilotTransport();
  const brainstem = new FixtureBrainstem();
  const channel = new SyntheticIMessage();
  const keys = fixtureSigners();
  let now = '2026-09-13T20:00:00.000Z';
  const settings = {
    directory, signatures: keys.signatures, signers: keys.signers,
    brainstem, channel, fixture: true,
    provider: new CopilotSdkProvider(transport, { mode: 'empty', sessionStorage: 'memory-only', canonicalContextOnly: true }),
    clock: () => now, ...options,
  };
  const runtime = await HeadlessRuntime.open(settings);
  return {
    directory, runtime, transport, brainstem, channel, keys, settings,
    time: value => { now = value; },
    restart: async () => HeadlessRuntime.open(settings),
    create: async (which = 0) => runtime.bots.create({
      name: which === 0 ? 'Copilot Builder' : 'Independent Reviewer',
      keyedRoot: keys.signers[which].root, operationId: which === 0 ? 'create-builder' : 'create-reviewer',
    }),
    discover: async root => runtime.estate.discover(root, {
      discover: async () => discoveryEvidence(await readFixture('rapp-up')),
    }, 'discover-native'),
  };
}

export async function inventory(directory) {
  const result = {};
  async function walk(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), name);
      else result[name] = createHash('sha256').update(await readFile(path.join(current, entry.name))).digest('hex');
    }
  }
  await walk(directory);
  return result;
}

export async function durableText(directory) {
  let result = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    result += entry.isDirectory() ? await durableText(path.join(directory, entry.name))
      : await readFile(path.join(directory, entry.name), 'utf8');
  }
  return result;
}

export async function allowPair(h, a, b) {
  await h.runtime.collaboration.grant(a, b, 'Builder public brief: propose reviewed canonical organization.', 'allow', 'grant-a-b');
  await h.runtime.collaboration.grant(b, a, 'Reviewer public brief: critique pointer federation without private retrieval.', 'allow', 'grant-b-a');
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
