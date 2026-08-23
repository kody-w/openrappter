import { createHash } from 'node:crypto';

export const RINGS = ['stable', 'beta', 'canary', 'alpha', 'nightly'] as const;
export type RingName = (typeof RINGS)[number];

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
    provenance: 'github-commit-archive-sha256' | 'npm-registry-download-sha256';
  };
  promoted_at: string;
  predecessor: Exclude<RingName, 'stable'> | null;
  status: 'published' | 'unpublished' | 'disabled';
  reason: string | null;
  receipt: string | null;
}

const TOP_KEYS = ['artifact', 'predecessor', 'promoted_at', 'reason', 'receipt', 'ring', 'schema', 'source', 'status', 'version'];
const SOURCE_KEYS = ['commit', 'repository', 'tag'];
const ARTIFACT_KEYS = ['install_url', 'provenance', 'sha256', 'url'];
const ALLOWED_HOSTS = new Set(['github.com', 'registry.npmjs.org']);

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

export function selectRing(options: {
  cliRing?: string;
  env?: NodeJS.ProcessEnv;
} = {}): RingName {
  const env = options.env ?? process.env;
  const candidate = options.cliRing || env.OPENRAPPTER_RING || env.OPENRAPPTER_CHANNEL || 'stable';
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
  if (!isClosed(value, TOP_KEYS)) throw new Error('ring manifest is not a closed object');
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
  if (typeof value.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw new Error('version is not strict semver');
  }
  if (!isClosed(value.artifact, ARTIFACT_KEYS)) throw new Error('manifest artifact is not closed');
  requireHttps(value.artifact.url, 'artifact URL');
  if (value.artifact.install_url !== null) requireHttps(value.artifact.install_url, 'install URL');
  if (typeof value.artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.artifact.sha256)) {
    throw new Error('artifact SHA-256 is malformed');
  }
  if (!['github-commit-archive-sha256', 'npm-registry-download-sha256'].includes(
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
  return value as unknown as RingManifest;
}

function semverCore(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`cannot compare version ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionDowngrade(current: string, target: string): boolean {
  const left = semverCore(current);
  const right = semverCore(target);
  for (let i = 0; i < 3; i += 1) {
    if (right[i] !== left[i]) return right[i] < left[i];
  }
  return false;
}

export async function fetchRingManifest(
  ring: RingName,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<RingManifest> {
  const response = await (options.fetchImpl ?? fetch)(RING_MANIFEST_URLS[ring], {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`could not reach ${ring} manifest (${response.status})`);
  return validateRingManifest(await response.json(), ring, options.now);
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
