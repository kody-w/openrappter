import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  REQUIRED_RELEASE_FILES,
  validateReleaseState,
  waitForRegistryArtifacts,
} from './release-preflight.mjs';

const VERSION = '1.10.0';
const PACKAGE_NAME = 'openrappter';

function validState(overrides = {}) {
  return {
    tag: `v${VERSION}`,
    typescriptPackageName: PACKAGE_NAME,
    typescriptPackageVersion: VERSION,
    typescriptPackageLockVersion: VERSION,
    typescriptPackageLockRootVersion: VERSION,
    pythonProjectName: PACKAGE_NAME,
    pythonProjectVersion: VERSION,
    typescriptRuntimeVersion: VERSION,
    pythonRuntimeVersion: VERSION,
    typescriptRuntimeSourceValid: true,
    existingFiles: [...REQUIRED_RELEASE_FILES],
    artifactNames: expectedArtifactNames(VERSION),
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

test('rejects a tag that does not match package and runtime versions', () => {
  const errors = validateReleaseState(validState({
    tag: 'v1.10.1',
    artifactNames: undefined,
  }));

  assert.equal(errors.length, 6);
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

test('rejects malformed package and malicious macOS release tags', () => {
  for (const tag of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-rc.1']) {
    assert.throws(() => parsePackageReleaseTag(tag), /must match vX\.Y\.Z exactly/);
  }

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
    error.includes('typescript/package.json version must match X.Y.Z exactly')));
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

test('orders stable semver numerically and rejects non-release versions', () => {
  assert.equal(compareSemver('1.10.0', '1.9.99'), 1);
  assert.equal(compareSemver('2.0.0', '1.999.999'), 1);
  assert.equal(compareSemver('1.10.0', '1.10.0'), 0);
  assert.equal(compareSemver('1.9.99', '1.10.0'), -1);
  assert.equal(compareSemver('100000000000000000000.0.0', '2.0.0'), 1);
  assert.throws(() => compareSemver('1.10.0-rc.1', '1.10.0'), /must match X\.Y\.Z/);
  assert.throws(() => compareSemver('01.10.0', '1.10.0'), /must match X\.Y\.Z/);
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
    /npm latest version must match X\.Y\.Z/,
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

test('macOS workflow validates the tag before checkout and never injects output into shell', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release-bar.yml', import.meta.url),
    'utf8',
  );
  const validation = workflow.indexOf('- name: Validate exact macOS release tag');
  const checkout = workflow.indexOf('- uses: actions/checkout@v4');
  assert.ok(validation >= 0 && validation < checkout);
  assert.ok(workflow.includes(
    '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-bar$',
  ));
  assert.doesNotMatch(workflow, /run:\s*VERSION=\$\{\{/);
  assert.match(workflow, /VERSION="\$RELEASE_VERSION" bash scripts\/build-mac-app\.sh/);
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
  const publishStart = workflow.indexOf('          npm publish \\');
  const publishEnd = workflow.indexOf('\n\n      - name:', publishStart);
  assert.notEqual(publishStart, -1);
  const publishCommand = workflow.slice(publishStart, publishEnd);
  assert.match(publishCommand, /--tag "\$NPM_PUBLISH_TAG"/);
  assert.equal((workflow.match(/^\s+npm publish \\\s*$/gm) || []).length, 1);
  assert.match(workflow, /"build==1\.5\.1"[\s\S]*"hatchling==1\.31\.0"/);
  assert.match(workflow, /python -m build --no-isolation/);
  assert.match(workflow, /overwrite: true/);
  assert.match(workflow, /overwrite_files: true/);
  assert.match(workflow, /needs: \[preflight, publish-registries\]/);
});

test('generated macOS release notes use the live Homebrew tap', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release-bar.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /brew tap kody-w\/tap/);
  assert.doesNotMatch(workflow, /brew tap openrappter\/tap/);
});
