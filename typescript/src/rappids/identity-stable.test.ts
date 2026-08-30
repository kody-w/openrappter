import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadOrCreateStableRappid,
  rappidHex,
  stableRappidTailPath,
} from './identity.js';

const SCRATCH_ROOT = join(process.cwd(), '.test-scratch');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function identityDirectory(label: string): string {
  const directory = join(
    SCRATCH_ROOT,
    `stable-rappid-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  roots.push(directory);
  return directory;
}

describe('persisted stable RAPPID', () => {
  it('keeps the same logical RAPPID across restart fixtures', () => {
    const directory = identityDirectory('restart');
    const first = loadOrCreateStableRappid({
      directory,
      owner: 'openrappter',
      name: 'scout',
      tailFactory: () => 'a'.repeat(64),
    });
    const remint = vi.fn(() => 'b'.repeat(64));
    const afterRestart = loadOrCreateStableRappid({
      directory,
      owner: 'openrappter',
      name: 'scout',
      tailFactory: remint,
    });

    expect(afterRestart).toBe(first);
    expect(remint).not.toHaveBeenCalled();
  });

  it('preserves an existing canonical tail rather than replacing it', () => {
    const directory = identityDirectory('existing');
    mkdirSync(directory, { recursive: true });
    writeFileSync(stableRappidTailPath(directory), `${'c'.repeat(64)}\n`);

    const rappid = loadOrCreateStableRappid({
      directory,
      owner: 'openrappter',
      name: 'alpha',
      tailFactory: () => 'd'.repeat(64),
    });

    expect(rappid).toBe(
      `rappid:@openrappter/alpha:${rappidHex('c'.repeat(64))}`,
    );
  });

  it('gives separate logical twins separate stable identities', () => {
    const scout = loadOrCreateStableRappid({
      directory: identityDirectory('scout'),
      name: 'scout',
      tailFactory: () => 'a'.repeat(64),
    });
    const courier = loadOrCreateStableRappid({
      directory: identityDirectory('courier'),
      name: 'courier',
      tailFactory: () => 'b'.repeat(64),
    });

    expect(scout).not.toBe(courier);
  });

  it('refuses a corrupt persisted tail instead of silently changing identity', () => {
    const directory = identityDirectory('corrupt');
    mkdirSync(directory, { recursive: true });
    writeFileSync(stableRappidTailPath(directory), 'not-a-tail\n');

    expect(() => loadOrCreateStableRappid({ directory, name: 'alpha' }))
      .toThrow(/persisted RAPPID tail is invalid/i);
  });
});
