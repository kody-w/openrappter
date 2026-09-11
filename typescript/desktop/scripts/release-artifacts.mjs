import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DESKTOP_ROOT, TYPESCRIPT_ROOT, REPOSITORY_ROOT, desktopIdentity, dmgName,
  inspectAppBundle, requireArchitecture, requirePlainPath, runCommand,
  sha256File, withMountedDmg, writeRegularFile,
} from './release-contract.mjs';

export const BUILD_RECORD = 'rapp-work-build.json';
export const PACKAGED_AUTHORITY = 'runtime/node_modules/openrappter/dist/rapp/authority.js';
const COMPILED_AUTHORITY = path.join(TYPESCRIPT_ROOT, 'dist', 'rapp', 'authority.js');
const AUTHORITY_SOURCE = path.join(TYPESCRIPT_ROOT, 'src', 'rapp', 'authority.ts');
const requireCore = createRequire(path.join(TYPESCRIPT_ROOT, 'package.json'));
const BUILD_SCHEMA = 'rapp-work-build/1';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function extractArchiveFile(extractFile, archive, archivePath) {
  const nativePath = archivePath.split('/').join(path.sep);
  try {
    return extractFile(archive, archivePath);
  } catch (error) {
    if (nativePath === archivePath) throw error;
    try {
      return extractFile(archive, nativePath);
    } catch {
      throw error;
    }
  }
}

