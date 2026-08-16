import { describe, expect, it, vi } from 'vitest';

import { BrowserAgent } from '../agents/BrowserAgent.js';
import {
  BrowserService,
  type BrowserRuntimeLoader,
} from './service.js';

function pageHarness() {
  const goto = vi.fn().mockResolvedValue(null);
  const screenshot = vi.fn().mockResolvedValue(Buffer.from('image'));
  return {
    goto,
    page: {
      goto,
      title: vi.fn().mockResolvedValue('Example'),
      url: vi.fn().mockReturnValue('https://example.com/'),
      evaluate: vi.fn().mockResolvedValue('content'),
      screenshot,
    },
  };
}

function serviceWithPage(
  config?: ConstructorParameters<typeof BrowserService>[0],
): { service: BrowserService; goto: ReturnType<typeof vi.fn> } {
  const service = new BrowserService(config);
  const { page, goto } = pageHarness();
  const internal = service as unknown as {
    pages: Map<string, unknown>;
  };
  internal.pages.set('test-page', page);
  return { service, goto };
}

describe('BrowserService URL policy', () => {
  it('blocks cloud metadata before Playwright receives the URL', async () => {
    const { service, goto } = serviceWithPage();

    const result = await service.navigate(
      'http://169.254.169.254/latest/meta-data/',
      'test-page',
    );

    expect(result.error).toMatch(/blocked|private/i);
    expect(goto).not.toHaveBeenCalled();
  });

  it('blocks a public hostname when DNS resolves it inward', async () => {
    const { service, goto } = serviceWithPage({
      hostLookup: async () => [{ address: '127.0.0.1' }],
    });

    const result = await service.navigate(
      'https://public.example/media',
      'test-page',
    );

    expect(result.error).toMatch(/resolves to|private/i);
    expect(goto).not.toHaveBeenCalled();
  });

  it('fails closed when a hostname cannot be verified', async () => {
    const { service, goto } = serviceWithPage({
      hostLookup: async () => { throw new Error('DNS unavailable'); },
    });

    const result = await service.navigate(
      'https://unverified.example/',
      'test-page',
    );

    expect(result.error).toMatch(/could not verify|DNS unavailable/i);
    expect(goto).not.toHaveBeenCalled();
  });

  it('still allows a public target', async () => {
    const { service, goto } = serviceWithPage({
      hostLookup: async () => [{ address: '93.184.216.34' }],
    });

    const result = await service.navigate(
      'https://example.com/',
      'test-page',
    );

    expect(result.error).toBeUndefined();
    expect(goto).toHaveBeenCalledWith(
      'https://example.com/',
      { waitUntil: 'domcontentloaded' },
    );
  });

  it('allows trusted local automation only through constructor opt-in', async () => {
    const { service, goto } = serviceWithPage({ allowPrivateNetwork: true });

    const result = await service.navigate(
      'http://127.0.0.1:3000/',
      'test-page',
    );

    expect(result.error).toBeUndefined();
    expect(goto).toHaveBeenCalled();
  });

  it('applies the policy to every browser request, including redirects', async () => {
    let routeHandler:
      | ((route: {
        request(): { url(): string };
        continue(): Promise<void>;
        abort(code?: string): Promise<void>;
      }) => Promise<void>)
      | undefined;
    let webSocketHandler:
      | ((route: {
        url(): string;
        connectToServer(): unknown;
        close(options?: { code?: number; reason?: string }): void;
      }) => Promise<void>)
      | undefined;
    const context = {
      newPage: vi.fn(),
      close: vi.fn(),
      pages: vi.fn().mockReturnValue([]),
      route: vi.fn().mockImplementation(async (_pattern, handler) => {
        routeHandler = handler;
      }),
      routeWebSocket: vi.fn().mockImplementation(async (_pattern, handler) => {
        webSocketHandler = handler;
      }),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };
    const loader: BrowserRuntimeLoader = async () => ({
      chromium: { launch: vi.fn().mockResolvedValue(browser) },
    });
    const service = new BrowserService(
      { hostLookup: async () => [{ address: '93.184.216.34' }] },
      loader,
    );
    await service.initialize();

    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(context.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ serviceWorkers: 'block' }),
    );
    expect(routeHandler).toBeDefined();

    const blocked = {
      request: () => ({ url: () => 'http://169.254.169.254/latest/meta-data/' }),
      continue: vi.fn(),
      abort: vi.fn(),
    };
    await routeHandler!(blocked);
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continue).not.toHaveBeenCalled();

    const publicRequest = {
      request: () => ({ url: () => 'https://example.com/app.js' }),
      continue: vi.fn(),
      abort: vi.fn(),
    };
    await routeHandler!(publicRequest);
    expect(publicRequest.continue).toHaveBeenCalled();
    expect(publicRequest.abort).not.toHaveBeenCalled();

    const blockedWebSocket = {
      url: () => 'ws://127.0.0.1:9222/devtools',
      connectToServer: vi.fn(),
      close: vi.fn(),
    };
    await webSocketHandler!(blockedWebSocket);
    expect(blockedWebSocket.close).toHaveBeenCalledWith({
      code: 1008,
      reason: 'Private network blocked',
    });
    expect(blockedWebSocket.connectToServer).not.toHaveBeenCalled();

    const publicWebSocket = {
      url: () => 'wss://example.com/socket',
      connectToServer: vi.fn(),
      close: vi.fn(),
    };
    await webSocketHandler!(publicWebSocket);
    expect(publicWebSocket.connectToServer).toHaveBeenCalled();
    expect(publicWebSocket.close).not.toHaveBeenCalled();
  });

  it('does not retain a context when secure routing setup fails', async () => {
    const context = {
      newPage: vi.fn(),
      close: vi.fn(),
      pages: vi.fn().mockReturnValue([]),
      route: vi.fn(),
      // Deliberately no routeWebSocket: Playwright < 1.48.
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const service = new BrowserService(
      { hostLookup: async () => [{ address: '93.184.216.34' }] },
      async () => ({ chromium: { launch } }),
    );

    await expect(service.navigate('https://example.com/')).rejects.toThrow(
      /routeWebSocket/,
    );
    await expect(service.navigate('https://example.com/')).rejects.toThrow(
      /routeWebSocket/,
    );

    expect(launch).toHaveBeenCalledTimes(2);
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(2);
    expect(service.isRunning()).toBe(false);
  });

  it('implements the page listing and extraction BrowserAgent calls', async () => {
    const { service } = serviceWithPage({
      hostLookup: async () => [{ address: '93.184.216.34' }],
    });

    expect(service.listPages()).toEqual([
      { id: 'test-page', url: 'https://example.com/' },
    ]);
    await expect(service.extract(undefined, 'test-page')).resolves.toBe('content');
  });
});

