import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openrappterHome, openrappterPath } from './infra/openrappter-home.js';

export const RINGS = ['stable', 'beta', 'canary', 'alpha', 'nightly'] as const;
export type RingName = (typeof RINGS)[number];
export interface CandidateBundleIdentity {
  ref: string;
  sourceCommit: string;
  kind: 'snapshot' | 'release';
  candidateId: string;
  sha256: string;
}

export function parseCandidateBundleUrl(value: string): CandidateBundleIdentity {
  const url = new URL(value);
  if (
    !/^[\x20-\x7e]+$/.test(value)
    || !value.startsWith('https://raw.githubusercontent.com/')
    || url.protocol !== 'https:'
    || url.hostname !== 'raw.githubusercontent.com'
    || url.username || url.password || url.port || url.search || url.hash
    || /[^\x20-\x7e]|%|\\/.test(url.pathname)
  ) throw new Error('candidate URL origin/query/credentials/path encoding rejected');
  const parts = url.pathname.replace(/^\//, '').split('/');
  if (
    parts.length !== 8 || parts[0] !== 'kody-w' || parts[1] !== 'openrappter'
    || parts[3] !== 'candidates' || !/^[0-9a-f]{40}$/.test(parts[2])
    || !/^[0-9a-f]{40}$/.test(parts[4])
    || !['snapshot', 'release'].includes(parts[5])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parts[6])
    || parts[6] === '.' || parts[6] === '..'
    || !/^[0-9a-f]{64}\.tar\.gz$/.test(parts[7])
  ) throw new Error('candidate URL repository/ref/path identity rejected');
  return {
    ref: parts[2],
    sourceCommit: parts[4],
    kind: parts[5] as 'snapshot' | 'release',
    candidateId: parts[6],
    sha256: parts[7].slice(0, 64),
  };
}

export const RING_REPOSITORIES: Readonly<Record<RingName, string>> = {
  stable: 'kody-w/openrappter',
  beta: 'kody-w/openrappter-beta',
  canary: 'kody-w/openrappter-canary',
  alpha: 'kody-w/openrappter-alpha',
  nightly: 'kody-w/openrappter-nightly',
};

export const RING_MANIFEST_URLS: Readonly<Record<RingName, string>> = Object.fromEntries(
  RINGS.map((ring) => [
    ring,
    `https://raw.githubusercontent.com/${RING_REPOSITORIES[ring]}/main/.ring/manifest.json`,
  ]),
) as Record<RingName, string>;

export interface RingManifest {
  schema: 'openrappter-ring/v1';
  ring: RingName;
  source: {
    repository: 'kody-w/openrappter';
    commit: string;
    tag: string | null;
  };
  version: string;
  artifact: {
    url: string;
    install_url: string | null;
    sha256: string;
    provenance: 'github-commit-archive-sha256' | 'npm-registry-download-sha256' | 'github-release-download-sha256' | 'github-candidate-bundle-sha256';
  };
  promoted_at: string;
  predecessor: Exclude<RingName, 'stable'> | null;
  status: 'published' | 'unpublished' | 'disabled';
  reason: string | null;
  receipt: string | null;
  promotion_id: string | null;
  intended_release_tag?: string | null;
  channel_version?: string | null;
}

const TOP_KEYS = ['artifact', 'channel_version', 'intended_release_tag', 'predecessor', 'promoted_at', 'promotion_id', 'reason', 'receipt', 'ring', 'schema', 'source', 'status', 'version'];
const SOURCE_KEYS = ['commit', 'repository', 'tag'];
const ARTIFACT_KEYS = ['install_url', 'provenance', 'sha256', 'url'];
const ALLOWED_HOSTS = new Set(['github.com', 'registry.npmjs.org', 'raw.githubusercontent.com']);

function isClosed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function requireHttps(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`${label} host is not authorized`);
  }
  return value;
}

export function isRing(value: string): value is RingName {
  return (RINGS as readonly string[]).includes(value);
}

export function readPersistedRing(): RingName | null {
  const candidates = [openrappterPath('ring'), openrappterPath('channel')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!isRing(value)) {
      throw new Error(`persisted release ring ${JSON.stringify(value)} is invalid`);
    }
    return value;
  }
  return null;
}

