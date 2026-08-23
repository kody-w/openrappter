import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  artifactDigests,
  chooseNpmPublishTag,
  compareSemver,
  expectedArtifactNames,
  fetchNpmReleaseIndex,
  fetchRegistryVersionMetadata,
  inspectRegistryArtifacts,
  parseMacosReleaseTag,
  parsePackageReleaseTag,
  pythonArtifactVersion,
  REQUIRED_RELEASE_FILES,
  validateReleaseState,
  waitForRegistryArtifacts,
} from './release-preflight.mjs';

const requireFromTypescript = createRequire(
  new URL('../typescript/package.json', import.meta.url),
);
const { parse: parseYaml } = requireFromTypescript('yaml');

const VERSION = '1.10.0';
const PRERELEASE_VERSION = '1.11.0-beta.9';
const PACKAGE_NAME = 'openrappter';

function validState(overrides = {}, version = VERSION) {
  return {
    tag: `v${version}`,
    typescriptPackageName: PACKAGE_NAME,
    typescriptPackageVersion: version,
    typescriptPackageLockVersion: version,
    typescriptPackageLockRootVersion: version,
    desktopPackageVersion: version,
    desktopPackageLockVersion: version,
    desktopPackageLockRootVersion: version,
    pythonProjectName: PACKAGE_NAME,
    pythonProjectVersion: version,
    typescriptRuntimeVersion: version,
    pythonRuntimeVersion: version,
    typescriptRuntimeSourceValid: true,
    existingFiles: [...REQUIRED_RELEASE_FILES],
    artifactNames: expectedArtifactNames(version),
    ...overrides,
  };
}

function response(status, body = {}) {
  return { status, json: async () => body };
}

function artifactFixture() {
  const [npmName, wheelName, sourceName] = expectedArtifactNames(VERSION);
  const files = new Map([
    [npmName, Buffer.from('exact npm tarball')],
    [wheelName, Buffer.from('exact Python wheel')],
    [sourceName, Buffer.from('exact Python source distribution')],
  ]);
  return {
    npmName,
    wheelName,
    sourceName,
    files,
    readFileImpl: (filePath) => {
      const contents = files.get(path.basename(filePath));
      if (!contents) throw new Error(`unexpected local artifact read: ${filePath}`);
      return contents;
    },
  };
}

function npmMetadata(name, contents, overrides = {}) {
  const digests = artifactDigests(contents);
  return {
    dist: {
      integrity: digests.integrity,
      shasum: digests.sha1,
      tarball: `https://registry.npmjs.org/openrappter/-/${name}`,
      ...overrides,
    },
  };
}

function pypiArtifact(filename, contents, overrides = {}) {
  return {
    filename,
    digests: {
      sha256: artifactDigests(contents).sha256,
      ...overrides,
    },
  };
}

async function inspectFixture(registry, metadata) {
  const fixture = artifactFixture();
  const result = await inspectRegistryArtifacts({
    registry,
    packageName: PACKAGE_NAME,
    version: VERSION,
    artifactsDir: '/injected/release-dist',
    readFileImpl: fixture.readFileImpl,
    fetchImpl: async () => metadata === null
      ? response(404)
      : response(200, metadata),
  });
  return { result, fixture };
}

test('accepts a matching strict tag, versions, files, and artifact names', () => {
  assert.deepEqual(validateReleaseState(validState()), []);
  assert.equal(parsePackageReleaseTag('v1.10.0'), '1.10.0');
  assert.equal(parseMacosReleaseTag('v1.10.0-bar'), '1.10.0');
});

test('accepts a matching strict prerelease across tags, runtimes, and artifacts', () => {
  assert.deepEqual(validateReleaseState(validState({}, PRERELEASE_VERSION)), []);
  assert.equal(
    parsePackageReleaseTag(`v${PRERELEASE_VERSION}`),
    PRERELEASE_VERSION,
  );
  assert.equal(pythonArtifactVersion(PRERELEASE_VERSION), '1.11.0b9');
  assert.deepEqual(expectedArtifactNames(PRERELEASE_VERSION), [
    'openrappter-1.11.0-beta.9.tgz',
    'openrappter-1.11.0b9-py3-none-any.whl',
    'openrappter-1.11.0b9.tar.gz',
  ]);
});