export function verifyAuthorityEmission(source, compiled) {
  const ts = requireCore('typescript');
  const config = ts.readConfigFile(path.join(TYPESCRIPT_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('Cannot read the canonical TypeScript build configuration.');
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, TYPESCRIPT_ROOT);
  if (converted.errors.length) throw new Error('Invalid canonical TypeScript build configuration.');
  const emitted = ts.transpileModule(source.toString('utf8'), {
    fileName: AUTHORITY_SOURCE,
    // Isolated transpilation cannot infer package.json's NodeNext ESM mode.
    compilerOptions: {
      ...converted.options,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  }).outputText;
  if (emitted !== compiled.toString('utf8')) {
    throw new Error('Canonical RAPP/1 build is stale relative to its source; run the core build first.');
  }
}

export async function canonicalAuthority() {
  const source = fs.readFileSync(AUTHORITY_SOURCE);
  const compiled = fs.readFileSync(COMPILED_AUTHORITY);
  verifyAuthorityEmission(source, compiled);
  const moduleSha256 = sha256(compiled);
  const module = await import(`${pathToFileURL(COMPILED_AUTHORITY).href}?sha256=${moduleSha256}`);
  if (sha256(fs.readFileSync(COMPILED_AUTHORITY)) !== moduleSha256) {
    throw new Error('Canonical RAPP/1 build changed while loading its authority.');
  }
  const selected = module.ACCEPTED_RAPP_PROTOCOL_AUTHORITY;
  if (!module.isSelectedProtocolAuthority(selected) || selected.status !== 'accepted') {
    throw new Error('The canonical RAPP/1 module did not select an accepted authority.');
  }
  return {
    protocol: 'RAPP/1',
    authority: { ...module.protocolAuthorityDetails(selected) },
    provenance: {
      sourceModule: 'typescript/src/rapp/authority.ts',
      sourceSha256: sha256(source),
      packagedModule: PACKAGED_AUTHORITY,
      moduleSha256,
    },
  };
}

async function verifyPackagedRuntime(resources) {
  requirePlainPath(resources, 'isDirectory');
  const archive = path.join(resources, 'app.asar');
  requirePlainPath(archive, 'isFile');
  const { extractFile } = await import('@electron/asar');
  const identity = desktopIdentity();
  const desktop = JSON.parse(extractArchiveFile(extractFile, archive, 'package.json').toString());
  const runtime = JSON.parse(extractArchiveFile(
    extractFile,
    archive, 'runtime/node_modules/openrappter/package.json',
  ).toString());
  const core = JSON.parse(fs.readFileSync(path.join(TYPESCRIPT_ROOT, 'package.json'), 'utf8'));
  if (desktop.name !== identity.packageName || desktop.version !== identity.version ||
      runtime.name !== core.name || runtime.version !== identity.version ||
      core.version !== identity.version) {
    throw new Error('Packaged desktop/core identity or version does not match this checkout.');
  }
  const canonical = await canonicalAuthority();
  const bundledHash = sha256(extractArchiveFile(extractFile, archive, PACKAGED_AUTHORITY));
  if (bundledHash !== canonical.provenance.moduleSha256) {
    throw new Error('Packaged RAPP/1 authority module differs from the canonical build. Rebuild the desktop runtime.');
  }
  return canonical;
}

export async function writeBuildRecord(resources, { run = runCommand } = {}) {
  const rapp1 = await verifyPackagedRuntime(resources);
  const gitCommit = run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT }).trim();
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error('Git did not return a full commit identity.');
  const gitDirty = run('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: REPOSITORY_ROOT,
  }).trim().length > 0;
  const { productName, version, appId, bundleName } = desktopIdentity();
  const record = {
    schema: BUILD_SCHEMA, productName, version, appId, bundleName,
    gitCommit, gitDirty, rapp1,
  };
  writeRegularFile(path.join(resources, BUILD_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// electron-builder runs afterPack before signing/notarization. The record is
// inside the signed app and describes the actual ASAR, not just the checkout.
export default async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, desktopIdentity().bundleName, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  await writeBuildRecord(resources);
}

export async function verifyBuildRecord(resources, { requireClean = false } = {}) {
  const rapp1 = await verifyPackagedRuntime(resources);
  const filename = path.join(resources, BUILD_RECORD);
  requirePlainPath(filename, 'isFile');
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const identity = desktopIdentity();
  if (record.schema !== BUILD_SCHEMA ||
      !['productName', 'version', 'appId', 'bundleName'].every((key) => record[key] === identity[key]) ||
      typeof record.gitCommit !== 'string' ||
      !/^[0-9a-f]{40}$/.test(record.gitCommit) ||
      typeof record.gitDirty !== 'boolean' ||
      !isDeepStrictEqual(record.rapp1, rapp1)) {
    throw new Error('Packaged build record has unverified identity or RAPP/1 authority claims.');
  }
  if (requireClean && record.gitDirty) {
    throw new Error('Release artifacts require a clean build; this app records uncommitted changes.');
  }
  return record;
}

export async function generateReleaseArtifacts(dmg, {
  architecture,
  requireClean = false,
  run = runCommand,
  mount = withMountedDmg,
} = {}) {
  dmg = path.resolve(dmg);
  requirePlainPath(dmg, 'isFile');
  if (architecture !== undefined) requireArchitecture(architecture);
  const checksum = await sha256File(dmg);
  const verified = await mount(dmg, async (app) => {
    const identity = inspectAppBundle(app, { run, version: desktopIdentity().version });
    if (architecture !== undefined && identity.architecture !== architecture) {
      throw new Error(`DMG architecture ${identity.architecture} does not match ${architecture}.`);
    }
    if (path.basename(dmg) !== dmgName(identity.architecture)) {
      throw new Error(`Expected DMG filename ${dmgName(identity.architecture)}.`);
    }
    const record = await verifyBuildRecord(path.join(app, 'Contents', 'Resources'), { requireClean });
    return { ...record, architecture: identity.architecture };
  }, { run });
  if (await sha256File(dmg) !== checksum) throw new Error('DMG changed while it was being verified.');
  const manifest = {
    ...verified,
    schema: 'rapp-work-release/1',
    dmg: {
      filename: path.basename(dmg),
      sha256: checksum,
      size: fs.statSync(dmg).size,
    },
  };
  const checksumPath = `${dmg}.sha256`;
  const manifestPath = `${dmg}.manifest.json`;
  writeRegularFile(checksumPath, `${checksum}  ${path.basename(dmg)}\n`);
  writeRegularFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { checksumPath, manifestPath, manifest };
}

export function parseManifestArgs(args) {
  const options = { requireClean: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--require-clean') options.requireClean = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--dmg' || arg === '--arch') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg === '--dmg' ? 'dmg' : 'architecture'] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.dmg) {
    options.architecture ??= process.arch;
    options.dmg = path.join(DESKTOP_ROOT, 'dist', dmgName(options.architecture));
  }
  if (options.architecture !== undefined) requireArchitecture(options.architecture);
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseManifestArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/release-artifacts.mjs [--dmg FILE] [--arch arm64|x64|universal] [--require-clean]');
    } else {
      const result = await generateReleaseArtifacts(options.dmg, options);
      console.log(`Verified ${result.manifest.productName} ${result.manifest.version} (${result.manifest.architecture})`);
      console.log(`${result.checksumPath}\n${result.manifestPath}`);
    }
  } catch (error) {
    console.error(`Release artifacts: ${error.message}`);
    process.exitCode = 1;
  }
}
