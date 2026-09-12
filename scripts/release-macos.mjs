#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { packageMacRelease } from '../packages/release/src/package-macos.mjs';
import { parseOptions, trustOptions } from '../packages/release/src/cli-options.mjs';

try {
  const options = parseOptions(process.argv.slice(2), ['root', 'app', 'output', 'version', 'signing-identity', 'team-id', 'notary-profile', 'private-key', 'trusted-key'], ['development-unsigned']);
  const result = await packageMacRelease({
    root: options.root, appPath: options.app, outputDirectory: options.output, version: options.version,
    ...await trustOptions(options),
    signingIdentity: options['signing-identity'], notaryProfile: options['notary-profile'],
    privateKey: options['private-key'] ? await readFile(options['private-key'], 'utf8') : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
