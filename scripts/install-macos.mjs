#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { installDmg, rollbackInstallation } from '../packages/release/src/installer.mjs';
import { parseOptions, trustOptions } from '../packages/release/src/cli-options.mjs';
import { invariant } from '../packages/release/src/common.mjs';

try {
  const options = parseOptions(process.argv.slice(2), ['dmg', 'manifest', 'applications-directory', 'trusted-key', 'team-id', 'expected-commit', 'rollback'], ['development-unsigned']);
  const trust = await trustOptions(options);
  const applicationsDirectory = options['applications-directory'];
  invariant(applicationsDirectory, 'Select an existing applications directory explicitly');
  let result;
  if (options.rollback) {
    invariant(!options.dmg && !options.manifest, 'Rollback does not accept a replacement artifact');
    result = await rollbackInstallation({ journalPath: options.rollback, applicationsDirectory, ...trust });
  } else {
    invariant(options.dmg && options.manifest, 'Select a DMG and its provenance manifest');
    const envelope = JSON.parse(await readFile(options.manifest, 'utf8'));
    result = await installDmg({ dmgPath: options.dmg, envelope, applicationsDirectory, ...trust });
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
