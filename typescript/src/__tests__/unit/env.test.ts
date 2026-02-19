import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadEnv, saveEnv, loadConfig, saveConfig } from '../../env.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadEnv', () => {
  it('should return empty object for non-existent file', async () => {
    const result = await loadEnv(path.join(tmpDir, 'nope'));
    expect(result).toEqual({});
  });

  it('should parse KEY="value" (double-quoted)', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, 'FOO="bar"\n');
    const result = await loadEnv(file);
    expect(result.FOO).toBe('bar');
  });

  it('should parse KEY=value (unquoted)', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, 'FOO=bar\n');
    const result = await loadEnv(file);
    expect(result.FOO).toBe('bar');
  });

  it("should parse KEY='value' (single-quoted)", async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, "FOO='bar'\n");
    const result = await loadEnv(file);
    expect(result.FOO).toBe('bar');
  });

  it('should skip comments', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, '# comment\nFOO=bar\n');
    const result = await loadEnv(file);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('should skip blank lines', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, '\n\nFOO=bar\n\n');
    const result = await loadEnv(file);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('should handle equals signs in values', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, 'FOO="a=b=c"\n');
    const result = await loadEnv(file);
    expect(result.FOO).toBe('a=b=c');
  });

  it('should return empty object for empty file', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, '');
    const result = await loadEnv(file);
    expect(result).toEqual({});
  });

  it('should parse multiple keys', async () => {
    const file = path.join(tmpDir, '.env');
    await fs.writeFile(file, 'A="1"\nB="2"\nC="3"\n');
    const result = await loadEnv(file);
    expect(result).toEqual({ A: '1', B: '2', C: '3' });
  });
});

describe('saveEnv', () => {
  it('should create parent directories', async () => {
    const file = path.join(tmpDir, 'sub', 'dir', '.env');
    await saveEnv({ FOO: 'bar' }, file);
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
  });

  it('should write correct format', async () => {
    const file = path.join(tmpDir, '.env');
    await saveEnv({ FOO: 'bar', BAZ: 'qux' }, file);
    const content = await fs.readFile(file, 'utf-8');
    expect(content).toContain('FOO="bar"');
    expect(content).toContain('BAZ="qux"');
    expect(content).toContain('# openrappter environment');
  });

  it('should round-trip with loadEnv', async () => {
    const file = path.join(tmpDir, '.env');
    const original = { GITHUB_TOKEN: 'gho_abc123', TELEGRAM_BOT_TOKEN: '123456:ABC-DEF' };
    await saveEnv(original, file);
    const loaded = await loadEnv(file);
    expect(loaded).toEqual(original);
  });

  it('should overwrite existing file', async () => {
    const file = path.join(tmpDir, '.env');
    await saveEnv({ OLD: 'value' }, file);
    await saveEnv({ NEW: 'value' }, file);
    const loaded = await loadEnv(file);
    expect(loaded).toEqual({ NEW: 'value' });
    expect(loaded.OLD).toBeUndefined();
  });

  it('should handle empty env object', async () => {
    const file = path.join(tmpDir, '.env');
    await saveEnv({}, file);
    const loaded = await loadEnv(file);
    expect(loaded).toEqual({});
  });

  it('should verify written content via read-back', async () => {
    const file = path.join(tmpDir, '.env');
    // Normal save should succeed (verification passes)
    await expect(saveEnv({ KEY: 'val' }, file)).resolves.toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('should return empty object for non-existent file', async () => {
    const result = await loadConfig(path.join(tmpDir, 'nope.json'));
    expect(result).toEqual({});
  });

  it('should parse valid JSON', async () => {
    const file = path.join(tmpDir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ setupComplete: true }));
    const result = await loadConfig(file);
    expect(result.setupComplete).toBe(true);
  });
});

describe('saveConfig', () => {
  it('should write JSON and round-trip', async () => {
    const file = path.join(tmpDir, 'config.json');
    const original = { setupComplete: true, onboardedAt: '2025-01-01' };
    await saveConfig(original, file);
    const loaded = await loadConfig(file);
    expect(loaded).toEqual(original);
  });
});
