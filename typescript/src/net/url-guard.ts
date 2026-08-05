/**
 * One place that decides whether a URL may be fetched.
 *
 * This logic existed twice, character for character, in WebAgent and
 * ImageAgent. openrappter#72 fixed WebAgent's copy; ImageAgent's kept every
 * hole — `http://[::1]/`, `http://localtest.me/`, `file://` and `data:` were
 * all accepted by it while the identical-looking function next door refused
 * them.
 *
 * Duplicated security logic does not stay in agreement. It lives here now so
 * the next fix reaches every caller.
 */
import { lookup } from 'dns/promises';

const BLOCKED_HOST_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^::$/,
  /^fc[0-9a-f]{2}:/,
  /^fd[0-9a-f]{2}:/,
  /^fe80:/,
];

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Reduce a URL hostname or resolved address to something the patterns match.
 *
 * `URL.hostname` keeps the brackets on an IPv6 literal, so `http://[::1]/`
 * arrives as `"[::1]"` and `/^::1$/` never fires. IPv4-mapped addresses are
 * folded back to dotted quad so the IPv4 rules apply: `::ffff:7f00:1` is
 * 127.0.0.1 wearing a different hat.
 */
export function normaliseHost(host: string): string {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  const mappedDotted = /^::ffff:((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/.exec(bare);
  if (mappedDotted) return mappedDotted[1];

  return bare;
}

export function isBlockedHost(host: string): boolean {
  const normalised = normaliseHost(host);
  if (normalised === 'localhost' || normalised.endsWith('.local')) return true;
  return BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(normalised));
}

/** Reject by scheme and by literal address, without touching the network. */
export function assertFetchableUrl(url: string): URL {
  const parsed = new URL(url);

  // A fetcher of web content has no business on any other scheme. `data:` URLs
  // are fetchable by Node and would let a caller feed arbitrary bytes back as
  // though they had been retrieved; `file:` is refused by fetch today, which is
  // a property of fetch rather than a decision made here.
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Access to private IP range blocked: ${parsed.hostname}`);
  }
  return parsed;
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: HostLookup = hostname => lookup(hostname, { all: true });

/**
 * Resolve the host and check where it actually points.
 *
 * The checks above read the hostname as text, so any public name that resolves
 * inward walks straight past them. `localtest.me` is a real public DNS name
 * resolving to loopback.
 *
 * Resolution failures are deliberately not fatal: the fetch will fail on its
 * own terms, and failing closed on every lookup error breaks hosts that were
 * never private.
 */
export async function assertHostResolvesPublicly(
  url: string,
  hostLookup: HostLookup = defaultLookup,
): Promise<void> {
  const { hostname } = new URL(url);
  let resolved: Array<{ address: string }>;
  try {
    resolved = await hostLookup(hostname);
  } catch {
    return;
  }

  for (const { address } of resolved) {
    if (isBlockedHost(address)) {
      throw new Error(
        `Access to private IP range blocked: ${hostname} resolves to ${address}`,
      );
    }
  }
}


/** How many hops a redirect chain may take before we stop following it. */
export const MAX_REDIRECTS = 5;

/**
 * Fetch, validating every hop.
 *
 * Sharing `assertFetchableUrl` was not enough, and openrappter#74 shipping only
 * that is why: the checks that matter most — resolving the host, and
 * re-checking after each redirect — live in the *fetch path*, not the
 * predicate. WebAgent had them. ImageAgent got the predicate and kept fetching
 * through `MediaProcessor`, which called plain `fetch` with default redirect
 * following and no resolution at all, so this reached a loopback server while
 * WebAgent refused the identical URL:
 *
 *     WebAgent   : blocked - localtest.me resolves to 127.0.0.1
 *     ImageAgent : NOT BLOCKED (reached loopback)
 *
 * Every caller that fetches a URL a user supplied belongs here.
 */
export async function fetchGuarded(
  url: string,
  init?: RequestInit,
  hostLookup?: HostLookup,
  assertUrl: (url: string) => void = assertFetchableUrl,
): Promise<Response> {
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertUrl(target);
    await assertHostResolvesPublicly(target, hostLookup);

    const response = await fetch(target, { ...init, redirect: 'manual' });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    // Resolve a relative Location against the hop it came from.
    target = new URL(location, target).toString();
  }

  throw new Error(`Too many redirects (limit ${MAX_REDIRECTS}): ${url}`);
}
