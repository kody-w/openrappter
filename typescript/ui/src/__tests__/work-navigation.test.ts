import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenRappterApp } from '../components/app.js';
import type { RappWork } from '../components/work.js';

const client = vi.hoisted(() => ({
  connect: vi.fn(), call: vi.fn(), subscribe: vi.fn(), on: vi.fn(), off: vi.fn(),
  onStatusChange: null as ((connected: boolean) => void) | null,
}));
vi.mock('../services/gateway.js', () => ({ gateway: client }));
import '../components/app.js';
import '../components/sidebar.js';
import '../components/work.js';
import { VIEW_IDS } from '../services/navigation.js';
import { handleDesktopUiCommand, snapshotDesktopUi } from '../services/desktop-control.js';

async function settle(app: OpenRappterApp) {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await app.updateComplete;
    const work = app.shadowRoot?.querySelector<RappWork>('rapp-work');
    await work?.updateComplete;
    await app.shadowRoot?.querySelector('openrappter-sidebar')?.updateComplete;
  }
}

async function mount() {
  const app = document.createElement('openrappter-app');
  document.body.append(app);
  await settle(app);
  return app;
}

beforeEach(() => {
  client.connect.mockReset().mockResolvedValue(undefined);
  client.subscribe.mockReset().mockResolvedValue(undefined);
  client.call.mockReset().mockImplementation(async (method) => {
    if (method === 'status') return { uptime: 120, connections: 1 };
    if (method === 'vm.status') return { state: 'stopped', local: true };
    return [];
  });
  client.on.mockClear();
  client.off.mockClear();
});
afterEach(() => {
  document.body.replaceChildren();
  delete window.openrappterDesktop;
});

