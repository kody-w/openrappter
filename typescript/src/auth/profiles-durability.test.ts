import * as fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthProfileStore,
  type AuthProfileStoreFs,
} from './profiles.js';

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(
    path.join(process.cwd(), '.profile-durability-test-'),
  );
  roots.push(directory);
  return directory;
}

function profile(id: string, token: string, isDefault: boolean) {
  return {
    id,
    provider: 'copilot',
    type: 'device-code' as const,
    token,
    default: isDefault,
  };
}

function injected(
  overrides: Partial<AuthProfileStoreFs>,
): AuthProfileStoreFs {
  return { ...fs, ...overrides };
}

function artifacts(directory: string): string[] {
  return fs.readdirSync(directory).filter((entry) =>
    /\.(?:tmp|rollback|bak)$/.test(entry)
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('AuthProfileStore durability', () => {
  it('propagates write failure and retains the prior in-memory and disk state', () => {
    const directory = root();
    const original = new AuthProfileStore(directory);
    original.add(profile('first', 'first-token', true));
    const store = new AuthProfileStore(directory, injected({
      writeFileSync: vi.fn(() => {
        throw new Error('injected write failure');
      }) as typeof fs.writeFileSync,
    }));

    expect(() => store.add(profile('second', 'second-token', false)))
      .toThrow('Auth profile store write failed.');
    expect(store.list('copilot').map((entry) => entry.id)).toEqual(['first']);
    expect(new AuthProfileStore(directory).list('copilot').map((entry) => entry.id))
      .toEqual(['first']);
    expect(artifacts(directory)).toEqual([]);
  });

  it('propagates rename failure and a deleted profile cannot resurrect', () => {
    const directory = root();
    const original = new AuthProfileStore(directory);
    original.add(profile('first', 'first-token', true));
    const store = new AuthProfileStore(directory, injected({
      renameSync: vi.fn(() => {
        throw new Error('injected rename failure');
      }),
    }));

    expect(() => store.remove('copilot', 'first'))
      .toThrow('Auth profile store write failed.');
    expect(store.get('copilot')?.id).toBe('first');
    expect(new AuthProfileStore(directory).get('copilot')?.id).toBe('first');
    expect(artifacts(directory)).toEqual([]);

    expect(original.remove('copilot', 'first')).toBe(true);
    expect(new AuthProfileStore(directory).list('copilot')).toEqual([]);
  });

  it('rolls back a parent fsync failure without changing the default', () => {
    const directory = root();
    const original = new AuthProfileStore(directory);
    original.add(profile('first', 'first-token', true));
    original.add(profile('second', 'second-token', false));
    let syncs = 0;
    const store = new AuthProfileStore(directory, injected({
      fsyncSync: vi.fn((descriptor: number) => {
        syncs += 1;
        if (syncs === 2) throw new Error('injected parent fsync failure');
        fs.fsyncSync(descriptor);
      }),
    }));

    expect(() => store.setDefault('copilot', 'second'))
      .toThrow('Auth profile store write failed.');
    expect(store.get('copilot')?.id).toBe('first');
    expect(new AuthProfileStore(directory).get('copilot')?.id).toBe('first');
    expect(artifacts(directory)).toEqual([]);
  });
});
