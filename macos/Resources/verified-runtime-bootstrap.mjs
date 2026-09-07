import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const RINGS = ['nightly', 'alpha', 'canary', 'beta'];
const REPOSITORY = 'kody-w/openrappter';
const AUTHORITY = 'kody-w/openrappter-release-train';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function closed(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} is not closed`);
}

export function canonical(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  // Authority ringctl.py uses Python's ensure_ascii=True canonical JSON.
  return JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const bytesDigest = value => createHash('sha256').update(value).digest('hex');

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    requireValue(result.bytesWritten > 0, 'Installer write made no progress');
    offset += result.bytesWritten;
  }
}

export function validateMetadata(metadata, architecture, version, sourceCommit) {
  closed(metadata, ['schema', 'source_commit', 'version', 'approval_url', 'helper_sha256', 'variants'], 'bootstrap metadata');
  requireValue(metadata.schema === 'openrappter-bar-bootstrap/v1', 'Unknown bootstrap schema');
  requireValue(VERSION.test(metadata.version) && HEX40.test(metadata.source_commit)
    && metadata.version === version && metadata.source_commit === sourceCommit, 'Bar release identity mismatch');
  requireValue(HEX64.test(metadata.helper_sha256), 'The helper must be pinned inside the signed Bar');
  requireValue(metadata.approval_url
    === `https://github.com/${REPOSITORY}/releases/download/v${version}-bar/runtime-bootstrap-proof.json`,
  'Approval must belong to this exact Bar release');
  closed(metadata.variants, ['arm64', 'x86_64'], 'architecture variants');
  requireValue(['arm64', 'x86_64'].includes(architecture), 'Unsupported Bar architecture');
  for (const [arch, variant] of Object.entries(metadata.variants)) {
    closed(variant, ['node', 'runtime'], 'runtime variant');
    const node = variant.node;
    closed(node, ['version', 'url', 'sha256', 'size', 'binary_path', 'binary_sha256', 'binary_size'], 'Node pin');
    requireValue(VERSION.test(node.version) && Number(node.version.split('.')[0]) >= 24, 'Unsupported pinned Node version');
    const nodeArch = arch === 'x86_64' ? 'x64' : arch;
    const root = `node-v${node.version}-darwin-${nodeArch}`;
    requireValue(node.url === `https://nodejs.org/dist/v${node.version}/${root}.tar.gz`
      && node.binary_path === `${root}/bin/node`, 'Node source/architecture must be exact');
    for (const [hash, size] of [[node.sha256, node.size], [node.binary_sha256, node.binary_size]]) {
      requireValue(HEX64.test(hash) && Number.isSafeInteger(size) && size > 0 && size <= 256 * 1024 * 1024,
        'Invalid pinned Node bytes');
    }
    const runtime = variant.runtime;
    closed(runtime, ['file', 'sha256', 'size'], 'runtime archive pin');
    requireValue(runtime.file === `openrappter-runtime-${version}-darwin-${arch}.tar.gz`
      && HEX64.test(runtime.sha256) && Number.isSafeInteger(runtime.size)
      && runtime.size > 0 && runtime.size <= MAX_ARCHIVE / 2, 'Runtime archive identity mismatch');
  }
  return metadata.variants[architecture];
}

function candidateURL(url, metadata, sha) {
  const candidateId = `tag-${Buffer.from(`v${metadata.version}`).toString('base64url')}`;
  const prefix = `https://raw.githubusercontent.com/${REPOSITORY}/`;
  requireValue(typeof url === 'string' && url.startsWith(prefix), 'Candidate authority is not allowlisted');
  const rest = url.slice(prefix.length).split('/');
  requireValue(rest.length === 6 && HEX40.test(rest[0]) && rest[1] === 'candidates'
    && rest[2] === metadata.source_commit && rest[3] === 'release'
    && rest[4] === candidateId && rest[5] === `${sha}.tar.gz`, 'Candidate URL is not immutable or release-bound');
  return url;
}

const RECEIPT_KEYS = [
  'schema', 'promotion_id', 'target_repository', 'target_ring', 'target_manifest_sha256',
  'target_manifest_commit', 'source_repository', 'source_commit', 'source_tag', 'version',
  'artifact_url', 'install_url', 'artifact_sha256', 'artifact_provenance',
  'predecessor_manifest_sha256', 'emitted_at', 'receipt_kind', 'sequence',
  'intended_release_tag', 'channel_version',
];
const MANIFEST_KEYS = [
  'schema', 'ring', 'source', 'version', 'artifact', 'promoted_at', 'predecessor',
  'status', 'reason', 'receipt', 'promotion_id', 'intended_release_tag', 'channel_version',
];

function timestamp(value) {
  requireValue(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 300_000, 'Invalid or future receipt timestamp');
  return Date.parse(value);
}

