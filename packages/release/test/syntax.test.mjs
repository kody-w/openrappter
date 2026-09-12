import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('every release module passes the Node syntax checker', async () => {
  for (const root of [fileURLToPath(new URL('../src/', import.meta.url)), fileURLToPath(new URL('../../../scripts/', import.meta.url))]) {
    for (const name of await readdir(root)) {
      if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', path.join(root, name)], { stdio: 'pipe' });
    }
  }
});
