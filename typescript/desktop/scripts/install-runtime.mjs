import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescript = path.resolve(desktop, '..');
const runtime = path.join(desktop, 'runtime');
const packageRoot = path.join(runtime, 'node_modules', 'openrappter');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'openrappter-desktop-runtime-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const metadata = JSON.parse(
  readFileSync(path.join(desktop, 'package.json'), 'utf8'),
);
const electronVersion = String(metadata.devDependencies.electron).replace(/^[^\d]*/, '');

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? 'unknown'}):\n` +
      `${result.stdout || ''}${result.stderr || ''}`,
    );
  }
  return result.stdout;
}

function run(args, options = {}) {
  return runCommand(npm, args, options);
}

function parsePackResult(output) {
  for (
    let start = output.indexOf('[');
    start >= 0;
    start = output.indexOf('[', start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '[') depth += 1;
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
  throw new Error(`npm pack did not emit artifact JSON:\n${output}`);
}

try {
  const packed = parsePackResult(
    runCommand(
      process.execPath,
      [
        path.join(typescript, 'scripts', 'pack-locked.mjs'),
        '--json',
        '--pack-destination',
        scratch,
      ],
      {
        cwd: typescript,
      },
    ),
  );
  const filename = packed[0]?.filename;
  if (!filename) throw new Error('npm pack did not report an OpenRappter tarball.');
  if (
    !(packed[0]?.files ?? []).some(
      (entry) => entry.path === 'npm-shrinkwrap.json',
    )
  ) {
    throw new Error('OpenRappter tarball is missing its reviewed dependency lock.');
  }

  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });
  runCommand(
    tar,
    [
      '-xzf',
      path.join(scratch, filename),
      '-C',
      packageRoot,
      '--strip-components=1',
    ],
  );
  run(
    [
      'ci',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: packageRoot },
  );
  const sourceLock = JSON.parse(
    readFileSync(path.join(typescript, 'package-lock.json'), 'utf8'),
  );
  for (const [packagePath, locked] of Object.entries(sourceLock.packages ?? {})) {
    if (
      !packagePath.startsWith('node_modules/') ||
      locked?.dev === true ||
      typeof locked?.version !== 'string'
    ) {
      continue;
    }
    const installedPackage = path.join(packageRoot, packagePath, 'package.json');
    if (!existsSync(installedPackage)) {
      if (locked.optional === true) continue;
      throw new Error(`Desktop runtime dependency is missing: ${packagePath}`);
    }
    const installed = JSON.parse(readFileSync(installedPackage, 'utf8'));
    if (installed.version !== locked.version) {
      throw new Error(
        `Desktop runtime dependency drifted: ${packagePath} ` +
        `${locked.version} -> ${installed.version}`,
      );
    }
  }
  run(['rebuild', 'better-sqlite3'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_dist_url: 'https://electronjs.org/headers',
    },
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
