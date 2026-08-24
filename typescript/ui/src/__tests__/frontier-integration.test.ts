// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const html = read('beta/ui/index.html');
const brainstem = read('rapp_brainstem/index.html');
const core = read('beta/ui/frontier-core.js');
const features = read('beta/ui/frontier-features.js');
const css = read('beta/ui/frontier-features.css');
const bridge = read('beta/ui/frontier-chat-bridge.js');
const host = read('beta/ui/frontier-host-adapter.js');

const requestedFeatures = [
  'clever-girl',
  'release-rings',
  'quantum-rappids',
  'living-company',
  'organism-egg',
  'adaptive-twins',
  'large-media',
  'voice',
  'about',
];

async function bootFrontier() {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:18790/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.defineProperty(window, 'crypto', { value: globalThis.crypto });
  Object.defineProperty(window, 'structuredClone', {
    value: globalThis.structuredClone,
  });
  Object.defineProperty(window, 'TextEncoder', { value: globalThis.TextEncoder });
  const dialog = window.document.getElementById(
    'frontier-features',
  ) as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => dialog.removeAttribute('open');
  Object.defineProperty(dialog, 'open', {
    get: () => dialog.hasAttribute('open'),
  });
  window.OpenRappterFrontierHost = {
    mode: 'fixture',
    legacyUrl: './legacy/index.html',
    health: async () => ({ status: 'ok', version: 'fixture' }),
    showAndTell: async () => ({ status: 'success' }),
    rpc: async (method: string, params: Record<string, unknown>) => {
      const values: Record<string, unknown> = {
        'auth.status': { status: 'ready', message: 'fixture ready' },
        'backend.status': { status: 'ready', model: 'fixture-model' },
        'rings.get': {
          selectedRing: 'stable',
          resolved: { status: 'published', version: '1.13.0' },
        },
        'rings.preview': {
          status: 'published',
          version: '1.13.0',
          canApply: true,
          olderThanCurrent: false,
          ring: params?.ring,
        },
        'rings.apply': { applied: true, selectedRing: params?.ring },
        'clever-girl.status': { version: 'v3-fixture' },
        'twin.versions': { versions: ['v1'] },
        'voice.mode.status': { enabled: false },
        'tts.providers': { providers: ['local', 'elevenlabs'] },
        'system.status': { status: 'ok' },
        'channels.status': [],
        'estate.buddies.list': { buddies: [] },
        'agents.list': [],
        'skills.list': [],
      };
      if (!(method in values)) throw new Error(`fixture unavailable: ${method}`);
      return values[method];
    },
  };
  window.brainstemBeta = {
    twinList: async () => [],
  };
  window.eval(core);
  window.eval(features);
  return dom;
}

describe('packaged Frontier browser integration', () => {
  const doms: JSDOM[] = [];

  afterEach(() => {
    while (doms.length > 0) doms.pop()?.window.close();
  });

  it('preserves the real chat, toolbar, prompt, drop, and Copilot panel contract', () => {
    const outer = new JSDOM(html).window.document;
    expect(outer.documentElement.dataset.openrappterShell).toBe('frontier');
    expect(outer.getElementById('brainstem')).not.toBeNull();
    expect(outer.getElementById('surgeon')).not.toBeNull();
    expect(outer.getElementById('surgeon-tabs')).not.toBeNull();
    expect(outer.getElementById('grail-sidebar')).toBeNull();
    for (const id of ['model-select', 'agents-btn', 'voice-btn', 'starter-prompts']) {
      expect(brainstem).toContain(`id="${id}"`);
    }
    expect(brainstem).toContain('Drag & Drop .py Agents Here');
    expect(bridge).toContain('openrappter-frontier:api');
    expect(host).toContain('rpc("agent"');
    expect(host).toContain('rpc("models.available"');
    expect(host).toContain('rpc("agents.files.list"');
  });

  it('opens every added capability in the native Frontier modal', async () => {
    const dom = await bootFrontier();
    doms.push(dom);
    for (const feature of requestedFeatures) {
      const state = await dom.window.openrappterFrontierSemantic.open(feature);
      expect(state.activeFeature).toBe(feature);
      expect(state.shell).toBe('frontier');
    }
    expect(Object.keys(dom.window.openrappterFrontierSemantic).sort())
      .toEqual(['open', 'snapshot']);
    for (const forbidden of ['approve', 'send', 'publish', 'submit', 'shell', 'import']) {
      expect(dom.window.openrappterFrontierSemantic[forbidden]).toBeUndefined();
    }
  });

  it('boots the packaged chat and Copilot panel through the authenticated fixture transport', async () => {
    const dom = new JSDOM(html, {
      url: 'file:///openrappter/ui/dist/index.html',
      runScripts: 'outside-only',
    });
    doms.push(dom);
    const { window } = dom;
    window.openrappterDesktop = {
      gatewayUrl: 'ws://127.0.0.1:18791',
      gatewayToken: 'fixture-token',
    };
    window.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok', version: 'fixture' }),
    });
    class FixtureSocket {
      static OPEN = 1;
      readyState = 1;
      listeners = new Map<string, (event?: { data: string }) => void>();
      constructor() {
        setTimeout(() => this.listeners.get('open')?.(), 0);
      }
      addEventListener(name: string, callback: (event?: { data: string }) => void) {
        this.listeners.set(name, callback);
      }
      send(raw: string) {
        const request = JSON.parse(raw);
        const payloads: Record<string, unknown> = {
          connect: {},
          'backend.status': { status: 'ready', model: 'fixture-model' },
          agent: { content: 'fixture Copilot reply', sessionId: 'fixture-session' },
        };
        setTimeout(() => this.listeners.get('message')?.({
          data: JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload: payloads[request.method] || {},
          }),
        }), 0);
      }
    }
    window.WebSocket = FixtureSocket;
    window.eval(host);
    const state = await window.brainstemBeta.getState();
    expect(state).toMatchObject({
      brainstem: { phase: 'ready' },
      surgeon: { phase: 'ready' },
    });
    expect(state.url).toContain('frontier-chat/index.html');
    expect(state.url).toContain('frontierHost=1');
    const events: Array<{ type: string; content?: string }> = [];
    window.brainstemBeta.onSurgeonEvent((event: { type: string }) => events.push(event));
    await window.brainstemBeta.surgeonSend(1, 'fixture prompt');
    expect(events.map((event) => event.type)).toEqual(['response-start', 'done']);
    expect(events.at(-1)?.content).toBe('fixture Copilot reply');
  });

  it('runs deterministic Living Company Week with private drafts and no effects', async () => {
    const dom = await bootFrontier();
    doms.push(dom);
    await dom.window.__openrappterDesktopCommand({
      action: 'company_scenario',
      args: { operation: 'replay' },
    });
    const state = await dom.window.__openrappterDesktopCommand({
      action: 'company_state',
    });
    expect(state).toMatchObject({
      status: 'completed',
      externalSideEffects: 0,
      sends: 0,
      publishes: 0,
      submissions: 0,
    });
    expect(state.ledger).toHaveLength(5);
    expect(state.drafts.every((draft: { private: boolean }) => draft.private))
      .toBe(true);
  });

  it('keeps modal, responsive, reduced-motion, and explicit Legacy recovery', async () => {
    const dom = await bootFrontier();
    doms.push(dom);
    const { document } = dom.window;
    (document.getElementById('frontier-features-tab') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById('frontier-features')?.hasAttribute('open')).toBe(true);
    expect(document.getElementById('frontier-legacy-patient')?.textContent)
      .toContain('Legacy Patient Interface');
    expect(css).toContain('@media (max-width: 660px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
  });
});
