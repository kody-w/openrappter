import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceOwnedProof } from '../test/source-owned-fixture.mjs';

const next = fileURLToPath(new URL('../', import.meta.url));
const { h, pages, trustedPages, events, report } = await sourceOwnedProof();
const directory = path.join(next, '.test-scratch', `source-ownership-${process.pid}-${Date.now()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(path.join(directory, 'fixture-registry.json'), JSON.stringify(h.keys.registry, null, 2) + '\n');
await writeFile(path.join(directory, 'replay.json'), JSON.stringify(pages, null, 2) + '\n');
await writeFile(path.join(directory, 'replay-trust.json'), JSON.stringify({
  schema: 'rapp-work.catch-up-verification-manifest/1', pages: trustedPages,
}, null, 2) + '\n');
await writeFile(path.join(directory, 'projection-events.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
const run = (script, args) => {
  const result = spawnSync('python3', [path.join(next, 'scripts', script), ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const canonical = run('reference-check.py', [h.directory, path.join(directory, 'fixture-registry.json')]);
assert(canonical.framesScanned > 0 && canonical.signedFrames === canonical.framesScanned);
const independentDigests = run('check-replay-digests.py',
  [path.join(directory, 'replay.json'), path.join(directory, 'replay-trust.json'), h.directory]);
const result = { ...report, canonical, independentDigests,
  canonicalDirectory: path.relative(next, h.directory), evidenceDirectory: path.relative(next, directory) };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
