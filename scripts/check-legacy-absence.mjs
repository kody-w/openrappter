#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLegacyAbsence } from '../packages/release/src/legacy.mjs';

export { checkLegacyAbsence };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    while (args.length) {
      const flag = args.shift();
      if (!['--root', '--app', '--asar', '--resources'].includes(flag) || !args[0] || args[0].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${flag}`);
      const key = flag.slice(2);
      if (Object.hasOwn(options, key)) throw new Error(`Repeated argument: ${flag}`);
      options[key] = path.resolve(args.shift());
    }
    if (!Object.keys(options).length) options.root = fileURLToPath(new URL('../', import.meta.url));
    const result = await checkLegacyAbsence(options);
    console.log(JSON.stringify({ status: 'passed', source: result.source, applicationDigest: result.application?.digest, asarDigest: result.asar?.digest, resourcesDigest: result.resources?.digest }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
