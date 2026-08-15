import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const component = readFileSync(
  resolve(root, 'components/show-and-tell.ts'),
  'utf8',
);
const app = readFileSync(resolve(root, 'components/app.ts'), 'utf8');
const sidebar = readFileSync(resolve(root, 'components/sidebar.ts'), 'utf8');
const preload = readFileSync(
  resolve(root, '../../desktop/src/preload.cts'),
  'utf8',
);

describe('Electron Show-and-Tell surface', () => {
  it('routes the desktop recorder through the existing UI shell', () => {
    expect(app).toContain("case 'show-and-tell'");
    expect(sidebar).toContain("id: 'show-and-tell'");
    expect(component).toContain('@customElement(\'openrappter-show-and-tell\')');
    expect(app).toContain("if (window.openrappterDesktop)");
    expect(app).toContain("this.currentView = 'chat'");
  });

  it('uses the narrow desktop bridge instead of Node APIs', () => {
    expect(component).toContain('desktopBridge()');
    expect(component).not.toMatch(/from ['"](?:node:|electron)/);
    expect(preload).toContain("ipcRenderer.invoke('openrappter:show-and-tell'");
  });

  it('exposes the Skill Recorder lifecycle', () => {
    for (const action of [
      'start',
      'note',
      'capture',
      'stop',
      'analyze',
      'review',
      'build',
      'replay',
      'test',
    ]) {
      expect(component).toContain(`action: '${action}'`);
    }
  });
});