describe('BrowserAgent navigation result', () => {
  it('does not turn a service-level navigation refusal into success', async () => {
    const agent = new BrowserAgent();
    const internal = agent as unknown as {
      browser: { navigate(url: string): Promise<{ error: string }> };
    };
    internal.browser = {
      navigate: vi.fn().mockResolvedValue({ error: 'private address blocked' }),
    };

    const result = JSON.parse(
      await agent.perform({
        action: 'navigate',
        url: 'http://169.254.169.254/latest/meta-data/',
      }),
    ) as { status: string; message: string };

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/blocked/i);
  });

  it('passes screenshot paths in the shape BrowserService accepts', async () => {
    const screenshot = vi.fn().mockResolvedValue('base64-image');
    const agent = new BrowserAgent();
    (agent as unknown as { browser: { screenshot: typeof screenshot } }).browser = {
      screenshot,
    };

    const result = JSON.parse(
      await agent.perform({ action: 'screenshot', path: '/tmp/page.png' }),
    ) as { status: string; path: string };

    expect(result.status).toBe('success');
    expect(result.path).toBe('/tmp/page.png');
    expect(screenshot).toHaveBeenCalledWith({ path: '/tmp/page.png' });
  });

  it.each(['click', 'fill'])(
    'does not turn a service-level %s refusal into success',
    async (action) => {
      const browser = {
        [action]: vi.fn().mockResolvedValue({
          success: false,
          error: `${action} failed`,
        }),
      };
      const agent = new BrowserAgent();
      (agent as unknown as { browser: typeof browser }).browser = browser;

      const result = JSON.parse(
        await agent.perform({
          action,
          selector: '#submit',
          value: 'text',
        }),
      ) as { status: string; message: string };

      expect(result.status).toBe('error');
      expect(result.message).toContain(`${action} failed`);
    },
  );
});
