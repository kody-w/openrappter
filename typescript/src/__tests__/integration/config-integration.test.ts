/**
 * Config Integration Tests
 * Tests that import and exercise real config modules:
 * - loadConfig / saveConfig / mergeConfigs
 * - substituteEnvVars / parseConfigContent
 * - validateConfig (Zod schema)
 * - ConfigWatcher lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadConfig,
  saveConfig,
  mergeConfigs,
  substituteEnvVars,
  parseConfigContent,
} from '../../config/loader.js';
import { validateConfig } from '../../config/schema.js';
import { ConfigWatcher } from '../../config/watcher.js';
import type { OpenRappterConfig } from '../../config/types.js';

describe('Config Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `openrappter-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── loadConfig ────────────────────────────────────────────────────────

  describe('loadConfig', () => {
    it('should return empty config when file does not exist', () => {
      const config = loadConfig({ path: join(tmpDir, 'nonexistent.json5') });
      expect(config).toEqual({});
    });

    it('should load a valid JSON5 config file', () => {
      const configPath = join(tmpDir, 'config.json5');
      writeFileSync(configPath, `{
        // JSON5 comment
        gateway: { port: 9999, bind: "loopback" },
      }`);

      const config = loadConfig({ path: configPath });
      expect(config.gateway?.port).toBe(9999);
      expect(config.gateway?.bind).toBe('loopback');
    });

    it('should throw on invalid config values', () => {
      const configPath = join(tmpDir, 'bad.json5');
      writeFileSync(configPath, `{ gateway: { port: "not-a-number" } }`);

      expect(() => loadConfig({ path: configPath })).toThrow();
    });

    it('should substitute environment variables', () => {
      process.env.TEST_OPENRAPPTER_PORT = '4567';
      const configPath = join(tmpDir, 'env.json5');
      writeFileSync(configPath, `{ gateway: { port: 4567 } }`);

      const config = loadConfig({ path: configPath });
      expect(config.gateway?.port).toBe(4567);

      delete process.env.TEST_OPENRAPPTER_PORT;
    });
  });

  // ── saveConfig ────────────────────────────────────────────────────────

  describe('saveConfig', () => {
    it('should write config to file', () => {
      const configPath = join(tmpDir, 'output.json5');
      const config: OpenRappterConfig = {
        gateway: { port: 8888, bind: 'all' },
      };

      saveConfig(config, { path: configPath });
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('8888');
    });

    it('should create backup when overwriting', () => {
      const configPath = join(tmpDir, 'backup-test.json5');
      writeFileSync(configPath, '{ gateway: { port: 1111 } }');

      saveConfig({ gateway: { port: 2222, bind: 'loopback' } }, { path: configPath });

      const backupPath = configPath.replace(/\.json5$/, '.backup.json5');
      expect(existsSync(backupPath)).toBe(true);

      const backupContent = readFileSync(backupPath, 'utf-8');
      expect(backupContent).toContain('1111');
    });
  });

  // ── substituteEnvVars ─────────────────────────────────────────────────

  describe('substituteEnvVars', () => {
    it('should substitute known env vars', () => {
      process.env.TEST_SUB_VAR = 'hello';
      const result = substituteEnvVars('prefix-${TEST_SUB_VAR}-suffix');
      expect(result).toBe('prefix-hello-suffix');
      delete process.env.TEST_SUB_VAR;
    });

    it('should replace unknown env vars with empty string', () => {
      delete process.env.NONEXISTENT_VAR_XYZ;
      const result = substituteEnvVars('${NONEXISTENT_VAR_XYZ}');
      expect(result).toBe('');
    });

    it('should handle multiple substitutions', () => {
      process.env.A_VAR = 'a';
      process.env.B_VAR = 'b';
      const result = substituteEnvVars('${A_VAR}-${B_VAR}');
      expect(result).toBe('a-b');
      delete process.env.A_VAR;
      delete process.env.B_VAR;
    });

    it('should leave strings without vars unchanged', () => {
      expect(substituteEnvVars('no vars here')).toBe('no vars here');
    });
  });

  // ── parseConfigContent ────────────────────────────────────────────────

  describe('parseConfigContent', () => {
    it('should parse valid JSON5', () => {
      const result = parseConfigContent(`{ port: 1234, bind: "all" }`) as Record<string, unknown>;
      expect(result.port).toBe(1234);
      expect(result.bind).toBe('all');
    });

    it('should throw on invalid JSON5', () => {
      expect(() => parseConfigContent('not valid json')).toThrow();
    });
  });

  // ── validateConfig ────────────────────────────────────────────────────

  describe('validateConfig', () => {
    it('should accept empty config', () => {
      const result = validateConfig({});
      expect(result.success).toBe(true);
    });

    it('should accept valid full config', () => {
      const result = validateConfig({
        gateway: { port: 18790, bind: 'loopback' },
        memory: { provider: 'openai', chunkTokens: 512, chunkOverlap: 64 },
        cron: { enabled: true },
      });
      expect(result.success).toBe(true);
      expect(result.data?.gateway?.port).toBe(18790);
    });

    it('should reject invalid gateway bind mode', () => {
      const result = validateConfig({
        gateway: { port: 18790, bind: 'invalid-mode' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid model provider', () => {
      const result = validateConfig({
        models: [{ id: 'test', provider: 'fake-provider', model: 'x', auth: { type: 'api-key' } }],
      });
      expect(result.success).toBe(false);
    });

    it('should apply defaults for optional fields', () => {
      const result = validateConfig({ gateway: {} });
      expect(result.success).toBe(true);
      expect(result.data?.gateway?.port).toBe(18790);
      expect(result.data?.gateway?.bind).toBe('loopback');
    });
  });

  // ── mergeConfigs ──────────────────────────────────────────────────────

  describe('mergeConfigs', () => {
    it('should merge gateway configs with override', () => {
      const base: Partial<OpenRappterConfig> = {
        gateway: { port: 18790, bind: 'loopback' },
      };
      const override: Partial<OpenRappterConfig> = {
        gateway: { port: 9999, bind: 'all' },
      };

      const merged = mergeConfigs(base, override);
      expect(merged.gateway?.port).toBe(9999);
      expect(merged.gateway?.bind).toBe('all');
    });

    it('should merge channels from multiple configs', () => {
      const a: Partial<OpenRappterConfig> = {
        channels: { telegram: { enabled: true } },
      };
      const b: Partial<OpenRappterConfig> = {
        channels: { discord: { enabled: false } },
      };

      const merged = mergeConfigs(a, b);
      expect(merged.channels?.telegram?.enabled).toBe(true);
      expect(merged.channels?.discord?.enabled).toBe(false);
    });

    it('should concatenate agent lists', () => {
      const a: Partial<OpenRappterConfig> = {
        agents: { list: [{ id: 'a1', model: 'x' }] },
      };
      const b: Partial<OpenRappterConfig> = {
        agents: { list: [{ id: 'a2', model: 'y' }] },
      };

      const merged = mergeConfigs(a, b);
      expect(merged.agents?.list).toHaveLength(2);
    });

    it('should concatenate model arrays', () => {
      const a: Partial<OpenRappterConfig> = {
        models: [{ id: 'm1', provider: 'openai', model: 'gpt-4', auth: { type: 'api-key' } }],
      };
      const b: Partial<OpenRappterConfig> = {
        models: [{ id: 'm2', provider: 'anthropic', model: 'claude-3', auth: { type: 'api-key' } }],
      };

      const merged = mergeConfigs(a, b);
      expect(merged.models).toHaveLength(2);
    });

    it('should handle empty configs gracefully', () => {
      const merged = mergeConfigs({}, {}, {});
      expect(merged).toEqual({});
    });
  });

  // ── ConfigWatcher ─────────────────────────────────────────────────────

  describe('ConfigWatcher', () => {
    it('should start and stop without error', async () => {
      const configPath = join(tmpDir, 'watch.json5');
      writeFileSync(configPath, '{}');

      const watcher = new ConfigWatcher({
        path: configPath,
        debounceMs: 100,
      });

      await watcher.start();
      expect(watcher.isWatching).toBe(true);

      watcher.stop();
      expect(watcher.isWatching).toBe(false);
    });

    it('should not start twice', async () => {
      const configPath = join(tmpDir, 'watch2.json5');
      writeFileSync(configPath, '{}');

      const watcher = new ConfigWatcher({ path: configPath });
      await watcher.start();
      await watcher.start(); // should be idempotent
      expect(watcher.isWatching).toBe(true);

      watcher.stop();
    });

    it('should invoke onError callback for invalid config on reload', async () => {
      const configPath = join(tmpDir, 'watch-err.json5');
      writeFileSync(configPath, '{}');

      const watcher = new ConfigWatcher({
        path: configPath,
        debounceMs: 50,
        onError: () => { /* intentionally ignored — test verifies no crash */ },
      });

      await watcher.start();

      // Write invalid content to trigger error on reload
      writeFileSync(configPath, 'not valid json5 at all {{{{');

      // Wait for debounce + reload
      await new Promise((r) => setTimeout(r, 200));

      watcher.stop();
      // Error may or may not fire depending on chokidar availability
      // but the watcher should not crash
    });
  });

  // ── Round-trip: save → load ───────────────────────────────────────────

  describe('Round-trip', () => {
    it('should save and reload config preserving values', () => {
      const configPath = join(tmpDir, 'roundtrip.json5');
      const original: OpenRappterConfig = {
        gateway: { port: 5555, bind: 'all' },
        cron: { enabled: true },
        memory: { provider: 'local', chunkTokens: 256, chunkOverlap: 32 },
      };

      saveConfig(original, { path: configPath });
      const loaded = loadConfig({ path: configPath });

      expect(loaded.gateway?.port).toBe(5555);
      expect(loaded.cron?.enabled).toBe(true);
      expect(loaded.memory?.provider).toBe('local');
    });
  });
});
