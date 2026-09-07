import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  bytesDigest, canonical, digest, extractCandidate, extractRuntime, installRuntime,
  recoverActivation, validateMetadata, validateRuntimeParts, verifyApproval,
} from '../Resources/verified-runtime-bootstrap.mjs';

const COMMIT = 'a'.repeat(40);
const VERSION = '1.14.0';
const signal = () => new AbortController().signal;

function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    for (const [offset, length, value] of [[100, 8, entry.mode ?? 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    }
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

async function fixture(t, runtimeEntries, { chunked = false } = {}) {
  const root = path.join(process.cwd(), `.bootstrap-test-${crypto.randomUUID()}`);
  await fs.mkdir(root, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  const node = Buffer.from('fixture verified Node bytes');
  const nodeExecutable = path.join(workspace, 'node');
  await fs.writeFile(nodeExecutable, node);
  const runtime = tar(runtimeEntries ?? [
    { name: 'runtime/', type: '5', mode: 0o755 },
    { name: 'runtime/package.json', data: JSON.stringify({ name: 'openrappter', version: VERSION }) },
    { name: 'runtime/dist/index.js', data: 'export const verified = true;\n', mode: 0o755 },
    { name: 'runtime/node_modules/module.js', data: 'module.exports = {};\n' },
    { name: 'runtime/node_modules/.bin/module', type: '2', link: '../module.js' },
  ]);
  const helperSHA = bytesDigest(Buffer.from('fixture sealed helper'));
  const metadata = {
    schema: 'openrappter-bar-bootstrap/v1', source_commit: COMMIT, version: VERSION,
    approval_url: `https://github.com/kody-w/openrappter/releases/download/v${VERSION}-bar/runtime-bootstrap-proof.json`,
    helper_sha256: helperSHA,
    variants: Object.fromEntries(['arm64', 'x86_64'].map(architecture => {
      const nodeRoot = `node-v24.19.0-darwin-${architecture === 'x86_64' ? 'x64' : architecture}`;
      return [architecture, {
        node: {
          version: '24.19.0', url: `https://nodejs.org/dist/v24.19.0/${nodeRoot}.tar.gz`,
          sha256: bytesDigest(Buffer.from('fixture Node archive')), size: 10,
          binary_path: `${nodeRoot}/bin/node`, binary_sha256: bytesDigest(node), binary_size: node.length,
        },
        runtime: {
          file: `openrappter-runtime-${VERSION}-darwin-${architecture}.tar.gz`,
          sha256: bytesDigest(runtime), size: runtime.length,
        },
      }];
    })),
  };
  const dmg = Buffer.from('fixture notarized DMG');
  const partPayloads = new Map();
  const descriptors = new Map();
  const runtimeFiles = Object.entries(metadata.variants).flatMap(([architecture, variant]) => {
    if (!chunked) return [[variant.runtime.file, runtime]];
    const parts = [];
    for (let offset = 0; offset < runtime.length; offset += 32 * 1024 * 1024) {
      const bytes = runtime.subarray(offset, offset + 32 * 1024 * 1024);
      const sha = bytesDigest(bytes);
      const file = `runtime-${architecture}-${String(parts.length).padStart(4, '0')}-${sha}.part`;
      parts.push({ file, sha256: sha, size: bytes.length });
      partPayloads.set(file, bytes);
    }
    const descriptor = {
      schema: 'openrappter-runtime-chunks/v1', source_commit: COMMIT, version: VERSION,
      architecture, ...variant.runtime, parts,
    };
    descriptors.set(architecture, descriptor);
    return [[`${variant.runtime.file}.parts.json`, Buffer.from(JSON.stringify(descriptor))]];
  });
  const candidateFiles = new Map([
    [`OpenRappter-Bar-${VERSION}.dmg`, dmg],
    [`OpenRappter-Bar-${VERSION}.dmg.sha256`, Buffer.from(`${bytesDigest(dmg)}  OpenRappter-Bar-${VERSION}.dmg\n`)],
    [`openrappter-${VERSION}.tgz`, Buffer.from('fixture npm tarball')],
    [`openrappter-${VERSION}-py3-none-any.whl`, Buffer.from('fixture wheel')],
    [`openrappter-${VERSION}.tar.gz`, Buffer.from('fixture sdist')],
    ['install.sh', Buffer.from('fixture verified installer')],
    ['install.ps1', Buffer.from('fixture verified installer')],
    ...runtimeFiles,
  ]);
  const bar = {
    schema: 'openrappter-bar-candidate/v1', source_commit: COMMIT, version: VERSION,
    release_tag: `v${VERSION}-bar`, architectures: ['arm64', 'x86_64'],
    dmg: { name: `OpenRappter-Bar-${VERSION}.dmg`, sha256: bytesDigest(dmg), size: dmg.length },
    notarization: { id: '12345678-1234-1234-1234-123456789abc', status: 'Accepted' },
  };
  candidateFiles.set('macos-bar.json', Buffer.from(JSON.stringify(bar)));
  const provenance = {
    schema: 'openrappter-candidate-provenance/v1', channel: 'candidate', stable: false,
    source_repository: 'kody-w/openrappter', source_commit: COMMIT, source_tag: null,
    source_date_epoch: 1_700_000_000, candidate_kind: 'release',
    candidate_id: `tag-${Buffer.from(`v${VERSION}`).toString('base64url')}`,
    intended_release_tag: `v${VERSION}`,
    versions: { npm: VERSION, pypi: VERSION, runtime: VERSION, channel: '0.1.0-beta.11' },
    files: [...candidateFiles].map(([name, bytes]) => ({ path: name, sha256: bytesDigest(bytes) })),
  };
  candidateFiles.set('provenance.json', Buffer.from(JSON.stringify(provenance)));
  candidateFiles.set('SHA256SUMS', Buffer.from([...candidateFiles].map(([name, bytes]) => `${bytesDigest(bytes)}  ${name}\n`).join('')));
  const candidate = tar([...candidateFiles].map(([name, data]) => ({ name: `./${name}`, data })));
  const sha = bytesDigest(candidate);
  const candidateURL = `https://raw.githubusercontent.com/kody-w/openrappter/${'b'.repeat(40)}/candidates/${COMMIT}/release/${provenance.candidate_id}/${sha}.tar.gz`;
  const documents = new Map();
  const receipts = [];
  let predecessor = 'f'.repeat(64);
  for (const [index, ring] of ['nightly', 'alpha', 'canary', 'beta'].entries()) {
    const id = String(index + 1).repeat(64);
    const targetCommit = String(index + 1).repeat(40);
    const manifest = {
      schema: 'openrappter-ring/v1', ring,
      source: { repository: 'kody-w/openrappter', commit: COMMIT, tag: null },
      version: VERSION, artifact: {
        url: candidateURL, install_url: candidateURL, sha256: sha, provenance: 'github-candidate-bundle-sha256',
      },
      promoted_at: '2026-01-01T00:00:00Z', predecessor: index ? ['nightly', 'alpha', 'canary'][index - 1] : null,
      status: 'published', reason: null, receipt: null, promotion_id: id,
      intended_release_tag: `v${VERSION}`, channel_version: '0.1.0-beta.11',
    };
    const receipt = {
      schema: 'openrappter-promotion-receipt/v1', promotion_id: id,
      target_repository: `kody-w/openrappter-${ring}`, target_ring: ring,
      target_manifest_sha256: digest(manifest), target_manifest_commit: targetCommit,
      source_repository: 'kody-w/openrappter', source_commit: COMMIT, source_tag: null,
      version: VERSION, artifact_url: candidateURL, install_url: candidateURL,
      artifact_sha256: sha, artifact_provenance: 'github-candidate-bundle-sha256',
      predecessor_manifest_sha256: predecessor, emitted_at: `2026-01-01T00:00:0${index}Z`,
      receipt_kind: 'promotion', sequence: index + 1,
      intended_release_tag: `v${VERSION}`, channel_version: '0.1.0-beta.11',
    };
    const url = `https://raw.githubusercontent.com/kody-w/openrappter-release-train/${'c'.repeat(40)}/receipts/${ring}/${id}.json`;
    receipts.push({ ring, url, sha256: digest(receipt) });
    documents.set(url, receipt);
    documents.set(`https://raw.githubusercontent.com/kody-w/openrappter-${ring}/${targetCommit}/.ring/manifest.json`, manifest);
    predecessor = digest(manifest);
  }
  const proof = {
    schema: 'openrappter-bar-cask-proposal/v1', source_commit: COMMIT, version: VERSION,
    url: `https://github.com/kody-w/openrappter/releases/download/v${VERSION}-bar/OpenRappter-Bar-${VERSION}.dmg`,
    sha256: bytesDigest(dmg), candidate_sha256: sha,
    authority_receipt_url: receipts[3].url, authority_receipt_sha256: receipts[3].sha256,
    authority_receipts: receipts, publication: 'proposal-only',
  };
  documents.set(metadata.approval_url, proof);
  let executions = 0;
  const events = [];
  const options = {
    metadata, architecture: 'arm64', home, workspace, nodeExecutable,
    signal: signal(), progress: event => events.push(event.phase),
    getJSON: async url => {
      assert.ok(documents.has(url), `unexpected network request: ${url}`);
      return structuredClone(documents.get(url));
    },
    downloadArtifact: async (url, destination, expectedSHA) => {
      const base = candidateURL.slice(0, candidateURL.lastIndexOf('/') + 1);
      if (url !== candidateURL && url.startsWith(base) && partPayloads.has(url.slice(base.length))) {
        await fs.writeFile(destination, partPayloads.get(url.slice(base.length)), { flag: 'wx' });
        return;
      }
      assert.equal(url, candidateURL);
      assert.equal(expectedSHA, sha);
      await fs.writeFile(destination, candidate, { flag: 'wx' });
    },
    verifyRuntime: async (directory, version) => {
      executions += 1;
      assert.equal(version, VERSION);
      assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'package.json'))).version, VERSION);
    },
  };
  return { root, home, workspace, nodeExecutable, metadata, runtime, candidate, proof, documents, options, events, partPayloads, descriptors, executions: () => executions };
}

