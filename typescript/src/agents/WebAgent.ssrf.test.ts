/**
 * WebAgent advertises "SSRF protection to prevent access to private networks",
 * and it validated only the URL the caller supplied. `fetch` follows redirects
 * by default, so a public host could hand back a `302` pointing anywhere and
 * the fetch would follow it:
 *
 *     caller asks for   http://public.example/go
 *     validateUrl       passes — the host is public
 *     server replies    302 Location: http://127.0.0.1:PORT/
 *     fetch follows     and returns the internal response body
 *
 * Reproduced against a local pair of servers before this file existed: the
 * body of the blocked host came back intact.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebAgent } from './WebAgent.js';

const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function fetchVia(agent: WebAgent, url: string): Promise<Record<string, unknown>> {
  const raw = await (agent as unknown as {
    fetchUrl(url: string): Promise<string>;
  }).fetchUrl(url);
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Loopback is the only address a test can bind, so tests about *redirect*
 * behaviour have to neutralise the address checks to reach the behaviour they
 * are actually about. Both guards, or the DNS one still refuses the fixture.
 */
function allowLoopback(agent: WebAgent, exceptAfterFirstHop = false): void {
  const internals = agent as unknown as {
    validateUrl(url: string): void;
    assertHostResolvesPublicly(url: string): Promise<void>;
    lookupHost(hostname: string): Promise<Array<{ address: string }>>;
  };
  // Resolution is now checked inside the shared fetch path, so the seam that
  // has to be neutralised is the lookup itself, not the agent's wrapper.
  internals.lookupHost = async () => [{ address: '93.184.216.34' }];
  const realValidate = internals.validateUrl.bind(internals);
  let first = true;
  internals.validateUrl = (url: string) => {
    if (exceptAfterFirstHop && !first) { realValidate(url); return; }
    first = false;
  };
  internals.assertHostResolvesPublicly = async () => undefined;
}

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
});

describe('WebAgent redirect handling', () => {
  it('refuses a redirect that lands on a blocked address', async () => {
    const secret = await listen((_req, res) => { res.writeHead(200); res.end('INTERNAL'); });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${secret}/` });
      res.end();
    });

    // The first hop has to pass validation for this to test the second one, so
    // the redirector is reached through a host the validator accepts.
    const agent = new WebAgent();
    allowLoopback(agent, true);

    await expect(fetchVia(agent, `http://127.0.0.1:${redirector}/`))
      .rejects.toThrow(/blocked/i);
  });

  it('does not return the blocked body', async () => {
    const secret = await listen((_req, res) => { res.writeHead(200); res.end('INTERNAL'); });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${secret}/` });
      res.end();
    });

    const agent = new WebAgent();
    allowLoopback(agent, true);

    await expect(fetchVia(agent, `http://127.0.0.1:${redirector}/`))
      .rejects.toThrow();
    // The assertion that matters: nothing from the internal service escaped.
  });

  it('stops a redirect loop after a bounded number of hops', async () => {
    // Counting the requests matters: asserting only that it eventually throws
    // would also pass with a limit of 100,000, which is not a limit worth
    // having. The server records how many times it was actually asked.
    let hits = 0;
    let port = 0;
    port = await listen((_req, res) => {
      hits += 1;
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/` });
      res.end();
    });

    const agent = new WebAgent();
    allowLoopback(agent);

    await expect(fetchVia(agent, `http://127.0.0.1:${port}/`))
      .rejects.toThrow(/too many redirects/i);

    expect(hits).toBeLessThanOrEqual(10);
  });

  it('still follows a redirect to an allowed address', async () => {
    // Positive control. Refusing every redirect would satisfy the tests above
    // and break ordinary browsing, where redirects are routine.
    const target = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<p>DESTINATION</p>');
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${target}/` });
      res.end();
    });

    const agent = new WebAgent();
    allowLoopback(agent);

    const result = await fetchVia(agent, `http://127.0.0.1:${redirector}/`);
    expect(result.status).toBe('success');
    expect(String(result.content)).toContain('DESTINATION');
  });

  it('still fetches a direct response with no redirect', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<p>DIRECT</p>');
    });

    const agent = new WebAgent();
    allowLoopback(agent);

    const result = await fetchVia(agent, `http://127.0.0.1:${port}/`);
    expect(result.status).toBe('success');
    expect(String(result.content)).toContain('DIRECT');
  });
});