describe('RAPP Work entry points and navigation', () => {
  it.each(['web', 'desktop'])('opens Work by default on %s without a legacy override', async (host) => {
    if (host === 'desktop') window.openrappterDesktop = {} as typeof window.openrappterDesktop;
    const app = await mount();
    expect(app.shadowRoot!.querySelector('rapp-work')).not.toBeNull();
    expect(app.shadowRoot!.querySelector('openrappter-surgeon')).toBeNull();
    expect(app.shadowRoot!.querySelector('openrappter-chat')).toBeNull();
    const sidebar = app.shadowRoot!.querySelector('openrappter-sidebar')!;
    expect(sidebar.shadowRoot!.querySelector('[aria-current="page"]')?.textContent).toContain('Work');
    expect(sidebar.shadowRoot!.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    const primary = sidebar.shadowRoot!.querySelector('[aria-label="Primary navigation"]')!;
    expect(primary.textContent).not.toMatch(/Surgeon|RAPPIDs|Operating room|dinosaur/);
    expect(sidebar.shadowRoot!.textContent).toContain('RAPP Work');
    expect(sidebar.shadowRoot!.textContent).toContain('Compatibility');
  });

  it('keeps all registered destinations wired through keyboard-native navigation buttons', async () => {
    const app = await mount();
    const sidebar = app.shadowRoot!.querySelector('openrappter-sidebar')!;
    const routes = sidebar.shadowRoot!.querySelectorAll<HTMLButtonElement>('[data-view]');
    expect([...routes].map((button) => button.dataset.view).sort()).toEqual([...VIEW_IDS].sort());
    for (const view of VIEW_IDS) {
      const navigation = sidebar.shadowRoot!.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!;
      expect(navigation.tagName).toBe('BUTTON');
      navigation.click();
      await settle(app);
      const tag = view === 'work' ? 'rapp-work' : `openrappter-${view}`;
      expect(app.shadowRoot!.querySelector(tag), `Route ${view}`).not.toBeNull();
      expect(document.title).toMatch(/^RAPP Work · /);
    }
    app.shadowRoot!.querySelector<HTMLButtonElement>('.back')!.click();
    await settle(app);
    expect(app.shadowRoot!.querySelector('rapp-work')).not.toBeNull();
  });

  it('retains Work during initial connection, failure, and reconnect without injecting demo data', async () => {
    client.connect.mockRejectedValueOnce(new Error('Unauthorized'));
    const app = await mount();
    const work = app.shadowRoot!.querySelector('rapp-work')!;
    expect(app.shadowRoot!.textContent).toContain('RAPP Work is waiting for your gateway.');
    expect(work.shadowRoot!.querySelector('[data-demo]')).toBeNull();
    expect(app.shadowRoot!.textContent).not.toMatch(/patient|anatomy|operating room/i);
    app.shadowRoot!.querySelector<HTMLButtonElement>('.retry')!.click();
    await settle(app);
    expect(app.shadowRoot!.querySelector('rapp-work')).toBe(work);
    expect(app.shadowRoot!.querySelector('.status-dot.connected')).not.toBeNull();
    client.onStatusChange!(false);
    await settle(app);
    expect(work.connected).toBe(false);
    client.onStatusChange!(true);
    await settle(app);
    expect(work.connected).toBe(true);
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(client.subscribe.mock.calls[1][0]).toEqual(expect.arrayContaining(['approval', 'workspace', 'vm', 'agent.tool']));
  });

  it('does not hide usable Work when only event subscription is unavailable', async () => {
    client.subscribe.mockRejectedValue(new Error('Method not found: subscribe'));
    const app = await mount();
    expect(app.shadowRoot!.querySelector('rapp-work')?.connected).toBe(true);
    expect(app.shadowRoot!.textContent).toContain('Live event subscription unavailable');
  });

  it('routes a real Work thread to Chat with its session ID and supports desktop Work navigation', async () => {
    const app = await mount();
    app.shadowRoot!.querySelector('rapp-work')!.dispatchEvent(new CustomEvent('navigate', {
      detail: { view: 'chat', sessionId: 'a-real-session' }, bubbles: true, composed: true,
    }));
    await settle(app);
    expect((app.shadowRoot!.querySelector('openrappter-chat') as HTMLElement & { initialSessionId: string }).initialSessionId)
      .toBe('a-real-session');
    await handleDesktopUiCommand({ action: 'navigate', args: { view: 'work' } });
    await settle(app);
    expect(app.shadowRoot!.querySelector('rapp-work')).not.toBeNull();
    expect(snapshotDesktopUi().view).toBe('work');
    await handleDesktopUiCommand({ action: 'navigate', args: { view: 'chat' } });
    await settle(app);
    expect((app.shadowRoot!.querySelector('openrappter-chat') as HTMLElement & { initialSessionId: string | null }).initialSessionId)
      .toBeNull();
    await handleDesktopUiCommand({ action: 'navigate', args: { view: 'rappids' } });
    await settle(app);
    expect(app.shadowRoot!.querySelector('openrappter-rappids')).not.toBeNull();
    await expect(handleDesktopUiCommand({ action: 'navigate', args: { view: 'invented' } })).rejects.toThrow('Unknown RAPP Work view');
  });

  it('preserves chat focus mode and ignores invented UI routes', async () => {
    const app = await mount();
    app.navigate('chat');
    await settle(app);
    app.shadowRoot!.querySelector('openrappter-chat')!.dispatchEvent(new CustomEvent('toggle-focus', {
      detail: { focused: true }, bubbles: true, composed: true,
    }));
    await settle(app);
    expect(app.shadowRoot!.querySelector('openrappter-sidebar')).toBeNull();
    app.navigate('work');
    await settle(app);
    expect(app.shadowRoot!.querySelector('openrappter-sidebar')).not.toBeNull();
    app.navigate('invented' as never);
    await settle(app);
    expect(app.shadowRoot!.querySelector('rapp-work')).not.toBeNull();
  });

  it('brands shipped metadata while retaining install and repository identifiers', () => {
    const ui = resolve(__dirname, '../..');
    const index = readFileSync(resolve(ui, 'index.html'), 'utf8');
    const main = readFileSync(resolve(ui, 'src/main.ts'), 'utf8');
    const desktop = JSON.parse(readFileSync(resolve(ui, '../desktop/package.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(resolve(ui, 'package.json'), 'utf8'));
    expect(index).toContain('<title>RAPP Work · Your local AI workforce.</title>');
    expect(index).toContain('content="RAPP Work"');
    expect(main).toContain("import './components/work.js'");
    expect(main).toContain("import './components/surgeon.js'");
    expect(main).toContain("import './components/rappids.js'");
    expect(pkg.name).toBe('openrappter-ui');
    expect(desktop.name).toBe('openrappter-desktop');
    expect(desktop.build.productName).toBe('RAPP Work');
    expect(desktop.build.appId).toBe('com.openrappter.desktop');
  });
});