test('canonical receipt hashes match the authority ASCII JSON contract', () => {
  assert.equal(canonical({ z: 'é 🦖', a: 1 }), '{"a":1,"z":"\\u00e9 \\ud83e\\udd96"}');
});

test('both architecture pins bind official versioned Node and the exact Bar source', async t => {
  const f = await fixture(t);
  for (const arch of ['arm64', 'x86_64']) assert.ok(validateMetadata(f.metadata, arch, VERSION, COMMIT));
  assert.throws(() => validateMetadata(f.metadata, 'arm64', '1.13.0', COMMIT), /identity/);
  assert.throws(() => validateMetadata(f.metadata, 'arm64', VERSION, 'f'.repeat(40)), /identity/);
  assert.throws(() => validateMetadata(f.metadata, 'linux', VERSION, COMMIT), /architecture/);
  f.metadata.variants.arm64.node.url = 'https://nodejs.org/dist/latest/node.tar.gz';
  assert.throws(() => validateMetadata(f.metadata, 'arm64', VERSION, COMMIT), /exact/);
});

test('the frozen complete receipt chain authorizes one exact candidate', async t => {
  const f = await fixture(t);
  const approval = await verifyApproval(f.proof, f.metadata, f.options.getJSON);
  assert.equal(approval.sha256, bytesDigest(f.candidate));
});

