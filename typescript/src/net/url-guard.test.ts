/**
 * One guard, two callers.
 *
 * WebAgent and ImageAgent each carried a character-for-character copy of these
 * checks. openrappter#72 fixed WebAgent's; ImageAgent's kept every hole, and
 * accepted all of the following while the identical-looking function next door
 * refused them:
 *
 *     http://[::1]/x.png          ALLOWED
 *     http://[fe80::1]/x.png      ALLOWED
 *     http://localtest.me/x.png   ALLOWED
 *     file:///etc/hosts           ALLOWED
 *     data:image/png;base64,AAA   ALLOWED
 *
 * The tests below run the same table through both agents, so a fix that
 * reaches only one of them fails here.
 */
import { describe, it, expect } from 'vitest';
import { WebAgent } from '../agents/WebAgent.js';
import { ImageAgent } from '../agents/ImageAgent.js';
import { assertFetchableUrl, isBlockedHost, normaliseHost } from './url-guard.js';

type Validator = { validateUrl(url: string): void };

const agents: Array<[string, () => Validator]> = [
  ['WebAgent', () => new WebAgent() as unknown as Validator],
  ['ImageAgent', () => new ImageAgent() as unknown as Validator],
];

const REFUSED = [
  ['IPv6 loopback', 'http://[::1]/'],
  ['IPv6 link-local lower boundary', 'http://[fe80::1]/'],
  ['IPv6 link-local fe90 subnet', 'http://[fe90::1]/'],
  ['IPv6 link-local fea0 subnet', 'http://[fea0::1]/'],
  ['IPv6 link-local upper boundary', 'http://[febf::1]/'],
  ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
  ['IPv4 loopback', 'http://127.0.0.1/'],
  ['RFC 1918', 'http://10.0.0.1/'],
  ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['localhost', 'http://localhost/'],
  ['file scheme', 'file:///etc/passwd'],
  ['data scheme', 'data:text/plain,hello'],
];

describe.each(agents)('%s uses the shared URL guard', (_name, make) => {
  it.each(REFUSED)('refuses %s', (_label, url) => {
    expect(() => make().validateUrl(url)).toThrow();
  });

  it('still allows a public address', () => {
    // Without this, an agent that refused everything would pass the table.
    expect(() => make().validateUrl('https://example.com/a.png')).not.toThrow();
  });
});

describe('normaliseHost', () => {
  it('strips the brackets that made every IPv6 rule unreachable', () => {
    expect(normaliseHost('[::1]')).toBe('::1');
    expect(normaliseHost('[FE80::1]')).toBe('fe80::1');
  });

  it('folds IPv4-mapped addresses back to dotted quad', () => {
    expect(normaliseHost('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(normaliseHost('::ffff:192.168.0.1')).toBe('192.168.0.1');
  });

  it('leaves an ordinary host alone', () => {
    expect(normaliseHost('Example.COM')).toBe('example.com');
  });
});

describe('isBlockedHost', () => {
  it.each(['::1', '::', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'fc00::1', 'fd12::1', '127.0.0.1', '169.254.169.254', 'localhost'])(
    'blocks %s', (host) => expect(isBlockedHost(host)).toBe(true),
  );

  it.each(['example.com', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8'])(
    'allows %s', (host) => expect(isBlockedHost(host)).toBe(false),
  );
});

describe('assertFetchableUrl', () => {
  it('returns the parsed URL so callers need not parse twice', () => {
    expect(assertFetchableUrl('https://example.com/a?b=1').hostname).toBe('example.com');
  });
});
