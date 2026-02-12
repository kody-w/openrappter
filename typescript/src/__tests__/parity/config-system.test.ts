import { describe, it, expect, afterEach } from 'vitest';
import { mergePatch } from '../../config/merge-patch.js';
import { expandEnvVars, expandEnvDeep } from '../../config/env-expand.js';
import { migrateConfig } from '../../config/migrations.js';
import { openRappterConfigSchema, validateConfig, getConfigJsonSchema } from '../../config/schema.js';

describe('Config System Parity', () => {
  describe('Config Schema', () => {
    it('should validate empty config', () => {
      expect(validateConfig({}).success).toBe(true);
    });

    it('should validate config with all sections', () => {
      const config = {
        gateway: {},
        cron: {},
        memory: {},
        env: {},
        auth: {},
        tools: {},
        plugins: {},
        browser: {},
        voice: {},
        media: {},
        network: {},
        security: {},
        logging: {},
        session: {},
        hooks: {},
        ui: {},
      };
      const result = validateConfig(config);
      expect(result.success).toBe(true);
    });

    it('should have configVersion field', () => {
      const result = validateConfig({ configVersion: 1 });
      expect(result.success).toBe(true);
    });

    it('should reject invalid types', () => {
      const config = {
        gateway: {
          port: 'not-a-number',
        },
      };
      const result = validateConfig(config);
      expect(result.success).toBe(false);
    });

    it('getConfigJsonSchema should return object with properties', () => {
      const jsonSchema = getConfigJsonSchema();
      expect(jsonSchema).toBeDefined();
      expect(jsonSchema.properties).toBeDefined();

      // Check for key section properties
      const properties = jsonSchema.properties as Record<string, unknown>;
      expect(properties.env).toBeDefined();
      expect(properties.auth).toBeDefined();
      expect(properties.tools).toBeDefined();
      expect(properties.plugins).toBeDefined();
      expect(properties.browser).toBeDefined();
      expect(properties.voice).toBeDefined();
      expect(properties.media).toBeDefined();
      expect(properties.network).toBeDefined();
      expect(properties.security).toBeDefined();
      expect(properties.logging).toBeDefined();
      expect(properties.session).toBeDefined();
      expect(properties.hooks).toBeDefined();
      expect(properties.ui).toBeDefined();
    });
  });

  describe('Config Sections', () => {
    it('should have 13+ top-level section keys', () => {
      const shape = openRappterConfigSchema.shape;
      const sectionKeys = Object.keys(shape);

      // Check for all expected sections
      expect(sectionKeys).toContain('env');
      expect(sectionKeys).toContain('auth');
      expect(sectionKeys).toContain('tools');
      expect(sectionKeys).toContain('plugins');
      expect(sectionKeys).toContain('browser');
      expect(sectionKeys).toContain('voice');
      expect(sectionKeys).toContain('media');
      expect(sectionKeys).toContain('network');
      expect(sectionKeys).toContain('security');
      expect(sectionKeys).toContain('logging');
      expect(sectionKeys).toContain('session');
      expect(sectionKeys).toContain('hooks');
      expect(sectionKeys).toContain('ui');

      // Should have at least 13 sections
      expect(sectionKeys.length).toBeGreaterThanOrEqual(13);
    });

    it('each section should be optional', () => {
      // Empty object should validate successfully
      const result = validateConfig({});
      expect(result.success).toBe(true);
    });
  });

  describe('JSON Merge Patch (RFC 7396)', () => {
    it('should merge simple objects', () => {
      expect(mergePatch({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should remove keys with null', () => {
      expect(mergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    });

    it('should deep merge nested objects', () => {
      expect(mergePatch({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } });
    });

    it('should replace arrays (not merge them)', () => {
      expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    });

    it('should handle non-object target', () => {
      expect(mergePatch('string', { a: 1 })).toEqual({ a: 1 });
    });

    it('should return patch if patch is non-object', () => {
      expect(mergePatch({ a: 1 }, 'string')).toBe('string');
    });
  });

  describe('Environment Variable Expansion', () => {
    afterEach(() => {
      // Clean up test environment variables
      delete process.env.TEST_VAR;
      delete process.env.NONEXISTENT_VAR;
      delete process.env.DEFINITELY_MISSING_VAR;
    });

    it('should expand env vars', () => {
      process.env.TEST_VAR = 'hello';
      expect(expandEnvVars('${TEST_VAR}')).toBe('hello');
    });

    it('should use defaults', () => {
      expect(expandEnvVars('${NONEXISTENT_VAR:-fallback}')).toBe('fallback');
    });

    it('should return empty for missing vars without defaults', () => {
      expect(expandEnvVars('${DEFINITELY_MISSING_VAR}')).toBe('');
    });

    it('expandEnvDeep should handle objects', () => {
      process.env.TEST_VAR = 'hello';
      const result = expandEnvDeep({ key: '${TEST_VAR}' });
      expect(result).toEqual({ key: 'hello' });
    });

    it('expandEnvDeep should handle arrays', () => {
      process.env.TEST_VAR = 'hello';
      const result = expandEnvDeep(['${TEST_VAR}']);
      expect(result).toEqual(['hello']);
    });

    it('expandEnvDeep should pass through non-strings', () => {
      const input = { num: 42, bool: true };
      const result = expandEnvDeep(input);
      expect(result).toEqual(input);
    });
  });

  describe('Config Migrations', () => {
    it('should migrate from version 1', () => {
      const result = migrateConfig({}, 1);
      expect(result.config.configVersion).toBe(2);
      expect(result.migrationsApplied).toBeGreaterThan(0);
    });

    it('should not migrate if already current', () => {
      const result = migrateConfig({ configVersion: 999 }, 999);
      expect(result.migrationsApplied).toBe(0);
    });

    it('should preserve existing config', () => {
      const result = migrateConfig({ foo: 'bar' }, 1);
      expect(result.config.foo).toBe('bar');
    });
  });
});
