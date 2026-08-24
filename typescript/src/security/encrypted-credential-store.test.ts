import {
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedCredentialStore } from './encrypted-credential-store.js';

const roots: string[] = [];
const SECRET = `sk_${'c'.repeat(40)}`;

function createStore() {
  const root = join(process.cwd(), `.elevenlabs-store-${Date.now()}-${roots.length}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
  return {
    root,
    store: new EncryptedCredentialStore({
      filePath: join(root, 'credentials.json'),
      cipher,
      allowInsideRepoForTests: true,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EncryptedCredentialStore', () => {
  it('stores one encrypted copy and exposes only masked verification metadata', () => {
    const { root, store } = createStore();
    store.set('elevenlabs', SECRET, {
      verifiedAt: '2026-08-23T12:00:00.000Z',
      provider: 'elevenlabs',
    });
    expect(store.get('elevenlabs')).toBe(SECRET);
    expect(store.describe('elevenlabs')).toEqual({
      present: true,
      masked: '••••••••',
      verifiedAt: '2026-08-23T12:00:00.000Z',
      provider: 'elevenlabs',
    });
    const serialized = readFileSync(join(root, 'credentials.json'), 'utf8');
    expect(serialized).not.toContain(SECRET);
    expect((serialized.match(/ZW5jcnlwdGVk/g) ?? [])).toHaveLength(1);
  });

  it('deletes the only stored copy', () => {
    const { root, store } = createStore();
    store.set('elevenlabs', SECRET, {
      verifiedAt: '2026-08-23T12:00:00.000Z',
      provider: 'elevenlabs',
    });
    expect(store.delete('elevenlabs')).toBe(true);
    expect(store.get('elevenlabs')).toBeNull();
    expect(readFileSync(join(root, 'credentials.json'), 'utf8')).not.toContain('ZW5jcnlwdGVk');
  });

  it('fails closed when OS encryption is unavailable', () => {
    const { root } = createStore();
    const store = new EncryptedCredentialStore({
      filePath: join(root, 'unavailable.json'),
      cipher: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      allowInsideRepoForTests: true,
    });
    expect(() => store.set('elevenlabs', SECRET, {
      verifiedAt: new Date().toISOString(),
      provider: 'elevenlabs',
    })).toThrow(/secure credential storage is unavailable/i);
  });
});
