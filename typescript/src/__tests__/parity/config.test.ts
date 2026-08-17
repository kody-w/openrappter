/**
 * Config System Parity Tests
 *
 * Exercises the real config loader and schema (src/config/loader.ts,
 * src/config/schema.ts). The previous version of this file built literal config
 * objects and asserted on their own shape — e.g. "should reject invalid config
 * values" built an array of `{ port, error }` literals and only checked that the
 * `error` strings it had just written were defined, never calling the validator.
 * It also encoded claims that are wrong for the real schema (gateway.auth.mode
 * has no 'token' option; chunkTokens has no positivity constraint). These tests
 * call the real validateConfig / mergeConfigs / substituteEnvVars /
 * parseConfigContent.
 *
 * config-system.test.ts covers mergePatch / expandEnvVars / migrateConfig; this
 * file covers the loader.ts helpers and the Zod range/enum constraints.
 */

import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../config/schema.js';
import { mergeConfigs, substituteEnvVars, parseConfigContent } from '../../config/loader.js';
import type { OpenRappterConfig, GatewayConfig } from '../../config/types.js';

describe('Config System Parity', () => {
  describe('Schema validation (validateConfig)', () => {
    it('accepts an empty config', () => {
      expect(validateConfig({}).success).toBe(true);
    });

    it('accepts a valid gateway config', () => {
      const result = validateConfig({ gateway: { port: 18790, bind: 'loopback' } });
      expect(result.success).toBe(true);
      expect(result.data?.gateway?.port).toBe(18790);
    });

    it('rejects a gateway port below the valid range', () => {
      expect(validateConfig({ gateway: { port: -1 } }).success).toBe(false);
    });

    it('rejects a gateway port above 65535', () => {
      expect(validateConfig({ gateway: { port: 99999 } }).success).toBe(false);
    });

    it('rejects a non-integer gateway port', () => {
      expect(validateConfig({ gateway: { port: 18790.5 } }).success).toBe(false);
    });

    it('rejects an unknown gateway bind value', () => {
      expect(validateConfig({ gateway: { bind: 'everywhere' } }).success).toBe(false);
    });

    it('rejects an unknown model provider', () => {
      const result = validateConfig({
        models: [{ id: 'm', provider: 'not-a-provider', model: 'x', auth: { type: 'api-key' } }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts a valid model provider', () => {
      const result = validateConfig({
        models: [{ id: 'm', provider: 'anthropic', model: 'claude', auth: { type: 'api-key' } }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Config merging (mergeConfigs)', () => {
    it('lets a later config override earlier gateway fields while preserving the rest', () => {
      const defaults: Partial<OpenRappterConfig> = { gateway: { port: 18790, bind: 'loopback' } };
      const user: Partial<OpenRappterConfig> = { gateway: { port: 9999 } as GatewayConfig };

      const merged = mergeConfigs(defaults, user);
      expect(merged.gateway?.port).toBe(9999);
      expect(merged.gateway?.bind).toBe('loopback');
    });

    it('concatenates model lists across configs', () => {
      const merged = mergeConfigs(
        { models: [{ id: 'a', provider: 'anthropic', model: 'claude', auth: { type: 'api-key' } }] },
        { models: [{ id: 'b', provider: 'openai', model: 'gpt', auth: { type: 'api-key' } }] }
      );
      expect(merged.models?.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });

  describe('Environment variable substitution (substituteEnvVars)', () => {
    it('substitutes a defined ${VAR}', () => {
      const key = 'OPENRAPPTER_PARITY_TEST_VAR';
      process.env[key] = 'super-secret';
      try {
        expect(substituteEnvVars(`token-\${${key}}`)).toBe('token-super-secret');
      } finally {
        delete process.env[key];
      }
    });

    it('substitutes an undefined ${VAR} with an empty string', () => {
      const key = 'OPENRAPPTER_PARITY_UNSET_VAR';
      delete process.env[key];
      expect(substituteEnvVars(`x-\${${key}}-y`)).toBe('x--y');
    });
  });

  describe('JSON5 parsing (parseConfigContent)', () => {
    it('parses JSON5 with comments and trailing commas', () => {
      const parsed = parseConfigContent(`{
        // gateway settings
        gateway: {
          port: 18790,
        },
      }`) as { gateway: { port: number } };

      expect(parsed.gateway.port).toBe(18790);
    });

    it('throws on malformed content instead of returning a partial object', () => {
      expect(() => parseConfigContent('{ not valid : : }')).toThrow();
    });
  });
});
