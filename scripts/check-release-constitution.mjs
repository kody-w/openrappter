#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_POLICY, AUTHORITY, canonical, invariant, readContract } from '../packages/release/src/common.mjs';
import { scanSource } from '../packages/release/src/legacy.mjs';
import { inventoryTree, sourceSnapshot } from '../packages/release/src/inventory.mjs';

export async function checkReleaseConstitution(root) {
  const source = await scanSource(root);
  invariant(canonical(source.workspaces) === canonical([...readContract('legacy-policy.json').workspaceDirectories].sort()), 'The clean product requires every declared application and package');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  invariant(packageJson.name === 'rapp-work' && packageJson.private === true, 'The only root product is the private RAPP Work workspace');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  invariant(lock.lockfileVersion === 3 && lock.name === 'rapp-work', 'A complete npm v3 lock for RAPP Work is required');
  for (const directory of source.workspaces) {
    const manifest = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    invariant(lock.packages?.[directory]?.version === manifest.version, `Workspace is missing from the exact root lock: ${directory}`);
  }
  const authority = JSON.parse(await readFile(path.join(root, 'contracts/rapp1-authority.json'), 'utf8'));
  invariant(canonical(authority) === canonical(AUTHORITY) && authority.protocol === 'RAPP/1' && authority.status === 'accepted', 'Only the selected canonical authority may ship');
  invariant(ARTIFACT_POLICY.platform === 'darwin' && ARTIFACT_POLICY.architecture === 'arm64' && ARTIFACT_POLICY.bundleIdentifier === 'com.rapp.work', 'Release platform or application identity drifted');
  const fixtures = await inventoryTree(path.join(root, ARTIFACT_POLICY.canonicalFixturesRoot));
  invariant(fixtures.entries.some(entry => entry.type === 'file'), 'Canonical protocol fixtures must not be empty');
  const workflows = (await readdir(path.join(root, '.github/workflows'))).filter(name => /\.ya?ml$/u.test(name)).sort();
  invariant(canonical(workflows) === canonical(['ci.yml', 'release-constitution-check.yml', 'release-macos.yml']), 'Only the three clean workflows may exist');
  const release = await readFile(path.join(root, '.github/workflows/release-macos.yml'), 'utf8');
  invariant(release.includes('environment: production') && release.includes('node scripts/release-macos.mjs') && release.includes('node scripts/verify-release.mjs'), 'Production release requires the protected environment, builder and independent artifact verifier');
  invariant(!release.includes('--development-unsigned') && !/continue-on-error|pull_request_target|\|\|\s*true/u.test(release), 'Production release must not bypass verification or use unsigned development mode');
  invariant((await readFile(path.join(root, 'README.md'), 'utf8')).startsWith('# RAPP Work\n'), 'The root README must describe RAPP Work');
  for (const filename of ['tests/acceptance/runtime.test.ts', 'tests/acceptance/release-artifacts.test.mjs', 'tests/macos-arm64/atomic-replacement.test.mjs', 'tests/macos-arm64/dmg.test.mjs']) {
    const text = await readFile(path.join(root, filename), 'utf8');
    invariant(!/\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(/u.test(text), `Acceptance must run completely: ${filename}`);
  }
  const required = readContract('acceptance.json').required;
  const runtime = await readFile(path.join(root, 'tests/acceptance/runtime.test.ts'), 'utf8');
  const artifacts = await readFile(path.join(root, 'tests/acceptance/release-artifacts.test.mjs'), 'utf8');
  for (const id of required) invariant(runtime.includes(`'${id}'`) || artifacts.includes(`'${id}'`), `Acceptance scenario is missing: ${id}`);
  const snapshot = await sourceSnapshot(root, { requireClean: true });
  return { status: 'passed', commit: snapshot.commit, sourceDigest: snapshot.digest, lockDigest: snapshot.locks.digest, fixturesDigest: fixtures.digest, workspaces: source.workspaces.length, acceptanceScenarios: required.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    invariant(process.argv.length <= 3, 'Usage: node scripts/check-release-constitution.mjs [repository-root]');
    console.log(JSON.stringify(await checkReleaseConstitution(path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