for (const mutation of ['missing ring', 'mutable reference', 'bootstrap receipt', 'wrong source', 'broken predecessor', 'out of order', 'unpublished manifest']) {
  test(`approval refuses ${mutation}`, async t => {
    const f = await fixture(t);
    if (mutation === 'missing ring') f.proof.authority_receipts.pop();
    if (mutation === 'mutable reference') f.proof.authority_receipts[0].url = f.proof.authority_receipts[0].url.replace('c'.repeat(40), 'main');
    const reference = f.proof.authority_receipts[1];
    const receipt = f.documents.get(reference.url);
    if (mutation === 'bootstrap receipt') receipt.receipt_kind = 'bootstrap';
    if (mutation === 'wrong source') receipt.source_commit = 'e'.repeat(40);
    if (mutation === 'broken predecessor') receipt.predecessor_manifest_sha256 = '0'.repeat(64);
    if (mutation === 'out of order') receipt.emitted_at = '2025-01-01T00:00:00Z';
    if (mutation === 'unpublished manifest') {
      const url = `https://raw.githubusercontent.com/kody-w/openrappter-alpha/${receipt.target_manifest_commit}/.ring/manifest.json`;
      const manifest = f.documents.get(url);
      manifest.status = 'unpublished';
      receipt.target_manifest_sha256 = digest(manifest);
    }
    reference.sha256 = digest(receipt);
    await assert.rejects(verifyApproval(f.proof, f.metadata, f.options.getJSON));
  });
}

