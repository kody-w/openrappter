import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env };
const npmExecPath = env.npm_execpath;

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
run(['run', 'build', '--prefix', 'ui']);
