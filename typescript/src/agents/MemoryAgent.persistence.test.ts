import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { MemoryAgent } from './MemoryAgent.js';

let home: string;
let file: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.OPENRAPPTER_HOME!, 'memory-store-'));
  file = path.join(home, 'memory.json');
  fs.writeFileSync(file, '{}');
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(home, { recursive: true, force: true });
});

function stored(): Record<string, { message: string }> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('MemoryAgent durable persistence', () => {
  it.each([false, true])('preserves simultaneous writes (separate instances: %s)', async (separate) => {
    const agent = new MemoryAgent(home);
    let tick = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++tick);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (separate ? new MemoryAgent(home) : agent).perform({
        action: 'remember',
        message: `fact-${String(index).padStart(3, '0')}`,
      }).then(JSON.parse),
    ));
    expect(responses.every(result => result.status === 'success')).toBe(true);
    expect(responses.every(result => /^mem_\d+$/.test(result.key))).toBe(true);
    expect(new Set(responses.map(result => result.key)).size).toBe(12);
    expect(Object.values(stored()).map(entry => entry.message).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `fact-${String(index).padStart(3, '0')}`),
    );
  });

  it('does not overwrite facts recorded in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const agent = new MemoryAgent(home);
    await agent.perform({ action: 'remember', message: 'first fact' });
    await agent.perform({ action: 'remember', message: 'second fact' });
    expect(Object.values(stored()).map(entry => entry.message).sort()).toEqual(['first fact', 'second fact']);
  });

  it('fails rather than overwriting a fact when the random id source collides repeatedly', async () => {
    const agent = new MemoryAgent(home);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-1111-1111-111111111111');
    syncBuiltinESMExports();
    await agent.perform({ action: 'remember', message: 'first fact' });
    const before = fs.readFileSync(file);
    await expect(agent.perform({ action: 'remember', message: 'second fact' }))
      .rejects.toThrow('unique memory id');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('deduplicates within the transaction, not before acquiring the lock', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      new MemoryAgent(home).perform({ action: 'remember', message: 'one fact' }).then(JSON.parse),
    ));
    expect(responses.filter(result => result.duplicate).length).toBe(7);
    expect(Object.keys(stored())).toHaveLength(1);
  });

  it.each(['{broken', 'null', '[]', '{"broken":42}', '{"broken":{"message":42}}'])(
    'fails closed without replacing an invalid store: %s',
    async content => {
      fs.writeFileSync(file, content);
      await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'new fact' }))
        .rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    },
  );

  it('rejects invalid UTF-8 instead of acknowledging replacement characters', async () => {
    const content = Buffer.concat([Buffer.from('{"legacy":{"message":"'), Buffer.from([0xff]), Buffer.from('"}}')]);
    fs.writeFileSync(file, content);
    await expect(new MemoryAgent(home).perform({ action: 'remember', message: 'new fact' }))
      .rejects.toThrow('not valid JSON');
    expect(fs.readFileSync(file)).toEqual(content);
  });

  it('preserves legacy keys and unknown per-entry metadata', async () => {
    const legacy = {
      id: 'old-id', message: 'legacy fact', theme: 'fact', date: '2026-01-01',
      trust: { custodians: ['principal:local-owner'], grants: [] },
      custom: { nested: [1, 2, 3] },
    };
    fs.writeFileSync(file, JSON.stringify({ 'mem_123': legacy }));
    const agent = new MemoryAgent(home);
    await agent.perform({ action: 'remember', message: 'new fact' });
    expect(stored().mem_123).toEqual(legacy);
    const result = JSON.parse(await agent.perform({ action: 'forget', query: 'mem_123' }));
    expect(result.deleted).toEqual(['mem_123']);
    expect(Object.values(stored()).map(entry => entry.message)).toEqual(['new fact']);
  });

  it('does not hide a corrupt store from the static context reader', async () => {
    const original = process.env.OPENRAPPTER_HOME;
    process.env.OPENRAPPTER_HOME = home;
    fs.writeFileSync(file, '{broken');
    try {
      await expect(MemoryAgent.loadAllMemories()).rejects.toThrow('not valid JSON');
    } finally {
      process.env.OPENRAPPTER_HOME = original;
    }
  });
});