/** Frozen-chain checks mirror release_gate.validate_chain and ringctl.validate_receipt. */
export async function verifyApproval(proof, metadata, fetchJSON) {
  closed(proof, [
    'schema', 'source_commit', 'version', 'url', 'sha256', 'candidate_sha256',
    'authority_receipt_url', 'authority_receipt_sha256', 'authority_receipts', 'publication',
  ], 'Bar approval proof');
  requireValue(proof.schema === 'openrappter-bar-cask-proposal/v1' && proof.publication === 'proposal-only',
    'Approval must be the existing frozen Bar receipt proof');
  requireValue(proof.source_commit === metadata.source_commit && proof.version === metadata.version
    && HEX64.test(proof.sha256) && HEX64.test(proof.candidate_sha256), 'Approval release identity mismatch');
  requireValue(proof.url === `https://github.com/${REPOSITORY}/releases/download/v${metadata.version}-bar/OpenRappter-Bar-${metadata.version}.dmg`,
    'Approval names another Bar download');
  requireValue(Array.isArray(proof.authority_receipts) && proof.authority_receipts.length === 4,
    'All four finalized ring receipts are required');
  let previousManifest;
  let previousTime;
  let artifactURL;
  let channelVersion;
  const ids = new Set();
  for (const [index, ring] of RINGS.entries()) {
    const reference = proof.authority_receipts[index];
    closed(reference, ['ring', 'url', 'sha256'], 'receipt reference');
    const prefix = `https://raw.githubusercontent.com/${AUTHORITY}/`;
    requireValue(reference.ring === ring && HEX64.test(reference.sha256)
      && typeof reference.url === 'string' && reference.url.startsWith(prefix), 'Receipt order or authority mismatch');
    const parts = reference.url.slice(prefix.length).split('/');
    requireValue(parts.length === 4 && HEX40.test(parts[0]) && parts[1] === 'receipts'
      && parts[2] === ring && /^[0-9a-f]{64}\.json$/.test(parts[3]), 'Receipt reference is not frozen');
    const receipt = await fetchJSON(reference.url);
    closed(receipt, RECEIPT_KEYS, 'promotion receipt');
    requireValue(digest(receipt) === reference.sha256, 'Immutable receipt checksum mismatch');
    requireValue(receipt.schema === 'openrappter-promotion-receipt/v1' && receipt.receipt_kind === 'promotion'
      && receipt.target_repository === `kody-w/openrappter-${ring}` && receipt.target_ring === ring
      && receipt.promotion_id === parts[3].slice(0, -5) && !ids.has(receipt.promotion_id),
    'Receipt was not finalized for this ring');
    ids.add(receipt.promotion_id);
    requireValue(receipt.source_repository === REPOSITORY && receipt.source_commit === metadata.source_commit
      && receipt.source_tag === null && receipt.version === metadata.version
      && receipt.intended_release_tag === `v${metadata.version}`
      && receipt.artifact_provenance === 'github-candidate-bundle-sha256'
      && receipt.artifact_sha256 === proof.candidate_sha256
      && receipt.install_url === receipt.artifact_url, 'Receipt does not authorize these exact bytes');
    candidateURL(receipt.artifact_url, metadata, proof.candidate_sha256);
    if (artifactURL !== undefined) requireValue(artifactURL === receipt.artifact_url, 'Candidate changed between rings');
    artifactURL = receipt.artifact_url;
    requireValue(Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0
      && HEX40.test(receipt.target_manifest_commit) && HEX64.test(receipt.target_manifest_sha256)
      && HEX64.test(receipt.predecessor_manifest_sha256)
      && typeof receipt.channel_version === 'string' && SEMVER.test(receipt.channel_version), 'Malformed receipt identity');
    if (channelVersion !== undefined) requireValue(channelVersion === receipt.channel_version, 'Channel identity changed between rings');
    channelVersion = receipt.channel_version;
    const manifest = await fetchJSON(`https://raw.githubusercontent.com/kody-w/openrappter-${ring}/${receipt.target_manifest_commit}/.ring/manifest.json`);
    closed(manifest, MANIFEST_KEYS, 'ring manifest');
    closed(manifest.source, ['repository', 'commit', 'tag'], 'manifest source');
    closed(manifest.artifact, ['url', 'install_url', 'sha256', 'provenance'], 'manifest artifact');
    requireValue(digest(manifest) === receipt.target_manifest_sha256
      && manifest.schema === 'openrappter-ring/v1' && manifest.ring === ring
      && manifest.status === 'published' && manifest.reason === null && manifest.receipt === null
      && manifest.predecessor === (index === 0 ? null : RINGS[index - 1])
      && manifest.promotion_id === receipt.promotion_id, 'Published immutable manifest mismatch');
    requireValue(manifest.source.repository === REPOSITORY && manifest.source.commit === metadata.source_commit
      && manifest.source.tag === null && manifest.version === metadata.version
      && manifest.intended_release_tag === receipt.intended_release_tag && manifest.channel_version === channelVersion
      && manifest.artifact.url === artifactURL && manifest.artifact.install_url === artifactURL
      && manifest.artifact.sha256 === proof.candidate_sha256
      && manifest.artifact.provenance === receipt.artifact_provenance, 'Manifest source/artifact mismatch');
    timestamp(manifest.promoted_at);
    const emitted = timestamp(receipt.emitted_at);
    requireValue(previousTime === undefined || emitted >= previousTime, 'Receipt timestamps are out of order');
    requireValue(previousManifest === undefined || receipt.predecessor_manifest_sha256 === digest(previousManifest),
      'Receipt does not descend from the prior finalized ring');
    previousTime = emitted;
    previousManifest = manifest;
  }
  const beta = proof.authority_receipts[3];
  requireValue(proof.authority_receipt_url === beta.url && proof.authority_receipt_sha256 === beta.sha256,
    'Beta receipt reference changed');
  return { url: artifactURL, sha256: proof.candidate_sha256, channelVersion };
}

