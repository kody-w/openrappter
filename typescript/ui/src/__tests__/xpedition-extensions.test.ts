import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../components/xpedition-extension-host.js';
import '../components/xpedition-onboarding.js';
import '../components/xpedition-shell.js';
import {
  XPEDITION_EXTENSION_SCHEMA,
  installXpeditionExtensionApi,
  listXpeditionExtensions,
  registerXpeditionExtension,
  type XpeditionAppExtensionV1,
} from '../services/xpedition-extensions.js';
import {
  DEFAULT_XPEDITION_PREFERENCES,
  allXpeditionApps,
  saveXpeditionPreferences,
  type StorageLike,
} from '../services/xpedition.js';
import { handleDesktopUiCommand } from '../services/desktop-control.js';
import type { OpenRappterXpeditionExtensionHost } from '../components/xpedition-extension-host.js';
import type { OpenRappterXpeditionShell } from '../components/xpedition-shell.js';

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function extension(
  id = 'extension:boundary-fixture',
  elementTag = 'boundary-fixture-app',
): XpeditionAppExtensionV1 {
  return {
    schema: XPEDITION_EXTENSION_SCHEMA,
    id: id as `extension:${string}`,
    title: 'Boundary Fixture',
    shortTitle: 'Boundary',
    description: 'An external fixture mounted through the public seam.',
    glyph: 'EXT',
    elementTag: elementTag as `${string}-${string}`,
    desktop: true,
    dataSeams: ['fixture.status/1.0'],
  };
}

