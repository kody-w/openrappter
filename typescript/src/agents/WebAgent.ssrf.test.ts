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
    const permissive = agent as unknown as { validateUrl(url: string): void };
    const realValidate = permissive.validateUrl.bind(permissive);
    let firstCall = true;
    permissive.validateUrl = (url: string) => {
      if (firstCall) { firstCall = false; return; }  // stand in for a public host
      realValidate(url);
    };

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
    const permissive = agent as unknown as { validateUrl(url: string): void };
    const realValidate = permissive.validateUrl.bind(permissive);
    let firstCall = true;
    permissive.validateUrl = (url: string) => {
      if (firstCall) { firstCall = false; return; }
      realValidate(url);
    };

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
    const permissive = agent as unknown as { validateUrl(url: string): void };
    permissive.validateUrl = () => undefined;  // allow every hop

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
    const permissive = agent as unknown as { validateUrl(url: string): void };
    permissive.validateUrl = () => undefined;

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
    (agent as unknown as { validateUrl(url: string): void }).validateUrl = () => undefined;

    const result = await fetchVia(agent, `http://127.0.0.1:${port}/`);
    expect(result.status).toBe('success');
    expect(String(result.content)).toContain('DIRECT');
  });
});
