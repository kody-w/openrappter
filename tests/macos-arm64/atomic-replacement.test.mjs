import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildNativeInstaller } from '../../packages/release/src/build-native.mjs';
import { command, requireMacArm64 } from '../../packages/release/src/apple.mjs';
import { put, scratch } from '../../packages/release/test/helpers.mjs';

test('real macOS arm64 renamex_np swaps apps atomically and refuses clobber or symlink destinations', async t => {
  requireMacArm64();
  const root = await scratch(t);
  const binary = await buildNativeInstaller(path.join(root, 'rapp-work-installer'));
  await assert.rejects(command('/usr/bin/codesign', ['--verify', '--strict', '-R',
    '=anchor apple generic and certificate leaf[subject.OU] = "RAPPWORK01"', binary]), /requirement|signature/u);
  const current = path.join(root, 'Current.app');
  const candidate = path.join(root, 'Candidate.app');
  await put(current, 'version', 'prior');
  await put(candidate, 'version', 'next');
  const response = await command(binary, ['swap', candidate, current]);
  assert.equal(JSON.parse(response.stdout).committed, true);
  assert.equal(await readFile(path.join(current, 'version'), 'utf8'), 'next');
  assert.equal(await readFile(path.join(candidate, 'version'), 'utf8'), 'prior');
  await command(binary, ['swap', candidate, current]);
  assert.equal(await readFile(path.join(current, 'version'), 'utf8'), 'prior');
  await assert.rejects(command(binary, ['move', candidate, current]), /destination must not exist/u);
  const linked = path.join(root, 'Link.app');
  await symlink(current, linked);
  await assert.rejects(command(binary, ['swap', candidate, linked]), /real applications/u);
  const incoming = path.join(root, 'Incoming.app');
  await mkdir(incoming);
  const installed = path.join(root, 'Installed.app');
  await command(binary, ['move', incoming, installed]);
});