function safeHTTPS(url) {
  const parsed = new URL(url);
  requireValue(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
    && !parsed.hash && ['github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(parsed.hostname),
  'Download host or protocol is not allowlisted');
  return parsed;
}

async function responseFor(url, signal, timeout = 60_000) {
  safeHTTPS(url);
  let target = url;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(target, {
      redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { 'accept-encoding': 'identity' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      target = new URL(response.headers.get('location'), target).href;
      const next = safeHTTPS(target);
      requireValue(next.hostname === 'release-assets.githubusercontent.com', 'Unexpected release download redirect');
      continue;
    }
    requireValue(response.ok && response.status === 200 && response.body,
      'This release has no approved runtime download yet. Retry after its approved release is available.');
    return response;
  }
  throw new Error('Too many release download redirects');
}

export async function fetchJSON(url, signal) {
  const response = await responseFor(url, signal);
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    signal.throwIfAborted();
    size += chunk.length;
    requireValue(size <= MAX_JSON, 'Approval document exceeds its byte limit');
    chunks.push(chunk);
  }
  return JSON.parse(fatalDecoder.decode(Buffer.concat(chunks)));
}

export async function download(url, destination, expectedHash, signal, progress = () => {}) {
  const response = await responseFor(url, signal, 600_000);
  const output = await fsp.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      signal.throwIfAborted();
      size += chunk.length;
      requireValue(size <= MAX_ARCHIVE, 'Candidate download exceeds its byte limit');
      hash.update(chunk);
      await writeAll(output, chunk);
      progress(size);
    }
    await output.sync();
  } finally { await output.close(); }
  requireValue(hash.digest('hex') === expectedHash, 'Candidate archive checksum mismatch');
}

function tarString(bytes) {
  const zero = bytes.indexOf(0);
  return fatalDecoder.decode(zero < 0 ? bytes : bytes.subarray(0, zero));
}

function tarNumber(bytes) {
  const value = tarString(bytes).trim();
  requireValue(/^[0-7]*$/.test(value), 'Unsupported tar numeric encoding');
  const number = Number.parseInt(value || '0', 8);
  requireValue(Number.isSafeInteger(number) && number >= 0, 'Invalid tar number');
  return number;
}

function paxFields(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    requireValue(space > offset, 'Invalid PAX record');
    const length = Number(bytes.subarray(offset, space).toString('ascii'));
    requireValue(Number.isSafeInteger(length) && length > space - offset + 2 && offset + length <= bytes.length
      && bytes[offset + length - 1] === 10, 'Invalid PAX record length');
    const row = fatalDecoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equal = row.indexOf('=');
    requireValue(equal > 0, 'Invalid PAX field');
    const key = row.slice(0, equal);
    requireValue(!Object.hasOwn(fields, key), 'Duplicate PAX field');
    fields[key] = row.slice(equal + 1);
    offset += length;
  }
  return fields;
}

