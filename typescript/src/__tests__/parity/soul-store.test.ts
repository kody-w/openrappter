/**
 * Soul Config Persistence — SoulStore + RappterManager integration + RPC methods
 *
 * Roadmap 1.2: save/load soul configs from ~/.openrappter/souls/*.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SoulStore } from '../../gateway/soul-store.js';
import { RappterManager } from '../../gateway/rappter-manager.js';
import type { RappterSoulConfig } from '../../gateway/rappter-manager.js';
import { registerRappterMethods } from '../../gateway/methods/rappter-methods.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Mock agent ──

class MockSoulAgent extends BasicAgent {
  constructor(name: string) {
    const metadata: AgentMetadata = {
      name,
      description: `Mock agent ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
  }

  async perform(): Promise<string> {
    return JSON.stringify({ status: 'success', agent: this.name });
  }
}

// ── Mock server for RPC tests ──

type Handler = (params: unknown, connection: unknown) => Promise<unknown>;

class MockServer {
  methods: Map<string, Handler> = new Map();

  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
  ): void {
    this.methods.set(name, handler as Handler);
  }

  async call<P, R>(name: string, params?: P): Promise<R> {
    const handler = this.methods.get(name);
    if (!handler) throw new Error(`Method not found: ${name}`);
    return handler(params, null) as Promise<R>;
  }
}

// ── Helpers ──

function makeAgents(): Map<string, BasicAgent> {
  const agents = new Map<string, BasicAgent>();
  agents.set('Alpha', new MockSoulAgent('Alpha'));
  agents.set('Beta', new MockSoulAgent('Beta'));
  return agents;
}

function soulConfig(id: string, overrides?: Partial<RappterSoulConfig>): RappterSoulConfig {
  return {
    id,
    name: `Soul ${id}`,
    description: `Test soul ${id}`,
    emoji: '💾',
    ...overrides,
  };
}

// ── Tests ──

describe('Soul Config Persistence', () => {
  let soulsDir: string;
  let store: SoulStore;

  beforeEach(async () => {
    soulsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-souls-'));
    store = new SoulStore(soulsDir);
  });

  afterEach(async () => {
    await fs.rm(soulsDir, { recursive: true, force: true });
  });

  // ── SoulStore basics ──

  describe('SoulStore', () => {
    it('save writes <id>.json and returns the file path', async () => {
      const filePath = await store.save(soulConfig('researcher'));
      expect(filePath).toBe(path.join(soulsDir, 'researcher.json'));

      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.id).toBe('researcher');
      expect(parsed.name).toBe('Soul researcher');
    });

    it('load round-trips a saved config', async () => {
      const config = soulConfig('coder', {
        agents: ['Alpha'],
        excludeAgents: ['Beta'],
        model: 'claude-sonnet-5',
        systemPrompt: 'You are a coder.',
      });
      await store.save(config);

      const loaded = await store.load('coder');
      expect(loaded).toEqual(config);
    });

    it('load returns undefined for a missing id', async () => {
      const loaded = await store.load('does-not-exist');
      expect(loaded).toBeUndefined();
    });

    it('list returns all saved configs', async () => {
      await store.save(soulConfig('s1'));
      await store.save(soulConfig('s2'));
      await store.save(soulConfig('s3'));

      const configs = await store.list();
      expect(configs).toHaveLength(3);
      expect(configs.map((c) => c.id).sort()).toEqual(['s1', 's2', 's3']);
    });

    it('list returns empty array when the souls dir does not exist', async () => {
      const missing = new SoulStore(path.join(soulsDir, 'never-created'));
      const configs = await missing.list();
      expect(configs).toEqual([]);
    });

    it('list skips corrupt and invalid files', async () => {
      await store.save(soulConfig('good'));
      await fs.writeFile(path.join(soulsDir, 'corrupt.json'), '{not json!!', 'utf-8');
      await fs.writeFile(path.join(soulsDir, 'invalid.json'), JSON.stringify({ id: 'invalid' }), 'utf-8');
      await fs.writeFile(path.join(soulsDir, 'notes.txt'), 'not a soul', 'utf-8');

      const configs = await store.list();
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe('good');
    });

    it('remove deletes the file and returns true; false when missing', async () => {
      await store.save(soulConfig('temp'));
      expect(await store.remove('temp')).toBe(true);
      expect(await store.load('temp')).toBeUndefined();
      expect(await store.remove('temp')).toBe(false);
    });

    it('save rejects ids that are unsafe as filenames', async () => {
      await expect(store.save(soulConfig('../evil'))).rejects.toThrow(/Invalid soul id/);
      await expect(store.save(soulConfig('a/b'))).rejects.toThrow(/Invalid soul id/);
      await expect(store.save(soulConfig(''))).rejects.toThrow(/Invalid soul id/);
    });

    it('load treats unsafe ids as not found instead of touching the filesystem', async () => {
      expect(await store.load('../../etc/passwd')).toBeUndefined();
      expect(await store.remove('../../etc/passwd')).toBe(false);
    });

    it('save requires id, name, and description', async () => {
      await expect(
        store.save({ id: 'x', name: '', description: 'd' } as RappterSoulConfig),
      ).rejects.toThrow(/name/);
      await expect(
        store.save({ id: 'x', name: 'n', description: '' } as RappterSoulConfig),
      ).rejects.toThrow(/description/);
    });
  });

  // ── RappterManager integration ──

  describe('RappterManager persistence integration', () => {
    let manager: RappterManager;

    beforeEach(() => {
      manager = new RappterManager(makeAgents(), store);
    });

    it('saveSoul persists a loaded soul config to disk', async () => {
      await manager.loadSoul(soulConfig('persist-me', { agents: ['Alpha'] }));
      const filePath = await manager.saveSoul('persist-me');

      const loaded = await store.load('persist-me');
      expect(filePath).toContain('persist-me.json');
      expect(loaded?.id).toBe('persist-me');
      expect(loaded?.agents).toEqual(['Alpha']);
    });

    it('saveSoul throws for an unloaded soul', async () => {
      await expect(manager.saveSoul('ghost')).rejects.toThrow('Soul not found: ghost');
    });

    it('loadSoul with persist option auto-saves the config', async () => {
      await manager.loadSoul(soulConfig('auto-saved'), { persist: true });
      const loaded = await store.load('auto-saved');
      expect(loaded?.id).toBe('auto-saved');
    });

    it('restoreSouls loads every persisted config', async () => {
      await store.save(soulConfig('r1'));
      await store.save(soulConfig('r2'));

      const result = await manager.restoreSouls();
      expect(result.restored.sort()).toEqual(['r1', 'r2']);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(manager.getSoul('r1')).toBeDefined();
      expect(manager.getSoul('r2')).toBeDefined();
    });

    it('restoreSouls skips souls that are already loaded', async () => {
      await store.save(soulConfig('already'));
      await manager.loadSoul(soulConfig('already'));

      const result = await manager.restoreSouls();
      expect(result.restored).toEqual([]);
      expect(result.skipped).toEqual(['already']);
    });

    it('restored souls are summonable', async () => {
      await store.save(soulConfig('summon-me'));
      await manager.restoreSouls();

      const result = await manager.summon({
        rappterIds: ['summon-me'],
        message: 'hello from the vault',
        mode: 'single',
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].error).toBeUndefined();
    });

    it('deleteSavedSoul removes the persisted config but keeps the loaded soul', async () => {
      await manager.loadSoul(soulConfig('forget-me'), { persist: true });
      expect(await store.load('forget-me')).toBeDefined();

      const forgotten = await manager.deleteSavedSoul('forget-me');
      expect(forgotten).toBe(true);
      expect(await store.load('forget-me')).toBeUndefined();
      expect(manager.getSoul('forget-me')).toBeDefined();
    });

    it('listSavedSouls returns configs on disk', async () => {
      await store.save(soulConfig('on-disk'));
      const configs = await manager.listSavedSouls();
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe('on-disk');
    });

    it('saveSoulConfig persists a raw config without loading it', async () => {
      await manager.saveSoulConfig(soulConfig('raw-config'));
      expect(await store.load('raw-config')).toBeDefined();
      expect(manager.getSoul('raw-config')).toBeUndefined();
    });

    it('saveSoulConfig rejects path-traversal ids', async () => {
      await expect(manager.saveSoulConfig(soulConfig('../../evil'))).rejects.toThrow(/Invalid soul id/);
    });

    it('loadSavedSouls returns the restored souls', async () => {
      await store.save(soulConfig('lss-1'));
      await store.save(soulConfig('lss-2'));
      const loaded = await manager.loadSavedSouls();
      expect(loaded.map((s) => s.id).sort()).toEqual(['lss-1', 'lss-2']);
    });
  });

  // ── RPC integration ──

  describe('RPC persistence methods', () => {
    let manager: RappterManager;
    let server: MockServer;

    beforeEach(() => {
      manager = new RappterManager(makeAgents(), store);
      server = new MockServer();
      registerRappterMethods(server, { rappterManager: manager });
    });

    it('registers the persistence methods', () => {
      for (const method of ['rappter.save', 'rappter.restore', 'rappter.persisted', 'rappter.forget']) {
        expect(server.methods.has(method)).toBe(true);
      }
    });

    it('rappter.save persists a loaded soul', async () => {
      await manager.loadSoul(soulConfig('rpc-save'));
      const result = await server.call<unknown, { saved: boolean; path: string }>('rappter.save', {
        rappterId: 'rpc-save',
      });
      expect(result.saved).toBe(true);
      expect(result.path).toContain('rpc-save.json');
      expect(await store.load('rpc-save')).toBeDefined();
    });

    it('rappter.persisted lists configs on disk', async () => {
      await store.save(soulConfig('rpc-listed'));
      const result = await server.call<unknown, { configs: RappterSoulConfig[] }>('rappter.persisted');
      expect(result.configs).toHaveLength(1);
      expect(result.configs[0].id).toBe('rpc-listed');
    });

    it('rappter.restore loads persisted souls into the manager', async () => {
      await store.save(soulConfig('rpc-restored'));
      const result = await server.call<unknown, { restored: string[]; skipped: string[] }>('rappter.restore');
      expect(result.restored).toEqual(['rpc-restored']);
      expect(manager.getSoul('rpc-restored')).toBeDefined();
    });

    it('rappter.forget removes a persisted config', async () => {
      await store.save(soulConfig('rpc-forgotten'));
      const result = await server.call<unknown, { forgotten: boolean }>('rappter.forget', {
        rappterId: 'rpc-forgotten',
      });
      expect(result.forgotten).toBe(true);
      expect(await store.load('rpc-forgotten')).toBeUndefined();
    });

    it('rappter.load with persist flag saves to disk', async () => {
      await server.call('rappter.load', { config: soulConfig('rpc-load-persist'), persist: true });
      expect(await store.load('rpc-load-persist')).toBeDefined();
    });

    it('rappter.create builds a soul from a description and persists it', async () => {
      const result = await server.call<unknown, { soul: { id: string; name: string } }>('rappter.create', {
        description: 'summarize weekly metrics into a report',
        persist: true,
      });
      expect(result.soul.name).toBe('SummarizeWeekly');
      expect(result.soul.id).toBe('summarize-weekly');
      const persisted = await store.load('summarize-weekly');
      expect(persisted?.systemPrompt).toContain('You are SummarizeWeekly.');
    });
  });
});
