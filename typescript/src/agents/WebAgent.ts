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

  private validateUrl(url: string): void {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Block private IP ranges (SSRF protection)
    const privatePatterns = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^0\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/,
    ];

    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) {
        throw new Error(`Access to private IP range blocked: ${hostname}`);
      }
    }

    // Block localhost
    if (hostname === 'localhost' || hostname.endsWith('.local')) {
      throw new Error(`Access to localhost blocked: ${hostname}`);
    }
  }

  private async fetchUrl(url: string): Promise<string> {
    this.validateUrl(url);

    const response = await fetch(url);
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
