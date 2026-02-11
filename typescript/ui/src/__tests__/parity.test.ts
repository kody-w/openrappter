/**
 * Feature parity test — compares the openrappter UI against
 * the openclaw UI to ensure the same feature surface exists.
 *
 * Checks: views/tabs, RPC methods used, controller patterns.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const uiRoot = path.resolve(__dirname, '..');
const openclawUiRoot = path.resolve(__dirname, '..', '..', '..', '..', 'openclaw', 'ui', 'src');

// --- Helpers ---

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

function readFile(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function findAllTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ===== Feature Parity Tests =====

describe('Feature Parity: OpenRappter vs OpenClaw', () => {
  // --- Views / Tabs ---
  
  const openclawViews = [
    'chat',
    'config',
    'channels',
    'sessions',
    'cron',
    'agents',
    'logs',
    'devices',
    'presence',
    'skills',
  ];

  it('openrappter has all OpenClaw view tabs', () => {
    const sidebarSrc = readFile(path.join(uiRoot, 'components', 'sidebar.ts'));
    
    for (const view of openclawViews) {
      expect(
        sidebarSrc.includes(`'${view}'`) || sidebarSrc.includes(`"${view}"`),
        `Missing view tab: ${view}`,
      ).toBe(true);
    }
  });

  it('openrappter app.ts routes all OpenClaw views', () => {
    const appSrc = readFile(path.join(uiRoot, 'components', 'app.ts'));
    
    for (const view of openclawViews) {
      expect(
        appSrc.includes(`'${view}'`) || appSrc.includes(`"${view}"`),
        `Missing route for view: ${view}`,
      ).toBe(true);
    }
  });

  it('openrappter has component files for all views', () => {
    const componentFiles = [
      'chat.ts',
      'config.ts',
      'channels.ts',
      'sessions.ts',
      'cron.ts',
      'agents.ts',
      'logs.ts',
      'devices.ts',
      'skills.ts',
      'presence.ts',
    ];
    for (const f of componentFiles) {
      expect(
        fileExists(path.join(uiRoot, 'components', f)),
        `Missing component file: ${f}`,
      ).toBe(true);
    }
  });

  // --- RPC Methods ---

  const requiredRpcMethods = [
    'status',
    'health',
    'auth',
    'subscribe',
    'agent',
    'chat.list',
    'chat.messages',
    'chat.delete',
    'channels.list',
    'channels.send',
    'cron.list',
    'cron.run',
    'cron.enable',
    'connections.list',
    'config.get',
    'config.set',
    'config.apply',
  ];

  it('openrappter services reference all required RPC methods', () => {
    const serviceFiles = findAllTsFiles(path.join(uiRoot, 'services'));
    const allServiceCode = serviceFiles.map((f) => readFile(f)).join('\n');

    for (const method of requiredRpcMethods) {
      expect(
        allServiceCode.includes(`'${method}'`) || allServiceCode.includes(`"${method}"`),
        `Missing RPC method reference: ${method}`,
      ).toBe(true);
    }
  });

  // --- Controller Services ---

  const requiredControllers = [
    'chat.ts',
    'config.ts',
    'channels.ts',
    'cron.ts',
    'logs.ts',
    'presence.ts',
  ];

  it('openrappter has all required controller services', () => {
    for (const f of requiredControllers) {
      expect(
        fileExists(path.join(uiRoot, 'services', f)),
        `Missing controller: services/${f}`,
      ).toBe(true);
    }
  });

  // --- Types ---

  it('openrappter types.ts defines all required interfaces', () => {
    const typesSrc = readFile(path.join(uiRoot, 'types.ts'));
    const requiredTypes = [
      'RpcRequest',
      'RpcResponse',
      'RpcError',
      'RpcEvent',
      'StreamingResponse',
      'AgentRequest',
      'AgentResponse',
      'ChatSession',
      'ChatMessage',
      'ChannelStatus',
      'CronJob',
      'ConfigSnapshot',
      'GatewayStatus',
      'HealthResponse',
      'LogEntry',
      'ConnectionInfo',
      'GatewayEvents',
    ];
    for (const t of requiredTypes) {
      expect(
        typesSrc.includes(t),
        `Missing type definition: ${t}`,
      ).toBe(true);
    }
  });

  // --- Gateway Client ---

  it('openrappter gateway has required methods', () => {
    const gatewaySrc = readFile(path.join(uiRoot, 'services', 'gateway.ts'));
    const requiredMethods = [
      'connect',
      'disconnect',
      'call',
      'callStream',
      'subscribe',
      'unsubscribe',
      'authenticate',
      'on(',
      'off(',
      'isConnected',
      'isAuthenticated',
    ];
    for (const m of requiredMethods) {
      expect(
        gatewaySrc.includes(m),
        `Missing gateway method: ${m}`,
      ).toBe(true);
    }
  });

  // --- Event Types ---

  it('openrappter defines all OpenClaw event constants', () => {
    const typesSrc = readFile(path.join(uiRoot, 'types.ts'));
    const events = [
      'agent',
      'agent.stream',
      'agent.tool',
      'chat',
      'chat.message',
      'channel',
      'channel.message',
      'channel.status',
      'cron',
      'cron.run',
      'cron.complete',
      'presence',
      'heartbeat',
      'shutdown',
      'error',
    ];
    for (const evt of events) {
      expect(
        typesSrc.includes(`'${evt}'`) || typesSrc.includes(`"${evt}"`),
        `Missing event constant: ${evt}`,
      ).toBe(true);
    }
  });

  // --- Feature Completeness ---

  it('openrappter chat supports streaming', () => {
    const chatSrc = readFile(path.join(uiRoot, 'services', 'chat.ts'));
    expect(chatSrc).toContain('callStream');
    expect(chatSrc).toContain('streaming');
    expect(chatSrc).toContain('streamContent');
  });

  it('openrappter config supports form and raw modes', () => {
    const configComponent = readFile(path.join(uiRoot, 'components', 'config.ts'));
    expect(configComponent).toContain('form');
    expect(configComponent).toContain('raw');
    expect(configComponent).toContain('Save');
    expect(configComponent).toContain('Reset');
  });

  it('openrappter channels shows connection status', () => {
    const channelsSrc = readFile(path.join(uiRoot, 'components', 'channels.ts'));
    expect(channelsSrc).toContain('connected');
    expect(channelsSrc).toContain('disconnected');
    expect(channelsSrc).toContain('Refresh');
  });

  it('openrappter cron supports toggle and run', () => {
    const cronSrc = readFile(path.join(uiRoot, 'components', 'cron.ts'));
    expect(cronSrc).toContain('toggleJob');
    expect(cronSrc).toContain('runJob');
    expect(cronSrc).toContain('Run Now');
  });

  it('openrappter logs support level filtering', () => {
    const logsSrc = readFile(path.join(uiRoot, 'components', 'logs.ts'));
    expect(logsSrc).toContain('levelFilter');
    expect(logsSrc).toContain('Debug');
    expect(logsSrc).toContain('Info');
    expect(logsSrc).toContain('Warn');
    expect(logsSrc).toContain('Error');
  });

  it('openrappter has dark theme CSS variables', () => {
    const indexHtml = readFile(path.join(uiRoot, '..', 'index.html'));
    expect(indexHtml).toContain('--bg-primary');
    expect(indexHtml).toContain('--accent');
    expect(indexHtml).toContain('--text-primary');
  });

  it('openrappter sidebar has all navigation sections', () => {
    const sidebarSrc = readFile(path.join(uiRoot, 'components', 'sidebar.ts'));
    expect(sidebarSrc).toContain('Main');
    expect(sidebarSrc).toContain('System');
  });
});
