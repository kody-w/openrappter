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

import {
  assertFetchableUrl,
  assertHostResolvesPublicly,
  fetchGuarded,
} from '../net/url-guard.js';


export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/web',
  version: '1.0.0',
  display_name: 'Web',
  description: 'Fetch web pages and search the web. Includes SSRF protection to prevent access to private networks.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'network'
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

  /** Shared with ImageAgent so the two cannot drift apart again. */
  private validateUrl(url: string): void {
    assertFetchableUrl(url);
  }

  /**
   * Test seam. Which loopback address a name resolves to is a property of the
   * machine, not of this code: `localtest.me` gives 127.0.0.1 on one host and
   * ::1 on another, and a test that pinned either one failed on the other.
   */
  protected async lookupHost(hostname: string): Promise<Array<{ address: string }>> {
    return lookup(hostname, { all: true });
  }

  private async assertHostResolvesPublicly(url: string): Promise<void> {
    await assertHostResolvesPublicly(url, hostname => this.lookupHost(hostname));
  }

  private async fetchWithValidatedRedirects(url: string): Promise<Response> {
    // Pass this agent's own checks through, so a caller that overrides them —
    // tests reaching loopback on purpose — still overrides the whole path.
    return fetchGuarded(
      url,
      undefined,
      hostname => this.lookupHost(hostname),
      target => this.validateUrl(target),
    );
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