/** Streaming tar reader: no system extraction, special files, or unbounded buffering. */
export async function walkTar(archive, visitor, signal) {
  const source = fs.createReadStream(archive);
  const unzip = createGunzip();
  source.on('error', error => unzip.destroy(error));
  source.pipe(unzip);
  const abort = () => { source.destroy(); unzip.destroy(signal.reason ?? new Error('Cancelled')); };
  signal.addEventListener('abort', abort, { once: true });
  const iterator = unzip[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  let inflated = 0;
  let entries = 0;
  let pax = {};
  let longPath;
  let longLink;
  const take = async (size) => {
    while (buffered.length < size) {
      signal.throwIfAborted();
      const next = await iterator.next();
      requireValue(!next.done, 'Truncated runtime archive');
      inflated += next.value.length;
      requireValue(inflated <= MAX_ARCHIVE, 'Expanded runtime archive exceeds its byte limit');
      buffered = Buffer.concat([buffered, next.value]);
    }
    const value = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return value;
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const header = await take(512);
      if (header.every(byte => byte === 0)) {
        requireValue((await take(512)).every(byte => byte === 0), 'Invalid tar terminator');
        requireValue(buffered.every(byte => byte === 0), 'Trailing archive payload');
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          inflated += chunk.length;
          requireValue(inflated <= MAX_ARCHIVE && chunk.every(byte => byte === 0), 'Trailing archive payload');
        }
        requireValue(!Object.keys(pax).length && longPath === undefined && longLink === undefined, 'Orphaned tar metadata');
        return;
      }
      entries += 1;
      requireValue(entries <= 100_000, 'Runtime archive contains too many entries');
      const checksum = tarNumber(header.subarray(148, 156));
      let actual = 0;
      for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index];
      requireValue(checksum === actual, 'Tar header checksum mismatch');
      const type = String.fromCharCode(header[156] || 48);
      const rawSize = tarNumber(header.subarray(124, 136));
      requireValue(rawSize <= MAX_ARCHIVE / 2, 'Tar member exceeds its byte limit');
      if (['x', 'g', 'L', 'K'].includes(type)) {
        requireValue(rawSize <= 64 * 1024 && type !== 'g', 'Unsupported or oversized global tar metadata');
        const data = await take(rawSize);
        if (type === 'x') pax = paxFields(data);
        if (type === 'L') longPath = tarString(data);
        if (type === 'K') longLink = tarString(data);
        if (rawSize % 512) await take(512 - rawSize % 512);
        continue;
      }
      const prefix = tarString(header.subarray(345, 500));
      const baseName = tarString(header.subarray(0, 100));
      const name = pax.path ?? longPath ?? (prefix ? `${prefix}/${baseName}` : baseName);
      const link = pax.linkpath ?? longLink ?? tarString(header.subarray(157, 257));
      requireValue(pax.size === undefined || /^(0|[1-9]\d*)$/.test(pax.size), 'Invalid PAX member size encoding');
      const size = pax.size === undefined ? rawSize : Number(pax.size);
      requireValue(Number.isSafeInteger(size) && size >= 0 && size <= MAX_ARCHIVE / 2, 'Invalid PAX member size');
      requireValue(!Object.keys(pax).some(key => key.startsWith('GNU.sparse') || key === 'SCHILY.filetype'),
        'Sparse/special runtime members are forbidden');
      pax = {};
      longPath = undefined;
      longLink = undefined;
      let remaining = size;
      const consume = async (sink = () => {}) => {
        while (remaining) {
          const chunk = await take(Math.min(remaining, 64 * 1024));
          remaining -= chunk.length;
          await sink(chunk);
        }
      };
      await visitor({ name, link, type, size, mode: tarNumber(header.subarray(100, 108)) }, consume);
      requireValue(remaining === 0, 'Archive visitor did not consume member');
      if (size % 512) await take(512 - size % 512);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    source.destroy();
    unzip.destroy();
  }
}

function safeRelative(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value), 'Unsafe archive path');
  const stripped = value.replace(/^\.\//, '').replace(/\/$/, '');
  requireValue(stripped && stripped.split('/').every(part => part && part !== '.' && part !== '..'), 'Archive path traversal');
  return stripped;
}

async function writeMember(file, consume, mode = 0o600) {
  const output = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { await consume(chunk => writeAll(output, chunk)); await output.sync(); }
  finally { await output.close(); }
}

async function directoryWithoutLinks(directory, root) {
  const relative = path.relative(root, directory);
  requireValue(!relative.startsWith('..') && !path.isAbsolute(relative), 'Installer path escapes its private root');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { await fsp.mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fsp.lstat(cursor);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Installer directory is a symbolic link');
  }
}

