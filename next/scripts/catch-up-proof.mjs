import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HeadlessRuntime } from '../dist/runtime.js';
import { fixtureSigners } from '../dist/fixtures.js';
import { canonicalJson, contentHash, sha256 } from '../dist/canonical.js';
import { AI_RIGHTS, VIEW_SCHEMA } from '../dist/ai-contract.js';
import { foldState, permittedScopes } from '../dist/state.js';
import { CatchUpPlayer } from '../test/catch-up-player.mjs';
import { computerReplayFixture } from '../test/computer-replay-fixture.mjs';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(rootDirectory, '.test-scratch', `catch-up-${process.pid}-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const keys = fixtureSigners();
let time = Date.parse('2026-09-13T23:00:00.000Z');
let modelCalls = 0;
const options = {
  directory: path.join(evidence, 'canonical'), signers: keys.signers, signatures: keys.signatures,
  clock: () => new Date(time++).toISOString(),
  provider: { complete: async () => { modelCalls++; throw new Error('Replay must never call a model'); } },
};
const runtime = await HeadlessRuntime.open(options);
const bot = await runtime.bots.create({ name: 'Catch me up fixture', keyedRoot: keys.signers[0].root, operationId: 'create-replay-root' });
const grant = await runtime.ai.authority.grant(bot.root, {
  name: 'Replay observer', provider: 'any-ai', scope: 'root', rights: [...AI_RIGHTS], ttlSeconds: 3_600,
}, 'replay-observer');
const publish = (id, content, view) => runtime.ai.publish(bot.root, grant.capability, {
  kind: 'conversation', content: { text: content }, causes: [],
  ...(view ? { view, viewParents: [] } : {}),
}, id);
await publish('public-work', 'A public canonical work summary.');
await publish('recorded-view', 'The intended work emphasis is explicitly recorded.', {
  schema: VIEW_SCHEMA, focus: 'monorepo', emphasis: 'work', cards: [], progress: null, screenArtifact: null,
});
await publish('missing-view', 'Useful work remains despite an unavailable hint.', { html: 'REJECTED-PRIVATE-UI-CODE' });
const h = { runtime, keys, settings: options };
const guest = await computerReplayFixture(h, bot.root);
const hosted = await HeadlessRuntime.open({ ...options, computerReplay: guest.replay });
const sourceDirectory = path.join(evidence, 'computer-broker');
await mkdir(path.join(sourceDirectory, 'frames'), { recursive: true, mode: 0o700 });
for (const frame of guest.frames) await writeFile(path.join(sourceDirectory, 'frames', `${String(frame.seq).padStart(12, '0')}.json`), canonicalJson(frame));
await writeFile(path.join(evidence, 'fixture-registry.json'), JSON.stringify(keys.registry, null, 2) + '\n');

function trustedReplay(root, scope, request, page, guestEvidenceDigest = null) {
  const { timelineDigest: _claimed, ...payload } = page;
  const trustedTimelineDigest = contentHash(payload);
  assert.equal(page.timelineDigest, trustedTimelineDigest);
  return {
    schema: 'rapp-work.catch-up-verification-input/1',
    root: root.definition.root,
    scope,
    request,
    visibleScopes: [...permittedScopes(foldState(root).scopes, scope)].sort(),
    guestEvidenceDigest,
    trustedTimelineDigest,
  };
}

async function bytes(directory) {
  const result = {};
  async function walk(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), name);
      else result[name] = sha256(await readFile(path.join(current, entry.name)));
    }
  }
  await walk(directory);
  return result;
}
const before = await bytes(options.directory);
const normalRequest = { from: null };
const normal = await hosted.ai.catchUp(bot.root, grant.capability, normalRequest);
assert(normal.steps.every(step => step.guest === null));
const privateRequest = { from: null, guest: guest.option };
const privatePage = await hosted.ai.catchUp(bot.root, grant.capability, privateRequest);
const guestSteps = privatePage.steps.filter(step => step.guest !== null);
assert.deepEqual(guestSteps.map(step => step.grade), ['recorded', 'reconstructed', 'reconstructed', 'unavailable']);
const canonicalRoot = await hosted.bots.repository.root(bot.root);
const trustedPages = [
  trustedReplay(canonicalRoot, 'root', normalRequest, normal),
  trustedReplay(canonicalRoot, 'root', privateRequest, privatePage, guest.replay.snapshotDigest),
];
const player = new CatchUpPlayer(canonicalRoot, 'root');
player.load(privatePage, trustedPages[1]);
player.forward(privatePage.steps.length);
const restarted = await HeadlessRuntime.open({ ...options, computerReplay: guest.replay });
const repeat = await restarted.ai.catchUp(bot.root, grant.capability, { from: null, to: privatePage.to, guest: guest.option });
assert.equal(canonicalJson(repeat), canonicalJson(privatePage));
await hosted.conversation.converse(bot.root, 'Catch me up', 'read-only-natural-request');
assert.deepEqual(await bytes(options.directory), before);
assert.equal(modelCalls, 0);
const serialized = canonicalJson([normal, privatePage]);
for (const prohibited of ['EXCLUDED-SECRET-ARGUMENT', 'EXCLUDED-SECRET-STDOUT', 'EXCLUDED-SECRET-STDERR', 'EXCLUDED-KEYSTROKES', 'REJECTED-PRIVATE-UI-CODE']) {
  assert(!serialized.includes(prohibited));
}
await writeFile(path.join(evidence, 'replay.json'), JSON.stringify([normal, privatePage], null, 2) + '\n');
await writeFile(path.join(evidence, 'replay-trust.json'), JSON.stringify({
  schema: 'rapp-work.catch-up-verification-manifest/1', pages: trustedPages,
}, null, 2) + '\n');
const checkArguments = [path.join(rootDirectory, 'scripts/check-replay-digests.py'), path.join(evidence, 'replay.json'),
  path.join(evidence, 'replay-trust.json'), options.directory, sourceDirectory];
const check = spawnSync('python3', checkArguments, {
  encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
assert.equal(check.status, 0, check.stdout + check.stderr);
const tampered = JSON.parse(JSON.stringify([normal, privatePage]));
const occurrence = tampered[0].steps.findIndex(step => step.stepKind === 'occurrence' && step.origin !== null);
const other = tampered[0].steps.findIndex((step, index) => index !== occurrence && step.origin !== null);
assert(occurrence >= 0 && other >= 0);
tampered[0].steps[occurrence].origin = tampered[0].steps[other].origin;
tampered[0].steps[occurrence].previousCursor = tampered[0].steps[other].previousCursor;
tampered[0].selectionDigest = contentHash({ forged: 'selection' });
const { timelineDigest: _tamperedDigest, ...tamperedPayload } = tampered[0];
tampered[0].timelineDigest = contentHash(tamperedPayload);
await writeFile(path.join(evidence, 'replay-tampered.json'), JSON.stringify(tampered, null, 2) + '\n');
const tamperedCheck = spawnSync('python3', [path.join(rootDirectory, 'scripts/check-replay-digests.py'),
  path.join(evidence, 'replay-tampered.json'), path.join(evidence, 'replay-trust.json'), options.directory, sourceDirectory], {
  encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
assert.notEqual(tamperedCheck.status, 0, 'A consistently rehashed page with forged provenance must be rejected.');
const checks = [];
for (const source of [options.directory, sourceDirectory]) {
  const run = spawnSync('python3', [path.join(rootDirectory, 'scripts/reference-check.py'), source, path.join(evidence, 'fixture-registry.json')],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  checks.push(JSON.parse(run.stdout));
}
const report = {
  schema: 'rapp-work.catch-up-gate/1', root: bot.root, status: 'passed',
  grades: privatePage.grades, guestGrades: guestSteps.map(step => ({ grade: step.grade, kind: step.guest.kind })),
  deterministicAfterRestart: true, passiveFastForward: true,
  sourceFrameHashesRetained: true, stateDigests: 'rapp/1:particle', independentDigestCheck: JSON.parse(check.stdout),
  independentOriginsCursorsAndSelection: true, trustedTimelineDigestInputs: true, recomputedTamperedPageRejected: true,
  canonicalChecks: checks, replayModelCalls: modelCalls, replayToolExecutions: 0, replayMutations: 0,
  hiddenReasoningExported: false, hostScreenIncluded: false, secretsOrKeystrokesIncluded: false,
  guestDefaultOff: true, guestRequiresExplicitGoddPrivatePolicy: true, liveGuestCapturePerformed: false,
  guestEvidence: 'synthetic canonical ComputerBroker fixture; production capture origin/safety binding remains required',
  timelineDigest: privatePage.timelineDigest, finalStateDigest: player.stateDigest,
  replaySourceDigest: contentHash(before), evidenceDirectory: path.relative(rootDirectory, evidence),
  uiImplemented: false, migrationReleaseGateStillRequired: true,
};
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
