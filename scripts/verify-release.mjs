#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPackagedDmg } from '../packages/release/src/installer.mjs';
import { parseOptions, trustOptions } from '../packages/release/src/cli-options.mjs';
import { invariant } from '../packages/release/src/common.mjs';

try {
  const options = parseOptions(process.argv.slice(2), ['root', 'dmg', 'manifest', 'mount-directory', 'trusted-key', 'team-id', 'expected-commit'], ['development-unsigned']);
  invariant(options.dmg && options.manifest, 'Select a DMG and its provenance manifest');
  const trust = await trustOptions(options);
  const envelope = JSON.parse(await readFile(options.manifest, 'utf8'));
  const mountDirectory = path.resolve(options['mount-directory'] ?? 'packages/release/dist/verification');
  await mkdir(mountDirectory, { recursive: true, mode: 0o700 });
  const result = await verifyPackagedDmg({ root: options.root, dmgPath: options.dmg, envelope, mountDirectory, ...trust });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
