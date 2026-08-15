import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageLock = path.join(root, 'package-lock.json');
const shrinkwrap = path.join(root, 'npm-shrinkwrap.json');
const locked = readFileSync(packageLock, 'utf8');
const existing = existsSync(shrinkwrap);

if (existing && readFileSync(shrinkwrap, 'utf8') !== locked) {
  throw new Error(
    'npm-shrinkwrap.json exists but does not match package-lock.json.',
  );
}
if (!existing) writeFileSync(shrinkwrap, locked);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : npm;
  const args = npmCli
    ? [npmCli, 'pack', ...process.argv.slice(2)]
    : ['pack', ...process.argv.slice(2)];
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && !npmCli,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (!existing) rmSync(shrinkwrap, { force: true });
}
