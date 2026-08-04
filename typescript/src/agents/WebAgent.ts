/**
 * WebAgent - HTTP requests and web search agent.
 *
 * Provides web content fetching with SSRF protection and DuckDuckGo search.
 * Includes inline validation to block access to private IP ranges.
 *
 * Actions: fetch, search
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { lookup } from 'dns/promises';


export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/web',
  version: '1.0.0',
  display_name: 'Web',
  description: 'Fetch web pages and search the web. Includes SSRF protection to prevent access to private networks.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'network',
    'process-exec'
  ],
  tags: [
    'openrappter',
    'web'
  ],
  category: 'research',
  quality_tier: 'official',
  requires_env: []
} as const;
export class WebAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Web',
      description: 'Fetch web pages and search the web. Includes SSRF protection to prevent access to private networks.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The web action to perform.',
            enum: ['fetch', 'search'],
          },
          url: {
            type: 'string',
            description: "URL to fetch (for 'fetch' action).",
          },
          query: {
            type: 'string',
            description: "Search query (for 'search' action).",
          },
        },
        required: [],
      },
    };
    super('Web', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const url = kwargs.url as string | undefined;
    const query = kwargs.query as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: fetch or search',
      });
    }

    try {
      switch (action) {
        case 'fetch':
          if (!url) {
            return JSON.stringify({ status: 'error', message: 'URL required for fetch action' });
          }
          return await this.fetchUrl(url);

        case 'search':
          if (!query) {
            return JSON.stringify({ status: 'error', message: 'Query required for search action' });
          }
          return await this.searchWeb(query);

        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  private static readonly MAX_REDIRECTS = 5;

  /**
   * Test seam. Which loopback address a name resolves to is a property of the
   * machine, not of this code: `localtest.me` gives 127.0.0.1 on one host and
   * ::1 on another, and a test that pinned either one failed on the other.
   */
  protected async lookupHost(hostname: string): Promise<Array<{ address: string }>> {
    return lookup(hostname, { all: true });
  }

  private static readonly BLOCKED_HOST_PATTERNS = [
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

  /**
   * Reduce a URL hostname or a resolved address to something the patterns can
   * match.
   *
   * `URL.hostname` keeps the brackets on an IPv6 literal, so `http://[::1]/`
   * arrives as `"[::1]"` and `/^::1$/` never fires. Every IPv6 rule in this
   * list was unreachable for that reason — `[::1]`, `[fe80::1]` and
   * `[::ffff:127.0.0.1]` were all allowed through.
   *
   * IPv4-mapped addresses are folded back to dotted quad so the IPv4 rules
   * apply to them: `::ffff:7f00:1` is 127.0.0.1 wearing a different hat.
   */
  private static normaliseHost(host: string): string {
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

  private static isBlockedHost(host: string): boolean {
    const normalised = WebAgent.normaliseHost(host);
    if (normalised === 'localhost' || normalised.endsWith('.local')) return true;
    return WebAgent.BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(normalised));
  }

  private validateUrl(url: string): void {
    const parsed = new URL(url);

    // A web fetcher has no business on any other scheme. `data:` URLs are
    // fetchable by Node and would let a caller feed arbitrary content back to
    // the model as though it had been retrieved; `file:` is refused by fetch
    // today, which is a property of fetch rather than a decision made here.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    }

    if (WebAgent.isBlockedHost(parsed.hostname)) {
      throw new Error(`Access to private IP range blocked: ${parsed.hostname}`);
    }
  }

  /**
   * Resolve the host and check where it actually points.
   *
   * The checks above read the hostname as text, so any public name that
   * resolves inward walked straight past them. `localtest.me` is a real public
   * DNS name that resolves to 127.0.0.1, and fetching it returned the body of a
   * loopback server on this machine — the whole protection bypassed without a
   * redirect or a malformed address.
   *
   * DNS can still change between this lookup and the connection. That race is
   * narrower than the hole it closes, and closing it completely means pinning
   * the resolved address through the socket, which fetch does not expose.
   */
  private async assertHostResolvesPublicly(url: string): Promise<void> {
    const { hostname } = new URL(url);
    let resolved: Array<{ address: string }>;
    try {
      resolved = await this.lookupHost(hostname);
    } catch {
      return;  // Unresolvable; fetch will fail on its own terms.
    }

    for (const { address } of resolved) {
      if (WebAgent.isBlockedHost(address)) {
        throw new Error(
          `Access to private IP range blocked: ${hostname} resolves to ${address}`,
        );
      }
    }
  }

  private async fetchWithValidatedRedirects(url: string): Promise<Response> {
    let target = url;

    for (let hop = 0; hop <= WebAgent.MAX_REDIRECTS; hop++) {
      this.validateUrl(target);
      await this.assertHostResolvesPublicly(target);
      const response = await fetch(target, { redirect: 'manual' });

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) return response;

      const location = response.headers.get('location');
      if (!location) return response;

      // Resolve relative redirects against the hop they came from.
      target = new URL(location, target).toString();
    }

    throw new Error(`Too many redirects (limit ${WebAgent.MAX_REDIRECTS}): ${url}`);
  }

  private async fetchUrl(url: string): Promise<string> {
    const response = await this.fetchWithValidatedRedirects(url);
    if (!response.ok) {
      return JSON.stringify({
        status: 'error',
        message: `HTTP ${response.status}: ${response.statusText}`,
        url,
      });
    }

    let content = await response.text();

    // Strip HTML tags with regex
    content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    content = content.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    content = content.replace(/<[^>]+>/g, ' ');
    content = content.replace(/\s+/g, ' ').trim();

    // Limit to 5000 characters
    const truncated = content.length > 5000;
    content = content.slice(0, 5000);

    return JSON.stringify({
      status: 'success',
      action: 'fetch',
      url,
      content,
      truncated,
      length: content.length,
    });
  }

  private async searchWeb(query: string): Promise<string> {
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl);
    if (!response.ok) {
      return JSON.stringify({
        status: 'error',
        message: `Search failed: HTTP ${response.status}`,
        query,
      });
    }

    const html = await response.text();

    // Parse DuckDuckGo lite HTML results
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkPattern = /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi;
    const snippetPattern = /<td class="result-snippet">([^<]+)<\/td>/gi;

    let linkMatch;
    const links: Array<{ url: string; title: string }> = [];
    while ((linkMatch = linkPattern.exec(html)) !== null) {
      links.push({ url: linkMatch[1], title: linkMatch[2] });
    }

    let snippetMatch;
    const snippets: string[] = [];
    while ((snippetMatch = snippetPattern.exec(html)) !== null) {
      snippets.push(snippetMatch[1].trim());
    }

    for (let i = 0; i < Math.min(links.length, snippets.length, 10); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i],
      });
    }

    return JSON.stringify({
      status: 'success',
      action: 'search',
      query,
      results,
      count: results.length,
    });
  }
}
