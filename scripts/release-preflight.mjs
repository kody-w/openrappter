#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_COMPONENT_SOURCE = '(?:0|[1-9]\\d*)';
const SEMVER_SOURCE =
  `${SEMVER_COMPONENT_SOURCE}\\.${SEMVER_COMPONENT_SOURCE}\\.${SEMVER_COMPONENT_SOURCE}`;
const SEMVER_PATTERN = new RegExp(`^(${SEMVER_COMPONENT_SOURCE})\\.(${SEMVER_COMPONENT_SOURCE})\\.(${SEMVER_COMPONENT_SOURCE})$`);
const TAG_PATTERN = new RegExp(`^v(${SEMVER_SOURCE})$`);
const MACOS_TAG_PATTERN = new RegExp(`^v(${SEMVER_SOURCE})-bar$`);
const REGISTRY_URLS = Object.freeze({
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org/pypi',
});
const RELEASE_REGISTRIES = Object.freeze(['npm', 'pypi']);

export const REQUIRED_RELEASE_FILES = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/workflows/install-smoke.yml',
  '.github/workflows/release.yml',
  'python/openrappter/__init__.py',
  'python/pyproject.toml',
  'python/scripts/gateway_token_smoke.py',
  'scripts/release-preflight.mjs',
  'typescript/bin/openrappter.mjs',
  'typescript/package-lock.json',
  'typescript/package.json',
  'typescript/src/version.ts',
]);

function requireSemver(version, label = 'version') {
  const match = typeof version === 'string' && SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`${label} must match X.Y.Z exactly (received ${JSON.stringify(version)})`);
  }
  return match.slice(1).map((component) => BigInt(component));
}

export function parsePackageReleaseTag(tag) {
  const version = typeof tag === 'string' && TAG_PATTERN.exec(tag)?.[1];
  if (!version) {
    throw new Error(`tag must match vX.Y.Z exactly (received ${JSON.stringify(tag)})`);
  }
  return version;
}

export function parseMacosReleaseTag(tag) {
  const version = typeof tag === 'string' && MACOS_TAG_PATTERN.exec(tag)?.[1];
  if (!version) {
    throw new Error(`macOS tag must match vX.Y.Z-bar exactly (received ${JSON.stringify(tag)})`);
  }
  return version;
}

export function compareSemver(left, right) {
  const leftParts = requireSemver(left, 'left version');
  const rightParts = requireSemver(right, 'right version');

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function highestSemver(versions) {
  let highest;
  for (const version of versions) {
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) continue;
    if (highest === undefined || compareSemver(version, highest) > 0) {
      highest = version;
    }
  }
  return highest;
}

export function expectedArtifactNames(version) {
  requireSemver(version);
  return [
    `openrappter-${version}.tgz`,
    `openrappter-${version}-py3-none-any.whl`,
    `openrappter-${version}.tar.gz`,
  ];
}

export function validateReleaseState(state) {
  const errors = [];
  let tagVersion;
  try {
    tagVersion = parsePackageReleaseTag(state.tag);
  } catch (error) {
    errors.push(error.message);
  }

  const versions = [
    ['typescript/package.json', state.typescriptPackageVersion],
    ['typescript/package-lock.json', state.typescriptPackageLockVersion],
    ['typescript/package-lock.json root package', state.typescriptPackageLockRootVersion],
    ['python/pyproject.toml', state.pythonProjectVersion],
    ['TypeScript runtime', state.typescriptRuntimeVersion],
    ['Python runtime', state.pythonRuntimeVersion],
  ];

  for (const [label, version] of versions) {
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
      errors.push(`${label} version must match X.Y.Z exactly (received ${JSON.stringify(version)})`);
    } else if (tagVersion && version !== tagVersion) {
      errors.push(`${label} version ${version} does not match tag version ${tagVersion}`);
    }
  }

  if (state.typescriptPackageName !== 'openrappter') {
    errors.push(`typescript package name must be openrappter (received ${JSON.stringify(state.typescriptPackageName)})`);
  }
  if (state.pythonProjectName !== 'openrappter') {
    errors.push(`Python project name must be openrappter (received ${JSON.stringify(state.pythonProjectName)})`);
  }
  if (!state.typescriptRuntimeSourceValid) {
    errors.push('typescript/src/version.ts must report the version from typescript/package.json');
  }

  const existingFiles = new Set(state.existingFiles);
  for (const requiredFile of REQUIRED_RELEASE_FILES) {
    if (!existingFiles.has(requiredFile)) {
      errors.push(`required release file is missing: ${requiredFile}`);
    }
  }

  if (state.artifactNames !== undefined && tagVersion) {
    const expected = new Set(expectedArtifactNames(tagVersion));
    const observed = new Set(state.artifactNames);

    for (const name of expected) {
      if (!observed.has(name)) {
        errors.push(`required artifact is missing: ${name}`);
      }
    }
    for (const name of observed) {
      if (!expected.has(name)) {
        errors.push(`unexpected artifact name: ${name}`);
      }
    }
  }

  return errors;
}

