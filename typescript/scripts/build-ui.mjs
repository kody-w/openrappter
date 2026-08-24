import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env };
const npmExecPath = env.npm_execpath;
const uiRoot = path.join(packageRoot, 'ui');
const grailRoot = path.resolve(packageRoot, '..', 'beta', 'ui');
const grailIcon = path.resolve(packageRoot, '..', 'beta', 'build', 'icon.svg');
const output = path.join(uiRoot, 'dist');
const legacyOutput = path.join(uiRoot, '.legacy-dist');

// Do not leak outer `npm pack --json/--dry-run` flags into nested installs.
delete env.npm_config_json;
delete env.npm_config_dry_run;

function run(args) {
  const result = spawnSync(
    npmExecPath ? process.execPath : npm,
    npmExecPath ? [npmExecPath, ...args] : args,
    {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['ci', '--prefix', 'ui', '--ignore-scripts', '--no-audit', '--no-fund']);
run(['run', 'build:legacy', '--prefix', 'ui']);

rmSync(legacyOutput, { recursive: true, force: true });
renameSync(output, legacyOutput);
mkdirSync(output, { recursive: true });
cpSync(grailRoot, output, { recursive: true });
cpSync(legacyOutput, path.join(output, 'legacy'), { recursive: true });
cpSync(grailIcon, path.join(output, 'icon.svg'));
for (const selectorAsset of [
  'release-ring-selector.js',
  'release-ring-selector.js.map',
  'release-ring-selector.d.ts',
]) {
  cpSync(
    path.join(legacyOutput, selectorAsset),
    path.join(output, selectorAsset),
  );
}
const builtIndex = path.join(output, 'index.html');
writeFileSync(
  builtIndex,
  readFileSync(builtIndex, 'utf8').replace(
    'href="../build/icon.svg"',
    'href="icon.svg"',
  ),
);
rmSync(legacyOutput, { recursive: true, force: true });
