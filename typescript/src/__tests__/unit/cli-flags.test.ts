import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '../..');

describe('CLI flags', () => {
  let indexSource: string;

  beforeAll(async () => {
    indexSource = await fs.readFile(path.join(srcRoot, 'index.ts'), 'utf-8');
  });

  it('should have --web flag in commander config', () => {
    expect(indexSource).toContain("--web");
  });

  it('should have --daemon flag in commander config', () => {
    expect(indexSource).toContain("--daemon");
  });

  it('should have TTY guard on onboard command', () => {
    expect(indexSource).toContain('process.stdin.isTTY');
  });

  it('bootstraps Flight Recorder after env hydration and before direct agent dispatch', () => {
    const envLoad = indexSource.indexOf('const envVars = await loadEnv()');
    const recorderBootstrap = indexSource.indexOf(
      'await ensureFlightRecorderFromEnv();',
      envLoad,
    );
    const discovery = indexSource.indexOf(
      'await registry.discoverAgents();',
      envLoad,
    );

    expect(envLoad).toBeGreaterThanOrEqual(0);
    expect(recorderBootstrap).toBeGreaterThan(envLoad);
    expect(discovery).toBeGreaterThan(recorderBootstrap);
  });

  it('hydrates managed gateway env before recorder bootstrap', () => {
    const gatewayStart = indexSource.indexOf(
      'async function startGatewayInProcess',
    );
    const hydration = indexSource.indexOf(
      'await hydrateManagedEnv();',
      gatewayStart,
    );
    const recorderBootstrap = indexSource.indexOf(
      'await ensureFlightRecorderFromEnv();',
      gatewayStart,
    );

    expect(hydration).toBeGreaterThan(gatewayStart);
    expect(recorderBootstrap).toBeGreaterThan(hydration);
  });

  it('acquires the runtime lock before starting --web gateway mode', () => {
    const webBranch = indexSource.indexOf('if (options.web)');
    const lock = indexSource.indexOf('acquireLock({ filePath: lockFile })', webBranch);
    const gateway = indexSource.indexOf('startGatewayInProcess({', webBranch);

    expect(lock).toBeGreaterThan(webBranch);
    expect(gateway).toBeGreaterThan(lock);
  });

  it('publishes named web gateway identity and endpoint', () => {
    const webBranch = indexSource.indexOf('if (options.web)');
    const declare = indexSource.indexOf(
      'declareCurrentInstance(lockInstance)',
      webBranch,
    );
    const endpoint = indexSource.indexOf(
      'writeGatewayEndpoint({',
      webBranch,
    );

    expect(declare).toBeGreaterThan(webBranch);
    expect(endpoint).toBeGreaterThan(declare);
  });

  it('resolves reset database from hydrated process env before file fallback', () => {
    const resetBranch = indexSource.indexOf(".command('reset')");
    const processOverride = indexSource.indexOf(
      'process.env.OPENRAPPTER_FLIGHT_DB',
      resetBranch,
    );
    const fileFallback = indexSource.indexOf(
      'resetEnv.OPENRAPPTER_FLIGHT_DB',
      resetBranch,
    );

    expect(processOverride).toBeGreaterThan(resetBranch);
    expect(fileFallback).toBeGreaterThan(processOverride);
  });
});

describe('install.sh TTY guard', () => {
  it('should check for interactive TTY before onboard wizard', async () => {
    const installSh = await fs.readFile(
      path.resolve(srcRoot, '../../install.sh'),
      'utf-8'
    );
    // install.sh uses gum_is_tty to guard interactive prompts
    expect(installSh).toContain('gum_is_tty');
    expect(installSh).toContain('/dev/tty');
  });

  describe('MCP stdio bootstrap', () => {
    it('initializes Flight Recorder before serving child-process agents', async () => {
      const source = await fs.readFile(
        path.join(srcRoot, 'mcp', 'stdio.ts'),
        'utf-8',
      );
      expect(source.indexOf('await ensureFlightRecorderFromEnv();')).toBeLessThan(
        source.indexOf('await registry.getAllAgents();'),
      );
    });
  });
});
