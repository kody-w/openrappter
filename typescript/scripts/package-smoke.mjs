import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const scratch = mkdtempSync(path.join(packageRoot, '.package-smoke-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function parsePackResult(output) {
  for (let start = output.indexOf('['); start >= 0; start = output.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index++) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '[') depth++;
      else if (char === ']' && --depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(start, index + 1));
          if (Array.isArray(parsed) && parsed[0]?.filename) return parsed;
        } catch {
          break;
        }
        break;
      }
    }
  }
  throw new Error(`npm pack did not emit its artifact JSON:\n${output}`);
}

try {
  const packed = run(npm, [
    'pack',
    '--json',
    '--pack-destination',
    scratch,
  ]);
  const packResult = parsePackResult(packed.stdout);
  const artifact = packResult[0];
  if (!artifact?.filename) throw new Error('npm pack did not report a tarball');

  const packedFiles = new Set((artifact.files ?? []).map((entry) => entry.path));
  if (!packedFiles.has('ui/dist/index.html')) {
    throw new Error('Tarball does not contain ui/dist/index.html');
  }

  const tarball = path.join(scratch, artifact.filename);
  if (!existsSync(tarball)) throw new Error(`Missing tarball: ${tarball}`);

  const installRoot = path.join(scratch, 'install');
  const home = path.join(scratch, 'home');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(installRoot, 'package.json'),
    JSON.stringify({ name: 'openrappter-package-smoke', private: true }),
  );

  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ], { cwd: installRoot });

  const installedRoot = path.join(installRoot, 'node_modules', 'openrappter');
  const installedIndex = path.join(installedRoot, 'ui', 'dist', 'index.html');
  if (!existsSync(installedIndex) || readFileSync(installedIndex, 'utf8').length === 0) {
    throw new Error('Installed package is missing ui/dist/index.html');
  }

  const cli = run(process.execPath, [
    path.join(installedRoot, 'bin', 'openrappter.mjs'),
    '--web',
  ], {
    cwd: installRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENRAPPTER_WEB_CHECK: '1',
    },
  });
  if (!cli.stdout.includes('Web UI assets available:')) {
    throw new Error(`Installed --web did not locate packaged UI assets:\n${cli.stdout}`);
  }

  console.log(`Package smoke passed: ${artifact.filename} includes a runnable Web UI`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