test('rejects a tag that does not match package and runtime versions', () => {
  const errors = validateReleaseState(validState({
    tag: 'v1.10.1',
    artifactNames: undefined,
  }));

  assert.equal(errors.length, 9);
  assert.ok(errors.every((error) =>
    error.includes('does not match tag version 1.10.1')));
});

test('rejects a mismatching runtime report', () => {
  assert.deepEqual(validateReleaseState(validState({
    pythonRuntimeVersion: '1.9.9',
  })), [
    'Python runtime version 1.9.9 does not match tag version 1.10.0',
  ]);
});

test('rejects a prerelease runtime report that does not exactly match the tag', () => {
  assert.deepEqual(validateReleaseState(validState({
    pythonRuntimeVersion: '1.11.0-beta.8',
  }, PRERELEASE_VERSION)), [
    'Python runtime version 1.11.0-beta.8 does not match tag version 1.11.0-beta.9',
  ]);
});

test('rejects malformed package tags and unsupported build metadata', () => {
  const malformedTags = [
    '1.2.3',
    'v1.2',
    'v01.2.3',
    'v1.2.3-',
    'v1.2.3-beta..1',
    'v1.2.3-beta.01',
    'v1.2.3+build.1',
    'v1.2.3-beta.1+build.2',
    'v1.2.3\nmalicious',
  ];
  for (const tag of malformedTags) {
    assert.throws(() => parsePackageReleaseTag(tag), /strict SemVer/);
  }
});

test('keeps macOS Bar tags stable-only and injection-safe', () => {
  const maliciousTags = [
    'v1.2.3;echo PWNED-bar',
    'v1.2.3${IFS}touch-bar',
    'v1.2.3`id`-bar',
    'v1.2.3-bar;echo',
    'v1.2.3-bar\nmalicious',
    'v01.2.3-bar',
    'v1.2.3.4-bar',
    'v1.2.3-rc.1-bar',
  ];
  for (const tag of maliciousTags) {
    assert.throws(() => parseMacosReleaseTag(tag), /must match vX\.Y\.Z-bar exactly/);
  }
});