export function artifactDigests(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function expectedRegistryArtifactNames(registry, version) {
  const [npmTarball, wheel, sourceDistribution] = expectedArtifactNames(version);
  return registry === 'npm'
    ? [npmTarball]
    : [wheel, sourceDistribution];
}

function readLocalRegistryArtifacts({
  registry,
  version,
  artifactsDir,
  readFileImpl = readFileSync,
}) {
  return expectedRegistryArtifactNames(registry, version).map((name) => {
    const filePath = path.join(artifactsDir, name);
    const contents = readFileImpl(filePath);
    return {
      name,
      path: filePath,
      ...artifactDigests(contents),
    };
  });
}

function registryVersionUrl(registry, packageName, version, registryUrls = REGISTRY_URLS) {
  const baseUrl = registryUrls[registry].replace(/\/$/, '');
  const encodedName = encodeURIComponent(packageName);
  const encodedVersion = encodeURIComponent(version);
  return registry === 'npm'
    ? `${baseUrl}/${encodedName}/${encodedVersion}`
    : `${baseUrl}/${encodedName}/${encodedVersion}/json`;
}

async function responseJson(response, registry, description) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${registry} ${description} returned invalid JSON: ${error.message}`);
  }
}

export async function fetchRegistryVersionMetadata(
  registry,
  packageName,
  version,
  options = {},
) {
  if (!RELEASE_REGISTRIES.includes(registry)) {
    throw new Error(`unsupported release registry: ${registry}`);
  }
  requireSemver(version, `${registry} query version`);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('registry checks require a fetch implementation');
  }

  const response = await fetchImpl(
    registryVersionUrl(registry, packageName, version, options.registryUrls),
    {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    },
  );

  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(
      `${registry} registry lookup for ${packageName}@${version} failed with HTTP ${response.status}`,
    );
  }
  return responseJson(response, registry, 'version lookup');
}

function npmTarballName(tarballUrl) {
  if (typeof tarballUrl !== 'string') return undefined;
  try {
    return decodeURIComponent(path.posix.basename(new URL(tarballUrl).pathname));
  } catch {
    return undefined;
  }
}

export function compareRegistryArtifactMetadata(registry, metadata, localArtifacts) {
  const matchedArtifacts = [];
  const missingArtifacts = [];
  const errors = [];

  if (registry === 'npm') {
    const local = localArtifacts[0];
    const dist = metadata?.dist;
    if (!dist || typeof dist !== 'object') {
      errors.push('npm metadata is missing dist integrity information');
      return { matchedArtifacts, missingArtifacts, errors };
    }

    const integrityValues = typeof dist.integrity === 'string'
      ? dist.integrity.trim().split(/\s+/)
      : [];
    if (!integrityValues.includes(local.integrity)) {
      errors.push(`npm integrity mismatch for ${local.name}`);
    }
    if (dist.shasum !== local.sha1) {
      errors.push(`npm shasum mismatch for ${local.name}`);
    }
    if (npmTarballName(dist.tarball) !== local.name) {
      errors.push(`npm tarball name mismatch for ${local.name}`);
    }
    if (errors.length === 0) matchedArtifacts.push(local.name);
    return { matchedArtifacts, missingArtifacts, errors };
  }

  if (registry !== 'pypi') {
    throw new Error(`unsupported release registry: ${registry}`);
  }
  if (!Array.isArray(metadata?.urls)) {
    errors.push('PyPI metadata is missing the release artifact list');
    return { matchedArtifacts, missingArtifacts, errors };
  }

  const localNames = new Set(localArtifacts.map(({ name }) => name));
  const remoteByName = new Map();
  for (const remote of metadata.urls) {
    const filename = remote?.filename;
    if (typeof filename !== 'string') {
      errors.push('PyPI metadata contains an artifact without a filename');
      continue;
    }
    if (!localNames.has(filename)) {
      errors.push(`PyPI contains unexpected artifact: ${filename}`);
      continue;
    }
    if (remoteByName.has(filename)) {
      errors.push(`PyPI metadata contains duplicate artifact: ${filename}`);
      continue;
    }
    remoteByName.set(filename, remote);
  }

  for (const local of localArtifacts) {
    const remote = remoteByName.get(local.name);
    if (!remote) {
      missingArtifacts.push(local.name);
      continue;
    }
    if (remote?.digests?.sha256 !== local.sha256) {
      errors.push(`PyPI sha256 mismatch for ${local.name}`);
      continue;
    }
    matchedArtifacts.push(local.name);
  }

  return { matchedArtifacts, missingArtifacts, errors };
}

export async function inspectRegistryArtifacts({
  registry,
  packageName,
  version,
  artifactsDir,
  fetchImpl,
  readFileImpl,
  registryUrls,
}) {
  if (!RELEASE_REGISTRIES.includes(registry)) {
    throw new Error(`unsupported release registry: ${registry}`);
  }
  const artifacts = readLocalRegistryArtifacts({
    registry,
    version,
    artifactsDir,
    readFileImpl,
  });
  const metadata = await fetchRegistryVersionMetadata(
    registry,
    packageName,
    version,
    { fetchImpl, registryUrls },
  );

  if (metadata === null) {
    return {
      registry,
      status: 'absent',
      artifacts,
      matchedArtifacts: [],
      missingArtifacts: artifacts.map(({ name }) => name),
      errors: [],
    };
  }

  const comparison = compareRegistryArtifactMetadata(registry, metadata, artifacts);
  const status = comparison.errors.length > 0
    ? 'conflict'
    : comparison.missingArtifacts.length > 0
      ? 'partial'
      : 'matching';
  return { registry, status, artifacts, ...comparison };
}

function registryConflictError(result) {
  return new Error(
    `${result.registry} registry artifacts conflict with this build:\n`
    + result.errors.map((error) => `- ${error}`).join('\n'),
  );
}

export async function waitForRegistryArtifacts({
  inspect,
  registry,
  attempts = 12,
  retryDelayMs = 5_000,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('registry verification attempts must be a positive integer');
  }
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await inspect();
    if (result.status === 'matching') return result;
    if (result.status === 'conflict') throw registryConflictError(result);
    if (attempt < attempts) await delay(retryDelayMs);
  }
  throw new Error(
    `${registry} registry artifacts remained ${result.status} after ${attempts} attempts`,
  );
}

function requireChildPath(root, child, label) {
  const relative = path.relative(root, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a directory inside the repository`);
  }
}

