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

export class BrowserAgent extends BasicAgent {
  private browser: any = null;

  constructor() {
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
  }

  private async getBrowser() {
    if (!this.browser) {
      const { BrowserService } = await import('../browser/service.js');
      this.browser = new BrowserService();
    }
    return this.browser;
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
          await browser.navigate(url);
          return JSON.stringify({
            status: 'success',
            action: 'navigate',
            url,
            message: `Navigated to ${url}`,
          });

        case 'screenshot':
          const screenshotPath = await browser.screenshot(path);
          return JSON.stringify({
            status: 'success',
            action: 'screenshot',
            path: screenshotPath,
            message: `Screenshot saved to ${screenshotPath}`,
          });

        case 'click':
          if (!selector) {
            return JSON.stringify({ status: 'error', message: 'Selector required for click action' });
          }
          await browser.click(selector);
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
          await browser.fill(selector, value);
          return JSON.stringify({
            status: 'success',
            action: 'fill',
            selector,
            message: `Filled ${selector} with value`,
          });

        case 'extract':
          const content = await browser.extract(selector);
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
          const pages = await browser.pages();
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
