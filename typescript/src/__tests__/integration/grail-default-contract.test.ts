import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path: string) =>
  existsSync(resolve(root, path)) ? read(path) : '';

const grailHtml = read('beta/ui/index.html');
const grailRuntime = readIfPresent('beta/ui/grail-app.js');
const grailCore = readIfPresent('beta/ui/grail-core.js');
const grailSource = `${grailRuntime}\n${grailCore}`;
const buildUi = read('typescript/scripts/build-ui.mjs');
const productionIndex = read('typescript/ui/index.html');
const desktopMain = read('typescript/desktop/src/main.ts');
const packageSmoke = read('typescript/scripts/package-smoke.mjs');

const REQUIRED_SURFACES = [
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
] as const;

describe('Brainstem Frontier Grail default-shell contract', () => {
  it('boots authoritative beta/ui as the hosted and Electron default', () => {
    expect(grailHtml).toContain('data-openrappter-shell="grail"');
    expect(buildUi).toContain("const grailRoot");
    expect(buildUi).toContain("'beta', 'ui'");
    expect(buildUi).toContain('legacy');
    expect(productionIndex).toContain('Legacy OpenRappter');
    expect(desktopMain).toContain("path.join(packageRoot, 'ui', 'dist')");
    expect(packageSmoke).toContain('Brainstem Frontier Grail');
  });

  it('registers every required feature as a native Grail surface', () => {
    for (const surface of REQUIRED_SURFACES) {
      expect(grailHtml, surface).toContain(`data-grail-surface="${surface}"`);
      expect(grailSource, surface).toContain(surface);
    }
    expect(grailHtml).not.toMatch(/iframe[^>]+legacy/i);
  });

  it('fails closed for patient transport, model, auth, and dependency state', () => {
    for (const marker of [
      'patient-transport-status',
      'copilot-model-status',
      'copilot-auth-status',
      'release-ring-status',
      'detector-v3-status',
      'adaptive-twin-status',
    ]) {
      expect(grailHtml).toContain(`id="${marker}"`);
    }
    expect(grailSource).toContain('/health');
    expect(grailCore).toContain('"needs-sign-in"');
    expect(grailCore).toContain('"no-entitlement"');
    expect(grailSource).toContain('truthfulUnavailable');
  });

  it('pins contrast and 100MB media states without success fallback', () => {
    expect(grailHtml).toContain('data-contrast');
    expect(grailHtml).toContain('high-contrast');
    expect(grailCore).toContain('100 * 1024 * 1024');
    expect(grailCore).toContain('"too-large"');
    expect(grailCore).toContain('"unsupported"');
    expect(grailCore).toContain('"ingesting"');
    expect(grailCore).toContain('"ready"');
    expect(grailCore).toContain('"error"');
  });

  it('runs extracted Living Company Week through Grail with zero side effects', () => {
    expect(grailCore).toContain('LivingCompanyWeek');
    expect(grailCore).toContain('externalSideEffects: 0');
    expect(grailCore).toContain('sends: 0');
    expect(grailCore).toContain('publishes: 0');
    expect(grailCore).toContain('submissions: 0');
    expect(grailCore).toContain('private CEO memo');
    expect(grailCore).toContain('review-ready');
  });

  it('preserves immutable approvals and bounded semantic controls', () => {
    expect(grailCore).toContain('payloadHash');
    expect(grailCore).toContain('baseHash');
    expect(grailRuntime).toContain('semanticSnapshot');
    expect(grailRuntime).toContain('semanticOpen');
    expect(grailSource).not.toMatch(
      /semantic(?:Approve|Send|Publish|Submit|Shell|Import)/,
    );
    expect(grailSource).not.toMatch(/customElements\.define/);
  });

  it('provides Grail-native onboarding, recovery, and reversible Legacy migration', () => {
    for (const marker of [
      'onboarding-privacy',
      'onboarding-health',
      'onboarding-copilot',
      'onboarding-ring',
      'onboarding-skills',
      'onboarding-channels',
      'onboarding-recovery',
    ]) {
      expect(grailHtml).toContain(`data-grail-step="${marker}"`);
    }
    expect(grailHtml).toContain('Use Legacy OpenRappter');
    expect(grailRuntime).toContain('openLegacy');
    expect(grailRuntime).toContain('restoreFocus');
  });
});