describe('XPedition public extension seam', () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    while (unregisters.length > 0) unregisters.pop()?.();
    document.body.innerHTML = '';
    delete window.openrappterXpeditionExtensions;
    vi.restoreAllMocks();
  });

  it('registers, lists, freezes, and cleanly unregisters a v1 app', () => {
    const unregister = registerXpeditionExtension(extension());
    unregisters.push(unregister);
    const registered = listXpeditionExtensions();
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      schema: 'openrappter-xpedition-extension/1.0',
      id: 'extension:boundary-fixture',
      elementTag: 'boundary-fixture-app',
    });
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered[0])).toBe(true);
    expect(Object.isFrozen(registered[0].dataSeams)).toBe(true);

    expect(allXpeditionApps().some((app) => app.id === registered[0].id)).toBe(true);
    unregister();
    unregisters.pop();
    expect(listXpeditionExtensions()).toEqual([]);
  });

  it('publishes only the stable registration interface on window', () => {
    const api = installXpeditionExtensionApi();
    expect(window.openrappterXpeditionExtensions).toBe(api);
    expect(Object.keys(api).sort()).toEqual(['list', 'register', 'schema']);
    expect(api.schema).toBe('openrappter-xpedition-extension/1.0');
    expect(JSON.stringify(api)).not.toMatch(/tenant|billing|licenseKey|controlPlane/i);
  });

  it('rejects arbitrary ids, schemas, tags, empty seams, and duplicates', () => {
    expect(() => registerXpeditionExtension({
      ...extension(),
      schema: 'private-control-plane/1.0' as never,
    })).toThrow(/Unsupported/);
    expect(() => registerXpeditionExtension({
      ...extension(),
      id: 'tenant-123' as never,
    })).toThrow(/extension:/);
    expect(() => registerXpeditionExtension({
      ...extension(),
      elementTag: 'notacustomelement' as never,
    })).toThrow(/custom-element/);
    expect(() => registerXpeditionExtension({
      ...extension(),
      dataSeams: [],
    })).toThrow(/dataSeams/);
    unregisters.push(registerXpeditionExtension(extension()));
    expect(() => registerXpeditionExtension(extension())).toThrow(/already registered/);
  });

  it('mounts only an installed custom element and exposes a minimal personal context', async () => {
    class BoundaryFixtureApp extends HTMLElement {
      openrappterXpedition?: Record<string, unknown>;
    }
    if (!customElements.get('boundary-installed-app')) {
      customElements.define('boundary-installed-app', BoundaryFixtureApp);
    }
    const descriptor = extension(
      'extension:installed-boundary',
      'boundary-installed-app',
    );
    const unregister = registerXpeditionExtension(descriptor);
    unregisters.push(unregister);
    const host = document.createElement(
      'openrappter-xpedition-extension-host',
    ) as OpenRappterXpeditionExtensionHost;
    host.extension = descriptor;
    document.body.append(host);
    await host.updateComplete;
    const child = host.shadowRoot!.querySelector(
      'boundary-installed-app',
    ) as BoundaryFixtureApp;
    expect(child).not.toBeNull();
    expect(child.openrappterXpedition).toMatchObject({
      schema: 'openrappter-xpedition-extension-context/1.0',
      product: 'OpenRappter Personal',
    });
    expect(Object.keys(child.openrappterXpedition!).sort()).toEqual([
      'openApp',
      'product',
      'schema',
    ]);
    expect(JSON.stringify(child.openrappterXpedition)).not.toMatch(
      /token|tenant|billing|credential/i,
    );
  });

  it('shows a truthful unavailable state when the registered element is absent', async () => {
    const descriptor = extension(
      'extension:missing-boundary',
      'boundary-missing-app',
    );
    const unregister = registerXpeditionExtension(descriptor);
    unregisters.push(unregister);
    const host = document.createElement(
      'openrappter-xpedition-extension-host',
    ) as OpenRappterXpeditionExtensionHost;
    host.extension = descriptor;
    document.body.append(host);
    await host.updateComplete;
    await host.updateComplete;
    expect(host.shadowRoot!.textContent).toContain('Extension unavailable');
    expect(host.shadowRoot!.textContent).toContain('is not installed in this build');
    expect(host.shadowRoot!.textContent).toContain('fixture.status/1.0');
  });

  it('adds a first-class Start/desktop window without changing the core catalog', async () => {
    const descriptor = extension(
      'extension:first-class-boundary',
      'boundary-first-class-app',
    );
    const unregister = registerXpeditionExtension(descriptor);
    unregisters.push(unregister);
    const storage = new MemoryStorage();
    saveXpeditionPreferences(storage, {
      ...DEFAULT_XPEDITION_PREFERENCES,
      onboardingCompleted: true,
    });
    const shell = document.createElement(
      'openrappter-xpedition-shell',
    ) as OpenRappterXpeditionShell;
    shell.storage = storage;
    shell.connected = false;
    document.body.append(shell);
    await shell.updateComplete;
    shell.openApp(descriptor.id);
    await shell.updateComplete;
    expect(shell.getDesktopState()).toMatchObject({
      windows: [
        expect.objectContaining({ appId: descriptor.id }),
      ],
    });
    expect(shell.shadowRoot!.querySelector(
      'openrappter-xpedition-extension-host',
    )).not.toBeNull();
    unregister();
    unregisters.pop();
    await shell.updateComplete;
    expect((shell.getDesktopState().windows as unknown[])).toHaveLength(0);
  });

  it('allows semantic open only while an extension is registered', async () => {
    const descriptor = extension(
      'extension:semantic-boundary',
      'boundary-semantic-app',
    );
    const unregister = registerXpeditionExtension(descriptor);
    const app = document.createElement('openrappter-app') as HTMLElement &
      Record<string, unknown>;
    Object.assign(app, {
      openDesktopApp: vi.fn((appId: string) => ({ appId })),
    });
    document.body.append(app);
    await expect(handleDesktopUiCommand({
      action: 'open_app',
      args: { appId: descriptor.id },
    })).resolves.toEqual({ appId: descriptor.id });
    unregister();
    await expect(handleDesktopUiCommand({
      action: 'open_app',
      args: { appId: descriptor.id },
    })).rejects.toThrow(/unregistered/);
  });

  it('keeps the default open catalog tenant-free and control-plane-free', () => {
    const serialized = JSON.stringify(allXpeditionApps());
    expect(serialized).not.toMatch(
      /tenantId|subscriptionId|billingAccount|entitlementKey|controlPlaneUrl/i,
    );
    expect(serialized).toContain('OpenRappter');
  });
});