test('pinned release tooling shares strict prerelease and build-metadata rules', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  const prerelease = spawnSync(
    'node',
    [
      'scripts/pinned-release.mjs',
      'notes',
      '--commit',
      commit,
      '--version',
      'v1.14.0-rc.1',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(prerelease.status, 0, prerelease.stderr);
  assert.match(prerelease.stdout, /OpenRappter v1\.14\.0-rc\.1/);

  const buildMetadata = spawnSync(
    'node',
    [
      'scripts/pinned-release.mjs',
      'notes',
      '--commit',
      commit,
      '--version',
      'v1.14.0+build.1',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(buildMetadata.status, 1);
  assert.match(buildMetadata.stderr, /without build metadata/);
});

test('macOS build script rejects an injected version before invoking build tools', () => {
  const result = spawnSync('bash', ['macos/scripts/build-mac-app.sh'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      VERSION: '1.2.3;echo PWNED',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VERSION must match X\.Y\.Z exactly/);
  assert.doesNotMatch(result.stdout, /Building OpenRappter Bar/);
});

test('rejects malformed component versions', () => {
  const errors = validateReleaseState(validState({
    typescriptPackageVersion: '1.9',
  }));
  assert.ok(errors.some((error) =>
    error.includes('typescript/package.json version must be strict SemVer')));
});

test('rejects prereleases that PyPI cannot represent without changing identity', () => {
  const version = '1.11.0-preview.1';
  const state = validState({ tag: `v${version}`, artifactNames: undefined });
  for (const key of [
    'typescriptPackageVersion',
    'typescriptPackageLockVersion',
    'typescriptPackageLockRootVersion',
    'desktopPackageVersion',
    'desktopPackageLockVersion',
    'desktopPackageLockRootVersion',
    'pythonProjectVersion',
    'typescriptRuntimeVersion',
    'pythonRuntimeVersion',
  ]) {
    state[key] = version;
  }
  const errors = validateReleaseState(state);
  assert.ok(errors.some((error) =>
    error.includes('use alpha.N, beta.N, or rc.N')));
});

test('rejects missing, extra, or incorrectly named artifacts', () => {
  const errors = validateReleaseState(validState({
    artifactNames: [
      'openrappter-1.10.0.tgz',
      'openrappter-1.10.0-py3-none-any.whl',
      'openrappter-v1.10.0.tar.gz',
    ],
  }));

  assert.ok(errors.includes('required artifact is missing: openrappter-1.10.0.tar.gz'));
  assert.ok(errors.includes('unexpected artifact name: openrappter-v1.10.0.tar.gz'));
});

test('orders stable and prerelease SemVer and rejects malformed versions', () => {
  assert.equal(compareSemver('1.10.0', '1.9.99'), 1);
  assert.equal(compareSemver('2.0.0', '1.999.999'), 1);
  assert.equal(compareSemver('1.10.0', '1.10.0'), 0);
  assert.equal(compareSemver('1.9.99', '1.10.0'), -1);
  assert.equal(compareSemver('100000000000000000000.0.0', '2.0.0'), 1);
  assert.equal(compareSemver('1.10.0-rc.1', '1.10.0'), -1);
  assert.equal(compareSemver('1.10.0-beta.10', '1.10.0-beta.9'), 1);
  assert.equal(compareSemver('1.10.0-beta.9', '1.10.0-rc.1'), -1);
  assert.equal(compareSemver('1.10.0-beta', '1.10.0-beta.1'), -1);
  assert.throws(() => compareSemver('01.10.0', '1.10.0'), /strict SemVer/);
  assert.throws(() => compareSemver('1.10.0+build.1', '1.10.0'), /strict SemVer/);
});

test('selects latest only for the highest registry and repository release', () => {
  assert.deepEqual(chooseNpmPublishTag({
    candidateVersion: '1.10.0',
    latestVersion: '1.9.8',
    publishedVersions: ['1.9.8'],
    repositoryTags: ['v1.9.8'],
  }), {
    tag: 'latest',
    currentReleaseVersion: '1.9.8',
    isCurrentRelease: true,
  });

  assert.deepEqual(chooseNpmPublishTag({
    candidateVersion: '1.9.9',
    latestVersion: '1.9.8',
    publishedVersions: ['1.9.8'],
    repositoryTags: ['v1.10.0', 'v1.10.0-bar', 'v1.10.0-rc.1'],
  }), {
    tag: 'release-1-9-9',
    currentReleaseVersion: '1.10.0',
    isCurrentRelease: false,
  });

  assert.equal(chooseNpmPublishTag({
    candidateVersion: '1.10.0',
    latestVersion: '1.9.8',
    publishedVersions: ['1.11.0'],
  }).tag, 'release-1-10-0');

  assert.deepEqual(chooseNpmPublishTag({
    candidateVersion: '2.0.0-beta.9',
    latestVersion: '1.10.0',
    publishedVersions: ['1.10.0'],
  }), {
    tag: 'beta',
    currentReleaseVersion: '1.10.0',
    isCurrentRelease: true,
  });
  assert.throws(() => chooseNpmPublishTag({
    candidateVersion: '2.0.0-0.canary.1',
  }), /use alpha\.N, beta\.N, or rc\.N/);
});

test('npm release index is injectable, stable-only, and fails closed', async () => {
  assert.deepEqual(await fetchNpmReleaseIndex(PACKAGE_NAME, {
    fetchImpl: async () => response(404),
  }), {
    latestVersion: undefined,
    publishedVersions: [],
  });

  assert.deepEqual(await fetchNpmReleaseIndex(PACKAGE_NAME, {
    fetchImpl: async () => response(200, {
      'dist-tags': { latest: '1.10.0' },
      versions: { '1.9.9': {}, '1.10.0': {}, '1.11.0-rc.1': {} },
    }),
  }), {
    latestVersion: '1.10.0',
    publishedVersions: ['1.9.9', '1.10.0', '1.11.0-rc.1'],
  });

  await assert.rejects(
    fetchNpmReleaseIndex(PACKAGE_NAME, {
      fetchImpl: async () => response(200, {
        'dist-tags': { latest: 'not-semver' },
      }),
    }),
    /npm latest version must be strict SemVer/,
  );
  await assert.rejects(
    fetchNpmReleaseIndex(PACKAGE_NAME, {
      fetchImpl: async () => response(200, {
        'dist-tags': { latest: '1.11.0-beta.1' },
      }),
    }),
    /npm latest version must be a stable X\.Y\.Z version/,
  );
  await assert.rejects(
    fetchNpmReleaseIndex(PACKAGE_NAME, {
      fetchImpl: async () => response(503),
    }),
    /failed with HTTP 503/,
  );
});

test('registry metadata lookup treats only 404 as absent', async () => {
  assert.equal(await fetchRegistryVersionMetadata(
    'npm',
    PACKAGE_NAME,
    VERSION,
    { fetchImpl: async () => response(404) },
  ), null);
  assert.deepEqual(await fetchRegistryVersionMetadata(
    'pypi',
    PACKAGE_NAME,
    VERSION,
    { fetchImpl: async () => response(200, { urls: [] }) },
  ), { urls: [] });
  await assert.rejects(
    fetchRegistryVersionMetadata(
      'npm',
      PACKAGE_NAME,
      VERSION,
      { fetchImpl: async () => response(503) },
    ),
    /failed with HTTP 503/,
  );
});

test('accepts an existing npm version only when the exact tarball matches', async () => {
  const fixture = artifactFixture();
  const { result } = await inspectFixture(
    'npm',
    npmMetadata(fixture.npmName, fixture.files.get(fixture.npmName)),
  );
  assert.equal(result.status, 'matching');
  assert.deepEqual(result.matchedArtifacts, [fixture.npmName]);
  assert.deepEqual(result.errors, []);
});

test('fails on conflicting npm integrity, shasum, or tarball identity', async () => {
  const fixture = artifactFixture();
  const { result } = await inspectFixture('npm', npmMetadata(
    'wrong-name.tgz',
    Buffer.from('different tarball'),
    { shasum: '0'.repeat(40) },
  ));
  assert.equal(result.status, 'conflict');
  assert.ok(result.errors.some((error) => error.includes('integrity mismatch')));
  assert.ok(result.errors.some((error) => error.includes('shasum mismatch')));
  assert.ok(result.errors.some((error) => error.includes('tarball name mismatch')));
});

test('reports an absent npm version as publishable', async () => {
  const { result, fixture } = await inspectFixture('npm', null);
  assert.equal(result.status, 'absent');
  assert.deepEqual(result.missingArtifacts, [fixture.npmName]);
});

test('accepts an existing PyPI version only when both exact artifacts match', async () => {
  const fixture = artifactFixture();
  const metadata = {
    urls: [
      pypiArtifact(fixture.wheelName, fixture.files.get(fixture.wheelName)),
      pypiArtifact(fixture.sourceName, fixture.files.get(fixture.sourceName)),
    ],
  };
  const { result } = await inspectFixture('pypi', metadata);
  assert.equal(result.status, 'matching');
  assert.deepEqual(result.matchedArtifacts.sort(), [
    fixture.sourceName,
    fixture.wheelName,
  ].sort());
  assert.deepEqual(result.missingArtifacts, []);
});

test('identifies matching PyPI files and stages only the missing remainder', async () => {
  const fixture = artifactFixture();
  const { result } = await inspectFixture('pypi', {
    urls: [
      pypiArtifact(fixture.wheelName, fixture.files.get(fixture.wheelName)),
    ],
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.matchedArtifacts, [fixture.wheelName]);
  assert.deepEqual(result.missingArtifacts, [fixture.sourceName]);
  assert.deepEqual(result.errors, []);
});

test('fails closed for conflicting or unexpected PyPI artifacts', async () => {
  const fixture = artifactFixture();
  const { result } = await inspectFixture('pypi', {
    urls: [
      pypiArtifact(
        fixture.wheelName,
        fixture.files.get(fixture.wheelName),
        { sha256: '0'.repeat(64) },
      ),
      pypiArtifact(fixture.sourceName, fixture.files.get(fixture.sourceName)),
      pypiArtifact('openrappter-1.10.0-cp312-manylinux.whl', Buffer.from('extra')),
    ],
  });
  assert.equal(result.status, 'conflict');
  assert.ok(result.errors.some((error) => error.includes('sha256 mismatch')));
  assert.ok(result.errors.some((error) => error.includes('unexpected artifact')));
});

test('models a resumable split release with npm complete and PyPI absent', async () => {
  const fixture = artifactFixture();
  const npm = await inspectFixture(
    'npm',
    npmMetadata(fixture.npmName, fixture.files.get(fixture.npmName)),
  );
  const pypi = await inspectFixture('pypi', null);
  assert.equal(npm.result.status, 'matching');
  assert.equal(pypi.result.status, 'absent');
  assert.deepEqual(pypi.result.missingArtifacts.sort(), [
    fixture.sourceName,
    fixture.wheelName,
  ].sort());
});

test('waits through absent and partial registry states until exact artifacts match', async () => {
  const states = [
    { registry: 'pypi', status: 'absent', errors: [] },
    { registry: 'pypi', status: 'partial', errors: [] },
    { registry: 'pypi', status: 'matching', errors: [] },
  ];
  let delays = 0;
  const result = await waitForRegistryArtifacts({
    registry: 'pypi',
    attempts: 3,
    retryDelayMs: 0,
    inspect: async () => states.shift(),
    delay: async () => { delays += 1; },
  });
  assert.equal(result.status, 'matching');
  assert.equal(delays, 2);
});

test('registry verification rejects conflicts immediately', async () => {
  let calls = 0;
  await assert.rejects(
    waitForRegistryArtifacts({
      registry: 'npm',
      attempts: 3,
      inspect: async () => {
        calls += 1;
        return {
          registry: 'npm',
          status: 'conflict',
          errors: ['integrity mismatch'],
        };
      },
      delay: async () => {},
    }),
    /integrity mismatch/,
  );
  assert.equal(calls, 1);
});

test('release workflows retain per-tag builds and globally serialize publication', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  const macosWorkflow = readFileSync(
    new URL('../.github/workflows/release-bar.yml', import.meta.url),
    'utf8',
  );

  assert.match(
    workflow,
    /group: openrappter-release-packages-\$\{\{ github\.ref_name \}\}/,
  );
  assert.match(
    macosWorkflow,
    /group: openrappter-release-macos-\$\{\{ github\.ref_name \}\}/,
  );
  assert.match(
    workflow,
    /publish-registries:[\s\S]*?concurrency:\s*\n\s*group: openrappter-registry-publication\s*\n\s*cancel-in-progress: false/,
  );
});

test('Install Smoke runs whenever any shell script changes', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/install-smoke.yml', import.meta.url),
    'utf8',
  );
  const pathsBlock =
    workflow.match(/paths: &install-smoke-paths\n(?<paths>(?:\s+- .*\n)+)/)
      ?.groups?.paths ?? '';
  assert.match(pathsBlock, /^\s+- '\*\*\/\*\.sh'$/m);
  assert.doesNotMatch(
    pathsBlock.replace(/^\s+- '\*\*\/\*\.sh'\n/m, ''),
    /^\s+- '\*\*\/\*\.sh'$/m,
  );
});

test('macOS workflow validates tag provenance and never injects output into shell', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release-bar.yml', import.meta.url),
    'utf8',
  );
  const validation = workflow.indexOf('- name: Validate exact macOS release tag');
  const checkout = workflow.search(/- uses: actions\/checkout@[0-9a-f]{40}/);
  const provenance = workflow.indexOf('- name: Require release commit on main');
  assert.ok(checkout >= 0 && validation > checkout && provenance > validation);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/,
  );
  assert.ok(workflow.includes(
    '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-bar$',
  ));
  assert.doesNotMatch(workflow, /run:\s*VERSION=\$\{\{/);
  const versionedBuild =
    /VERSION="\$RELEASE_VERSION"\s*\\\s*\n[\s\S]*?\bbash scripts\/build-mac-app\.sh/;
  assert.match(workflow, versionedBuild);
  // Prove the assertion is about the version wiring and the real build
  // command, not merely two unrelated strings somewhere in the file.
  assert.doesNotMatch(
    workflow.replace('VERSION="$RELEASE_VERSION" \\', 'VERSION="1.2.3" \\'),
    versionedBuild,
  );
  assert.doesNotMatch(
    workflow.replace('bash scripts/build-mac-app.sh', 'bash scripts/other.sh'),
    versionedBuild,
  );
});

test('registry publication reconciles exact artifacts and selects an explicit npm tag', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(workflow, /\n  publish-npm:/);
  assert.doesNotMatch(workflow, /\n  publish-pypi:/);
  assert.match(workflow, /--check-registry pypi[\s\S]*--stage-missing-dir pypi-dist/);
  assert.match(workflow, /--check-registry npm/);
  assert.match(workflow, /--require-present/);
  assert.ok(
    workflow.indexOf('- name: Preflight npm artifact identity')
      < workflow.indexOf('- name: Publish only missing PyPI artifacts with OIDC'),
  );
  assert.match(workflow, /--npm-publish-tag-candidate "\$RELEASE_VERSION"/);
  assert.match(workflow, /latest\|alpha\|beta\|rc\|"\$historical_tag"/);
  assert.match(
    workflow,
    /prerelease: \$\{\{ needs\.preflight\.outputs\.prerelease == 'true' \}\}/,
  );
  assert.match(workflow, /release-dist\/openrappter-\*-py3-none-any\.whl/);
  assert.match(workflow, /release-dist\/openrappter-\*\.tar\.gz/);
  const publishStart = workflow.indexOf('          npm publish \\');
  const publishEnd = workflow.indexOf('\n\n      - name:', publishStart);
  assert.notEqual(publishStart, -1);
  const publishCommand = workflow.slice(publishStart, publishEnd);
  assert.match(publishCommand, /--tag "\$NPM_PUBLISH_TAG"/);
  assert.equal((workflow.match(/^\s+npm publish \\\s*$/gm) || []).length, 1);
  assert.match(workflow, /"build==1\.5\.1"[\s\S]*"hatchling==1\.31\.0"/);
  assert.match(workflow, /python -m build --no-isolation/);
  assert.match(workflow, /overwrite: true/);
  assert.match(workflow, /overwrite_files: false/);
  assert.match(
    workflow,
    /preflight:[\s\S]*?Require release commit on main[\s\S]*?git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/,
  );
  assert.match(
    workflow,
    /publish-registries:[\s\S]*?needs: \[preflight, smoke-artifacts, build-electron-artifacts, release-constitution\]/,
  );
  assert.match(
    workflow,
    /needs: \[preflight, publish-registries, build-electron-artifacts, release-constitution\]/,
  );
  assert.match(workflow, /node scripts\/pack-locked\.mjs/);
  const desktopJob = workflow.slice(
    workflow.indexOf('  build-electron-artifacts:'),
    workflow.indexOf('  build-artifacts:'),
  );
  assert.ok(
    desktopJob.indexOf('- name: Install desktop dependencies')
      < desktopJob.indexOf('- name: Prepare macOS notarization key'),
  );
  assert.doesNotMatch(
    desktopJob.slice(0, desktopJob.indexOf('    steps:')),
    /MACOS_CERTIFICATE|APPLE_API_KEY/,
  );
  assert.match(workflow, /desktop-dist\/\*\.dmg/);
  assert.match(workflow, /desktop-dist\/\*\.exe/);
  assert.match(workflow, /desktop-dist\/\*\.AppImage/);
  assert.match(desktopJob, /WINDOWS_CERTIFICATE_P12_BASE64/);
  assert.match(desktopJob, /Get-AuthenticodeSignature/);
  assert.match(workflow, /npm audit --audit-level=high/);
});

