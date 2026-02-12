/**
 * Browser Automation Service
 * Uses Playwright CDP for browser control
 */

import { EventEmitter } from 'events';

// Ambient declaration for browser-context code executed via page.evaluate()
declare const document: {
  querySelectorAll(selector: string): Array<{ remove(): void }> & { forEach(fn: (el: { remove(): void }) => void): void };
  querySelector(selector: string): { innerText?: string } | null;
  body: { innerText: string };
};

// Playwright types (dynamically imported)
interface Browser {
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  pages(): Page[];
}

interface Page {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<Response | null>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  pdf(options?: PDFOptions): Promise<Buffer>;
  click(selector: string, options?: ClickOptions): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  type(selector: string, text: string, options?: TypeOptions): Promise<void>;
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<ElementHandle | null>;
  waitForNavigation(options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<Response | null>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluateHandle<T>(fn: () => T): Promise<JSHandle<T>>;
  $(selector: string): Promise<ElementHandle | null>;
  $$(selector: string): Promise<ElementHandle[]>;
  close(): Promise<void>;
  isClosed(): boolean;
}

interface ElementHandle {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  innerText(): Promise<string>;
  innerHTML(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
}

interface JSHandle<T> {
  jsonValue(): Promise<T>;
  dispose(): Promise<void>;
}

interface Response {
  status(): number;
  url(): string;
}

interface BrowserContextOptions {
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
}

interface ScreenshotOptions {
  path?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
}

interface PDFOptions {
  path?: string;
  format?: 'Letter' | 'Legal' | 'Tabloid' | 'A4';
  printBackground?: boolean;
}

interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
}

interface TypeOptions {
  delay?: number;
}

interface WaitForSelectorOptions {
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeout?: number;
}

export interface BrowserConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  timeout?: number;
  slowMo?: number;
}

export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  screenshot?: string;
  error?: string;
}

export interface ActionResult {
  success: boolean;
  url?: string;
  error?: string;
  data?: unknown;
}

const DEFAULT_CONFIG: BrowserConfig = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  timeout: 30000,
};

export class BrowserService extends EventEmitter {
  private config: BrowserConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages = new Map<string, Page>();
  private pageCounter = 0;

  constructor(config?: Partial<BrowserConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the browser
   */
  async initialize(): Promise<void> {
    if (this.browser) return;

    try {
      const playwright = await import('playwright-core');

      // Try to connect to existing browser or launch new one
      this.browser = await playwright.chromium.launch({
        headless: this.config.headless,
        slowMo: this.config.slowMo,
      }) as unknown as Browser;

      this.context = await this.browser!.newContext({
        viewport: this.config.viewport,
        userAgent: this.config.userAgent,
      });

      console.log('Browser service initialized');
    } catch (error) {
      throw new Error(
        `Failed to initialize browser: ${(error as Error).message}. ` +
          `Make sure playwright-core is installed: npm install playwright-core`
      );
    }
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.pages.clear();
  }

  /**
   * Create a new page
   */
  async newPage(): Promise<string> {
    if (!this.context) {
      await this.initialize();
    }

    const page = await this.context!.newPage();
    const pageId = `page_${++this.pageCounter}`;
    this.pages.set(pageId, page);

    return pageId;
  }

  /**
   * Get or create default page
   */
  private async getDefaultPage(): Promise<Page> {
    let pageId = Array.from(this.pages.keys())[0];
    if (!pageId) {
      pageId = await this.newPage();
    }
    return this.pages.get(pageId)!;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, pageId?: string): Promise<BrowseResult> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) {
      return { url, title: '', content: '', error: 'Page not found' };
    }

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const title = await page.title();
      const content = await this.extractContent(page);