export async function extractRuntime(archive, destination, signal) {
  await fsp.mkdir(destination, { mode: 0o700 });
  const names = new Map();
  const folded = new Set();
  const links = [];
  await walkTar(archive, async (entry, consume) => {
    const name = safeRelative(entry.name);
    if (name === 'runtime' && entry.type === '5') { await consume(); return; }
    requireValue(name.startsWith('runtime/'), 'Runtime archive must have one runtime/ root');
    const relative = name.slice(8);
    const fold = relative.normalize('NFC').toLowerCase();
    requireValue(!folded.has(fold), 'Duplicate or case-colliding runtime path');
    folded.add(fold);
    names.set(relative, entry);
    const output = path.join(destination, relative);
    await directoryWithoutLinks(path.dirname(output), destination);
    if (entry.type === '5') {
      requireValue(entry.size === 0, 'Directory carries unexpected payload');
      await directoryWithoutLinks(output, destination);
    } else if (entry.type === '0') {
      await writeMember(output, consume, entry.mode & 0o111 ? 0o700 : 0o600);
    } else if (entry.type === '2' || entry.type === '1') {
      requireValue(entry.size === 0 && entry.link && !path.posix.isAbsolute(entry.link)
        && !entry.link.includes('\\') && !/[\x00-\x1f\x7f]/.test(entry.link), 'Unsafe runtime link');
      const target = entry.type === '1'
        ? safeRelative(entry.link).replace(/^runtime\//, '')
        : path.posix.normalize(path.posix.join(path.posix.dirname(relative), entry.link));
      requireValue(target && target !== '..' && !target.startsWith('../'), 'Runtime link escapes its root');
      links.push({ relative, target, hard: entry.type === '1', link: entry.link });
    } else {
      throw new Error('Special archive members are forbidden');
    }
    await consume();
  }, signal);
  const pending = new Map(links.map(link => [link.relative, link]));
  const resolve = (name, visited = new Set()) => {
    requireValue(visited.size < 32 && !visited.has(name), 'Runtime link cycle');
    const link = pending.get(name);
    if (!link) return name;
    visited.add(name);
    return resolve(link.target, visited);
  };
  for (const link of links) {
    const resolved = resolve(link.relative);
    const target = path.join(destination, resolved);
    const stat = await fsp.lstat(target);
    requireValue(stat.isFile() || (!link.hard && stat.isDirectory()), 'Runtime link target is not resident');
    await directoryWithoutLinks(path.dirname(target), destination);
    if (link.hard) await fsp.copyFile(target, path.join(destination, link.relative), fs.constants.COPYFILE_EXCL);
    else await fsp.symlink(path.posix.relative(path.posix.dirname(link.relative), resolved), path.join(destination, link.relative));
  }
  return destination;
}

export async function extractCandidate(archive, destination, metadata, architecture, proof, signal) {
  const selected = metadata.variants[architecture].runtime;
  const hashes = new Map();
  const sizes = new Map();
  const documents = new Map();
  const dmgSidecar = `OpenRappter-Bar-${metadata.version}.dmg.sha256`;
  await fsp.mkdir(destination, { mode: 0o700 });
  await walkTar(archive, async (entry, consume) => {
    if (['.', './'].includes(entry.name) && entry.type === '5') { await consume(); return; }
    const name = entry.name.replace(/^\.\//, '');
    requireValue(entry.type === '0' && FILENAME.test(name) && !hashes.has(name) && hashes.size < 256,
      'Candidate must contain unique flat regular files');
    const hash = createHash('sha256');
    const capture = ['provenance.json', 'SHA256SUMS', 'macos-bar.json', dmgSidecar].includes(name);
    requireValue(!capture || entry.size <= MAX_JSON, 'Candidate metadata exceeds its limit');
    const chunks = [];
    let output;
    if (name === selected.file) {
      requireValue(entry.size === selected.size, 'Selected runtime archive size mismatch');
      output = await fsp.open(path.join(destination, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    }
    try {
      await consume(async chunk => {
        hash.update(chunk);
        if (capture) chunks.push(chunk);
        if (output) await writeAll(output, chunk);
      });
    } finally { await output?.close(); }
    hashes.set(name, hash.digest('hex'));
    sizes.set(name, entry.size);
    if (capture) documents.set(name, Buffer.concat(chunks));
  }, signal);
  requireValue(hashes.get(selected.file) === selected.sha256, 'Runtime archive differs from signed Bar pins');
  requireValue(await fileDigest(path.join(destination, selected.file)) === selected.sha256,
    'Extracted runtime archive failed read-back verification');
  const provenance = JSON.parse(fatalDecoder.decode(documents.get('provenance.json') ?? Buffer.alloc(0)));
  closed(provenance, [
    'schema', 'channel', 'stable', 'candidate_kind', 'candidate_id', 'source_tag',
    'intended_release_tag', 'source_repository', 'source_commit', 'source_date_epoch', 'versions', 'files',
  ], 'candidate provenance');
  requireValue(provenance.schema === 'openrappter-candidate-provenance/v1'
    && provenance.channel === 'candidate' && provenance.stable === false
    && provenance.source_repository === REPOSITORY && provenance.source_commit === metadata.source_commit
    && provenance.source_tag === null && provenance.candidate_kind === 'release'
    && Number.isSafeInteger(provenance.source_date_epoch) && provenance.source_date_epoch >= 0
    && provenance.candidate_id === `tag-${Buffer.from(`v${metadata.version}`).toString('base64url')}`
    && provenance.intended_release_tag === `v${metadata.version}`, 'Candidate provenance source mismatch');
  closed(provenance.versions, ['npm', 'pypi', 'runtime', 'channel'], 'candidate versions');
  requireValue(provenance.versions.npm === metadata.version
    && Object.values(provenance.versions).every(value => typeof value === 'string' && SEMVER.test(value)), 'Candidate versions are invalid');
  const rows = new Map();
  requireValue(Array.isArray(provenance.files), 'Missing candidate file provenance');
  for (const row of provenance.files) {
    closed(row, ['path', 'sha256'], 'candidate file');
    requireValue(FILENAME.test(row.path) && !rows.has(row.path)
      && !['provenance.json', 'SHA256SUMS'].includes(row.path)
      && hashes.get(row.path) === row.sha256, 'Candidate file provenance mismatch');
    rows.set(row.path, row.sha256);
  }
  requireValue(rows.size + 2 === hashes.size && rows.get(selected.file) === selected.sha256
    && rows.has(`openrappter-${metadata.version}.tgz`)
    && [...rows.keys()].some(name => name.endsWith('.whl'))
    && rows.has(`openrappter-${provenance.versions.pypi}.tar.gz`)
    && rows.has('install.sh') && rows.has('install.ps1'), 'Candidate dependency/provenance closure is incomplete');
  const checks = new Map();
  for (const line of fatalDecoder.decode(documents.get('SHA256SUMS') ?? Buffer.alloc(0)).trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,180})$/.exec(line);
    requireValue(match && !checks.has(match[2]) && match[2] !== 'SHA256SUMS'
      && hashes.get(match[2]) === match[1], 'Candidate checksum manifest mismatch');
    checks.set(match[2], match[1]);
  }
  requireValue(checks.size + 1 === hashes.size, 'Candidate checksum manifest is incomplete');
  const bar = JSON.parse(fatalDecoder.decode(documents.get('macos-bar.json') ?? Buffer.alloc(0)));
  closed(bar, ['schema', 'source_commit', 'version', 'release_tag', 'architectures', 'dmg', 'notarization'], 'Bar candidate record');
  closed(bar.dmg, ['name', 'sha256', 'size'], 'Bar DMG identity');
  closed(bar.notarization, ['id', 'status'], 'Bar notarization');
  requireValue(bar.schema === 'openrappter-bar-candidate/v1' && bar.source_commit === metadata.source_commit
    && bar.version === metadata.version && bar.release_tag === `v${metadata.version}-bar`
    && JSON.stringify(bar.architectures) === JSON.stringify(['arm64', 'x86_64'])
    && bar.notarization?.status === 'Accepted'
    && /^[0-9a-fA-F-]{36}$/.test(bar.notarization.id)
    && bar.dmg?.name === `OpenRappter-Bar-${metadata.version}.dmg`
    && Number.isSafeInteger(bar.dmg.size) && bar.dmg.size > 0 && sizes.get(bar.dmg.name) === bar.dmg.size
    && bar.dmg.sha256 === proof.sha256 && hashes.get(bar.dmg.name) === proof.sha256
    && rows.has(dmgSidecar)
    && fatalDecoder.decode(documents.get(dmgSidecar) ?? Buffer.alloc(0)) === `${proof.sha256}  ${bar.dmg.name}\n`,
  'Approved Bar does not belong to this candidate');
  return { archive: path.join(destination, selected.file), provenance };
}

export async function fileDigest(file) {
  const stat = await fsp.lstat(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Installer expected a regular immutable file');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyInstalledRuntime(directory, version) {
  const packageJSON = JSON.parse(await fsp.readFile(path.join(directory, 'package.json'), 'utf8'));
  requireValue(packageJSON.name === 'openrappter' && packageJSON.version === version, 'Installed package identity mismatch');
  const entry = await fsp.lstat(path.join(directory, 'dist', 'index.js'));
  requireValue(entry.isFile() && !entry.isSymbolicLink() && entry.size > 0, 'Runtime entry point is missing');
  const require = createRequire(path.join(directory, 'package.json'));
  const root = await fsp.realpath(directory);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('node:')) return result;
      requireValue(result.url.startsWith('file:')
        && fs.realpathSync(fileURLToPath(result.url)).startsWith(root + path.sep),
      'Runtime dependency escaped the verified archive; no external module was executed');
      return result;
    },
  });
  try {
    const database = require('better-sqlite3')(':memory:');
    database.close();
    require('sharp');
  } finally { hooks.deregister(); }
}

