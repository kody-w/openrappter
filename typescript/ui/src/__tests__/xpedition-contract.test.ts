// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isXpeditionExtensionV1,
  type XpeditionExtensionV1,
} from '../services/xpedition.js';

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
    ]) {
      expect(desktopActions).toContain(`'${action}'`);
    }
    expect(desktopActions).toContain("'install_agent'");
  });

  it('exposes a data-only v1 extension seam without granting host authority', () => {
    const extension: XpeditionExtensionV1 = {
      id: 'business-nursery',
      title: 'Business Nursery',
      description: 'A separately operated, capability-gated surface.',
      glyph: 'BN',
      href: 'https://service.example/nursery',
      requiredCapability: 'organism:read',
      surfaceVersion: 1,
    };
    expect(isXpeditionExtensionV1(extension)).toBe(true);
    expect(isXpeditionExtensionV1({
      ...extension,
      href: 'javascript:alert(1)',
    })).toBe(false);
    expect(isXpeditionExtensionV1({
      ...extension,
      requiredCapability: '',
    })).toBe(false);
  });
});
