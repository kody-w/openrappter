/**
 * Browser automation RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface BrowserService {
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  getContent(selector?: string): Promise<string>;
}

interface BrowserMethodsDeps {
  browserService?: BrowserService;
}

interface BrowserRequestParams {
  action: 'navigate' | 'click' | 'screenshot' | 'content';
  url?: string;
  selector?: string;
}

interface BrowserRequestResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function registerBrowserMethods(
  server: MethodRegistrar,
  deps?: BrowserMethodsDeps
): void {
  server.registerMethod<BrowserRequestParams, BrowserRequestResult>(
    'browser.request',
    async (params) => {
      const { action, url, selector } = params;
      const browserService = deps?.browserService;

      if (!browserService) {
        return {
          success: false,
          error: 'Browser service not available',
        };
      }

      try {
        switch (action) {
          case 'navigate':
            if (!url) throw new Error('URL required for navigate action');
            await browserService.navigate(url);
            return { success: true };

          case 'click':
            if (!selector) throw new Error('Selector required for click action');
            await browserService.click(selector);
            return { success: true };

          case 'screenshot':
            const screenshot = await browserService.screenshot();
            return { success: true, data: screenshot.toString('base64') };

          case 'content':
            const content = await browserService.getContent(selector);
            return { success: true, data: content };

          default:
            return { success: false, error: `Unknown action: ${action}` };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
}