function stageMissingRegistryArtifacts(result, destination, root) {
  if (result.registry !== 'pypi') {
    throw new Error('only PyPI supports staging missing artifacts');
  }
  requireChildPath(root, destination, 'staging destination');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  const missing = new Set(result.missingArtifacts);
  for (const artifact of result.artifacts) {
    if (missing.has(artifact.name)) {
      copyFileSync(artifact.path, path.join(destination, artifact.name));
    }
  }
}

export async function fetchNpmReleaseIndex(packageName, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('npm release checks require a fetch implementation');
  }
  const baseUrl = (options.registryUrls?.npm ?? REGISTRY_URLS.npm).replace(/\/$/, '');
  const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(packageName)}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    return { latestVersion: undefined, publishedVersions: [] };
  }
  if (response.status !== 200) {
    throw new Error(
      `npm release index lookup for ${packageName} failed with HTTP ${response.status}`,
    );
  }

  const metadata = await responseJson(response, 'npm', 'release index lookup');
  const latestVersion = metadata?.['dist-tags']?.latest;
  if (latestVersion !== undefined) {
    requireSemver(latestVersion, 'npm latest version');
  }
  const publishedVersions = metadata?.versions && typeof metadata.versions === 'object'
    ? Object.keys(metadata.versions)
    : [];
  return { latestVersion, publishedVersions };
}

export function chooseNpmPublishTag({
  candidateVersion,
  latestVersion,
  publishedVersions = [],
  repositoryTags = [],
}) {
  requireSemver(candidateVersion, 'npm candidate version');
  if (latestVersion !== undefined) {
    requireSemver(latestVersion, 'npm latest version');
  }

  const repositoryVersions = repositoryTags
    .map((tag) => typeof tag === 'string' ? TAG_PATTERN.exec(tag)?.[1] : undefined)
    .filter(Boolean);
  const currentReleaseVersion = highestSemver([
    ...publishedVersions,
    ...repositoryVersions,
    ...(latestVersion ? [latestVersion] : []),
  ]);
  const isCurrentRelease = currentReleaseVersion === undefined
    || compareSemver(candidateVersion, currentReleaseVersion) >= 0;
  return {
    tag: isCurrentRelease
      ? 'latest'
      : `release-${candidateVersion.replaceAll('.', '-')}`,
    currentReleaseVersion,
    isCurrentRelease,
  };
}