      return { url: page.url(), title, content };
    } catch (error) {
      return { url, title: '', content: '', error: (error as Error).message };
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(options?: { fullPage?: boolean; pageId?: string }): Promise<string | null> {
    const page = options?.pageId
      ? this.pages.get(options.pageId)
      : await this.getDefaultPage();

    if (!page) return null;

    try {
      const buffer = await page.screenshot({
        type: 'png',
        fullPage: options?.fullPage,
      });

      return buffer.toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Click an element
   */
  async click(selector: string, pageId?: string): Promise<ActionResult> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) {
      return { success: false, error: 'Page not found' };
    }

    try {
      await page.click(selector);
      return { success: true, url: page.url() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Fill an input
   */
  async fill(selector: string, value: string, pageId?: string): Promise<ActionResult> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) {
      return { success: false, error: 'Page not found' };
    }

    try {
      await page.fill(selector, value);
      return { success: true, url: page.url() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Type text
   */
  async type(selector: string, text: string, pageId?: string): Promise<ActionResult> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) {
      return { success: false, error: 'Page not found' };
    }

    try {
      await page.type(selector, text);
      return { success: true, url: page.url() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Wait for selector
   */
  async waitForSelector(
    selector: string,
    options?: { timeout?: number; pageId?: string }
  ): Promise<ActionResult> {
    const page = options?.pageId
      ? this.pages.get(options.pageId)
      : await this.getDefaultPage();

    if (!page) {
      return { success: false, error: 'Page not found' };
    }

    try {
      await page.waitForSelector(selector, {
        timeout: options?.timeout ?? this.config.timeout,
      });
      return { success: true, url: page.url() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Execute JavaScript in page
   */
  async evaluate<T>(fn: () => T, pageId?: string): Promise<T | null> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) return null;

    try {
      return await page.evaluate(fn);
    } catch {
      return null;
    }
  }

  /**
   * Get element text
   */
  async getText(selector: string, pageId?: string): Promise<string | null> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) return null;

    try {
      const element = await page.$(selector);
      if (!element) return null;
      return element.innerText();
    } catch {
      return null;
    }
  }

  /**
   * Get element attribute
   */
  async getAttribute(
    selector: string,
    attribute: string,
    pageId?: string
  ): Promise<string | null> {
    const page = pageId ? this.pages.get(pageId) : await this.getDefaultPage();
    if (!page) return null;

    try {
      const element = await page.$(selector);
      if (!element) return null;
      return element.getAttribute(attribute);
    } catch {
      return null;
    }
  }

  /**
   * Close a page
   */
  async closePage(pageId: string): Promise<boolean> {
    const page = this.pages.get(pageId);
    if (!page) return false;

    await page.close();
    this.pages.delete(pageId);
    return true;
  }

  /**
   * Get current URL
   */
  getUrl(pageId?: string): string | null {
    const page = pageId ? this.pages.get(pageId) : this.pages.values().next().value;
    return page?.url() ?? null;
  }

  /**
   * Get page IDs
   */
  getPageIds(): string[] {
    return Array.from(this.pages.keys());
  }

  /**
   * Check if browser is running
   */
  isRunning(): boolean {
    return !!this.browser?.isConnected();
  }

  /**
   * Extract readable content from page
   */
  private async extractContent(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        // Remove scripts, styles, and hidden elements
        const removeSelectors = [
          'script',
          'style',
          'noscript',
          'iframe',
          'svg',
          '[hidden]',
          '[style*="display:none"]',
          '[style*="display: none"]',
        ];

        for (const selector of removeSelectors) {
          document.querySelectorAll(selector).forEach((el: { remove(): void }) => el.remove());
        }

        // Get main content or body
        const main =
          document.querySelector('main') ??
          document.querySelector('article') ??
          document.querySelector('[role="main"]') ??
          document.body;

        // Clean up whitespace
        return (main?.innerText ?? '').replace(/\s+/g, ' ').trim();
      });
    } catch {
      return '';
    }
  }
}

export function createBrowserService(config?: Partial<BrowserConfig>): BrowserService {
  return new BrowserService(config);
}
