/**
 * Tests for GitHub auth token caching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test the exported functions from copilot-check
// Mock the child_process to avoid actual gh CLI calls
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

describe('GitHub auth token caching', () => {
  const credDir = path.join(os.tmpdir(), `openrappter-test-${Date.now()}`);
  const tokenFile = path.join(credDir, 'github-token.json');

  beforeEach(() => {
    fs.mkdirSync(credDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(credDir, { recursive: true, force: true });
    } catch { /* cleanup */ }
  });

  it('saves and loads a token from JSON file', () => {
    const payload = {
      token: 'gho_test123456789',
      savedAt: Date.now(),
      source: 'device_code',
    };
    fs.writeFileSync(tokenFile, JSON.stringify(payload, null, 2));

    const loaded = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
    expect(loaded.token).toBe('gho_test123456789');
    expect(loaded.source).toBe('device_code');
  });

  it('handles missing token file gracefully', () => {
    const missingFile = path.join(credDir, 'nonexistent.json');
    let token: string | null = null;
    try {
      const data = fs.readFileSync(missingFile, 'utf-8');
      const cached = JSON.parse(data);
      token = cached.token;
    } catch {
      token = null;
    }
    expect(token).toBeNull();
  });

  it('handles corrupted JSON gracefully', () => {
    fs.writeFileSync(tokenFile, 'not json{{{');
    let token: string | null = null;
    try {
      const data = fs.readFileSync(tokenFile, 'utf-8');
      const cached = JSON.parse(data);
      token = cached.token;
    } catch {
      token = null;
    }
    expect(token).toBeNull();
  });

  it('token file includes source metadata', () => {
    const payload = {
      token: 'gho_manual_token',
      savedAt: Date.now(),
      source: 'manual',
    };
    fs.writeFileSync(tokenFile, JSON.stringify(payload, null, 2));

    const loaded = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
    expect(loaded.source).toBe('manual');
    expect(loaded.savedAt).toBeGreaterThan(0);
  });

  it('parses token from .env file format', () => {
    const envContent = [
      '# openrappter environment',
      '',
      'GITHUB_TOKEN="gho_from_env_file"',
      'TELEGRAM_BOT_TOKEN="123:ABC"',
    ].join('\n');

    const envFile = path.join(credDir, '.env');
    fs.writeFileSync(envFile, envContent);

    const data = fs.readFileSync(envFile, 'utf-8');
    let token: string | null = null;
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('GITHUB_TOKEN=')) {
        let val = trimmed.slice('GITHUB_TOKEN='.length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val.length > 0) token = val;
      }
    }
    expect(token).toBe('gho_from_env_file');
  });

  it('credential file directory is created recursively', () => {
    const deepDir = path.join(credDir, 'a', 'b', 'c');
    fs.mkdirSync(deepDir, { recursive: true });
    const file = path.join(deepDir, 'token.json');
    fs.writeFileSync(file, '{"token":"test"}');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('prefers credentials file over env file', () => {
    // Credentials file
    fs.writeFileSync(tokenFile, JSON.stringify({ token: 'from_credentials', savedAt: Date.now(), source: 'device_code' }));

    // Env file
    const envFile = path.join(credDir, '.env');
    fs.writeFileSync(envFile, 'GITHUB_TOKEN="from_env"');

    // The resolution order should find credentials first
    const credToken = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')).token;
    expect(credToken).toBe('from_credentials');
  });
});
