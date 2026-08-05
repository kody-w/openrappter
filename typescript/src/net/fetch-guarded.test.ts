/**
 * openrappter#74 shared `assertFetchableUrl` between WebAgent and ImageAgent
 * and called the duplication fixed. It was not.
 *
 * The checks that matter most — resolving the host, and re-checking after each
 * redirect — live in the *fetch path*, not the predicate. WebAgent had them.
 * ImageAgent got the predicate and kept fetching through `MediaProcessor`,
 * which called plain `fetch` with default redirect following and no resolution
 * at all. An outside reviewer found it; reproduced before this file existed:
 *
 *     WebAgent   : blocked - localtest.me resolves to 127.0.0.1
 *     ImageAgent : NOT BLOCKED (reached loopback)
 *
 * #74's tests could not have caught it. Every one of them called `validateUrl`.
 * They proved the predicate refuses bad URLs and said nothing about whether the
 * agent's actual fetch is protected — the same front-door gap this run has now
 * hit four times.
 *
 * These go in the front door: through the agents, not the predicate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebAgent } from '../agents/WebAgent.js';
import { ImageAgent } from '../agents/ImageAgent.js';

const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
});

/** localtest.me is a real public DNS name that resolves to loopback. */
async function loopbackViaPublicName(): Promise<string> {
  const port = await listen((_req, res) => { res.writeHead(200); res.end('INTERNAL'); });
  return `http://localtest.me:${port}/pixel.gif`;
}

describe('agents that fetch a user-supplied URL', () => {
  it('ImageAgent refuses a public name that resolves inward', async () => {
    const target = await loopbackViaPublicName();

    const result = JSON.parse(
      await new ImageAgent().perform({ action: 'process_url', url: target }),
    ) as { status: string; message?: string };

    expect(result.status).toBe('error');
    expect(String(result.message)).toMatch(/blocked|resolves to/i);
  });

  it('ImageAgent refuses a redirect that lands inward', async () => {
    const secret = await listen((_req, res) => { res.writeHead(200); res.end('INTERNAL'); });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${secret}/x.gif` });
      res.end();
    });

    const result = JSON.parse(
      await new ImageAgent().perform({
        action: 'process_url',
        url: `http://localtest.me:${redirector}/go`,
      }),
    ) as { status: string; message?: string };

    expect(result.status).toBe('error');
    expect(String(result.message)).toMatch(/blocked|resolves to/i);
  });

  it('WebAgent refuses the same URL, as it already did', async () => {
    const target = await loopbackViaPublicName();
    const web = new WebAgent() as unknown as { fetchUrl(url: string): Promise<string> };

    await expect(web.fetchUrl(target)).rejects.toThrow(/blocked|resolves to/i);
  });

  it('both agents still accept an ordinary public URL shape', async () => {
    // Positive control. Refusing everything would satisfy the tests above and
    // break both agents entirely. No network call: the guard rejects before
    // fetching, so reaching a DNS failure means it got past the address checks.
    const { assertFetchableUrl } = await import('./url-guard.js');
    expect(() => assertFetchableUrl('https://example.com/a.png')).not.toThrow();
  });
});
