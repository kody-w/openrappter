/**
 * Showcase: Config Hotswap
 *
 * Tests config utilities: parseConfigContent, validateConfig, mergeConfigs,
 * substituteEnvVars, getConfigJsonSchema. Pure function tests, no agents.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { substituteEnvVars, mergeConfigs, parseConfigContent } from '../../config/loader.js';
import { validateConfig, getConfigJsonSchema } from '../../config/schema.js';

describe('Showcase: Config Hotswap', () => {
  describe('JSON5 parsing', () => {
    it('should parse JSON5 with comments and trailing commas', () => {
      const content = `{
        // This is a comment
        "configVersion": 1,
        "gateway": {
          "port": 8080,
          "bind": "loopback",
        },
      }`;
      const parsed = parseConfigContent(content) as Record<string, unknown>;
      expect(parsed.configVersion).toBe(1);
      expect((parsed.gateway as Record<string, unknown>).port).toBe(8080);
    });
  });

  describe('Validation', () => {
    it('should validate correct config', () => {
      const result = validateConfig({
        configVersion: 1,
        gateway: { port: 18790, bind: 'loopback' },
      });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should reject config with invalid gateway bind value', () => {
      const result = validateConfig({
        gateway: { port: 18790, bind: 'invalid_bind_mode' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('Deep merge', () => {
    it('should merge two configs preserving all sections', () => {
      const base = {
        gateway: { port: 8080, bind: 'loopback' as const },
        cron: { enabled: false },
      };
      const override = {
        gateway: { port: 9090, bind: 'all' as const },
        memory: { provider: 'openai' as const, chunkTokens: 256, chunkOverlap: 32 },
      };

      const merged = mergeConfigs(base, override);
      expect(merged.gateway?.port).toBe(9090);
      expect(merged.gateway?.bind).toBe('all');
      expect(merged.cron?.enabled).toBe(false);
      expect(merged.memory?.provider).toBe('openai');
    });
  });

  describe('Environment variable substitution', () => {
    afterEach(() => {
      delete process.env.TEST_PORT;
      delete process.env.TEST_TOKEN;
    });

    it('should substitute ${VAR} with environment value', () => {
      process.env.TEST_PORT = '9090';
      const result = substituteEnvVars('port=${TEST_PORT}');
      expect(result).toBe('port=9090');
    });

    it('should handle missing env vars by replacing with empty string', () => {
      delete process.env.MISSING_VAR;
      const result = substituteEnvVars('token=${MISSING_VAR}');
      expect(result).toBe('token=');
    });
  });

  describe('JSON Schema export', () => {
    it('should include all main config sections', () => {
      const schema = getConfigJsonSchema();
      expect(schema.type).toBe('object');

      const properties = schema.properties as Record<string, unknown>;
      expect(properties.gateway).toBeDefined();
      expect(properties.models).toBeDefined();
      expect(properties.agents).toBeDefined();
      expect(properties.channels).toBeDefined();
      expect(properties.memory).toBeDefined();
      expect(properties.cron).toBeDefined();
    });
  });
});
