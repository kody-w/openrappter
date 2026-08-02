import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const uiRoot = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(uiRoot, relativePath), 'utf8');
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

  it('offers an explicit reconnect instead of an unrecoverable spinner', () => {
    const app = read('components/app.ts');

    expect(app).toContain('this.connecting && !this.connected');
    expect(app).toContain('The OpenRappter patient is unreachable.');
    expect(app).toContain('Reconnect');
    expect(app).toContain('void this.connectToGateway()');
  });
});
