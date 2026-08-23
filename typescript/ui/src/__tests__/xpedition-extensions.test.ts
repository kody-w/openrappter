import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/xpedition-onboarding.js';
import '../components/xpedition-shell.js';
import {
  APPROVED_XPEDITION_ROUTE_IDS,
  AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID,
  installAuthoritativeXpeditionExtensionReader,
  installXpeditionDescriptorApi,
  listXpeditionDescriptors,
  registerXpeditionDescriptor,
  type AuthoritativeXpeditionExtensionReaderV1,
  type XpeditionExtensionDescriptorV1,
} from '../services/xpedition-extensions.js';
import {
  DEFAULT_XPEDITION_PREFERENCES,
  saveXpeditionPreferences,
  type StorageLike,
} from '../services/xpedition.js';
import { handleDesktopUiCommand } from '../services/desktop-control.js';
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

const allowedKeys = new Set([
  'appId',
  'capabilityIds',
  'order',
  'surfaceVersion',
]);
const allowedCapabilities = new Set([
  'ui:view',
  'agent:read',
  'channel:read',
  'session:read',
  'skill:read',
  'system:read',
  'memory:read',
]);

function fixtureReader(): AuthoritativeXpeditionExtensionReaderV1 {
  return {
    schemaId: AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID,
    read(candidate: unknown) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { ok: false, error: 'not an object' };
      }
      const record = candidate as Record<string, unknown>;
      if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        return { ok: false, error: 'additional property rejected' };
      }
      if (
        typeof record.appId !== 'string' ||
        !APPROVED_XPEDITION_ROUTE_IDS.includes(record.appId as never) ||
        (
          record.capabilityIds !== undefined &&
          (
            !Array.isArray(record.capabilityIds) ||
            record.capabilityIds.length > 7 ||
            new Set(record.capabilityIds).size !== record.capabilityIds.length ||
            record.capabilityIds.some((id) => !allowedCapabilities.has(String(id)))
          )
        ) ||
        (
          record.order !== undefined &&
          (
            !Number.isInteger(record.order) ||
            Number(record.order) < 0 ||
            Number(record.order) > 1000
          )
        ) ||
        record.surfaceVersion !== 1
      ) {
        return { ok: false, error: 'schema validation failed' };
      }
      return {
        ok: true,
        value: record as unknown as XpeditionExtensionDescriptorV1,
      };
    },
  };
}

function descriptor(): XpeditionExtensionDescriptorV1 {
  return {
    appId: 'agents',
    capabilityIds: ['agent:read'],
    order: 20,
    surfaceVersion: 1,
  };
}

describe('authoritative data-only XPedition v1 seam', () => {
  let uninstallReader: (() => void) | null = null;

  afterEach(() => {
    uninstallReader?.();
    uninstallReader = null;
    document.body.innerHTML = '';
    delete window.openrappterXpeditionDescriptors;
    vi.restoreAllMocks();
  });

  it('fails closed until the authoritative #445 reader is installed', () => {
    expect(() => registerXpeditionDescriptor(descriptor())).toThrow(
      /disabled until #445 lands/,
    );
    expect(listXpeditionDescriptors()).toEqual([]);
  });

  it('accepts only a reader bound to the exact #445 schema id', () => {
    expect(() => installAuthoritativeXpeditionExtensionReader({
      ...fixtureReader(),
      schemaId: 'https://example.test/competing-schema.json' as never,
    })).toThrow(/authoritative #445 schema id/);
    uninstallReader = installAuthoritativeXpeditionExtensionReader(
      fixtureReader(),
    );
    expect(() =>
      installAuthoritativeXpeditionExtensionReader(fixtureReader()),
    ).toThrow(/already installed/);
  });

  it('registers metadata that maps to an existing first-party route only', () => {
    uninstallReader = installAuthoritativeXpeditionExtensionReader(
      fixtureReader(),
    );
    const unregister = registerXpeditionDescriptor(descriptor());
    const registered = listXpeditionDescriptors();
    expect(registered).toEqual([
      {
        appId: 'extension:agents',
        descriptor: descriptor(),
      },
    ]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(JSON.stringify(registered)).not.toMatch(
      /elementTag|javascript|gatewayToken|preload|localStorage|href/i,
    );
    unregister();
    expect(listXpeditionDescriptors()).toEqual([]);
  });

  it('rejects executable, URL, arbitrary-route, and extra-control payloads', () => {
    uninstallReader = installAuthoritativeXpeditionExtensionReader(
      fixtureReader(),
    );
    for (const extra of [
      { elementTag: 'private-executable-app' },
      { javascript: 'run()' },
      { href: 'https://example.test' },
      { gatewayToken: 'fixture' },
      { onClick: 'activate-control' },
      { title: 'Caller controlled title' },
      { routeId: 'settings' },
    ]) {
      expect(() => registerXpeditionDescriptor({
        ...descriptor(),
        ...extra,
      })).toThrow(/additional property rejected/);
    }
    expect(() => registerXpeditionDescriptor({
      ...descriptor(),
      appId: 'private-control-plane',
    })).toThrow(/schema validation failed/);
    expect(() => registerXpeditionDescriptor({
      ...descriptor(),
      capabilityIds: ['tenant:admin'],
    })).toThrow(/schema validation failed/);
  });

  it('publishes only data registration/list methods to the browser', () => {
    const api = installXpeditionDescriptorApi();
    expect(window.openrappterXpeditionDescriptors).toBe(api);
    expect(Object.keys(api).sort()).toEqual(['list', 'register', 'schemaId']);
    expect(api.schemaId).toBe(
      'https://openrappter.dev/contracts/xpedition-extension-v1.json',
    );
    expect(JSON.stringify(api)).not.toMatch(
      /reader|element|execute|gateway|preload|storage|dom/i,
    );
  });

  it('opens the descriptor as the approved first-party route surface', async () => {
    uninstallReader = installAuthoritativeXpeditionExtensionReader(
      fixtureReader(),
    );
    const unregister = registerXpeditionDescriptor(descriptor());
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
    shell.openApp('extension:agents');
    await shell.updateComplete;
    expect(shell.shadowRoot!.querySelector('openrappter-agents')).not.toBeNull();
    expect(shell.shadowRoot!.textContent).toContain(
      'Data-only descriptor mapped to first-party route',
    );
    unregister();
    await shell.updateComplete;
    expect((shell.getDesktopState().windows as unknown[])).toHaveLength(0);
  });

  it('allows semantic open only for a currently approved registration', async () => {
    uninstallReader = installAuthoritativeXpeditionExtensionReader(
      fixtureReader(),
    );
    const unregister = registerXpeditionDescriptor(descriptor());
    const app = document.createElement('openrappter-app') as HTMLElement &
      Record<string, unknown>;
    Object.assign(app, {
      openDesktopApp: vi.fn((appId: string) => ({ appId })),
    });
    document.body.append(app);
    await expect(handleDesktopUiCommand({
      action: 'open_app',
      args: { appId: 'extension:agents' },
    })).resolves.toEqual({ appId: 'extension:agents' });
    unregister();
    await expect(handleDesktopUiCommand({
      action: 'open_app',
      args: { appId: 'extension:agents' },
    })).rejects.toThrow(/unregistered/);
  });
});
