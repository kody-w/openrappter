import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('mutable installer bytes are refused before Pages deploy', () => {
  const root = path.resolve('.pages-refusal-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'candidate', 'install.sh'), 'receipted\n');
  fs.writeFileSync(path.join(root, 'candidate', 'install.ps1'), 'receipted\n');
  fs.writeFileSync(path.join(root, 'candidate', 'provenance.json'), JSON.stringify({
    schema: 'openrappter-candidate-provenance/v1',
    stable: false,
  }));
  fs.writeFileSync(path.join(root, 'docs', 'install.sh'), 'tampered\n');
  fs.writeFileSync(path.join(root, 'docs', 'install.ps1'), 'receipted\n');
  const bundle = path.join(root, 'candidate.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', bundle, '-C', path.join(root, 'candidate'), '.']).status, 0);
  const result = spawnSync(
    process.execPath,
    [new URL('./verify-pages-installer.mjs', import.meta.url).pathname, bundle, path.join(root, 'docs')],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutable public installer refused/);
  fs.rmSync(root, { recursive: true, force: true });
  const workflow = fs.readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('verify-pages-installer.mjs') < workflow.indexOf('actions/deploy-pages'));
  assert.match(workflow, /needs: release-constitution/);
  const configure = fs.readFileSync(
    new URL('./configure-pages-workflow.sh', import.meta.url),
    'utf8',
  );
  assert.match(configure, /repos\/kody-w\/openrappter\/pages/);
  assert.match(configure, /"build_type":"workflow"/);
});
