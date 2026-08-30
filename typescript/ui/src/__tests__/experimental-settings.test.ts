// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';
import type { GatewayClient } from '../services/gateway.js';
import '../components/config.js';
import '../components/sidebar.js';
import '../components/chat.js';

interface ConfigElement extends HTMLElement {
  configState: {
    client: GatewayClient | null;
    raw: string;
    hash: string;
    format: 'yaml' | 'json';
    dirty: boolean;
    loading: boolean;
    saving: boolean;
    error: string | null;
  };
  expandedSections: Set<string>;
  updateComplete: Promise<boolean>;
  requestUpdate(): void;
}

interface LitElementForTest extends HTMLElement {
  updateComplete: Promise<boolean>;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function renderConfig(
  raw = '{}\n',
  expanded = false,
  client: GatewayClient | null = null,
): Promise<ConfigElement> {
  const element = document.createElement('openrappter-config') as ConfigElement;
  document.body.append(element);
  await element.updateComplete;
  element.configState = {
    client,
    raw,
    hash: 'initial-hash',
    format: 'yaml',
    dirty: false,
    loading: false,
    saving: false,
    error: null,
  };
  element.expandedSections = expanded
    ? new Set(['experimental'])
    : new Set();
  element.requestUpdate();
  await element.updateComplete;
  return element;
}

async function enableToggle(
  element: ConfigElement,
  path: string,
): Promise<void> {
  const input = element.shadowRoot?.querySelector<HTMLInputElement>(
    `[data-feature-toggle="${path}"]`,
  );
  expect(input).toBeTruthy();
  expect(input?.disabled).toBe(false);
  input!.checked = true;
  input!.dispatchEvent(new Event('change', { bubbles: true }));
  await element.updateComplete;
}

describe('experimental settings', () => {
  it('keeps feature-specific controls dark until Experimental is opened', async () => {
    const element = await renderConfig();
    const text = element.shadowRoot?.textContent ?? '';

    expect(text).toContain('Experimental');
    expect(text).not.toContain('Hermes adapter');
    expect(text).not.toContain('Pi adapter');
    expect(text).not.toContain('Brain Surgeon group chat');
  });

  it('renders every gate off and enforces the parent hierarchy', async () => {
    const element = await renderConfig('{}\n', true);
    const toggle = (path: string) =>
      element.shadowRoot?.querySelector<HTMLInputElement>(
        `[data-feature-toggle="${path}"]`,
      );

    expect(toggle('experimental.enabled')?.checked).toBe(false);
    expect(toggle('experimental.harnessAdapters.enabled')?.checked).toBe(false);
    expect(toggle('experimental.harnessAdapters.enabled')?.disabled).toBe(true);
    expect(toggle('experimental.harnessAdapters.hermes')?.disabled).toBe(true);
    expect(toggle('experimental.harnessAdapters.pi')?.disabled).toBe(true);
    expect(toggle('experimental.brainSurgeonGroupChat.enabled')?.disabled)
      .toBe(true);
    expect(element.shadowRoot?.textContent).toContain(
      'Restart the gateway after saving',
    );
  });

  it('persists nested gates through config.set', async () => {
    let savedRaw = '';
    const call = vi.fn(async (
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (method === 'config.set') {
        savedRaw = String(params?.raw ?? '');
        return { saved: true };
      }
      if (method === 'config.get') {
        return {
          raw: savedRaw,
          hash: 'saved-hash',
          format: 'yaml',
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = {
      isConnected: true,
      call,
    } as unknown as GatewayClient;
    const element = await renderConfig('{}\n', true, client);

    await enableToggle(element, 'experimental.enabled');
    await enableToggle(element, 'experimental.harnessAdapters.enabled');
    await enableToggle(element, 'experimental.harnessAdapters.hermes');
    await enableToggle(element, 'experimental.harnessAdapters.pi');
    await enableToggle(element, 'experimental.brainSurgeonGroupChat.enabled');

    const save = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button.primary',
    );
    expect(save?.disabled).toBe(false);
    save!.click();

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'config.set',
        expect.objectContaining({ baseHash: 'initial-hash' }),
      );
    });

    expect(YAML.parse(savedRaw)).toEqual({
      experimental: {
        enabled: true,
        harnessAdapters: {
          enabled: true,
          hermes: true,
          pi: true,
        },
        brainSurgeonGroupChat: {
          enabled: true,
        },
      },
    });
  });
});

describe('default application chrome', () => {
  it('keeps navigation unchanged and adds no experimental destination', async () => {
    const sidebar = document.createElement(
      'openrappter-sidebar',
    ) as LitElementForTest;
    document.body.append(sidebar);
    await sidebar.updateComplete;

    const labels = Array.from(
      sidebar.shadowRoot?.querySelectorAll('.nav-label') ?? [],
      node => node.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Copilot Surgeon',
      'Quantum RAPPIDs',
      'Chat',
      'Show & Tell',
      'Channels',
      'Sessions',
      'Agents',
      'Skills',
      'Cron Jobs',
      'Showcase',
      'Zen',
      'Accounts',
      'Config',
      'Devices',
      'Health',
      'Logs',
      'Debug',
    ]);
    expect(labels).not.toContain('Experimental');
    expect(labels).not.toContain('Hermes');
    expect(labels).not.toContain('Pi');
    expect(labels).not.toContain('Group Chat');
  });

  it('keeps the chat target selector and default target unchanged', async () => {
    const chat = document.createElement('openrappter-chat') as LitElementForTest;
    document.body.append(chat);
    await chat.updateComplete;

    const selector =
      chat.shadowRoot?.querySelector<HTMLSelectElement>('.brain-select');
    expect(selector?.value).toBe('openrappter');
    expect(Array.from(selector?.options ?? [], option => option.value)).toEqual([
      'openrappter',
      'brainstem',
    ]);
    expect(Array.from(selector?.options ?? [], option => option.textContent?.trim()))
      .toEqual(['🦖 OpenRappter', '🧠 Brainstem']);
    expect(chat.shadowRoot?.textContent).not.toContain('Hermes');
    expect(chat.shadowRoot?.textContent).not.toContain('Pi adapter');
    expect(chat.shadowRoot?.textContent).not.toContain('Group Chat');
  });
});
