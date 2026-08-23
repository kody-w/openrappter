// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('Windows XPedition build and accessibility contract', () => {
  const app = read('../components/app.ts');
  const shell = read('../components/xpedition-shell.ts');
  const onboarding = read('../components/xpedition-onboarding.ts');
  const main = read('../main.ts');
  const asset = read('../../public/xpedition-landscape.svg');
  const packageJson = JSON.parse(read('../../../package.json')) as {
    files: string[];
  };
  const desktopMain = read('../../../desktop/src/main.ts');
  const desktopActions = read('../../../src/desktop-control/types.ts');
  const companyRegistry = read('../services/company-app-registry.ts');
  const companyRuntime = read('../services/living-company.ts');
  const companyComponent = read('../components/company-app.ts');
  const configComponent = read('../components/config.ts');
  const cronComponent = read('../components/cron.ts');
  const sessionsComponent = read('../components/sessions.ts');
  const extensionApi = read('../services/xpedition-extensions.ts');
  const license = read('../../../../LICENSE');
  const readiness = read('../services/copilot-readiness.ts');
  const chat = read('../components/chat.ts');
  const surgeon = read('../components/surgeon.ts');

  it('boots XPedition by default while retaining a reversible legacy route', () => {
    expect(app).toContain("private shell: ShellPreference = 'xpedition'");
    expect(app).toContain('<openrappter-xpedition-shell');
    expect(app).toContain("shell: 'legacy'");
    expect(shell).toContain('Legacy OpenRappter');
    expect(main).toContain("import './components/xpedition-shell.js'");
  });

  it('ships the same compiled UI into npm and Electron', () => {
    expect(packageJson.files).toContain('ui/dist/');
    expect(desktopMain).toContain("const uiRoot = path.join(packageRoot, 'ui', 'dist')");
    expect(desktopMain).toContain('window.loadFile(uiIndex)');
  });

  it('packages only the original in-repo landscape with no remote image dependency', () => {
    expect(asset).toContain('<title id="title">XPedition Valley</title>');
    expect(asset).not.toMatch(/<image\b/i);
    expect(asset).not.toMatch(/bliss|microsoft|windows logo/i);
    expect(shell).toContain("url('/xpedition-landscape.svg')");
    expect(shell).not.toMatch(/https?:\/\/.*\.(?:png|jpg|webp)/i);
  });

  it('pins semantic roles, keyboard operation, responsive fallback, and contrast modes', () => {
    expect(shell).toContain('role="application"');
    expect(shell).toContain('role="dialog"');
    expect(shell).toContain("event.altKey && event.key === 'Tab'");
    expect(shell).toContain("event.ctrlKey && event.code === 'Space'");
    expect(shell).toContain('@media (max-width: 760px)');
    expect(shell).toContain('@media (prefers-reduced-motion: reduce)');
    expect(shell).toContain('@media (forced-colors: active)');
    expect(shell).toContain("data-contrast='high-contrast'");
    expect(onboarding).toContain('aria-live="assertive"');
  });

  it('keeps semantic controls bounded on the existing typed queue', () => {
    for (const action of [
      'desktop_state',
      'open_app',
      'focus_window',
      'close_window',
      'onboarding_step',
      'switch_shell',
      'company_state',
      'company_scenario',
      'company_approve',
    ]) {
      expect(desktopActions).toContain(`'${action}'`);
    }
    expect(desktopActions).toContain("'install_agent'");
  });

  it('registers Living Company apps through one generic window renderer', () => {
    for (const id of [
      'engineering',
      'release-operations',
      'customer-signals',
      'documentation',
      'expenses',
      'decisions',
      'rapp-estate-health',
    ]) {
      expect(companyRegistry).toContain(`'${id}'`);
    }
    expect(shell).toContain('isCompanyAppId(app.id)');
    expect(shell).toContain('<openrappter-company-app');
    expect(companyComponent).toContain("data-desktop-sensitive=\"company-approval\"");
    expect(configComponent).toContain("this.saveApprovals.request(");
    expect(configComponent).toContain("'credential.change'");
    expect(configComponent).toContain('data-desktop-sensitive="company-approval"');
    expect(cronComponent).toContain("'irreversible.action'");
    expect(cronComponent).toContain('data-desktop-sensitive="company-approval"');
    expect(sessionsComponent).toContain("'irreversible.action'");
    expect(sessionsComponent).not.toContain("confirm('Delete this session?");
    expect(companyRuntime).not.toContain("call('channels.send'");
    expect(companyRuntime).not.toContain("call('config.set'");
    expect(companyRuntime).not.toContain("call('exec.respond'");
  });

  it('brands the personal organism and states the repository license truthfully', () => {
    expect(shell).toContain('OpenRappter Personal');
    expect(shell).toContain('Apache License 2.0');
    expect(shell).toContain('separate private RapterOS SaaS');
    expect(shell).toContain('OpenRappter is not presented as MIT');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
  });

  it('exposes only the authoritative data-only #445 descriptor seam', () => {
    expect(extensionApi).toContain(
      'https://openrappter.dev/contracts/xpedition-extension-v1.json',
    );
    expect(extensionApi).toContain('installAuthoritativeXpeditionExtensionReader');
    expect(extensionApi).toContain('registerXpeditionDescriptor');
    expect(main).toContain('installXpeditionDescriptorApi()');
    expect(shell).not.toContain('openrappter-xpedition-extension-host');
    expect(extensionApi).not.toMatch(
      /customElements|createElement|elementTag|gatewayToken|preload|localStorage/,
    );
    expect(extensionApi).not.toMatch(
      /tenantId|billingAccount|entitlementKey|controlPlaneUrl|from ['\"]rapteros/i,
    );
  });

  it('consumes Copilot auth only through the typed fail-closed adapter', () => {
    for (const state of [
      'unknown',
      'checking',
      'ready',
      'needs-sign-in',
      'no-entitlement',
      'offline',
      'error',
    ]) {
      expect(readiness).toContain(`'${state}'`);
    }
    expect(readiness).toContain('interface CopilotAuthAdapter');
    expect(readiness).toContain('class PendingCopilotAuthAdapter');
    expect(readiness).not.toMatch(
      /auth\\.login|auth\\.poll|authenticateWithToken|gatewayToken|device code/i,
    );
    expect(chat).toContain('clearStaleCopilotContent');
    expect(surgeon).toContain('Previous Copilot consultation content was cleared as stale.');
    expect(onboarding).toContain("this.copilotReadiness.state !== 'ready'");
  });
});
