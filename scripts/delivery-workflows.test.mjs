import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = name => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');

test('release data refresh proposes a reviewed PR instead of writing main', () => {
  const text = workflow('beta-release-data.yml');
  assert.match(text, /pull-requests: write/);
  assert.match(text, /git push origin "\$branch"/);
  assert.match(text, /gh pr create.*--base main --head "\$branch"/);
  assert.doesNotMatch(text, /push origin (?:HEAD:)?main|gh pr merge|--force/);
});

test('pinned publication only requests the canonical gate with exact identity', () => {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'typescript/package.json'))).version;
  const result = spawnSync(process.execPath, [
    'scripts/pinned-release.mjs', 'publish', '--dry-run',
    '--commit', commit, '--version', `v${version}`,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /request only: gh workflow run create-release-tag.yml/);
  assert.ok(result.stdout.includes(`expected_commit=${commit}`));
  assert.ok(result.stdout.includes(`expected_tag=v${version}`));
  const source = fs.readFileSync(path.join(root, 'scripts/pinned-release.mjs'), 'utf8');
  assert.doesNotMatch(source, /'release', 'create'|git tag -a|git push origin|mkdtempSync/);
});

test('canonical tag creation checks requested identity and the full receipt chain', () => {
  const text = workflow('create-release-tag.yml');
  assert.match(text, /EXPECTED_COMMIT.*inputs.expected_commit/);
  assert.match(text, /EXPECTED_TAG.*inputs.expected_tag/);
  assert.match(text, /os\.environ\["EXPECTED_COMMIT"\]==r\["source_commit"\]/);
  assert.match(text, /os\.environ\["EXPECTED_TAG"\]==r\["intended_release_tag"\]/);
  assert.match(text, /authority\/scripts\/release_gate\.py/);
  assert.match(text, /--release release.json --remote/);
  assert.match(text, /create:\s*\n\s*needs: release-constitution/);
});

test('non-dry pinned publication invokes only a mocked canonical workflow request', () => {
  const scratch = fs.mkdtempSync(path.join(root, '.delivery-gh-'));
  try {
    const capture = path.join(scratch, 'arguments.json');
    fs.writeFileSync(path.join(scratch, 'gh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.FAKE_GH_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const version = JSON.parse(spawnSync('git', ['show', `${commit}:typescript/package.json`], { cwd: root, encoding: 'utf8' }).stdout).version;
    const args = ['scripts/pinned-release.mjs', 'publish', '--commit', commit, '--version', `v${version}`];
    const env = { ...process.env, PATH: `${scratch}${path.delimiter}${process.env.PATH}`, FAKE_GH_CAPTURE: capture };
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), [
      'workflow', 'run', 'create-release-tag.yml', '--repo', 'kody-w/openrappter',
      '--ref', 'main', '--field', `expected_commit=${commit}`, '--field', `expected_tag=v${version}`,
    ]);
    fs.unlinkSync(capture);
    const rejected = spawnSync(process.execPath, args, {
      cwd: root, env: { ...env, OPENRAPPTER_REPOSITORY: 'other/project' }, encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.existsSync(capture), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('Bar signing occurs before bundle provenance, never after promotion', () => {
  const builder = workflow('build-bar-candidate.yml');
  const bundle = workflow('build-candidate.yml');
  const release = workflow('release-bar.yml');
  assert.ok(builder.indexOf('stapler staple') < builder.indexOf('bar_candidate.py record'));
  assert.match(builder, /verify-dmg.sh "\$dmg" "\$RELEASE_VERSION" "\$sha"/);
  assert.match(bundle, /needs: \[resolve, bar\]/);
  assert.ok(bundle.indexOf('cp bar-inputs/* candidate/') < bundle.indexOf('const value=buildProvenance'));
  assert.match(bundle, /bar_candidate.py verify --root candidate/);
  assert.doesNotMatch(release, /notarytool submit|stapler staple|swift build|MACOS_CERTIFICATE/);
});

test('candidate check discovery is paginated and existing platform gates run on main', () => {
  assert.match(workflow('build-candidate.yml'), /gh api --paginate --slurp/);
  assert.match(workflow('build-candidate.yml'), /"macOS Menu Bar App","macos-14","ubuntu-latest","windows-latest"/);
  assert.match(workflow('desktop.yml'), /push:\s*\n\s*branches: \[main\]/);
});

test('distribution callers share an immutable authority pin that supports the current candidate URL contract', () => {
  const references = [
    'create-release-tag.yml', 'release-constitution.yml', 'pages.yml', 'release-bar.yml',
  ].map(name => {
    const text = workflow(name);
    const match = text.match(/repository: kody-w\/openrappter-release-train\s+ref: ([0-9a-f]{40})/);
    assert.ok(match, `${name} must pin the canonical authority`);
    return match[1];
  });
  assert.equal(new Set(references).size, 1);
  // That older validator accepts only flat paths, not snapshot/release/id paths.
  assert.notEqual(references[0], 'ce7fffe31d8cff3c66db1a0749596ec22fe064eb');
});
