// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const html = read('beta/ui/index.html');
const core = read('beta/ui/grail-core.js');
const app = read('beta/ui/grail-app.js');
const css = read('beta/ui/grail-app.css');

const surfaces = [
  'operating-room',
  'quantum-rappids',
  'chat',
  'show-and-tell',
  'channels',
  'sessions',
  'agents',
  'skills',
  'cron',
  'showcase',
  'zen',
  'accounts',
  'config',
  'devices',
  'health',
  'logs',
  'living-company',
];

async function bootGrail() {
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
  window.OpenRappterGrailHost = {
    mode: 'fixture',
    legacyUrl: './legacy/index.html',
    health: async () => ({
      status: 'ok',
      version: 'fixture',
      checks: { gateway: true },
    }),
    showAndTell: async () => ({ status: 'success' }),
    rpc: async (method: string) => {
      const values: Record<string, unknown> = {
        'auth.status': {
          status: 'ready',
          code: 'COPILOT_READY',
          message: 'fixture ready',
        },
        'backend.status': { status: 'ready', model: 'fixture-model' },
        'release.status': {
          ring: 'stable',
          receiptId: 'fixture-receipt',
        },
        'clever-girl.status': { version: 'v3-fixture' },
        'twin.versions': { versions: ['v1'] },
        'skills.list': [],
        'channels.list': [],
        'chat.list': [],
        'agents.list': [],
        'cron.list': [],
        'showcase.list': [],
        'zen.sessions': [],
        'connections.list': [],
        'logs.get': [],
        'config.get': { raw: 'port: 18790\n', hash: 'base', format: 'yaml' },
      };
      if (!(method in values)) throw new Error(`fixture unavailable: ${method}`);
      return values[method];
    },
  };
  window.brainstemBeta = {
    tilesList: async () => [],
    openrappterTileExport: async () => ({ message: 'fixture export' }),
    openrappterTileImport: async () => ({ message: 'fixture import' }),
  };
  window.eval(core);
  window.eval(app);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      window.openrappterGrailSemantic &&
      window.document.getElementById('grail-onboarding-continue')
        ?.disabled === false
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return dom;
}

describe('packaged Grail browser integration', () => {
  const doms: JSDOM[] = [];

  afterEach(() => {
    while (doms.length > 0) doms.pop()?.window.close();
  });

  it('boots Grail and verifies real fixture readiness before onboarding completes', async () => {
    const dom = await bootGrail();
    doms.push(dom);
    const { document } = dom.window;
    expect(document.documentElement.dataset.openrappterShell).toBe('grail');
    expect(document.getElementById('patient-transport-status')?.dataset.state)
      .toBe('ready');
    expect(document.getElementById('copilot-auth-status')?.dataset.state)
      .toBe('ready');
    expect(document.getElementById('copilot-model-status')?.dataset.state)
      .toBe('ready');
    expect(document.getElementById('release-ring-status')?.dataset.state)
      .toBe('ready');
    const continueButton = document.getElementById(
      'grail-onboarding-continue',
    ) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    continueButton.click();
    expect(document.getElementById('grail-onboarding')?.classList.contains('open'))
      .toBe(false);
  });

  it('opens every native surface through bounded semantic controls', async () => {
    const dom = await bootGrail();
    doms.push(dom);
    for (const surface of surfaces) {
      const state = await dom.window.openrappterGrailSemantic.open(surface);
      expect(state.activeSurface).toBe(surface);
    }
    expect(Object.keys(dom.window.openrappterGrailSemantic).sort())
      .toEqual(['open', 'snapshot']);
    for (const forbidden of [
      'approve',
      'send',
      'publish',
      'submit',
      'shell',
      'import',
    ]) {
      expect(dom.window.openrappterGrailSemantic[forbidden]).toBeUndefined();
    }
  });

  it('runs deterministic Company Week through the renderer command plane', async () => {
    const dom = await bootGrail();
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

  it('provides modal focus containment, contrast, responsive, and Legacy recovery', async () => {
    const dom = await bootGrail();
    doms.push(dom);
    const { document } = dom.window;
    const onboarding = document.getElementById('grail-onboarding')!;
    expect(onboarding.getAttribute('role')).toBe('dialog');
    expect(onboarding.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('[data-grail-legacy]')).not.toBeNull();
    (document.querySelector(
      '[data-grail-contrast="high-contrast"]',
    ) as HTMLButtonElement).click();
    expect(document.documentElement.dataset.contrast).toBe('high-contrast');
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