function readRepositoryTags(root) {
  return execFileSync('git', ['-C', root, 'tag', '--list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/).filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readPythonProject(contents) {
  let inProject = false;
  const fields = {};

  for (const line of contents.split(/\r?\n/)) {
    const table = line.trim().match(/^\[([^\]]+)\]$/);
    if (table) {
      if (inProject) break;
      inProject = table[1] === 'project';
      continue;
    }
    if (!inProject) continue;

    const field = line.trim().match(/^(name|version)\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

function readPythonRuntimeVersion(contents) {
  return contents.match(/^__version__\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
}

function validatesTypeScriptRuntimeSource(contents) {
  return (
    /new URL\(\s*['"]\.\.\/package\.json['"]\s*,\s*import\.meta\.url\s*\)/.test(contents)
    && /export const VERSION\s*=\s*loadPackageVersion\(\)\s*;/.test(contents)
  );
}

function readRepositoryState(options, includeArtifactNames) {
  const root = options.root;
  const packageJson = readJson(path.join(root, 'typescript/package.json'));
  const packageLock = readJson(path.join(root, 'typescript/package-lock.json'));
  const pyproject = readPythonProject(
    readFileSync(path.join(root, 'python/pyproject.toml'), 'utf8'),
  );
  const pythonRuntimeSource = readFileSync(
    path.join(root, 'python/openrappter/__init__.py'),
    'utf8',
  );
  const typescriptRuntimeSource = readFileSync(
    path.join(root, 'typescript/src/version.ts'),
    'utf8',
  );

  let artifactNames;
  if (includeArtifactNames && options.artifactsDir) {
    const artifactDirectory = path.resolve(root, options.artifactsDir);
    artifactNames = readdirSync(artifactDirectory, { withFileTypes: true })
      .map((entry) => entry.isFile() ? entry.name : `${entry.name}/`);
  }

  return {
    tag: options.tag,
    typescriptPackageName: packageJson.name,
    typescriptPackageVersion: packageJson.version,
    typescriptPackageLockVersion: packageLock.version,
    typescriptPackageLockRootVersion: packageLock.packages?.['']?.version,
    pythonProjectName: pyproject.name,
    pythonProjectVersion: pyproject.version,
    typescriptRuntimeVersion:
      options.typescriptRuntimeVersion ?? packageJson.version,
    pythonRuntimeVersion:
      options.pythonRuntimeVersion ?? readPythonRuntimeVersion(pythonRuntimeSource),
    typescriptRuntimeSourceValid:
      validatesTypeScriptRuntimeSource(typescriptRuntimeSource),
    existingFiles: REQUIRED_RELEASE_FILES.filter((file) =>
      existsSync(path.join(root, file))),
    artifactNames,
  };
}

function parseIntegerOption(argument, value, minimum) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${argument} requires an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${argument} must be at least ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const options = {
    root: path.resolve(scriptDirectory, '..'),
    tag: process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
    attempts: 12,
    retryDelayMs: 5_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '--require-present') {
      options.requirePresent = true;
      continue;
    }
    if (argument === '--include-repository-tags') {
      options.includeRepositoryTags = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);

    if (argument === '--root') {
      options.root = path.resolve(value);
    } else if (argument === '--tag') {
      options.tag = value;
    } else if (argument === '--typescript-runtime-version') {
      options.typescriptRuntimeVersion = value;
    } else if (argument === '--python-runtime-version') {
      options.pythonRuntimeVersion = value;
    } else if (argument === '--artifacts-dir') {
      options.artifactsDir = value;
    } else if (argument === '--check-registry') {
      options.checkRegistry = value;
    } else if (argument === '--stage-missing-dir') {
      options.stageMissingDir = value;
    } else if (argument === '--npm-publish-tag-candidate') {
      options.npmPublishTagCandidate = value;
    } else if (argument === '--attempts') {
      options.attempts = parseIntegerOption(argument, value, 1);
    } else if (argument === '--retry-delay-ms') {
      options.retryDelayMs = parseIntegerOption(argument, value, 0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
    index += 1;
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/release-preflight.mjs --tag vX.Y.Z [options]

Options:
  --root PATH                         repository root
  --typescript-runtime-version X.Y.Z actual TypeScript runtime report
  --python-runtime-version X.Y.Z     actual Python runtime report
  --artifacts-dir PATH               exact npm/wheel/sdist artifact directory
  --check-registry npm|pypi          reconcile remote and local artifacts
  --stage-missing-dir PATH           stage only missing PyPI artifacts
  --require-present                  wait for all registry artifacts to match
  --attempts N                       registry verification attempts (default 12)
  --retry-delay-ms N                 delay between attempts (default 5000)
  --npm-publish-tag-candidate X.Y.Z  select latest or a historical npm tag
  --include-repository-tags          include strict vX.Y.Z git tags in selection
  --help                             show this help`);
}

function reportValidationErrors(errors) {
  if (errors.length === 0) return false;
  console.error('Release preflight failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
  return true;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }

    if (options.npmPublishTagCandidate) {
      if (options.checkRegistry || options.requirePresent || options.stageMissingDir) {
        throw new Error('npm publish-tag selection cannot be combined with registry reconciliation');
      }
      const packageJson = readJson(path.join(options.root, 'typescript/package.json'));
      const index = await fetchNpmReleaseIndex(packageJson.name);
      const repositoryTags = options.includeRepositoryTags
        ? readRepositoryTags(options.root)
        : [];
      const decision = chooseNpmPublishTag({
        candidateVersion: options.npmPublishTagCandidate,
        latestVersion: index.latestVersion,
        publishedVersions: index.publishedVersions,
        repositoryTags,
      });
      console.error(
        decision.currentReleaseVersion
          ? `npm publication candidate ${options.npmPublishTagCandidate}; current release ${decision.currentReleaseVersion}; selected tag ${decision.tag}`
          : `npm publication candidate ${options.npmPublishTagCandidate}; no current release; selected tag latest`,
      );
      console.log(decision.tag);
      return;
    }

    if (!options.tag) {
      throw new Error('--tag is required (or set RELEASE_TAG/GITHUB_REF_NAME)');
    }
    const includeArtifactNames = Boolean(options.artifactsDir && !options.checkRegistry);
    const state = readRepositoryState(options, includeArtifactNames);
    const errors = validateReleaseState(state);
    if (reportValidationErrors(errors)) return;
    const version = parsePackageReleaseTag(state.tag);

    if (options.checkRegistry) {
      if (!RELEASE_REGISTRIES.includes(options.checkRegistry)) {
        throw new Error(`unsupported release registry: ${options.checkRegistry}`);
      }
      if (!options.artifactsDir) {
        throw new Error('--check-registry requires --artifacts-dir');
      }
      if (options.stageMissingDir && options.checkRegistry !== 'pypi') {
        throw new Error('--stage-missing-dir is only valid for PyPI');
      }

      const artifactsDir = path.resolve(options.root, options.artifactsDir);
      const inspect = () => inspectRegistryArtifacts({
        registry: options.checkRegistry,
        packageName: state.typescriptPackageName,
        version,
        artifactsDir,
      });
      const result = options.requirePresent
        ? await waitForRegistryArtifacts({
            inspect,
            registry: options.checkRegistry,
            attempts: options.attempts,
            retryDelayMs: options.retryDelayMs,
          })
        : await inspect();
      if (result.status === 'conflict') throw registryConflictError(result);

      if (options.stageMissingDir) {
        stageMissingRegistryArtifacts(
          result,
          path.resolve(options.root, options.stageMissingDir),
          options.root,
        );
      }
      console.error(
        `${options.checkRegistry} artifact state for openrappter ${version}: ${result.status}`
        + (result.missingArtifacts.length > 0
          ? `; missing ${result.missingArtifacts.join(', ')}`
          : ''),
      );
      console.log(result.status);
      return;
    }

    if (options.requirePresent || options.stageMissingDir) {
      throw new Error('--require-present and --stage-missing-dir require --check-registry');
    }
    console.log(`Release preflight passed for ${state.tag}`);
    console.log(`Expected artifacts: ${expectedArtifactNames(version).join(', ')}`);
    if (state.artifactNames !== undefined) {
      console.log(`Validated ${state.artifactNames.length} built artifacts`);
    }
    console.log('Registry artifacts will be reconciled immediately before publication');
  } catch (error) {
    console.error(`Release preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