test('positive first launch installs without npm, existing Node, or a runtime in the user home', async t => {
  const f = await fixture(t);
  const marker = await installRuntime(f.options);
  assert.equal(f.executions(), 1);
  assert.equal(marker.source_commit, COMMIT);
  const current = path.join(f.home, '.local/share/openrappter/current');
  assert.equal(JSON.parse(await fs.readFile(path.join(current, 'package.json'))).version, VERSION);
  assert.equal(await fs.readFile(path.join(current, 'node_modules/.bin/module'), 'utf8'), 'module.exports = {};\n');
  const stored = JSON.parse(await fs.readFile(path.join(f.home, '.openrappter/runtime-bootstrap-installation.json')));
  assert.deepEqual(stored, marker);
  assert.equal(f.events.at(-1), 'installed');
  assert.equal(await fs.stat(path.join(f.home, '.local/share/openrappter/releases', marker.installation_id, 'node/bin/node')).then(s => s.mode & 0o777), 0o700);
});

test('chunked first launch reassembles only the selected architecture from the same immutable commit', async t => {
  const f = await fixture(t, undefined, { chunked: true });
  const urls = [];
  const download = f.options.downloadArtifact;
  f.options.downloadArtifact = async (...args) => { urls.push(args[0]); return download(...args); };
  const marker = await installRuntime(f.options);
  assert.equal(marker.runtime_sha256, bytesDigest(f.runtime));
  assert.equal(f.executions(), 1);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes(`/runtime-arm64-0000-${bytesDigest(f.runtime)}.part`));
  assert.equal(urls[0].slice(0, urls[0].lastIndexOf('/')), urls[1].slice(0, urls[1].lastIndexOf('/')));
  assert.ok(f.events.includes('downloading-runtime-parts'));
});

test('a tampered runtime chunk never reaches extraction or execution', async t => {
  const f = await fixture(t, undefined, { chunked: true });
  const descriptor = f.descriptors.get('arm64');
  f.partPayloads.set(descriptor.parts[0].file, Buffer.alloc(descriptor.parts[0].size));
  await assert.rejects(installRuntime(f.options), /part checksum/);
  assert.equal(f.executions(), 0);
  await assert.rejects(fs.lstat(path.join(f.home, '.local/share/openrappter/current')), { code: 'ENOENT' });
});

test('multiple verified chunks preserve a complete archive across the 32-MiB boundary', async t => {
  const f = await fixture(t, [
    { name: 'runtime/package.json', data: JSON.stringify({ name: 'openrappter', version: VERSION }) },
    { name: 'runtime/dist/index.js', data: 'export const ready = true;' },
    { name: 'runtime/assets/payload.bin', data: randomBytes(33 * 1024 * 1024) },
  ], { chunked: true });
  assert.equal(f.descriptors.get('arm64').parts.length, 2);
  assert.equal(f.descriptors.get('arm64').parts[0].size, 32 * 1024 * 1024);
  const marker = await installRuntime(f.options);
  assert.equal(marker.runtime_sha256, bytesDigest(f.runtime));
  const current = path.join(f.home, '.local/share/openrappter/current');
  assert.equal((await fs.stat(path.join(current, 'assets/payload.bin'))).size, 33 * 1024 * 1024);
});

