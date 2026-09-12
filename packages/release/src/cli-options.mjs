import { readFile } from 'node:fs/promises';
import { invariant } from './common.mjs';

export function parseOptions(args, valueFlags, booleanFlags = []) {
  const result = {};
  while (args.length) {
    const flag = args.shift();
    invariant(typeof flag === 'string' && flag.startsWith('--'), `Unknown argument: ${flag}`);
    const name = flag.slice(2);
    invariant(!Object.hasOwn(result, name), `Repeated argument: ${flag}`);
    if (booleanFlags.includes(name)) result[name] = true;
    else {
      invariant(valueFlags.includes(name) && args[0] && !args[0].startsWith('--'), `Unknown or incomplete argument: ${flag}`);
      result[name] = args.shift();
    }
  }
  return result;
}

export async function trustOptions(options) {
  const mode = options['development-unsigned'] ? 'development-unsigned' : 'production';
  if (mode === 'production') invariant(options['trusted-key'] && options['team-id'], 'Production needs an independently trusted public key and Apple Team ID');
  else invariant(!options['trusted-key'] && !options['team-id'], 'Do not combine development mode with production trust inputs');
  return {
    mode,
    ...(options['trusted-key'] ? { trustedPublicKey: await readFile(options['trusted-key'], 'utf8') } : {}),
    ...(options['team-id'] ? { teamIdentifier: options['team-id'] } : {}),
    ...(options['expected-commit'] ? { expectedCommit: options['expected-commit'] } : {}),
  };
}