async function privateRoot(home, relative) {
  const root = path.resolve(home);
  requireValue((await fsp.lstat(root)).isDirectory(), 'Invalid user home');
  await directoryWithoutLinks(path.join(root, relative), root);
  return path.join(root, relative);
}

async function snapshot(file) {
  try {
    const stat = await fsp.lstat(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_JSON, 'Existing installation marker is not a regular bounded file');
    return await fsp.readFile(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicFile(file, data) {
  const staging = `${file}.${randomUUID()}.new`;
  await fsp.writeFile(staging, data, { flag: 'wx', mode: 0o600 });
  try { await fsp.rename(staging, file); }
  finally { await fsp.rm(staging, { force: true }); }
}

async function restoreFile(file, data) {
  if (data === null) await fsp.rm(file, { force: true });
  else await atomicFile(file, data);
}

async function replaceLink(file, target) {
  if (target === null) { await fsp.rm(file, { force: true }); return; }
  const next = `${file}.${randomUUID()}.new`;
  await fsp.symlink(target, next);
  try { await fsp.rename(next, file); }
  finally { await fsp.rm(next, { force: true }); }
}

async function readLink(file) {
  try {
    requireValue((await fsp.lstat(file)).isSymbolicLink(), 'Runtime selection is not a managed link');
    return await fsp.readlink(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function recoverActivation(privateData, releases, current) {
  const file = path.join(privateData, 'runtime-bootstrap-transaction.json');
  const bytes = await snapshot(file);
  if (bytes === null) return;
  const journal = JSON.parse(bytes.toString('utf8'));
  closed(journal, ['schema', 'installation_id', 'new_current', 'previous_current', 'previous_marker'], 'activation journal');
  requireValue(journal.schema === 'openrappter-bootstrap-activation/v1'
    && /^[0-9a-f]{40}-(arm64|x86_64)-[0-9a-f]{64}$/.test(journal.installation_id)
    && journal.new_current === path.join(releases, journal.installation_id, 'runtime')
    && (journal.previous_current === null || (typeof journal.previous_current === 'string'
      && path.resolve(path.dirname(current), journal.previous_current).startsWith(releases + path.sep))),
  'Interrupted activation has an invalid managed destination');
  requireValue(journal.previous_marker === null || (typeof journal.previous_marker === 'string'
    && Buffer.from(journal.previous_marker, 'base64').toString('base64') === journal.previous_marker
    && journal.previous_marker.length <= 128 * 1024), 'Interrupted activation marker is invalid');
  const selected = await readLink(current);
  requireValue(selected === journal.new_current || selected === journal.previous_current,
    'Runtime selection changed after interrupted setup; it was not overwritten');
  const marker = path.join(privateData, 'runtime-bootstrap-installation.json');
  const original = journal.previous_marker === null ? null : Buffer.from(journal.previous_marker, 'base64');
  const present = await snapshot(marker);
  if (present !== null && !(original !== null && present.equals(original))) {
    requireValue(JSON.parse(present.toString('utf8')).installation_id === journal.installation_id,
      'Installation marker changed after interrupted setup; it was not overwritten');
  }
  await replaceLink(current, journal.previous_current);
  await restoreFile(marker, original);
  await fsp.rm(path.join(releases, journal.installation_id), { recursive: true, force: true });
  await fsp.unlink(file);
}

async function installationLock(root) {
  const file = path.join(root, 'runtime-bootstrap.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      return async () => { await fsp.rm(file, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = JSON.parse((await snapshot(file)).toString('utf8'));
      requireValue(Number.isSafeInteger(prior.pid) && prior.pid > 0, 'Unrecognized installer lock');
      let alive = true;
      try { process.kill(prior.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      requireValue(!alive, 'Another verified setup is running. Wait for it to finish, then retry.');
      await fsp.unlink(file);
    }
  }
  throw new Error('Could not acquire the runtime installer lock');
}

async function pruneInterruptedStages(releases) {
  for (const entry of await fsp.readdir(releases, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.bootstrap-[0-9a-f-]{36}$/.test(entry.name)) continue;
    const directory = path.join(releases, entry.name);
    let owner;
    try {
      const data = await snapshot(path.join(directory, '.stage-owner.json'));
      if (data === null) continue;
      owner = JSON.parse(data.toString('utf8'));
    } catch { continue; }
    if (owner.schema !== 'openrappter-bootstrap-stage/v1'
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647) continue;
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (!alive) await fsp.rm(directory, { recursive: true, force: true });
  }
}

export async function installRuntime({
  metadata, architecture, home, workspace, nodeExecutable,
  signal = new AbortController().signal, progress = () => {},
  getJSON = url => fetchJSON(url, signal),
  downloadArtifact = (url, destination, sha, onProgress) => download(url, destination, sha, signal, onProgress),
  verifyRuntime = verifyInstalledRuntime,
  authorizeCommit = async () => true,
}) {
  const selected = validateMetadata(metadata, architecture, metadata.version, metadata.source_commit);
  const privateData = await privateRoot(home, '.openrappter');
  const releases = await privateRoot(home, '.local/share/openrappter/releases');
  const unlock = await installationLock(privateData);
  const stage = path.join(releases, `.bootstrap-${randomUUID()}`);
  const installationID = `${metadata.source_commit}-${architecture}-${selected.runtime.sha256}`;
  const destination = path.join(releases, installationID);
  const markerFile = path.join(privateData, 'runtime-bootstrap-installation.json');
  const current = path.join(home, '.local/share/openrappter/current');
  const journalFile = path.join(privateData, 'runtime-bootstrap-transaction.json');
  let previousMarker;
  let previousCurrent = null;
  let activated = false;
  let destinationCreated = false;
  let journalWritten = false;
  try {
    await recoverActivation(privateData, releases, current);
    await pruneInterruptedStages(releases);
    signal.throwIfAborted();
    progress({ phase: 'checking-approval' });
    const proof = await getJSON(metadata.approval_url);
    const approval = await verifyApproval(proof, metadata, getJSON);
    signal.throwIfAborted();
    progress({ phase: 'downloading-runtime' });
    const candidate = path.join(workspace, 'candidate.tar.gz');
    let lastProgress = 0;
    await downloadArtifact(approval.url, candidate, approval.sha256,
      bytes => {
        if (bytes - lastProgress >= 1024 * 1024) {
          lastProgress = bytes;
          progress({ phase: 'downloading-runtime', bytes });
        }
      });
    requireValue(await fileDigest(candidate) === approval.sha256, 'Downloaded candidate differs from frozen receipts');
    await fsp.mkdir(stage, { mode: 0o700 });
    await fsp.writeFile(path.join(stage, '.stage-owner.json'), JSON.stringify({
      schema: 'openrappter-bootstrap-stage/v1', pid: process.pid,
    }), { flag: 'wx', mode: 0o600 });
    progress({ phase: 'verifying-runtime' });
    const extracted = await extractCandidate(candidate, path.join(stage, 'candidate'), metadata, architecture, proof, signal);
    requireValue(extracted.provenance.versions.channel === approval.channelVersion, 'Candidate channel identity differs from receipts');
    progress({ phase: 'extracting-runtime' });
    const runtime = await extractRuntime(extracted.archive, path.join(stage, 'runtime'), signal);
    const nodeDirectory = path.join(stage, 'node', 'bin');
    await directoryWithoutLinks(nodeDirectory, stage);
    const node = path.join(nodeDirectory, 'node');
    requireValue(await fileDigest(nodeExecutable) === selected.node.binary_sha256, 'Bootstrap Node changed before installation');
    await fsp.copyFile(nodeExecutable, node, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(node, 0o700);
    progress({ phase: 'checking-runtime' });
    await verifyRuntime(runtime, metadata.version);
    signal.throwIfAborted();
    previousMarker = await snapshot(markerFile);
    if (previousMarker) {
      requireValue(previousMarker.length <= 64 * 1024, 'Existing installation marker is oversized');
      const previous = JSON.parse(previousMarker.toString('utf8'));
      if (previous.version !== undefined) {
        requireValue(VERSION.test(previous.version), 'Existing installation version is invalid');
        const next = metadata.version.split('.').map(Number);
        const prior = previous.version.split('.').map(Number);
        let difference = 0;
        for (let i = 0; i < 3 && difference === 0; i += 1) difference = next[i] - prior[i];
        requireValue(difference >= 0, 'Automatic runtime downgrade is forbidden. Use the approved rollback workflow.');
      }
    }
    try {
      const stat = await fsp.lstat(current);
      requireValue(stat.isSymbolicLink(), 'Existing runtime selection is not managed by this installer; it was not replaced.');
      previousCurrent = await fsp.readlink(current);
      const priorPath = path.resolve(path.dirname(current), previousCurrent);
      requireValue(priorPath.startsWith(`${releases}${path.sep}`), 'Existing runtime selection is outside managed releases; it was not replaced.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = await snapshot(path.join(privateData, 'config.json'));
    if (config) {
      const settings = JSON.parse(config.toString('utf8'));
      requireValue(!settings.projectPath || path.resolve(settings.projectPath) === current
        || path.resolve(settings.projectPath).startsWith(`${releases}${path.sep}`),
      'A custom runtime is selected in Settings. Keep it, or select the managed runtime before retrying.');
    }
    progress({ phase: 'ready-to-activate' });
    requireValue(await authorizeCommit(), 'Desktop became authoritative or setup was cancelled; no runtime was replaced.');
    signal.throwIfAborted();
    try {
      await fsp.lstat(destination);
      throw new Error('This runtime installation already exists. Recheck it before retrying; it was not overwritten.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicFile(journalFile, Buffer.from(JSON.stringify({
      schema: 'openrappter-bootstrap-activation/v1', installation_id: installationID,
      new_current: path.join(destination, 'runtime'), previous_current: previousCurrent,
      previous_marker: previousMarker === null ? null : previousMarker.toString('base64'),
    })));
    journalWritten = true;
    await fsp.rm(path.join(stage, 'candidate'), { recursive: true });
    await fsp.rename(stage, destination);
    destinationCreated = true;
    const marker = {
      schema: 'openrappter-bar-runtime-installation/v1',
      source_commit: metadata.source_commit, version: metadata.version, architecture,
      runtime_sha256: selected.runtime.sha256, node_sha256: selected.node.binary_sha256,
      candidate_sha256: approval.sha256, installation_id: installationID,
    };
    const nextLink = `${current}.${randomUUID()}.new`;
    await fsp.symlink(path.join(destination, 'runtime'), nextLink);
    try {
      await fsp.rename(nextLink, current);
      activated = true;
      signal.throwIfAborted();
      await atomicFile(markerFile, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`));
      signal.throwIfAborted();
    } finally { await fsp.rm(nextLink, { force: true }); }
    progress({ phase: 'installed', installation_id: installationID });
    await fsp.unlink(journalFile);
    journalWritten = false;
    return marker;
  } catch (error) {
    if (journalWritten) await recoverActivation(privateData, releases, current);
    else if (destinationCreated && !activated) await fsp.rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
    await unlock();
  }
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    requireValue(['--metadata', '--architecture', '--home', '--workspace'].includes(process.argv[index])
      && process.argv[index + 1] && !Object.hasOwn(options, process.argv[index]), 'Invalid installer arguments');
    options[process.argv[index]] = process.argv[index + 1];
  }
  requireValue(Object.keys(options).length === 4, 'Missing installer arguments');
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort(new Error('Runtime setup cancelled')));
  process.once('SIGINT', () => controller.abort(new Error('Runtime setup cancelled')));
  const progress = event => process.stdout.write(`${JSON.stringify(event)}\n`);
  const metadata = JSON.parse(await fsp.readFile(options['--metadata'], 'utf8'));
  const input = createInterface({ input: process.stdin });
  let authorize;
  const authorization = new Promise(resolve => { authorize = resolve; });
  controller.signal.addEventListener('abort', () => authorize(false), { once: true });
  input.on('line', line => {
    try { authorize(line.length <= 1024 && JSON.parse(line).action === 'commit'); }
    catch { authorize(false); }
  });
  input.on('close', () => authorize(false));
  try {
    await installRuntime({
      metadata, architecture: options['--architecture'], home: options['--home'],
      workspace: options['--workspace'], nodeExecutable: process.execPath,
      signal: controller.signal, progress,
      authorizeCommit: async () => {
        const timer = setTimeout(() => authorize(false), 30_000);
        try { return await authorization; } finally { clearTimeout(timer); }
      },
    });
  } catch (error) {
    progress({ phase: 'error', message: String(error.message || 'Verified runtime installation failed').slice(0, 512) });
    process.exitCode = 1;
  } finally { input.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