test('parsed release workflow preserves the privileged dependency graph', () => {
  const workflow = parseYaml(readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(
    workflow.jobs['publish-registries'].needs,
    ['preflight', 'smoke-artifacts', 'build-electron-artifacts', 'release-constitution'],
  );
  assert.deepEqual(
    workflow.jobs['github-release'].needs,
    ['preflight', 'publish-registries', 'build-electron-artifacts', 'release-constitution'],
  );
  assert.equal(
    workflow.jobs.preflight.steps.some(
      (step) =>
        step.name === 'Require release commit on main' &&
        String(step.run).includes(
          'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
        ),
    ),
    true,
  );
  const desktopStepNames = workflow.jobs['build-electron-artifacts'].steps
    .map((step) => step.name)
    .filter(Boolean);
  for (const stepName of [
    'Smoke packaged macOS application',
    'Smoke packaged Linux application',
    'Smoke packaged Windows application',
    'Require signed Windows release',
  ]) {
    assert.ok(desktopStepNames.includes(stepName), `missing ${stepName}`);
  }
});

test('macOS Bar release assets are immutable on rerun', () => {
  const workflow = parseYaml(readFileSync(
    new URL('../.github/workflows/release-bar.yml', import.meta.url),
    'utf8',
  ));
  const releaseStep = workflow.jobs['build-and-release'].steps.find(
    (step) => step.name === 'Upload DMG as release asset',
  );
  assert.equal(releaseStep.with.overwrite_files, false);
});

test('Windows Electron CI runs the complete smoke scope', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/desktop.yml', import.meta.url),
    'utf8',
  );
  const windowsSmoke = workflow.slice(
    workflow.indexOf('- name: Run real Electron smoke on Windows'),
    workflow.indexOf('- name: Build unpacked macOS application'),
  );
  assert.match(windowsSmoke, /OPENRAPPTER_DESKTOP_SMOKE = "1"/);
  assert.doesNotMatch(windowsSmoke, /OPENRAPPTER_DESKTOP_SMOKE_SCOPE/);
});

test('privileged release actions are pinned to immutable commits', () => {
  for (const workflowName of ['release.yml', 'release-bar.yml']) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${workflowName}`, import.meta.url),
      'utf8',
    );
    const externalUses = [...workflow.matchAll(
      /^\s*-?\s*uses:\s*([^./\s][^@\s]*)@([^\s#]+)\s*$/gm,
    )];
    assert.ok(externalUses.length > 0);
    for (const [, action, ref] of externalUses) {
      assert.match(
        ref,
        /^[0-9a-f]{40}$/,
        `${action} in ${workflowName} is not pinned`,
      );
    }
  }
});

test('generated macOS release notes use the live Homebrew tap', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release-bar.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /brew tap kody-w\/tap/);
  assert.doesNotMatch(workflow, /brew tap openrappter\/tap/);
});
