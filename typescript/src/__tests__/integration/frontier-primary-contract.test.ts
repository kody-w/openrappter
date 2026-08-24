import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readOptional = (path: string) =>
  existsSync(resolve(root, path)) ? read(path) : '';
const frontier = read('beta/ui/index.html');
const brainstem = read('rapp_brainstem/index.html');
const features = readOptional('beta/ui/frontier-features.js');
const core = readOptional('beta/ui/frontier-core.js');
const chatBridge = readOptional('beta/ui/frontier-chat-bridge.js');
const host = readOptional('beta/ui/frontier-host-adapter.js');
const build = read('typescript/scripts/build-ui.mjs');
const legacy = read('typescript/ui/index.html');
const desktop = read('typescript/desktop/src/main.ts');
const packageSmoke = read('typescript/scripts/package-smoke.mjs');

describe('Frontier-primary interface contract', () => {
  it('boots the canonical Frontier bundle at hosted / and in Electron', () => {
    expect(frontier).toContain('data-openrappter-shell="frontier"');
    expect(build).toContain("const frontierRoot");
    expect(build).toContain("'beta', 'ui'");
    expect(desktop).toContain("path.join(packageRoot, 'ui', 'dist')");
    expect(desktop).toContain("openrappterFrontierSemantic");
    expect(packageSmoke).toContain('Frontier primary interface');
  });

  it('preserves the concrete deployed beta chat and Copilot composition', () => {
    for (const marker of ['brainstem', 'surgeon', 'surgeon-tabs', 'surgeon-log', 'surgeon-input']) {
      expect(frontier).toContain(`id="${marker}"`);
    }
    for (const marker of [
      'model-select',
      'agents-btn',
      'voice-btn',
      'starter-prompts',
      'chat-import',
    ]) {
      expect(brainstem).toContain(`id="${marker}"`);
    }
    expect(brainstem).toContain('Drag & Drop .py Agents Here');
    expect(chatBridge).toContain('openrappter-frontier:api');
    expect(host).toContain('rpc("agent"');
  });

  it('routes the primary conversation only through the exact Brainstem /chat wire', () => {
    expect(host).toContain('`${gatewayHttpBase}/chat`');
    expect(host).toContain('body: rawBody');
    expect(host.match(/rpc\("agent"/g)).toHaveLength(1);
    expect(host).not.toContain('/api/agent');
    expect(host).not.toContain('surgeon.turn');
    expect(host).not.toContain('patient.chat');
    expect(brainstem).toContain('body = { user_input: payload, conversation_history: requestHistory }');
    expect(brainstem).toContain('body.session_id = sessionId');
    expect(brainstem).toContain('d.agent_logs');
    expect(frontier).toContain('show-mode-preview');
    expect(frontier).toContain('deploy-copilot-studio');
    expect(frontier).toContain("frame-src 'self'");
    expect(frontier).toContain('Brainstem /chat — OpenRappter main conversation');
  });

  it('adds features through the native Frontier panel without another shell', () => {
    expect(frontier).toContain('id="frontier-features"');
    expect(frontier).toContain('id="frontier-features-tab"');
    expect(frontier).not.toContain('id="grail-sidebar"');
    expect(frontier).not.toContain('id="grail-nav-toggle"');
    for (const feature of [
      'clever-girl',
      'release-rings',
      'quantum-rappids',
      'living-company',
      'organism-egg',
      'adaptive-twins',
      'large-media',
      'voice',
      'about',
    ]) {
      expect(frontier, feature).toContain(`data-frontier-feature="${feature}"`);
      expect(features, feature).toContain(feature);
    }
  });

  it('keeps Living Company deterministic and every irreversible action bounded', () => {
    expect(core).toContain('LivingCompanyWeek');
    expect(core).toContain('externalSideEffects: 0');
    expect(core).toContain('private CEO memo');
    expect(core).toContain('payloadHash');
    expect(core).toContain('baseHash');
    expect(features).toContain('openrappterFrontierSemantic');
    expect(features).not.toMatch(/semantic(?:Approve|Send|Publish|Submit|Shell|Import)/);
  });

  it('keeps Legacy Patient explicit and reversible for one release', () => {
    expect(frontier).toContain('Legacy Patient Interface');
    expect(features).toContain('./legacy/index.html');
    expect(legacy).toContain('Legacy Patient Interface');
    expect(legacy).toContain('Return to Frontier');
    expect(frontier).not.toMatch(/iframe[^>]+legacy/i);
  });

  it('supports bounded deep links without replacing the primary chat', () => {
    expect(features).toContain('searchParams.get("view")');
    expect(desktop).toContain("openrappterFrontierSemantic.open");
    expect(features).toContain('frontier-primary/1.0');
    expect(features).not.toMatch(/customElements\.define/);
  });

  it('packages one Frontier source of truth for web and Electron', () => {
    expect(build).toContain('cpSync(frontierRoot, output');
    expect(build).toContain("path.join(output, 'legacy')");
    expect(build).not.toContain('iframe');
    expect(packageSmoke).toContain('frontier-features.js');
    expect(packageSmoke).toContain('legacy/index.html');
  });
});
