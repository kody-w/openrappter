/**
 * BrowserAgent - Headless browser automation agent.
 *
 * Provides web browser automation capabilities including page navigation,
 * screenshots, element interaction, and content extraction.
 *
 * Actions: navigate, screenshot, click, fill, extract, close, pages
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import type { BrowserConfig } from '../browser/service.js';


export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/browser',
  version: '1.0.0',
  display_name: 'Browser',
  description: 'Headless browser automation for web scraping, testing, and interaction. Navigate pages, take screenshots, click elements, fill forms, and extract content.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'dynamic-code'
  ],
  tags: [
    'openrappter',
    'browser'
  ],
  category: 'automation',
  quality_tier: 'official',
  requires_env: []
} as const;

export interface BrowserAgentOptions {
  /** Trusted operator opt-in; never exposed as an agent action parameter. */
  allowPrivateNetwork?: boolean;
}

interface BrowserSurface {
  navigate(url: string): Promise<{ url?: string; error?: string }>;
  screenshot(options?: { path?: string }): Promise<string | null>;
  click(selector: string): Promise<{ success: boolean; error?: string }>;
  fill(selector: string, value: string): Promise<{ success: boolean; error?: string }>;
  extract(selector?: string): Promise<string | null>;
  close(): Promise<void>;
  listPages(): Array<{ id: string; url: string }>;
}

export class BrowserAgent extends BasicAgent {
  private browser: BrowserSurface | null = null;
  private browserConfig: Partial<BrowserConfig>;

  constructor(options: BrowserAgentOptions = {}) {
    const metadata: AgentMetadata = {
      name: 'Browser',
      description: 'Headless browser automation for web scraping, testing, and interaction. Navigate pages, take screenshots, click elements, fill forms, and extract content.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The browser action to perform.',
            enum: ['navigate', 'screenshot', 'click', 'fill', 'extract', 'close', 'pages'],
          },
          url: {
            type: 'string',
            description: "URL to navigate to (for 'navigate' action).",
          },
          path: {
            type: 'string',
            description: "File path to save screenshot (for 'screenshot' action).",
          },
          selector: {
            type: 'string',
            description: "CSS selector for element (for 'click', 'fill', 'extract' actions).",
          },
          value: {
            type: 'string',
            description: "Value to fill into input element (for 'fill' action).",
          },
        },
        required: [],
      },
    };
    super('Browser', metadata);
    this.browserConfig = {
      allowPrivateNetwork:
        options.allowPrivateNetwork
        ?? process.env.OPENRAPPTER_BROWSER_ALLOW_PRIVATE_NETWORK === '1',
    };
  }

  private async getBrowser(): Promise<BrowserSurface> {
    if (!this.browser) {
      const { BrowserService } = await import('../browser/service.js');
      this.browser = new BrowserService(this.browserConfig);
    }
    return this.browser!;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const url = kwargs.url as string | undefined;
    const path = kwargs.path as string | undefined;
    const selector = kwargs.selector as string | undefined;
    const value = kwargs.value as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: navigate, screenshot, click, fill, extract, close, or pages',
      });
    }

    try {
      const browser = await this.getBrowser();

      switch (action) {
        case 'navigate':
          if (!url) {
            return JSON.stringify({ status: 'error', message: 'URL required for navigate action' });
          }
          const navigation = await browser.navigate(url);
          if (navigation?.error) {
            return JSON.stringify({
              status: 'error',
              action: 'navigate',
              message: navigation.error,
            });
          }
          return JSON.stringify({
            status: 'success',
            action: 'navigate',
            url: navigation?.url ?? url,
            message: `Navigated to ${navigation?.url ?? url}`,
          });

        case 'screenshot':
          const screenshot = await browser.screenshot({ path });
          if (!screenshot) {
            return JSON.stringify({
              status: 'error',
              action: 'screenshot',
              message: 'Screenshot failed',
            });
          }
          return JSON.stringify({
            status: 'success',
            action: 'screenshot',
            path,
            data: path ? undefined : screenshot,
            message: path ? `Screenshot saved to ${path}` : 'Screenshot captured',
          });

        case 'click':
          if (!selector) {
            return JSON.stringify({ status: 'error', message: 'Selector required for click action' });
          }
          const click = await browser.click(selector);
          if (!click.success) {
            return JSON.stringify({
              status: 'error',
              action: 'click',
              message: click.error ?? 'Click failed',
            });
          }
          return JSON.stringify({
            status: 'success',
            action: 'click',
            selector,
            message: `Clicked element: ${selector}`,
          });

        case 'fill':
          if (!selector || !value) {
            return JSON.stringify({ status: 'error', message: 'Selector and value required for fill action' });
          }
          const fill = await browser.fill(selector, value);
          if (!fill.success) {
            return JSON.stringify({
              status: 'error',
              action: 'fill',
              message: fill.error ?? 'Fill failed',
            });
          }
          return JSON.stringify({
            status: 'success',
            action: 'fill',
            selector,
            message: `Filled ${selector} with value`,
          });

        case 'extract':
          const content = await browser.extract(selector);
          if (content === null) {
            return JSON.stringify({
              status: 'error',
              action: 'extract',
              message: 'Content not found',
            });
          }
          return JSON.stringify({
            status: 'success',
            action: 'extract',
            selector: selector || 'full page',
            content,
            length: typeof content === 'string' ? content.length : 0,
          });

        case 'close':
          await browser.close();
          this.browser = null;
          return JSON.stringify({
            status: 'success',
            action: 'close',
            message: 'Browser closed',
          });

        case 'pages':
          const pages = browser.listPages();
          return JSON.stringify({
            status: 'success',
            action: 'pages',
            pages,
            count: pages.length,
          });

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
}
