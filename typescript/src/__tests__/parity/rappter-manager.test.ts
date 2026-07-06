/**
 * Multi-Rappter Gateway — RappterSoul + RappterManager + RPC methods
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RappterManager, RappterSoul } from '../../gateway/rappter-manager.js';
import type { RappterSoulConfig, SummonResult } from '../../gateway/rappter-manager.js';
import { registerRappterMethods } from '../../gateway/methods/rappter-methods.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Mock agent ──

class MockSoulAgent extends BasicAgent {
  private output: Record<string, unknown>;
  private delay: number;

  constructor(name: string, output: Record<string, unknown>, delay: number = 0) {
    const metadata: AgentMetadata = {
      name,
      description: `Mock agent ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(name, metadata);
    this.output = output;
    this.delay = delay;
  }

  async perform(): Promise<string> {
    if (this.delay > 0) {
      await new Promise((r) => setTimeout(r, this.delay));
    }
    return JSON.stringify({ status: 'success', ...this.output });
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
  agents.set('Alpha', new MockSoulAgent('Alpha', { agent: 'Alpha', data_slush: { source_agent: 'Alpha' } }));
  agents.set('Beta', new MockSoulAgent('Beta', { agent: 'Beta', data_slush: { source_agent: 'Beta' } }));
  agents.set('Gamma', new MockSoulAgent('Gamma', { agent: 'Gamma', data_slush: { source_agent: 'Gamma' } }));
  return agents;
}

function defaultConfig(id: string, overrides?: Partial<RappterSoulConfig>): RappterSoulConfig {
  return {
    id,
    name: `Soul ${id}`,
    description: `Test soul ${id}`,
    emoji: '🧠',
    ...overrides,
  };
}

// ── Tests ──

describe('Multi-Rappter Gateway', () => {
  let manager: RappterManager;
  let agents: Map<string, BasicAgent>;

  beforeEach(() => {
    agents = makeAgents();
    manager = new RappterManager(agents);
  });

  // ── Soul Lifecycle (5 tests) ──

  describe('Soul lifecycle', () => {
    it('loads a soul with default agents', async () => {
      const soul = await manager.loadSoul(defaultConfig('soul-a'));
      expect(soul.id).toBe('soul-a');
      expect(soul.agentCount).toBe(3); // all default agents
      const status = soul.getStatus();
      expect(status.agentNames).toContain('Alpha');
      expect(status.agentNames).toContain('Beta');
      expect(status.agentNames).toContain('Gamma');
    });

    it('loads a soul with custom agent whitelist', async () => {
      const soul = await manager.loadSoul(
        defaultConfig('soul-b', { agents: ['Alpha', 'Beta'] }),
      );
      expect(soul.agentCount).toBe(2);
      const status = soul.getStatus();
      expect(status.agentNames).toContain('Alpha');
      expect(status.agentNames).toContain('Beta');
      expect(status.agentNames).not.toContain('Gamma');
    });

    it('unloads a soul and cleans up', async () => {
      await manager.loadSoul(defaultConfig('soul-c'));
      expect(manager.getSoul('soul-c')).toBeDefined();

      const unloaded = await manager.unloadSoul('soul-c');
      expect(unloaded).toBe(true);
      expect(manager.getSoul('soul-c')).toBeUndefined();

      // Unloading non-existent returns false
      const again = await manager.unloadSoul('soul-c');
      expect(again).toBe(false);
    });

    it('reloads a soul preserving ID, refreshing agents', async () => {
      const original = await manager.loadSoul(defaultConfig('soul-d'));
      const originalLoadedAt = original.loadedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      const reloaded = await manager.reloadSoul('soul-d');
      expect(reloaded.id).toBe('soul-d');
      expect(reloaded.loadedAt).toBeGreaterThanOrEqual(originalLoadedAt);
      expect(reloaded.agentCount).toBe(3);
    });

    it('loading duplicate ID throws error', async () => {
      await manager.loadSoul(defaultConfig('soul-e'));
      await expect(manager.loadSoul(defaultConfig('soul-e'))).rejects.toThrow(
        'Soul already loaded: soul-e',
      );
    });
  });

  // ── Summon Modes (5 tests) ──

  describe('Summon modes', () => {
    beforeEach(async () => {
      await manager.loadSoul(defaultConfig('fast', { emoji: '⚡' }));
      await manager.loadSoul(defaultConfig('slow', { emoji: '🐢' }));
    });

    it('single mode invokes one rappter, returns its result', async () => {
      const result = await manager.summon({
        rappterIds: ['fast'],
        message: 'hello',
        mode: 'single',
      });

      expect(result.mode).toBe('single');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].soulId).toBe('fast');
      expect(result.results[0].error).toBeUndefined();
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);

      const parsed = JSON.parse(result.results[0].result);
      expect(parsed.status).toBe('success');
      expect(parsed.soul).toBe('fast');
    });

    it('all mode invokes multiple rappters in parallel, returns all results', async () => {
      const result = await manager.summon({
        rappterIds: ['fast', 'slow'],
        message: 'parallel query',
        mode: 'all',
      });

      expect(result.mode).toBe('all');
      expect(result.results).toHaveLength(2);
      const ids = result.results.map((r) => r.soulId).sort();
      expect(ids).toEqual(['fast', 'slow']);
      for (const r of result.results) {
        expect(r.error).toBeUndefined();
      }
    });

    it('race mode returns first responder result', async () => {
      // Load souls with agents that have different delays
      const fastAgents = new Map<string, BasicAgent>();
      fastAgents.set('Speedy', new MockSoulAgent('Speedy', { fast: true }, 0));
      const slowAgents = new Map<string, BasicAgent>();
      slowAgents.set('Snail', new MockSoulAgent('Snail', { slow: true }, 50));

      const raceManager = new RappterManager(new Map());
      // Load souls with specific agents
      await raceManager.loadSoul(defaultConfig('racer', { agents: [] }));
      await raceManager.loadSoul(defaultConfig('turtle', { agents: [] }));

      // Use manager with default agents instead
      const result = await manager.summon({
        rappterIds: ['fast', 'slow'],
        message: 'race me',
        mode: 'race',
      });

      expect(result.mode).toBe('race');
      expect(result.winner).toBeDefined();
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    });

    it('chain mode pipes output through sequential rappters', async () => {
      const result = await manager.summon({
        rappterIds: ['fast', 'slow'],
        message: 'start here',
        mode: 'chain',
      });

      expect(result.mode).toBe('chain');
      expect(result.results).toHaveLength(2);
      expect(result.results[0].soulId).toBe('fast');
      expect(result.results[1].soulId).toBe('slow');

      // Second soul's input was first soul's output (chain piping)
      // Both should have completed without errors
      for (const r of result.results) {
        expect(r.error).toBeUndefined();
      }
    });

    it('summon with unknown rappter ID returns error', async () => {
      const result = await manager.summon({
        rappterIds: ['nonexistent'],
        message: 'hello',
        mode: 'single',
      });

      expect(result.error).toContain('Soul(s) not found: nonexistent');
      expect(result.results).toHaveLength(0);
    });
  });

  // ── Manager Operations (3 tests) ──

  describe('Manager operations', () => {
    it('list returns all loaded souls with metadata', async () => {
      await manager.loadSoul(defaultConfig('s1', { emoji: '🔥' }));
      await manager.loadSoul(defaultConfig('s2', { emoji: '❄️' }));

      const list = manager.listSouls();
      expect(list).toHaveLength(2);

      const ids = list.map((s) => s.id).sort();
      expect(ids).toEqual(['s1', 's2']);

      for (const soul of list) {
        expect(soul.name).toBeTruthy();
        expect(soul.description).toBeTruthy();
        expect(soul.agentCount).toBe(3);
      }
    });

    it('status shows invocation count, loadedAt, agent count', async () => {
      const soul = await manager.loadSoul(defaultConfig('stats'));
      expect(soul.invocationCount).toBe(0);
      expect(soul.loadedAt).toBeGreaterThan(0);

      // Invoke twice
      await soul.invoke('first');
      await soul.invoke('second');

      const status = soul.getStatus();
      expect(status.invocationCount).toBe(2);
      expect(status.loadedAt).toBeGreaterThan(0);
      expect(status.agentCount).toBe(3);
      expect(status.id).toBe('stats');
      expect(status.name).toBe('Soul stats');
    });

    it('default soul loads on startup (backward compat)', async () => {
      // Simulate what startGatewayInProcess would do
      const defaultSoul = await manager.loadSoul({
        id: 'default',
        name: 'Default Assistant',
        description: 'Backward-compatible default rappter',
      });

      expect(defaultSoul.id).toBe('default');
      expect(defaultSoul.agentCount).toBe(3);

      // Can be summoned
      const result = await manager.summon({
        rappterIds: ['default'],
        message: 'hi',
        mode: 'single',
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].error).toBeUndefined();
    });
  });

  // ── Soul Agent Filtering (2 tests) ──

  describe('Soul agent filtering', () => {
    it('excludeAgents blacklists specific agents', async () => {
      const soul = await manager.loadSoul(
        defaultConfig('filtered', { excludeAgents: ['Gamma'] }),
      );
      expect(soul.agentCount).toBe(2);
      const status = soul.getStatus();
      expect(status.agentNames).not.toContain('Gamma');
      expect(status.agentNames).toContain('Alpha');
      expect(status.agentNames).toContain('Beta');
    });

    it('whitelist + blacklist: whitelist wins', async () => {
      // Whitelist Alpha + Gamma, blacklist Gamma — Gamma should be removed
      const soul = await manager.loadSoul(
        defaultConfig('mixed', { agents: ['Alpha', 'Gamma'], excludeAgents: ['Gamma'] }),
      );
      expect(soul.agentCount).toBe(1);
      const status = soul.getStatus();
      expect(status.agentNames).toEqual(['Alpha']);
    });
  });

  // ── Soul Identity Injection (4 tests) ──

  describe('Soul identity injection', () => {
    class ContextCaptureAgent extends BasicAgent {
      captured: Array<Record<string, unknown>> = [];

      constructor(name: string) {
        const metadata: AgentMetadata = {
          name,
          description: `Capture agent ${name}`,
          parameters: { type: 'object', properties: {}, required: [] },
        };
        super(name, metadata);
      }

      async perform(): Promise<string> {
        const upstream = this.context?.upstream_slush ?? {};
        this.captured.push(JSON.parse(JSON.stringify(upstream)));
        return JSON.stringify({ status: 'success', agent: this.name });
      }
    }

    it('injects soul_identity into agent context via upstream_slush', async () => {
      const capture = new ContextCaptureAgent('Capture');
      const m = new RappterManager(new Map([['Capture', capture]]));
      await m.loadSoul({
        id: 'persona',
        name: 'Persona',
        description: 'A soul with identity',
        emoji: '🎭',
        systemPrompt: 'You are terse.',
        model: 'claude-sonnet-5',
      });

      await m.summon({ rappterIds: ['persona'], message: 'hi', mode: 'single' });

      expect(capture.captured).toHaveLength(1);
      const identity = capture.captured[0].soul_identity as Record<string, unknown>;
      expect(identity.soul_id).toBe('persona');
      expect(identity.soul_name).toBe('Persona');
      expect(identity.description).toBe('A soul with identity');
      expect(identity.emoji).toBe('🎭');
      expect(identity.system_prompt).toBe('You are terse.');
      expect(identity.model).toBe('claude-sonnet-5');
    });

    it('omits optional identity fields when unset', async () => {
      const capture = new ContextCaptureAgent('Capture');
      const m = new RappterManager(new Map([['Capture', capture]]));
      await m.loadSoul({ id: 'plain', name: 'Plain', description: 'No extras' });

      await m.summon({ rappterIds: ['plain'], message: 'hi', mode: 'single' });

      const identity = capture.captured[0].soul_identity as Record<string, unknown>;
      expect(identity.soul_id).toBe('plain');
      expect(identity.soul_name).toBe('Plain');
      expect('system_prompt' in identity).toBe(false);
      expect('emoji' in identity).toBe(false);
      expect('model' in identity).toBe(false);
    });

    it('each soul in a chain injects its own identity', async () => {
      const capture = new ContextCaptureAgent('Capture');
      const m = new RappterManager(new Map([['Capture', capture]]));
      await m.loadSoul({ id: 'first', name: 'First', description: 'Chain head', systemPrompt: 'Be first.' });
      await m.loadSoul({ id: 'second', name: 'Second', description: 'Chain tail', systemPrompt: 'Be second.' });

      await m.summon({ rappterIds: ['first', 'second'], message: 'go', mode: 'chain' });

      expect(capture.captured).toHaveLength(2);
      const ids = capture.captured.map((c) => (c.soul_identity as Record<string, unknown>).soul_id);
      expect(ids).toEqual(['first', 'second']);
      const prompts = capture.captured.map((c) => (c.soul_identity as Record<string, unknown>).system_prompt);
      expect(prompts).toEqual(['Be first.', 'Be second.']);
    });

    it('parallel summons on shared agent instances see their own soul identity (no context clobbering)', async () => {
      // Souls from the default pool share agent instances. BasicAgent.execute
      // stores context on the instance, so unserialized parallel invokes
      // would let the second soul's context overwrite the first's before
      // its perform() reads it.
      class SlowCaptureAgent extends BasicAgent {
        captured: string[] = [];

        constructor() {
          const metadata: AgentMetadata = {
            name: 'SlowCapture',
            description: 'Sleeps inside perform, then reads soul identity from context',
            parameters: { type: 'object', properties: {}, required: [] },
          };
          super('SlowCapture', metadata);
        }

        async perform(): Promise<string> {
          await new Promise((r) => setTimeout(r, 25));
          const identity = this.context?.upstream_slush?.soul_identity as
            | Record<string, unknown>
            | undefined;
          this.captured.push(String(identity?.soul_id));
          return JSON.stringify({ status: 'success' });
        }
      }

      const shared = new SlowCaptureAgent();
      const m = new RappterManager(new Map([['SlowCapture', shared]]));
      await m.loadSoul({ id: 'soul-a', name: 'A', description: 'First soul' });
      await m.loadSoul({ id: 'soul-b', name: 'B', description: 'Second soul' });

      await m.summon({ rappterIds: ['soul-a', 'soul-b'], message: 'go', mode: 'all' });

      expect(shared.captured.sort()).toEqual(['soul-a', 'soul-b']);
    });

    it('getStatus exposes systemPrompt', async () => {
      const soul = await manager.loadSoul(
        defaultConfig('with-prompt', { systemPrompt: 'You are a pirate.' }),
      );
      expect(soul.getStatus().systemPrompt).toBe('You are a pirate.');

      const bare = await manager.loadSoul(defaultConfig('without-prompt'));
      expect(bare.getStatus().systemPrompt).toBeUndefined();
    });
  });

  // ── Soul-to-Soul Communication (4 tests) ──

  describe('Soul-to-soul communication', () => {
    interface SoulHandle {
      id: string;
      chain: string[];
      summon: (ids: string[], msg: string, mode?: 'single' | 'all' | 'race' | 'chain') => Promise<SummonResult>;
    }

    class SummonerAgent extends BasicAgent {
      private targets: string[];

      constructor(name: string, targets: string[]) {
        const metadata: AgentMetadata = {
          name,
          description: `Summons ${targets.join(',')}`,
          parameters: { type: 'object', properties: {}, required: [] },
        };
        super(name, metadata);
        this.targets = targets;
      }

      async perform(kwargs: Record<string, unknown>): Promise<string> {
        const soul = kwargs._soul as SoulHandle;
        const summonResult = await soul.summon(this.targets, `from ${soul.id}`);
        return JSON.stringify({ status: 'success', summon_result: summonResult });
      }
    }

    class EchoAgent extends BasicAgent {
      constructor() {
        const metadata: AgentMetadata = {
          name: 'Echo',
          description: 'Echoes',
          parameters: { type: 'object', properties: {}, required: [] },
        };
        super('Echo', metadata);
      }

      async perform(kwargs: Record<string, unknown>): Promise<string> {
        return JSON.stringify({ status: 'success', echoed: kwargs.query });
      }
    }

    it('an agent in one soul can summon a sibling soul through the manager', async () => {
      const pool = new Map<string, BasicAgent>([
        ['SummonB', new SummonerAgent('SummonB', ['b'])],
        ['Echo', new EchoAgent()],
      ]);
      const m = new RappterManager(pool);
      await m.loadSoul({ id: 'a', name: 'A', description: 'caller', agents: ['SummonB'] });
      await m.loadSoul({ id: 'b', name: 'B', description: 'callee', agents: ['Echo'] });

      const result = await m.summon({ rappterIds: ['a'], message: 'go', mode: 'single' });
      const outer = JSON.parse(result.results[0].result);
      const nested = outer.agentResults.SummonB.summon_result as SummonResult;
      expect(nested.error).toBeUndefined();
      expect(nested.results[0].soulId).toBe('b');
      const echoed = JSON.parse(nested.results[0].result);
      expect(echoed.agentResults.Echo.echoed).toBe('from a');
    });

    it('blocks summon cycles (a → b → a)', async () => {
      const pool = new Map<string, BasicAgent>([
        ['SummonB', new SummonerAgent('SummonB', ['b'])],
        ['SummonA', new SummonerAgent('SummonA', ['a'])],
      ]);
      const m = new RappterManager(pool);
      await m.loadSoul({ id: 'a', name: 'A', description: 'caller', agents: ['SummonB'] });
      await m.loadSoul({ id: 'b', name: 'B', description: 'bouncer', agents: ['SummonA'] });

      const result = await m.summon({ rappterIds: ['a'], message: 'go', mode: 'single' });
      expect(result.results[0].result).toContain('Summon cycle blocked');
    });

    it('enforces the max summon depth', async () => {
      const pool = new Map<string, BasicAgent>([
        ['SummonB', new SummonerAgent('SummonB', ['b'])],
        ['SummonC', new SummonerAgent('SummonC', ['c'])],
        ['SummonD', new SummonerAgent('SummonD', ['d'])],
        ['Echo', new EchoAgent()],
      ]);
      const m = new RappterManager(pool);
      await m.loadSoul({ id: 'a', name: 'A', description: 'd1', agents: ['SummonB'] });
      await m.loadSoul({ id: 'b', name: 'B', description: 'd2', agents: ['SummonC'] });
      await m.loadSoul({ id: 'c', name: 'C', description: 'd3', agents: ['SummonD'] });
      await m.loadSoul({ id: 'd', name: 'D', description: 'd4', agents: ['Echo'] });

      const result = await m.summon({ rappterIds: ['a'], message: 'go', mode: 'single' });
      expect(result.results[0].result).toContain('Summon depth exceeded');
    });

    it('summon is unavailable for souls loaded without a manager', async () => {
      const soul = await RappterSoul.load(
        { id: 'lone', name: 'Lone', description: 'no manager' },
        { agents: new Map([['SummonB', new SummonerAgent('SummonB', ['b'])]]) },
      );
      const result = await soul.invoke('go');
      expect(result.result).toContain('Soul-to-soul summon unavailable');
    });
  });

  // ── Soul Creation from Natural Language (5 tests) ──

  describe('createSoul', () => {
    it('creates and loads a soul with an inferred name and kebab-case id', async () => {
      const soul = await manager.createSoul('research papers and summarize key findings');
      expect(soul.config.name).toBe('ResearchPapers');
      expect(soul.id).toBe('research-papers');
      expect(manager.getSoul('research-papers')).toBeDefined();
      expect(soul.agentCount).toBe(3); // default pool
    });

    it('explicit name wins over inference', async () => {
      const soul = await manager.createSoul('do many things', { name: 'Ops' });
      expect(soul.config.name).toBe('Ops');
      expect(soul.id).toBe('ops');
    });

    it('derives a systemPrompt so identity injection carries the persona', async () => {
      const soul = await manager.createSoul('triage bugs ruthlessly', { name: 'Triager' });
      expect(soul.config.systemPrompt).toBe('You are Triager. triage bugs ruthlessly');
      expect(soul.identity.system_prompt).toBe('You are Triager. triage bugs ruthlessly');
    });

    it('suffixes the id on collision', async () => {
      const first = await manager.createSoul('watch the deploys', { name: 'Watcher' });
      const second = await manager.createSoul('watch the tests', { name: 'Watcher' });
      expect(first.id).toBe('watcher');
      expect(second.id).toBe('watcher-2');
    });

    it('rejects an empty description', async () => {
      await expect(manager.createSoul('   ')).rejects.toThrow('requires a description');
    });
  });

  // ── RPC Integration (2 tests) ──

  describe('RPC integration', () => {
    it('registers all 13 rappter methods on server', () => {
      const server = new MockServer();
      registerRappterMethods(server, { rappterManager: manager });

      const expectedMethods = [
        'rappter.list',
        'rappter.summon',
        'rappter.create',
        'rappter.load',
        'rappter.unload',
        'rappter.reload',
        'rappter.status',
        'rappter.templates',
        'rappter.load-template',
        'rappter.save',
        'rappter.persisted',
        'rappter.restore',
        'rappter.forget',
      ];
      for (const method of expectedMethods) {
        expect(server.methods.has(method)).toBe(true);
      }
    });

    it('rappter.summon end-to-end with mock souls', async () => {
      await manager.loadSoul(defaultConfig('rpc-soul'));

      const server = new MockServer();
      registerRappterMethods(server, { rappterManager: manager });

      const result = await server.call<unknown, SummonResult>('rappter.summon', {
        rappterIds: ['rpc-soul'],
        message: 'test via RPC',
        mode: 'single',
      });

      expect(result.mode).toBe('single');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].soulId).toBe('rpc-soul');
      expect(result.results[0].error).toBeUndefined();

      const parsed = JSON.parse(result.results[0].result);
      expect(parsed.status).toBe('success');
    });
  });
});