export function writePersistedRing(ring: RingName): void {
  if (!isRing(ring)) throw new Error(`cannot persist unknown release ring ${JSON.stringify(ring)}`);
  const home = openrappterHome();
  fs.mkdirSync(home, { recursive: true });
  const destination = path.join(home, 'ring');
  const staging = path.join(home, `.ring-${process.pid}.new`);
  fs.writeFileSync(staging, `${ring}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(staging, destination);
}

export function selectRing(options: {
  cliRing?: string;
  env?: NodeJS.ProcessEnv;
  persistedRing?: string | null;
} = {}): RingName {
  const env = options.env ?? process.env;
  const persisted = options.persistedRing === undefined
    ? readPersistedRing()
    : options.persistedRing;
  const candidate = options.cliRing
    || env.OPENRAPPTER_RING
    || env.OPENRAPPTER_CHANNEL
    || persisted
    || 'stable';
  if (!isRing(candidate)) {
    throw new Error(`unknown release ring ${JSON.stringify(candidate)}; expected ${RINGS.join(', ')}`);
  }
  return candidate;
}

export function validateRingManifest(
  value: unknown,
  expectedRing: RingName,
  now = new Date(),
): RingManifest {
  const legacyKeys = TOP_KEYS.filter(key => !['intended_release_tag', 'channel_version'].includes(key));
  if (!isClosed(value, TOP_KEYS) && !isClosed(value, legacyKeys)) {
    throw new Error('ring manifest is not a closed object');
  }
  if (value.schema !== 'openrappter-ring/v1' || value.ring !== expectedRing) {
    throw new Error(`manifest does not identify the ${expectedRing} ring`);
  }
  if (!isClosed(value.source, SOURCE_KEYS)) throw new Error('manifest source is not closed');
  if (value.source.repository !== 'kody-w/openrappter') throw new Error('unauthorized source repository');
  if (typeof value.source.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.source.commit)) {
    throw new Error('source commit must be 40 lowercase hex characters');
  }
  if (value.source.tag !== null && (
    typeof value.source.tag !== 'string' || !/^v[0-9][0-9A-Za-z.+-]*$/.test(value.source.tag)
  )) throw new Error('source tag is malformed');
  if (typeof value.version !== 'string') throw new Error('version is not strict semver');
  parseSemVer(value.version);
  if (!isClosed(value.artifact, ARTIFACT_KEYS)) throw new Error('manifest artifact is not closed');
  requireHttps(value.artifact.url, 'artifact URL');
  if (value.artifact.install_url !== null) requireHttps(value.artifact.install_url, 'install URL');
  if (typeof value.artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.artifact.sha256)) {
    throw new Error('artifact SHA-256 is malformed');
  }
  if (!['github-commit-archive-sha256', 'npm-registry-download-sha256', 'github-release-download-sha256', 'github-candidate-bundle-sha256'].includes(
    String(value.artifact.provenance),
  )) throw new Error('checksum provenance is unknown');
  if (!['published', 'unpublished', 'disabled'].includes(String(value.status))) {
    throw new Error('manifest status is unknown');
  }
  if (value.status === 'published') {
    if (value.reason !== null || value.artifact.install_url === null) {
      throw new Error('published manifest lacks an install URL');
    }
  } else if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    throw new Error('non-published manifest lacks a reason');
  }
  const promoted = new Date(String(value.promoted_at));
  if (Number.isNaN(promoted.valueOf()) || promoted > new Date(now.valueOf() + 300_000)) {
    throw new Error('manifest promoted_at is malformed or in the future');
  }
  const train = ['nightly', 'alpha', 'canary', 'beta', 'stable'];
  const predecessor = expectedRing === 'nightly' ? null : train[train.indexOf(expectedRing) - 1];
  if (value.predecessor !== predecessor) throw new Error('manifest predecessor is invalid');
  if (value.receipt !== null && (
    typeof value.receipt !== 'string'
    || !/^https:\/\/github\.com\/kody-w\/openrappter-release-train\/blob\/[0-9a-f]{40}\/receipts\/.+\.json$/.test(value.receipt)
  )) throw new Error('manifest receipt is not immutable');
  if (value.promotion_id !== null && (
    typeof value.promotion_id !== 'string' || !/^[0-9a-f]{64}$/.test(value.promotion_id)
  )) throw new Error('manifest promotion_id is malformed');
  if (value.intended_release_tag != null && (
    typeof value.intended_release_tag !== 'string'
    || !/^v[0-9][0-9A-Za-z.+-]*$/.test(value.intended_release_tag)
  )) throw new Error('manifest intended_release_tag is malformed');
  if (value.channel_version != null) {
    if (typeof value.channel_version !== 'string') throw new Error('manifest channel_version is malformed');
    parseSemVer(value.channel_version);
  }
  const npmUrl = `https://registry.npmjs.org/openrappter/-/openrappter-${value.version}.tgz`;
  const tag = value.source.tag;
  const releasePrefix = tag
    ? `https://github.com/kody-w/openrappter/releases/download/${tag}/`
    : '';
  if (value.status === 'published') {
    const npm = value.artifact.provenance === 'npm-registry-download-sha256'
      && value.artifact.url === npmUrl
      && value.artifact.install_url === npmUrl;
    const release = value.artifact.provenance === 'github-release-download-sha256'
      && releasePrefix !== ''
      && String(value.artifact.url).startsWith(releasePrefix)
      && value.artifact.install_url === value.artifact.url;
    let candidate = false;
    if (value.artifact.provenance === 'github-candidate-bundle-sha256' && value.artifact.install_url === value.artifact.url) {
      try {
        const parsed = parseCandidateBundleUrl(String(value.artifact.url));
        candidate = parsed.sourceCommit === value.source.commit && parsed.sha256 === value.artifact.sha256;
      } catch { candidate = false; }
    }
    if (!npm && !release && !candidate) throw new Error('published artifact is not bound to canonical package/version');
  } else {
    const archive = value.artifact.url === `https://github.com/kody-w/openrappter/archive/${value.source.commit}.tar.gz`;
    let candidate = false;
    if (value.artifact.provenance === 'github-candidate-bundle-sha256') {
      try {
        const parsed = parseCandidateBundleUrl(String(value.artifact.url));
        candidate = parsed.sourceCommit === value.source.commit && parsed.sha256 === value.artifact.sha256;
      } catch { candidate = false; }
    }
    if ((!archive && !candidate) || value.artifact.install_url !== null) {
      throw new Error('nonpublished artifact is not exact canonical source');
    }
  }
  return value as unknown as RingManifest;
}

function canonicalDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

interface ParsedSemVer {
  core: [number, number, number];
  prerelease: string[] | null;
}

function parseSemVer(version: string): ParsedSemVer {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error(`cannot compare invalid SemVer ${JSON.stringify(version)}`);
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))) {
    throw new Error(`cannot compare invalid SemVer ${JSON.stringify(version)}`);
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

export function compareSemVer(leftVersion: string, rightVersion: string): -1 | 0 | 1 {
  const left = parseSemVer(leftVersion);
  const right = parseSemVer(rightVersion);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function isVersionDowngrade(current: string, target: string): boolean {
  return compareSemVer(target, current) < 0;
}

export async function fetchRingManifest(
  ring: RingName,
  options: { fetchImpl?: typeof fetch; now?: Date; persistSequence?: boolean } = {},
): Promise<RingManifest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headResponse = await fetchImpl(
    `https://raw.githubusercontent.com/kody-w/openrappter-release-train/main/heads/${ring}.json`,
    { headers: { accept: 'application/json' } },
  );
  if (!headResponse.ok) throw new Error(`could not reach ${ring} authority head (${headResponse.status})`);
  const head = await headResponse.json() as Record<string, unknown>;
  const headKeys = [
    'authority_commit', 'promotion_id', 'receipt_path', 'receipt_sha256',
    'ring', 'schema', 'sequence', 'target_manifest_commit',
    'target_manifest_sha256', 'target_repository',
  ];
  const repository = RING_REPOSITORIES[ring];
  if (
    !isClosed(head, headKeys)
    || head.schema !== 'openrappter-ring-head/v1'
    || head.ring !== ring
    || !Number.isSafeInteger(head.sequence)
    || Number(head.sequence) < 1
    || typeof head.promotion_id !== 'string'
    || !/^[0-9a-f]{64}$/.test(head.promotion_id)
    || typeof head.authority_commit !== 'string'
    || !/^[0-9a-f]{40}$/.test(head.authority_commit)
    || head.receipt_path !== `receipts/${ring}/${head.promotion_id}.json`
    || typeof head.receipt_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(head.receipt_sha256)
    || head.target_repository !== repository
    || typeof head.target_manifest_commit !== 'string'
    || !/^[0-9a-f]{40}$/.test(head.target_manifest_commit)
    || typeof head.target_manifest_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(head.target_manifest_sha256)
  ) throw new Error(`${ring} authority head is malformed`);
  const receiptResponse = await fetchImpl(
    `https://raw.githubusercontent.com/kody-w/openrappter-release-train/${head.authority_commit}/${head.receipt_path}`,
    { headers: { accept: 'application/json' } },
  );
  if (!receiptResponse.ok) throw new Error(`${ring} immutable authority receipt is unreachable`);
  const receipt = await receiptResponse.json() as Record<string, unknown>;
  if (canonicalDigest(receipt) !== head.receipt_sha256) {
    throw new Error(`${ring} authority receipt checksum mismatch`);
  }
  const manifestResponse = await fetchImpl(
    `https://raw.githubusercontent.com/${repository}/${head.target_manifest_commit}/.ring/manifest.json`,
    { headers: { accept: 'application/json' } },
  );
  if (!manifestResponse.ok) throw new Error(`${ring} immutable target manifest is unreachable`);
  const manifest = validateRingManifest(await manifestResponse.json(), ring, options.now);
  if (
    canonicalDigest(manifest) !== head.target_manifest_sha256
    || receipt.promotion_id !== head.promotion_id
    || (receipt.sequence !== undefined && receipt.sequence !== head.sequence)
    || receipt.target_repository !== repository
    || receipt.target_ring !== ring
    || receipt.target_manifest_commit !== head.target_manifest_commit
    || receipt.target_manifest_sha256 !== head.target_manifest_sha256
    || receipt.source_commit !== manifest.source.commit
    || receipt.source_tag !== manifest.source.tag
    || receipt.version !== manifest.version
    || receipt.artifact_url !== manifest.artifact.url
    || receipt.install_url !== manifest.artifact.install_url
    || receipt.artifact_sha256 !== manifest.artifact.sha256
    || receipt.artifact_provenance !== manifest.artifact.provenance
    || (receipt.intended_release_tag !== undefined && receipt.intended_release_tag !== manifest.intended_release_tag)
    || (receipt.channel_version !== undefined && receipt.channel_version !== manifest.channel_version)
  ) throw new Error(`${ring} authority head does not authorize immutable target manifest`);
  if (options.persistSequence ?? (options.fetchImpl === undefined)) {
    const sequencePath = openrappterPath('ring-head-sequences.json');
    let sequences: Record<string, number> = {};
    if (fs.existsSync(sequencePath)) {
      sequences = JSON.parse(fs.readFileSync(sequencePath, 'utf8')) as Record<string, number>;
    }
    const previous = sequences[ring] ?? 0;
    if (Number(head.sequence) < previous) throw new Error(`${ring} authority head sequence rolled back`);
    if (Number(head.sequence) > previous) {
      sequences[ring] = Number(head.sequence);
      const staging = `${sequencePath}.${process.pid}.new`;
      fs.mkdirSync(path.dirname(sequencePath), { recursive: true });
      fs.writeFileSync(staging, `${JSON.stringify(sequences, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(staging, sequencePath);
    }
  }
  return manifest;
}

export async function resolveRing(
  ring: RingName,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    currentVersion?: string;
    allowDowngrade?: boolean;
  } = {},
): Promise<RingManifest> {
  const manifest = await fetchRingManifest(ring, options);
  if (manifest.status !== 'published') {
    throw new Error(`${ring} is ${manifest.status}: ${manifest.reason}`);
  }
  if (
    options.currentVersion
    && !options.allowDowngrade
    && isVersionDowngrade(options.currentVersion, manifest.version)
  ) throw new Error(`refusing downgrade ${options.currentVersion} -> ${manifest.version}; pass --allow-downgrade`);
  return manifest;
}

export async function downloadAndVerify(
  manifest: RingManifest,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(manifest.artifact.url);
  if (!response.ok) throw new Error(`artifact download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.artifact.sha256) {
    throw new Error(`artifact checksum mismatch (expected ${manifest.artifact.sha256}, got ${actual})`);
  }
  return bytes;
}
