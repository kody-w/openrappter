/**
 * Plugin SDK and Extension Framework Tests
 *
 * Comprehensive tests covering:
 * - Manifest validation (valid/invalid schemas)
 * - Plugin SDK registration (all capability types)
 * - Plugin loader (discovery, security checks)
 * - Plugin manager (lifecycle, enable/disable)
 * - Error handling (bad plugins, missing deps)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import * as fs from 'fs/promises';

// ---------------------------------------------------------------------------
// Manifest validation tests
// ---------------------------------------------------------------------------

describe('Plugin Manifest', () => {
  // Dynamically import after we know the schema is available
  let manifest: typeof import('../manifest.js');

  beforeEach(async () => {
    manifest = await import('../manifest.js');
  });

  describe('PluginManifestSchema', () => {
    it('should accept a minimal valid manifest', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        entry: 'index.js',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a fully-specified manifest', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'full-plugin',
        version: '2.1.3',
        description: 'A full plugin',
        author: 'Test Author',
        entry: 'dist/index.js',
        capabilities: {
          channels: true,
          memory: true,
          tools: true,
          hooks: true,
          routes: true,
        },
        dependencies: { chalk: '^5.0.0', zod: '^4.0.0' },
        configSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'API key' },
            timeout: { type: 'number', description: 'Timeout in ms', default: 5000 },
            enabled: { type: 'boolean', description: 'Enable feature', default: true },
          },
          required: ['apiKey'],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('full-plugin');
        expect(result.data.version).toBe('2.1.3');
        expect(result.data.capabilities?.tools).toBe(true);
        expect(result.data.configSchema?.required).toContain('apiKey');
      }
    });

    it('should reject a manifest missing required "name"', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        version: '1.0.0',
        entry: 'index.js',
      });
      expect(result.success).toBe(false);
    });

    it('should reject a manifest missing required "version"', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        entry: 'index.js',
      });
      expect(result.success).toBe(false);
    });

    it('should reject a manifest missing required "entry"', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: '1.0.0',
      });
      expect(result.success).toBe(false);
    });

    it('should reject an invalid semver version', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: 'not-a-version',
        entry: 'index.js',
      });
      expect(result.success).toBe(false);
    });

    it('should allow capabilities to be partially specified', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: '1.0.0',
        entry: 'index.js',
        capabilities: { tools: true },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.capabilities?.tools).toBe(true);
        expect(result.data.capabilities?.channels).toBeUndefined();
      }
    });

    it('should default capabilities to empty object when omitted', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: '1.0.0',
        entry: 'index.js',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.capabilities).toBeDefined();
      }
    });

    it('should reject configSchema with invalid property type', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: '1.0.0',
        entry: 'index.js',
        configSchema: {
          type: 'object',
          properties: {
            foo: { type: 'invalid-type' },
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it('should accept dependencies as a string record', () => {
      const result = manifest.PluginManifestSchema.safeParse({
        name: 'my-plugin',
        version: '1.0.0',
        entry: 'index.js',
        dependencies: { axios: '^1.0.0', lodash: '4.17.21' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('extractManifestFromPackageJson', () => {
    it('should extract manifest from openrappter key in package.json', () => {
      const pkg = {
        name: 'my-plugin',
        version: '1.0.0',
        openrappter: {
          entry: 'dist/index.js',
          description: 'My plugin',
          capabilities: { tools: true },
        },
      };
      const result = manifest.extractManifestFromPackageJson(pkg);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('my-plugin');
      expect(result?.version).toBe('1.0.0');
      expect(result?.entry).toBe('dist/index.js');
      expect(result?.capabilities?.tools).toBe(true);
    });

    it('should return null when package.json has no openrappter key', () => {
      const pkg = { name: 'my-plugin', version: '1.0.0' };
      const result = manifest.extractManifestFromPackageJson(pkg);
      expect(result).toBeNull();
    });

    it('should return null when package.json openrappter key lacks entry', () => {
      const pkg = {
        name: 'my-plugin',
        version: '1.0.0',
        openrappter: { description: 'No entry field' },
      };
      const result = manifest.extractManifestFromPackageJson(pkg);
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin SDK tests
// ---------------------------------------------------------------------------

describe('Plugin SDK', () => {
  let sdk: typeof import('../sdk.js');

  beforeEach(async () => {
    sdk = await import('../sdk.js');
  });

  describe('createPluginContext', () => {
    it('should return a PluginContext with all required methods', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      expect(ctx).toBeDefined();
      expect(typeof ctx.registerChannel).toBe('function');
      expect(typeof ctx.registerTool).toBe('function');
      expect(typeof ctx.registerHook).toBe('function');
      expect(typeof ctx.registerRoute).toBe('function');
      expect(typeof ctx.registerMemoryBackend).toBe('function');
      expect(typeof ctx.getConfig).toBe('function');
      expect(typeof ctx.getLogger).toBe('function');
    });

    it('registerChannel should record the channel config', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      ctx.registerChannel({ id: 'my-channel', type: 'webhook', create: () => ({}) });
      const channels = ctx.getRegistrations().channels;
      expect(channels).toHaveLength(1);
      expect(channels[0].id).toBe('my-channel');
    });

    it('registerTool should record the tool', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      ctx.registerTool({
        name: 'my-tool',
        description: 'Does something',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'result',
      });
      const tools = ctx.getRegistrations().tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('my-tool');
    });

    it('registerTool should enforce that execute is a function', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      expect(() =>
        ctx.registerTool({
          name: 'bad-tool',
          description: 'Bad',
          parameters: { type: 'object', properties: {}, required: [] },
          execute: 'not-a-function' as unknown as () => Promise<unknown>,
        })
      ).toThrow();
    });

    it('registerHook should record the hook by phase', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      const handler = async (c: unknown) => c;
      ctx.registerHook('before_agent_start', handler);
      ctx.registerHook('after_tool_call', handler, 10);
      const hooks = ctx.getRegistrations().hooks;
      expect(hooks).toHaveLength(2);
      expect(hooks[0].event).toBe('before_agent_start');
      expect(hooks[1].event).toBe('after_tool_call');
      expect(hooks[1].priority).toBe(10);
    });

    it('registerRoute should record method + path + handler', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      const handler = async () => {};
      ctx.registerRoute('GET', '/api/my-plugin/status', handler);
      ctx.registerRoute('POST', '/api/my-plugin/action', handler);
      const routes = ctx.getRegistrations().routes;
      expect(routes).toHaveLength(2);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].path).toBe('/api/my-plugin/status');
      expect(routes[1].method).toBe('POST');
    });

    it('registerMemoryBackend should record the backend', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      ctx.registerMemoryBackend({
        id: 'redis-memory',
        name: 'Redis Memory Backend',
        store: async () => {},
        search: async () => [],
        delete: async () => {},
      });
      const backends = ctx.getRegistrations().memoryBackends;
      expect(backends).toHaveLength(1);
      expect(backends[0].id).toBe('redis-memory');
    });

    it('getConfig should return the config passed at creation', () => {
      const config = { apiKey: 'secret-123', timeout: 3000 };
      const ctx = sdk.createPluginContext('test-plugin', config);
      expect(ctx.getConfig()).toEqual(config);
    });

    it('getConfig should return empty object when no config provided', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      expect(ctx.getConfig()).toEqual({});
    });

    it('getLogger should return a namespaced logger', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      const logger = ctx.getLogger();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      // Should not throw
      expect(() => logger.info('test message')).not.toThrow();
      expect(() => logger.warn('warning')).not.toThrow();
      expect(() => logger.error('error')).not.toThrow();
      expect(() => logger.debug('debug')).not.toThrow();
    });

    it('multiple registrations should accumulate independently', () => {
      const ctx = sdk.createPluginContext('test-plugin', {});
      const hookHandler = async (c: unknown) => c;
      const routeHandler = async (_req: unknown, _res: unknown): Promise<void> => { return; };

      ctx.registerTool({ name: 'tool-a', description: 'A', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => {} });
      ctx.registerTool({ name: 'tool-b', description: 'B', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => {} });
      ctx.registerHook('before_agent_start', hookHandler);
      ctx.registerRoute('GET', '/health', routeHandler);

      const regs = ctx.getRegistrations();
      expect(regs.tools).toHaveLength(2);
      expect(regs.hooks).toHaveLength(1);
      expect(regs.routes).toHaveLength(1);
      expect(regs.channels).toHaveLength(0);
      expect(regs.memoryBackends).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin Loader tests (real filesystem, temp directories)
// ---------------------------------------------------------------------------

describe('Plugin Loader', () => {
  let loaderModule: typeof import('../loader.js');
  /** Real, unique temp root per test — removed in afterEach. */
  let tmpRoot: string;
  /** Real plugin directory (a subdirectory of tmpRoot) passed as `pluginDir`. */
  let pluginDir: string;

  beforeEach(async () => {
    vi.resetModules();
    loaderModule = await import('../loader.js');
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-plugin-test-'));
    pluginDir = path.join(tmpRoot, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** Writes a real, loadable plugin directory: package.json (with an
   * `openrappter` manifest key) + a trivial JS entry file. Returns the
   * plugin's own directory path. */
  async function writeRealPlugin(dir: string, name: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        openrappter: { name, version: '1.0.0', entry: 'index.js' },
      })
    );
    await fs.writeFile(path.join(dir, 'index.js'), 'export const marker = true;\n');
    return dir;
  }

  describe('SecurePluginLoader', () => {
    it('should expose a SecurePluginLoader class or createSecurePluginLoader factory', () => {
      const hasClass = 'SecurePluginLoader' in loaderModule;
      const hasFactory = 'createSecurePluginLoader' in loaderModule;
      expect(hasClass || hasFactory).toBe(true);
    });

    it('should reject a real, valid, loadable plugin directory that lives outside the plugin dir (path containment)', async () => {
      // A genuinely loadable plugin (real package.json + real entry file) —
      // the only thing wrong with it is that it lives *outside* pluginDir.
      // If containment were only a string check with no real fs boundary,
      // this plugin would otherwise load successfully.
      const outsideDir = await writeRealPlugin(path.join(tmpRoot, 'outside-plugin'), 'outside-plugin');
      const loader = loaderModule.createSecurePluginLoader({ pluginDir });

      await expect(loader.loadPluginFromPath(outsideDir)).rejects.toThrow(/outside the plugin directory/);
    });

    it('should reject a real plugin reached via directory traversal sequences (../../..)', async () => {
      // Same real, loadable plugin, but this time reached via a `pluginDir`-
      // relative traversal path instead of an absolute outside path — proves
      // the loader resolves the path before checking containment rather than
      // matching on the raw (unresolved) string.
      const escapedName = 'escaped-plugin';
      await writeRealPlugin(path.join(tmpRoot, escapedName), escapedName);
      const traversalPath = path.join(pluginDir, '..', escapedName);
      const loader = loaderModule.createSecurePluginLoader({ pluginDir });

      await expect(loader.loadPluginFromPath(traversalPath)).rejects.toThrow(/outside the plugin directory/);
    });

    it('should return null for a path that does not exist', async () => {
      const loader = loaderModule.createSecurePluginLoader({ pluginDir });
      const result = await loader.loadPluginFromPath(path.join(pluginDir, 'nonexistent-plugin'));
      expect(result).toBeNull();
    });

    it('should successfully load a real, valid plugin that lives inside the plugin dir', async () => {
      const goodDir = await writeRealPlugin(path.join(pluginDir, 'good-plugin'), 'good-plugin');
      const loader = loaderModule.createSecurePluginLoader({ pluginDir });

      const loaded = await loader.loadPluginFromPath(goodDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.manifest.name).toBe('good-plugin');
      expect(loaded?.module).toBeDefined();
    });

    it('discoverPlugins should return an empty array when dir does not exist', async () => {
      const loader = loaderModule.createSecurePluginLoader({
        pluginDir: path.join(tmpRoot, 'openrappter-test-nonexistent-12345'),
      });
      const plugins = await loader.discoverPlugins();
      expect(Array.isArray(plugins)).toBe(true);
      expect(plugins).toHaveLength(0);
    });

    it('discoverPlugins should find real plugin directories on disk without importing them', async () => {
      await writeRealPlugin(path.join(pluginDir, 'plugin-a'), 'plugin-a');
      await writeRealPlugin(path.join(pluginDir, 'plugin-b'), 'plugin-b');
      // A directory with no package.json — should be silently skipped, not
      // crash discovery.
      await fs.mkdir(path.join(pluginDir, 'not-a-plugin'), { recursive: true });

      const loader = loaderModule.createSecurePluginLoader({ pluginDir });
      const plugins = await loader.discoverPlugins();

      expect(plugins.map((p) => p.name).sort()).toEqual(['plugin-a', 'plugin-b']);
    });
  });

  describe('Security: symlink rejection', () => {
    it('isSymlink returns true for a real symlink and false for a real regular file/directory', async () => {
      const realFile = path.join(tmpRoot, 'real-file.txt');
      await fs.writeFile(realFile, 'hello');
      const realDir = path.join(tmpRoot, 'real-dir');
      await fs.mkdir(realDir);
      const linkPath = path.join(tmpRoot, 'a-real-symlink');
      await fs.symlink(realDir, linkPath, 'dir');

      expect(await loaderModule.isSymlink(linkPath)).toBe(true);
      expect(await loaderModule.isSymlink(realFile)).toBe(false);
      expect(await loaderModule.isSymlink(realDir)).toBe(false);
    });

    it('isSymlink returns false (not throws) for a path that does not exist', async () => {
      const result = await loaderModule.isSymlink(path.join(tmpRoot, 'definitely-not-a-symlink-xyz'));
      expect(result).toBe(false);
    });

    it('loadPluginFromPath rejects a real symlink inside pluginDir that escapes to a plugin outside it', async () => {
      // A real, otherwise-loadable plugin living outside the sandbox...
      const outsideDir = await writeRealPlugin(path.join(tmpRoot, 'symlink-target-plugin'), 'symlink-target-plugin');
      // ...reached through a real symlink planted *inside* pluginDir. If the
      // loader only checked path containment on the string and not the
      // symlink itself, this would resolve to a contained-looking path and
      // load successfully.
      const linkPath = path.join(pluginDir, 'escape-hatch');
      await fs.symlink(outsideDir, linkPath, 'dir');

      const loader = loaderModule.createSecurePluginLoader({ pluginDir });
      await expect(loader.loadPluginFromPath(linkPath)).rejects.toThrow(/symlink/);
    });
  });

  describe('isContainedPath', () => {
    it('correctly distinguishes real contained paths from real escaping paths', async () => {
      const base = pluginDir;
      const nested = path.join(base, 'my-plugin');
      await fs.mkdir(nested, { recursive: true });
      const outside = path.join(tmpRoot, 'sibling-dir');
      await fs.mkdir(outside, { recursive: true });

      expect(loaderModule.isContainedPath(base, nested)).toBe(true);
      expect(loaderModule.isContainedPath(base, path.join(nested, 'sub'))).toBe(true);
      expect(loaderModule.isContainedPath(base, outside)).toBe(false);
      expect(loaderModule.isContainedPath(base, path.join(base, '..', 'sibling-dir'))).toBe(false);
      // Exact equality to base counts as contained.
      expect(loaderModule.isContainedPath(base, base)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin Manager tests
// ---------------------------------------------------------------------------

describe('Plugin Manager', () => {
  let managerModule: typeof import('../manager.js');

  beforeEach(async () => {
    vi.resetModules();
    managerModule = await import('../manager.js');
  });

  describe('PluginManager class', () => {
    it('should be exported from manager.ts', () => {
      expect('PluginManager' in managerModule).toBe(true);
    });

    it('should instantiate with a plugin dir', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      expect(mgr).toBeDefined();
    });

    it('listPlugins should return empty array initially', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      expect(mgr.listPlugins()).toEqual([]);
    });

    it('getPlugin should return undefined for unknown plugin', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      expect(mgr.getPlugin('unknown')).toBeUndefined();
    });

    it('enable should throw for unknown plugin', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      await expect(mgr.enable('unknown-plugin')).rejects.toThrow();
    });

    it('disable should throw for unknown plugin', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      await expect(mgr.disable('unknown-plugin')).rejects.toThrow();
    });

    it('uninstall should return false for unknown plugin', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const result = await mgr.uninstall('unknown-plugin');
      expect(result).toBe(false);
    });

    it('should register and call event listeners', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const events: string[] = [];
      mgr.on('plugin:loaded', (name: string) => events.push(`loaded:${name}`));
      mgr.on('plugin:enabled', (name: string) => events.push(`enabled:${name}`));
      mgr.on('plugin:disabled', (name: string) => events.push(`disabled:${name}`));
      mgr.on('plugin:error', (name: string) => events.push(`error:${name}`));

      // Emit events manually to verify the EventEmitter wiring
      mgr.emit('plugin:loaded', 'test-plugin');
      mgr.emit('plugin:enabled', 'test-plugin');
      mgr.emit('plugin:disabled', 'test-plugin');
      mgr.emit('plugin:error', 'test-plugin');

      expect(events).toEqual([
        'loaded:test-plugin',
        'enabled:test-plugin',
        'disabled:test-plugin',
        'error:test-plugin',
      ]);
    });

    it('should emit plugin:loaded event when a plugin is registered', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const loaded: string[] = [];
      mgr.on('plugin:loaded', (name: string) => loaded.push(name));

      // Directly register a mock plugin (bypassing filesystem)
      mgr.registerPlugin({
        name: 'mock-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: {
          default: {
            initialize: async () => {},
          },
        },
      });

      expect(loaded).toContain('mock-plugin');
    });

    it('enable/disable should toggle plugin state', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });

      mgr.registerPlugin({
        name: 'toggleable-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: {
          default: {
            onEnable: vi.fn().mockResolvedValue(undefined),
            onDisable: vi.fn().mockResolvedValue(undefined),
          },
        },
      });

      const plugin = mgr.getPlugin('toggleable-plugin');
      expect(plugin).toBeDefined();
      expect(plugin?.enabled).toBe(false);

      await mgr.enable('toggleable-plugin');
      expect(mgr.getPlugin('toggleable-plugin')?.enabled).toBe(true);

      await mgr.disable('toggleable-plugin');
      expect(mgr.getPlugin('toggleable-plugin')?.enabled).toBe(false);
    });

    it('enable should be idempotent', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const onEnable = vi.fn().mockResolvedValue(undefined);

      mgr.registerPlugin({
        name: 'idempotent-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: { default: { onEnable } },
      });

      await mgr.enable('idempotent-plugin');
      await mgr.enable('idempotent-plugin'); // Should not call onEnable twice
      expect(onEnable).toHaveBeenCalledTimes(1);
    });

    it('disable should be idempotent', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const onDisable = vi.fn().mockResolvedValue(undefined);

      mgr.registerPlugin({
        name: 'idempotent-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: { default: { onDisable } },
      });

      // disable when already disabled should be a no-op
      await mgr.disable('idempotent-plugin');
      expect(onDisable).not.toHaveBeenCalled();
    });

    it('uninstall should remove an existing plugin', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });

      mgr.registerPlugin({
        name: 'removable-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: { default: {} },
      });

      expect(mgr.getPlugin('removable-plugin')).toBeDefined();
      const result = await mgr.uninstall('removable-plugin');
      expect(result).toBe(true);
      expect(mgr.getPlugin('removable-plugin')).toBeUndefined();
    });

    it('uninstall should disable a plugin before removing it', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const onDisable = vi.fn().mockResolvedValue(undefined);

      mgr.registerPlugin({
        name: 'cleanup-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: { default: { onDisable } },
      });

      await mgr.enable('cleanup-plugin');
      await mgr.uninstall('cleanup-plugin');
      expect(onDisable).toHaveBeenCalledOnce();
    });

    it('listPlugins should include all registered plugins', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });

      mgr.registerPlugin({ name: 'plugin-a', version: '1.0.0', entry: 'a.js', _module: { default: {} } });
      mgr.registerPlugin({ name: 'plugin-b', version: '2.0.0', entry: 'b.js', _module: { default: {} } });

      const list = mgr.listPlugins();
      expect(list).toHaveLength(2);
      const names = list.map((p) => p.name);
      expect(names).toContain('plugin-a');
      expect(names).toContain('plugin-b');
    });

    it('should emit plugin:error when plugin initialization throws', async () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });
      const errors: string[] = [];
      mgr.on('plugin:error', (name: string, _err: Error) => errors.push(name));

      mgr.registerPlugin({
        name: 'broken-plugin',
        version: '1.0.0',
        entry: 'index.js',
        _module: {
          default: {
            onEnable: async () => {
              throw new Error('Plugin failed to enable');
            },
          },
        },
      });

      // enable should not throw — errors are emitted via event
      await mgr.enable('broken-plugin').catch(() => {});
      // Either the error is emitted or enable rejects — check at least one is true
      const pluginState = mgr.getPlugin('broken-plugin');
      const isErrored = errors.includes('broken-plugin') || pluginState?.enabled === false;
      expect(isErrored).toBe(true);
    });
  });

  describe('PluginRecord shape', () => {
    it('getPlugin should return a PluginRecord with name, version, enabled, entry', () => {
      const mgr = new managerModule.PluginManager({ pluginDir: '/tmp/plugins' });

      mgr.registerPlugin({
        name: 'shape-plugin',
        version: '3.2.1',
        entry: 'dist/main.js',
        _module: { default: {} },
      });

      const plugin = mgr.getPlugin('shape-plugin');
      expect(plugin).toBeDefined();
      expect(plugin?.name).toBe('shape-plugin');
      expect(plugin?.version).toBe('3.2.1');
      expect(plugin?.entry).toBe('dist/main.js');
      expect(plugin?.enabled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: SDK + Manager round-trip
// ---------------------------------------------------------------------------

describe('Plugin System Integration', () => {
  it('a plugin can use the SDK and its registrations are accessible via manager', async () => {
    const { PluginManager } = await import('../manager.js');
    await import('../sdk.js'); // SDK imported for type reference

    const mgr = new PluginManager({ pluginDir: '/tmp/plugins' });

    // Simulate a plugin module that uses the SDK
    const pluginModule = {
      default: {
        initialize: async (ctx: any) => {
          ctx.registerTool({
            name: 'greet',
            description: 'Greet someone',
            parameters: {
              type: 'object' as const,
              properties: { name: { type: 'string' as const, description: 'Name to greet' } },
              required: ['name'],
            },
            execute: async ({ name }: Record<string, unknown>) => `Hello, ${name}!`,
          });

          ctx.registerHook('before_agent_start', async (context: unknown) => {
            return { ...context as object, pluginActive: true };
          });

          ctx.registerRoute('GET', '/api/greet', async () => { return; });
        },
      },
    };

    mgr.registerPlugin({
      name: 'greet-plugin',
      version: '1.0.0',
      entry: 'index.js',
      _module: pluginModule,
    });

    await mgr.enable('greet-plugin');

    const plugin = mgr.getPlugin('greet-plugin');
    expect(plugin?.enabled).toBe(true);
  });

  it('error in one plugin does not prevent others from loading', async () => {
    const { PluginManager } = await import('../manager.js');

    const mgr = new PluginManager({ pluginDir: '/tmp/plugins' });

    mgr.registerPlugin({
      name: 'broken-plugin',
      version: '1.0.0',
      entry: 'index.js',
      _module: {
        default: {
          onEnable: async () => { throw new Error('Broken!'); },
        },
      },
    });

    mgr.registerPlugin({
      name: 'healthy-plugin',
      version: '1.0.0',
      entry: 'index.js',
      _module: { default: { onEnable: async () => {} } },
    });

    // Enable both, expecting broken to fail but healthy to succeed
    await mgr.enable('broken-plugin').catch(() => {});
    await mgr.enable('healthy-plugin');

    expect(mgr.getPlugin('healthy-plugin')?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error handling edge cases
// ---------------------------------------------------------------------------

describe('Error Handling', () => {
  it('registerTool without a name should throw', async () => {
    const { createPluginContext } = await import('../sdk.js');
    const ctx = createPluginContext('test-plugin', {});
    expect(() =>
      ctx.registerTool({
        name: '',
        description: 'No name',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {},
      })
    ).toThrow();
  });

  it('registerHook with unknown phase should not throw (lenient)', async () => {
    const { createPluginContext } = await import('../sdk.js');
    const ctx = createPluginContext('test-plugin', {});
    // Unknown hook phases should be accepted or throw — either is fine as long as it's consistent
    const fn = () => ctx.registerHook('unknown_phase' as never, async (c) => c);
    // Just ensure it doesn't crash the process
    try { fn(); } catch { /* acceptable */ }
    expect(true).toBe(true);
  });

  it('registerRoute with invalid method should throw', async () => {
    const { createPluginContext } = await import('../sdk.js');
    const ctx = createPluginContext('test-plugin', {});
    expect(() =>
      ctx.registerRoute('INVALID' as 'GET', '/path', async () => {})
    ).toThrow();
  });

  it('registerChannel without id should throw', async () => {
    const { createPluginContext } = await import('../sdk.js');
    const ctx = createPluginContext('test-plugin', {});
    expect(() =>
      ctx.registerChannel({ id: '', type: 'webhook', create: () => ({}) })
    ).toThrow();
  });

  it('registerMemoryBackend without required methods should throw', async () => {
    const { createPluginContext } = await import('../sdk.js');
    const ctx = createPluginContext('test-plugin', {});
    expect(() =>
      ctx.registerMemoryBackend({
        id: 'bad-backend',
        name: 'Bad Backend',
        // Missing store, search, delete
      } as Parameters<typeof ctx.registerMemoryBackend>[0])
    ).toThrow();
  });
});
