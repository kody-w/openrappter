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
const desktopControl = readFileSync(
  resolve(root, 'services/desktop-control.ts'),
  'utf8',
);
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
    expect(app).toContain("this.navigate('chat')");
  });

  it('keeps desktop navigation keyboard reachable and scrollable', () => {
    expect(sidebar).toContain('<button');
    expect(sidebar).toContain('aria-current=');
    expect(sidebar).toContain('overflow-y: auto');
    expect(sidebar).toContain('focus-visible');
  });

  it('wires chat focus mode into the application shell', () => {
    expect(app).toContain('@toggle-focus=${this.handleToggleFocus}');
    expect(app).toContain("main-content ${this.focusMode ? 'focused' : ''}");
    expect(app).toContain('navigate(view: View): void');
    expect(desktopControl).toContain('app.navigate(view)');
    expect(desktopControl).not.toContain('app.currentView = view');
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

  it('binds narration to the recording session instead of the selected row', () => {
    expect(component).toContain('private narrationSessionId?: string');
    expect(component).toContain('session_id: sessionId');
    expect(component).toContain('Stop narration before switching demonstrations.');
  });
});
