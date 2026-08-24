import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const uiRoot = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(uiRoot, relativePath), 'utf8');
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[a-f\d]{2}/gi)!.map((part) => {
      const value = Number.parseInt(part, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (
      0.2126 * channels[0]
      + 0.7152 * channels[1]
      + 0.0722 * channels[2]
    );
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05)
    / (Math.min(first, second) + 0.05);
}

describe('OpenRappter surgeon surface', () => {
  it('makes the adaptive surgeon the default interaction instead of the dashboard shell', () => {
    const app = read('components/app.ts');
    const main = read('main.ts');

    expect(main).toContain("import './components/surgeon.js'");
    expect(app).toContain("private currentView: View = 'surgeon'");
    expect(app).toContain('<openrappter-surgeon');
    expect(app).toContain("this.currentView === 'surgeon'");
  });

  it('uses the OpenRappter patient and Copilot surgeon framing', () => {
    const surgeon = read('components/surgeon.ts');
    const service = read('services/surgeon.ts');

    expect(surgeon).toContain('OpenRappter is the patient');
    expect(surgeon).toContain('Copilot is the surgeon');
    expect(surgeon).toContain('It’s above that.');
    expect(service).toContain("'surgeon.patient'");
    expect(service).toContain("'surgeon.turn'");
  });

  it('renders AI-generated next choices as the primary navigation loop', () => {
    const surgeon = read('components/surgeon.ts');

    expect(surgeon).toContain('turn.options');
    expect(surgeon).toContain('option.value');
    expect(surgeon).toContain('sendTurn(option.value)');
    expect(surgeon).toContain('portal');
  });

  it('keeps static system pages behind a secondary anatomy action', () => {
    const surgeon = read('components/surgeon.ts');
    const app = read('components/app.ts');

    expect(surgeon).toContain('Open anatomy');
    expect(surgeon).toContain("this.navigate('presence')");
    expect(app.indexOf("this.currentView === 'surgeon'"))
      .toBeLessThan(app.indexOf('<openrappter-sidebar'));
  });

  it('requires visible approval before an AI-proposed procedure can run', () => {
    const surgeon = read('components/surgeon.ts');
    const service = read('services/surgeon.ts');

    expect(service).toContain("'surgeon.procedure.approve'");
    expect(service).toContain("'surgeon.procedure.operate'");
    expect(surgeon).toContain('OPERATE OPENRAPPTER');
    expect(surgeon).toContain('current.digest');
  });
});

describe('OpenRappter surgeon resilience', () => {
  it('gives long budgets to Copilot-backed turns and operations', () => {
    const service = read('services/surgeon.ts');

    expect(service).toContain('SURGEON_TURN_TIMEOUT_MS = 15 * 60_000');
    expect(service).toContain('SURGEON_OPERATION_TIMEOUT_MS = 30 * 60_000');
    expect(service).toContain('{ timeoutMs: SURGEON_TURN_TIMEOUT_MS }');
    expect(service).toContain('{ timeoutMs: SURGEON_OPERATION_TIMEOUT_MS }');
  });

  describe('Surgeon mode control accessibility contract', () => {
    it('defines tokenized visual states without a white-on-white fallback', () => {
      const surgeon = read('components/surgeon.ts');
      const modeCss = surgeon.slice(
        surgeon.indexOf('.mode-switcher'),
        surgeon.indexOf('.mode-icon'),
      );

      for (const state of [
        'selected',
        'unselected',
        'auth-unavailable',
        'model-unavailable',
        'transport-unavailable',
        'disabled',
      ]) {
        expect(surgeon).toContain(`data-state='${state}'`);
      }
      expect(modeCss).toContain('var(--bg-tertiary');
      expect(modeCss).toContain('var(--text-primary');
      expect(modeCss).toContain('var(--accent-foreground');
      expect(modeCss).toContain(':hover');
      expect(modeCss).toContain(':focus-visible');
      expect(modeCss).not.toMatch(/background:\s*(?:white|#fff(?:fff)?)/i);
      expect(modeCss).not.toMatch(/color:\s*white/i);
    });

    it('keeps every fallback foreground/background pair at WCAG AA contrast', () => {
      for (const [foreground, background] of [
        ['#f7f9ff', '#121a2d'],
        ['#f7f9ff', '#0b1020'],
        ['#050711', '#58f5d2'],
        ['#111827', '#e5e7eb'],
        ['#111827', '#f3f4f6'],
      ]) {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('defines light, increased-contrast, and forced-colors behavior', () => {
      const surgeon = read('components/surgeon.ts');

      expect(surgeon).toContain('@media (prefers-color-scheme: light)');
      expect(surgeon).toContain('@media (prefers-contrast: more)');
      expect(surgeon).toContain('@media (forced-colors: active)');
      expect(surgeon).toContain('background: ButtonFace');
      expect(surgeon).toContain('color: ButtonText');
      expect(surgeon).toContain('background: Highlight');
      expect(surgeon).toContain('color: HighlightText');
      expect(surgeon).toContain('color: GrayText');
    });

    it('removes Patient direct chat and links to canonical Brainstem chat', () => {
      const surgeon = read('components/surgeon.ts');
      const chat = read('components/chat.ts');

      expect(surgeon).not.toContain('data-mode="patient"');
      expect(surgeon).toContain('Legacy patient interface · status only');
      expect(surgeon).toContain('Open Brainstem Chat');
      expect(surgeon).toContain("this.navigate('chat')");
      expect(chat).toContain("chatTarget: 'brainstem' | 'estate' = 'brainstem'");
      expect(chat).toContain('askBrainstem(content');
      expect(chat).not.toContain('<option value="openrappter">');
    });
  });

  it('offers an explicit reconnect instead of an unrecoverable spinner', () => {
    const app = read('components/app.ts');

    expect(app).toContain('this.connecting && !this.connected');
    expect(app).toContain('The OpenRappter patient is unreachable.');
    expect(app).toContain('Reconnect');
    expect(app).toContain('void this.connectToGateway()');
  });
});
