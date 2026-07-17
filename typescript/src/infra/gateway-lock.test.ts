import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  isGatewayRunning,
  releaseLock,
} from './gateway-lock.js';

const roots: string[] = [];

function lockPath(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.gateway-lock-test-'));
  roots.push(root);
  return path.join(root, 'private', 'gateway.pid');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('gateway lock', () => {
  it('creates an exclusive private lock and rejects a live owner', () => {
    const filePath = lockPath();
    expect(acquireLock({
      filePath,
      pid: 101,
    })).toBe(true);
    expect(acquireLock({
      filePath,
      pid: 202,
    })).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('101\n');
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('reclaims stale and malformed locks without deleting another owner', () => {
    const filePath = lockPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not-a-lock');

    expect(isGatewayRunning({
      filePath,
    })).toBe(false);
    expect(acquireLock({
      filePath,
      pid: 303,
    })).toBe(true);

    releaseLock({ filePath, pid: 404 });
    expect(fs.existsSync(filePath)).toBe(true);
    releaseLock({ filePath, pid: 303 });
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
