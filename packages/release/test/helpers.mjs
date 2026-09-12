import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_POLICY, AUTHORITY, canonical, readContract } from '../src/common.mjs';
import { captureBuildInputs, createProvenance, releaseFilename, writeBuildReceipt } from '../src/provenance.mjs';

export const TEAM = 'RAPPWORK01';
export const negative = JSON.parse(await readFile(new URL('../../../tests/fixtures/migration/rejected-inputs.json', import.meta.url), 'utf8'));
export const homeSentinels = JSON.parse(await readFile(new URL('../../../tests/fixtures/migration/legacy-home.json', import.meta.url), 'utf8'));

export async function scratch(t) {
  const directory = path.resolve('.test-scratch', `release-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function put(root, relative, value, mode = 0o644) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, typeof value === 'object' && !Buffer.isBuffer(value) ? `${JSON.stringify(value, null, 2)}\n` : value, { mode });
  await chmod(filename, mode);
  return filename;
}

export async function sourceFixture(t) {
  const root = path.join(await scratch(t), 'source');
  await mkdir(root, { mode: 0o700 });
  await put(root, 'package.json', { name: 'rapp-work', version: '2.0.0', private: true, type: 'module', workspaces: ['apps/*', 'packages/*'] });
  await put(root, 'package-lock.json', { name: 'rapp-work', version: '2.0.0', lockfileVersion: 3, packages: { '': { name: 'rapp-work', version: '2.0.0' } } });
  await put(root, 'apps/desktop/package.json', { name: '@rapp-work/desktop', version: '2.0.0', type: 'module' });
  await put(root, 'apps/desktop/src/main.mjs', 'export const product = "RAPP Work";\n');
  await put(root, 'packages/release/package.json', { name: '@rapp-work/release', version: '2.0.0', type: 'module' });
  await put(root, 'packages/release/src/tool.mjs', 'export const release = true;\n');
  for (const directory of readContract('legacy-policy.json').workspaceDirectories) {
    await put(root, `${directory}/package.json`, { name: `@rapp-work/${path.posix.basename(directory)}`, version: '2.0.0', type: 'module' });
    await put(root, `${directory}/src/index.mjs`, 'export const fixture = true;\n');
  }
  await put(root, 'package-lock.json', {
    name: 'rapp-work', version: '2.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'rapp-work', version: '2.0.0' },
      ...Object.fromEntries(readContract('legacy-policy.json').workspaceDirectories.map(directory => [directory, { version: '2.0.0' }])),
    },
  });
  await put(root, 'packages/release/package-lock.json', { name: '@rapp-work/release', lockfileVersion: 3, packages: {} });
  await put(root, 'scripts/build.mjs', 'export const build = true;\n');
  await put(root, 'tests/acceptance/smoke.test.mjs', 'export const acceptance = true;\n');
  await put(root, 'contracts/rapp1-authority.json', AUTHORITY);
  await put(root, `${ARTIFACT_POLICY.canonicalFixturesRoot}/authority.json`, AUTHORITY);
  await put(root, '.github/workflows/ci.yml', 'name: CI\n');
  await put(root, 'README.md', '# RAPP Work\n');
  await put(root, 'LICENSE', 'Copyright 2026 Test Fixture\n');
  await put(root, '.gitignore', 'dist/\n.test-scratch/\nnode_modules/\n');
  execFileSync('git', ['init', '--quiet', '--template=', root]);
  commitFixture(root);
  return root;
}

export function commitFixture(root) {
  execFileSync('git', ['-C', root, 'add', '--all']);
  execFileSync('git', [
    '-C', root, '-c', 'user.name=Release Acceptance', '-c', 'user.email=release-tests@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m',
    'Record synthetic release fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nCopilot-Session: a707dede-bf95-4c62-ae1c-f4e1cce271d8',
  ]);
}

export function makeAsar(files, unpacked = new Set()) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const parts = name.split('/');
    let directory = header.files;
    for (const part of parts.slice(0, -1)) {
      directory[part] ??= { files: {} };
      directory = directory[part].files;
    }
    if (unpacked.has(name)) directory[parts.at(-1)] = { size: bytes.length, unpacked: true };
    else {
      directory[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
      chunks.push(bytes);
      offset += bytes.length;
    }
  }
  const json = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return Buffer.concat([prefix, ...chunks]);
}

export function appFiles(version = '2.0.0', extras = {}) {
  return {
    'package.json': JSON.stringify({ name: '@rapp-work/desktop', version, main: 'dist/main.js', type: 'module' }),
    'dist/main.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/preload.cjs': 'module.exports = {};\n',
    ...extras,
  };
}

export function arm64MachO() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}

export class TestAppleVerifier {
  calls = [];
  async application(appPath, { mode, teamIdentifier }) {
    this.calls.push(['application', appPath]);
    return mode === 'development-unsigned' ? null : {
      teamIdentifier, bundleIdentifier: ARTIFACT_POLICY.bundleIdentifier,
      hardenedRuntime: true, notarized: true, stapled: true,
    };
  }
  async dmg(dmgPath) { this.calls.push(['dmg', dmgPath]); }
}

export async function releaseFixture(t, { mode = 'production', version = '2.0.0', root: existingRoot, appExtras } = {}) {
  const root = existingRoot ?? await sourceFixture(t);
  const parent = path.join(root, 'dist', `artifact-${randomUUID()}`);
  const appPath = path.join(parent, ARTIFACT_POLICY.applicationName);
  await put(appPath, 'Contents/MacOS/RAPP Work', arm64MachO(), 0o755);
  await put(appPath, 'Contents/Info.plist', '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.rapp.work</string></dict></plist>\n');
  await put(appPath, 'Contents/Resources/app.asar', makeAsar(appFiles(version, appExtras)));
  await put(appPath, 'Contents/Resources/rapp-work-installer', arm64MachO(), 0o755);
  await put(appPath, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', arm64MachO(), 0o755);
  await put(appPath, 'Contents/Resources/host/host.cjs', 'module.exports = {};\n');
  await put(appPath, 'Contents/Resources/ui/index.html', '<!doctype html><title>RAPP Work fixture</title>');
  const inputs = await captureBuildInputs(root, mode);
  await writeBuildReceipt(appPath, { version, mode, ...inputs });
  const dmgPath = await put(parent, releaseFilename(version, mode), Buffer.from(`Synthetic DMG bytes for ${version}\n`));
  const keys = generateKeyPairSync('ed25519');
  const apple = new TestAppleVerifier();
  const envelope = await createProvenance({
    root, appPath, dmgPath, version, mode, ...inputs, apple,
    ...(mode === 'production' ? { privateKey: keys.privateKey, teamIdentifier: TEAM } : {}),
  });
  const trust = { mode, ...(mode === 'production' ? { trustedPublicKey: keys.publicKey, teamIdentifier: TEAM } : {}) };
  return { root, appPath, dmgPath, envelope, keys, apple, trust, inputs };
}

export async function copyPolicy(root) {
  for (const name of ['legacy-policy.json', 'legacy-allowlist.json', 'artifact-allowlist.json']) {
    await put(root, `contracts/${name}`, readContract(name));
  }
}

export async function copySentinels(home) {
  for (const sentinel of homeSentinels.sentinels) await put(home, sentinel.path, sentinel.content);
}

export { canonical, copyFile };