test('chunk descriptors refuse traversal, wrong identity, order, and oversized parts', async t => {
  const f = await fixture(t, undefined, { chunked: true });
  for (const mutate of [
    value => { value.source_commit = 'f'.repeat(40); },
    value => { value.parts[0].file = '../escape'; },
    value => { value.parts[0].file = value.parts[0].file.replace('-0000-', '-0001-'); },
    value => { value.parts[0].size = 33 * 1024 * 1024; },
    value => { value.parts[0].size -= 1; },
    value => { value.parts.push(structuredClone(value.parts[0])); },
    value => { value.parts[0].url = 'https://example.com/part'; },
  ]) {
    const value = structuredClone(f.descriptors.get('arm64'));
    mutate(value);
    assert.throws(() => validateRuntimeParts(value, f.metadata, 'arm64'));
  }
});

test('default offline smoke executes only dependencies carried in the verified archive', async t => {
  const f = await fixture(t, [
    { name: 'runtime/package.json', data: JSON.stringify({ name: 'openrappter', version: VERSION }) },
    { name: 'runtime/dist/index.js', data: 'export const ready = true;' },
    { name: 'runtime/node_modules/better-sqlite3/index.js', data: 'module.exports = () => ({close(){}});' },
    { name: 'runtime/node_modules/sharp/index.js', data: 'module.exports = {};' },
  ]);
  delete f.options.verifyRuntime;
  const result = await installRuntime(f.options);
  assert.equal(result.version, VERSION);
});