/**
 * The address checks read `URL.hostname` as text. Three ways past that:
 *
 *   1. IPv6 literals keep their brackets, so `[::1]` never matched `/^::1$/`.
 *      Every IPv6 rule in the list was unreachable.
 *   2. A public DNS name can resolve inward. `localtest.me` is a real name
 *      that resolves to 127.0.0.1; fetching it returned the body of a loopback
 *      server on this machine.
 *   3. The scheme was never checked, and Node fetches `data:` URLs.
 */
describe('WebAgent address validation', () => {
  function validate(url: string): void {
    (new WebAgent() as unknown as { validateUrl(u: string): void }).validateUrl(url);
  }

  it.each([
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unspecified', 'http://[::]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 unique-local fc00', 'http://[fc00::1]/'],
    ['IPv6 unique-local fd00', 'http://[fd12::1]/'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
  ])('blocks %s', (_label, url) => {
    expect(() => validate(url)).toThrow(/blocked/i);
  });

  it.each([
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['RFC 1918 ten', 'http://10.1.2.3/'],
    ['RFC 1918 one-nine-two', 'http://192.168.1.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost by name', 'http://localhost/'],
  ])('still blocks %s', (_label, url) => {
    expect(() => validate(url)).toThrow(/blocked/i);
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/plain,hello'],
    ['ftp', 'ftp://example.com/x'],
  ])('refuses the %s scheme', (_label, url) => {
    expect(() => validate(url)).toThrow(/unsupported url scheme/i);
  });

  it.each([
    'http://example.com/',
    'https://example.com/path?q=1',
    'http://93.184.216.34/',
    'http://[2606:2800:220:1:248:1893:25c8:1946]/',
  ])('still allows the public address %s', (url) => {
    expect(() => validate(url)).not.toThrow();
  });
});

describe('WebAgent DNS resolution', () => {
  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['RFC 1918', '10.0.0.5'],
    ['cloud metadata', '169.254.169.254'],
  ])('blocks a public name that resolves to %s', async (_label, address) => {
    // Hermetic on purpose. The first version of this test used localtest.me, a
    // real name pointing at loopback — it passed locally, where that is
    // 127.0.0.1, and failed on CI, where it is ::1. Which family a machine
    // answers with is not what this test is about.
    class Resolving extends WebAgent {
      protected async lookupHost(): Promise<Array<{ address: string }>> {
        return [{ address }];
      }
    }
    const agent = new Resolving() as unknown as { fetchUrl(u: string): Promise<string> };

    await expect(agent.fetchUrl('http://public-looking.example/'))
      .rejects.toThrow(/resolves to/i);
  });

  it('allows a public name that resolves to a public address', async () => {
    // Positive control: refusing every resolved address would pass the four
    // cases above and block the entire web.
    class Resolving extends WebAgent {
      protected async lookupHost(): Promise<Array<{ address: string }>> {
        return [{ address: '93.184.216.34' }];
      }
    }
    const agent = new Resolving() as unknown as {
      assertHostResolvesPublicly(u: string): Promise<void>;
    };
    await expect(agent.assertHostResolvesPublicly('http://example.com/'))
      .resolves.toBeUndefined();
  });

  it('blocks when any one of several resolved addresses is private', async () => {
    // A name can answer with more than one address, and one bad answer is
    // enough — checking only the first would miss it.
    class Resolving extends WebAgent {
      protected async lookupHost(): Promise<Array<{ address: string }>> {
        return [{ address: '93.184.216.34' }, { address: '127.0.0.1' }];
      }
    }
    const agent = new Resolving() as unknown as {
      assertHostResolvesPublicly(u: string): Promise<void>;
    };
    await expect(agent.assertHostResolvesPublicly('http://public-looking.example/'))
      .rejects.toThrow(/resolves to 127\.0\.0\.1/);
  });

  it('does not reject a name it cannot resolve, leaving that to fetch', async () => {
    // Failing closed on every lookup error would break offline and flaky-DNS
    // use for hosts that were never private to begin with.
    const agent = new WebAgent() as unknown as {
      assertHostResolvesPublicly(u: string): Promise<void>;
    };
    await expect(
      agent.assertHostResolvesPublicly('http://this-name-does-not-exist.invalid/'),
    ).resolves.toBeUndefined();
  });
});