test('an incomplete dependency closure cannot execute a module from elsewhere in the user home', async t => {
  const f = await fixture(t, [
    { name: 'runtime/package.json', data: JSON.stringify({ name: 'openrappter', version: VERSION }) },
    { name: 'runtime/dist/index.js', data: 'export const ready = true;' },
    { name: 'runtime/node_modules/better-sqlite3/index.js', data: "require('not-carried'); module.exports = () => ({close(){}});" },
    { name: 'runtime/node_modules/sharp/index.js', data: 'module.exports = {};' },
  ]);
  const outside = path.join(f.home, 'node_modules/not-carried');
  const effect = path.join(f.root, 'unverified-code-ran');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(effect)},'bad');`);
  delete f.options.verifyRuntime;
  await assert.rejects(installRuntime(f.options), /escaped the verified archive/);
  await assert.rejects(fs.lstat(effect), { code: 'ENOENT' });
});

test('unapproved release fails before candidate download or execution', async t => {
  const f = await fixture(t);
  f.options.getJSON = async () => { throw new Error('Approval not published'); };
  let downloads = 0;
  f.options.downloadArtifact = async () => { downloads += 1; };
  await assert.rejects(installRuntime(f.options), /Approval not published/);
  assert.equal(downloads + f.executions(), 0);
});

test('changed candidate bytes are refused before extraction or execution', async t => {
  const f = await fixture(t);
  f.options.downloadArtifact = async (_, destination) => { await fs.writeFile(destination, 'tampered'); };
  await assert.rejects(installRuntime(f.options), /differs from frozen receipts/);
  assert.equal(f.executions(), 0);
});

test('the sealed runtime archive pin cannot be replaced by a rewritten candidate manifest', async t => {
  const f = await fixture(t);
  f.metadata.variants.arm64.runtime.sha256 = '0'.repeat(64);
  await assert.rejects(installRuntime(f.options), /signed Bar pins/);
  assert.equal(f.executions(), 0);
});

test('changed Node bytes are refused before execution', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.nodeExecutable, 'replacement');
  await assert.rejects(installRuntime(f.options), /Node changed/);
  assert.equal(f.executions(), 0);
});

test('Desktop authority appearing before activation preserves existing selection', async t => {
  const f = await fixture(t);
  f.options.authorizeCommit = async () => false;
  await assert.rejects(installRuntime(f.options), /Desktop became authoritative/);
  await assert.rejects(fs.lstat(path.join(f.home, '.local/share/openrappter/current')), { code: 'ENOENT' });
  const releases = await fs.readdir(path.join(f.home, '.local/share/openrappter/releases'));
  assert.deepEqual(releases, []);
});

test('cancelled download cleans private staging and never activates', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.options.signal = abort.signal;
  f.options.downloadArtifact = async () => { abort.abort(); throw abort.signal.reason; };
  await assert.rejects(installRuntime(f.options));
  await assert.rejects(fs.lstat(path.join(f.home, '.local/share/openrappter/current')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(f.home, '.openrappter/runtime-bootstrap.lock')), { code: 'ENOENT' });
});

test('a late activation failure restores previous runtime and marker', async t => {
  const f = await fixture(t);
  const releases = path.join(f.home, '.local/share/openrappter/releases');
  const current = path.join(f.home, '.local/share/openrappter/current');
  await fs.mkdir(path.join(releases, 'previous/runtime'), { recursive: true });
  await fs.symlink(path.join(releases, 'previous/runtime'), current);
  await fs.mkdir(path.join(f.home, '.openrappter'), { recursive: true });
  const markerFile = path.join(f.home, '.openrappter/runtime-bootstrap-installation.json');
  const previous = Buffer.from('{"previous":"untouched"}');
  await fs.writeFile(markerFile, previous);
  f.options.progress = event => { if (event.phase === 'installed') throw new Error('simulated late failure'); };
  await assert.rejects(installRuntime(f.options), /simulated late failure/);
  assert.equal(await fs.readlink(current), path.join(releases, 'previous/runtime'));
  assert.deepEqual(await fs.readFile(markerFile), previous);
});

test('custom runtime selection is not overwritten', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, '.openrappter'), { recursive: true });
  const config = path.join(f.home, '.openrappter/config.json');
  const previous = '{"projectPath":"/operator/custom/runtime","other":"kept"}';
  await fs.writeFile(config, previous);
  await assert.rejects(installRuntime(f.options), /custom runtime/);
  assert.equal(await fs.readFile(config, 'utf8'), previous);
});

test('an absolute pin to an older managed release cannot falsely activate a different runtime', async t => {
  const f = await fixture(t);
  const privateData = path.join(f.home, '.openrappter');
  await fs.mkdir(privateData);
  const original = JSON.stringify({ projectPath: path.join(f.home, '.local/share/openrappter/releases/older/runtime') });
  await fs.writeFile(path.join(privateData, 'config.json'), original);
  await assert.rejects(installRuntime(f.options), /custom runtime/);
  assert.equal(await fs.readFile(path.join(privateData, 'config.json'), 'utf8'), original);
  await assert.rejects(fs.lstat(path.join(f.home, '.local/share/openrappter/current')), { code: 'ENOENT' });
});

test('post-marker recovery finalizes the verified installation without a delayed destructive rollback', async t => {
  const f = await fixture(t);
  const marker = await installRuntime(f.options);
  const privateData = path.join(f.home, '.openrappter');
  const current = path.join(f.home, '.local/share/openrappter/current');
  const journal = path.join(privateData, 'runtime-bootstrap-transaction.json');
  await fs.writeFile(journal, JSON.stringify({
    schema: 'openrappter-bootstrap-activation/v1', installation_id: marker.installation_id,
    new_current: await fs.readlink(current), previous_current: null, previous_marker: null,
  }));
  f.options.getJSON = async () => { throw new Error('offline after completed activation'); };
  const recovered = await installRuntime(f.options);
  assert.deepEqual(recovered, marker);
  assert.equal(JSON.parse(await fs.readFile(path.join(current, 'package.json'))).version, VERSION);
  await assert.rejects(fs.lstat(journal), { code: 'ENOENT' });
});

test('interrupted activation is rolled back from its journal without trusting a partial marker', async t => {
  const f = await fixture(t);
  const privateData = path.join(f.home, '.openrappter');
  const releases = path.join(f.home, '.local/share/openrappter/releases');
  const current = path.join(f.home, '.local/share/openrappter/current');
  const id = `${COMMIT}-arm64-${f.metadata.variants.arm64.runtime.sha256}`;
  const original = Buffer.from('{"previous":"preserved"}');
  const previousCurrent = path.join(releases, 'previous/runtime');
  await fs.mkdir(privateData, { recursive: true });
  await fs.mkdir(path.join(releases, id, 'runtime'), { recursive: true });
  await fs.mkdir(previousCurrent, { recursive: true });
  await fs.symlink(path.join(releases, id, 'runtime'), current);
  await fs.writeFile(path.join(privateData, 'runtime-bootstrap-installation.json'), JSON.stringify({ installation_id: id }));
  await fs.writeFile(path.join(privateData, 'runtime-bootstrap-transaction.json'), JSON.stringify({
    schema: 'openrappter-bootstrap-activation/v1', installation_id: id,
    new_current: path.join(releases, id, 'runtime'), previous_current: previousCurrent,
    previous_marker: original.toString('base64'),
  }));
  await recoverActivation(privateData, releases, current);
  assert.equal(await fs.readlink(current), previousCurrent);
  assert.deepEqual(await fs.readFile(path.join(privateData, 'runtime-bootstrap-installation.json')), original);
  await assert.rejects(fs.lstat(path.join(releases, id)), { code: 'ENOENT' });
});

test('a journal never overwrites an independently changed runtime selection', async t => {
  const f = await fixture(t);
  const privateData = path.join(f.home, '.openrappter');
  const releases = path.join(f.home, '.local/share/openrappter/releases');
  const current = path.join(f.home, '.local/share/openrappter/current');
  const id = `${COMMIT}-arm64-${f.metadata.variants.arm64.runtime.sha256}`;
  await fs.mkdir(privateData, { recursive: true });
  await fs.mkdir(releases, { recursive: true });
  const selected = path.join(releases, 'operator-selected/runtime');
  await fs.symlink(selected, current);
  await fs.writeFile(path.join(privateData, 'runtime-bootstrap-transaction.json'), JSON.stringify({
    schema: 'openrappter-bootstrap-activation/v1', installation_id: id,
    new_current: path.join(releases, id, 'runtime'), previous_current: null, previous_marker: null,
  }));
  await assert.rejects(recoverActivation(privateData, releases, current), /selection changed/);
  assert.equal(await fs.readlink(current), selected);
});

test('automatic downgrade does not bypass the rollback policy', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, '.openrappter'), { recursive: true });
  const marker = path.join(f.home, '.openrappter/runtime-bootstrap-installation.json');
  const original = '{"version":"99.0.0"}';
  await fs.writeFile(marker, original);
  await assert.rejects(installRuntime(f.options), /downgrade/);
  assert.equal(await fs.readFile(marker, 'utf8'), original);
});

for (const [name, entries] of [
  ['traversal', [{ name: 'runtime/../escape', data: 'bad' }]],
  ['absolute path', [{ name: '/runtime/escape', data: 'bad' }]],
  ['escaping symlink', [{ name: 'runtime/link', type: '2', link: '../../escape' }]],
  ['device member', [{ name: 'runtime/device', type: '3' }]],
  ['case collision', [{ name: 'runtime/File', data: 'a' }, { name: 'runtime/file', data: 'b' }]],
  ['symlink cycle', [{ name: 'runtime/a', type: '2', link: 'b' }, { name: 'runtime/b', type: '2', link: 'a' }]],
  ['symlink ancestor', [{ name: 'runtime/a', type: '2', link: 'b' }, { name: 'runtime/a/file', data: 'bad' }, { name: 'runtime/b', type: '5' }]],
]) {
  test(`safe extraction rejects ${name}`, async t => {
    const f = await fixture(t);
    const archive = path.join(f.workspace, 'unsafe.tar.gz');
    await fs.writeFile(archive, tar(entries));
    await assert.rejects(extractRuntime(archive, path.join(f.workspace, 'output'), signal()));
    await assert.rejects(fs.lstat(path.join(f.root, 'escape')), { code: 'ENOENT' });
  });
}

test('candidate archive cannot inject directory or symlink members', async t => {
  const f = await fixture(t);
  const archive = path.join(f.workspace, 'unsafe-candidate.tar.gz');
  await fs.writeFile(archive, tar([{ name: 'unsafe', type: '2', link: '../outside' }]));
  await assert.rejects(extractCandidate(archive, path.join(f.workspace, 'candidate'), f.metadata, 'arm64', f.proof, signal()), /flat regular/);
});
