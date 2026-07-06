/**
 * Multi-Rappter Gateway: Hot-Loadable Souls on a Single Brainstem
 *
 * The gateway server acts as a brainstem (always-running single endpoint)
 * that can summon one or more rappter souls per request. Each soul is a
 * hot-loadable configuration (agents + identity + config) that gets loaded
 * on demand. Multiple rappters can be summoned together on a single request
 * (parallel, race, or chain).
 */

import type { BasicAgent } from '../agents/BasicAgent.js';
import {
  type SoulTemplate,
  getTemplate,
  listTemplates,
  templateToConfig,
} from './soul-templates/index.js';
import { SoulStore } from './soul-store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RappterSoulConfig {
  /** Unique identifier for this soul */
  id: string;
  /** Display name */
  name: string;
  /** What this rappter does */
  description: string;
  /** Personality emoji */
  emoji?: string;
  /** Custom agents directory (hot-loaded) */
  agentsDir?: string;
  /** Whitelist of agent names to include from default pool */
  agents?: string[];
  /** Blacklist agents from default set */
  excludeAgents?: string[];
  /** Model override */
  model?: string;
  /** Personality/identity override */
  systemPrompt?: string;
}

export interface RappterSoulStatus {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  agentCount: number;
  agentNames: string[];
  loadedAt: number;
  invocationCount: number;
  model?: string;
  systemPrompt?: string;
}

/**
 * Identity payload injected into every agent invocation via data sloshing.
 * Agents read it from context: getSignal is per-slosh, so use
 * `this.context.upstream_slush.soul_identity` (snake_case keys).
 */
export interface SoulIdentity {
  soul_id: string;
  soul_name: string;
  description: string;
  emoji?: string;
  system_prompt?: string;
  model?: string;
}

export interface RappterSoulInfo {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  agentCount: number;
}

export interface RappterInvokeResult {
  soulId: string;
  soulName: string;
  result: string;
  durationMs: number;
  error?: string;
}

export interface SummonParams {
  /** Which souls to summon */
  rappterIds: string[];
  /** The message/query */
  message: string;
  /** Invocation mode */
  mode: 'single' | 'all' | 'race' | 'chain';
  /** Optional session ID */
  sessionId?: string;
}

export interface SummonResult {
  mode: 'single' | 'all' | 'race' | 'chain';
  results: RappterInvokeResult[];
  totalDurationMs: number;
  /** For race mode: which soul responded first */
  winner?: string;
  error?: string;
}

export interface RestoreSoulsResult {
  /** Soul IDs loaded from persisted configs */
  restored: string[];
  /** Soul IDs skipped because they were already loaded */
  skipped: string[];
  /** Configs that failed to load */
  errors: Array<{ id: string; error: string }>;
}

// ── Soul creation from natural language ─────────────────────────────────────

const SOUL_NAME_STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'agent', 'create', 'make', 'want', 'should',
  'would', 'could', 'the', 'and', 'for', 'to', 'of', 'in', 'on', 'be', 'is',
  'are', 'was', 'has', 'have', 'will', 'can', 'you', 'your', 'my', 'me', 'we',
  'our', 'us', 'about', 'like', 'into', 'when', 'then', 'them', 'they',
]);

/** Infer a CamelCase soul name from a description (LearnNewAgent naming convention). */
export function inferSoulName(description: string): string {
  const words = description.toLowerCase().match(/[a-z]+/g) ?? [];
  const keywords = words.filter(w => w.length > 3 && !SOUL_NAME_STOP_WORDS.has(w)).slice(0, 2);
  if (keywords.length === 0) return 'CustomSoul';
  return keywords.map(w => w[0].toUpperCase() + w.slice(1)).join('');
}

// ── Shared-agent serialization ──────────────────────────────────────────────
//
// Souls built from the default pool share agent instances, and
// BasicAgent.execute() stores per-invocation context on the instance.
// Parallel summons (all/race) would let one soul's context overwrite
// another's mid-invocation, so executions are serialized per instance.
// Distinct agents still run fully in parallel.

const agentLocks = new WeakMap<BasicAgent, Promise<unknown>>();

async function withAgentLock<T>(agent: BasicAgent, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(agent) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  agentLocks.set(agent, next.then(() => undefined, () => undefined));
  return next;
}

// ── RappterSoul ──────────────────────────────────────────────────────────────

/** Callback a soul uses to summon sibling souls through its manager. */
export type SoulSummoner = (params: SummonParams, chain: string[]) => Promise<SummonResult>;

/** Maximum soul-to-soul summon nesting (root invoke = depth 1). */
export const MAX_SOUL_SUMMON_DEPTH = 3;

export class RappterSoul {
  readonly id: string;
  readonly config: RappterSoulConfig;
  private agents: Map<string, BasicAgent>;
  private summoner?: SoulSummoner;
  private _loadedAt: number;
  private _invocationCount: number = 0;

  private constructor(config: RappterSoulConfig, agents: Map<string, BasicAgent>, summoner?: SoulSummoner) {
    this.id = config.id;
    this.config = config;
    this.agents = agents;
    this.summoner = summoner;
    this._loadedAt = Date.now();
  }

  /**
   * Load a soul from config + a default agent pool.
   * Applies whitelist/blacklist filtering to produce the soul's agent set.
   * The optional summoner enables soul-to-soul communication via the manager.
   */
  static async load(
    config: RappterSoulConfig,
    defaults: { agents: Map<string, BasicAgent> },
    summoner?: SoulSummoner,
  ): Promise<RappterSoul> {
    let agentMap = new Map(defaults.agents);

    // Apply whitelist
    if (config.agents && config.agents.length > 0) {
      const allowed = new Set(config.agents);
      agentMap = new Map(
        Array.from(agentMap.entries()).filter(([name]) => allowed.has(name)),
      );
    }

    // Apply blacklist
    if (config.excludeAgents && config.excludeAgents.length > 0) {
      for (const name of config.excludeAgents) {
        agentMap.delete(name);
      }
    }

    return new RappterSoul(config, agentMap, summoner);
  }

  /**
   * The soul's identity payload, injected into every agent invocation as
   * `upstream_slush.soul_identity` so agents can adapt behavior per soul.
   */
  get identity(): SoulIdentity {
    const identity: SoulIdentity = {
      soul_id: this.id,
      soul_name: this.config.name,
      description: this.config.description,
    };
    if (this.config.emoji) identity.emoji = this.config.emoji;
    if (this.config.systemPrompt) identity.system_prompt = this.config.systemPrompt;
    if (this.config.model) identity.model = this.config.model;
    return identity;
  }

  /**
   * Build the soul-to-soul handle agents receive as kwargs._soul.
   * The chain carries every ancestor soul id, so cycles and runaway
   * depth are blocked before they reach the manager.
   */
  private buildSoulHandle(chain: string[]) {
    return {
      id: this.id,
      chain,
      summon: async (
        rappterIds: string[],
        message: string,
        mode: SummonParams['mode'] = 'single',
      ): Promise<SummonResult> => {
        if (!this.summoner) {
          return { mode, results: [], totalDurationMs: 0, error: 'Soul-to-soul summon unavailable (no manager)' };
        }
        const cycle = rappterIds.filter((id) => chain.includes(id));
        if (cycle.length > 0) {
          return { mode, results: [], totalDurationMs: 0, error: `Summon cycle blocked: ${cycle.join(', ')} already in chain [${chain.join(' → ')}]` };
        }
        if (chain.length >= MAX_SOUL_SUMMON_DEPTH) {
          return { mode, results: [], totalDurationMs: 0, error: `Summon depth exceeded (max ${MAX_SOUL_SUMMON_DEPTH}): [${chain.join(' → ')}]` };
        }
        return this.summoner({ rappterIds, message, mode }, chain);
      },
    };
  }

  /**
   * Core async function — this IS the rappter.
   * Invokes agents with the given message and returns the result.
   *
   * Note: agents from the default pool are shared instances across souls, so
   * identity injection is per-invocation (via upstream_slush), not per-agent.
   */
  async invoke(message: string, options?: { sessionId?: string; chain?: string[] }): Promise<RappterInvokeResult> {
    this._invocationCount++;
    const start = Date.now();
    const chain = [...(options?.chain ?? []), this.id];

    try {
      // Route to the first available agent and execute
      const agentEntries = Array.from(this.agents.entries());
      if (agentEntries.length === 0) {
        return {
          soulId: this.id,
          soulName: this.config.name,
          result: JSON.stringify({ status: 'error', message: 'No agents available' }),
          durationMs: Date.now() - start,
          error: 'No agents available',
        };
      }

      // Execute all agents and collect results, injecting this soul's identity
      // and a _soul handle for soul-to-soul summons
      const results: Record<string, unknown> = {};
      for (const [name, agent] of agentEntries) {
        const agentResult = await withAgentLock(agent, () =>
          agent.execute({
            query: message,
            upstream_slush: { soul_identity: this.identity },
            _soul: this.buildSoulHandle(chain),
          }),
        );
        try {
          results[name] = JSON.parse(agentResult);
        } catch {
          results[name] = agentResult;
        }
      }

      return {
        soulId: this.id,
        soulName: this.config.name,
        result: JSON.stringify({
          status: 'success',
          soul: this.id,
          agentResults: results,
          data_slush: { source_soul: this.id, agent_count: agentEntries.length },
        }),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        soulId: this.id,
        soulName: this.config.name,
        result: JSON.stringify({ status: 'error', message: (err as Error).message }),
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  /** Cleanup resources */
  async unload(): Promise<void> {
    this.agents.clear();
  }

  /** Get current status */
  getStatus(): RappterSoulStatus {
    return {
      id: this.id,
      name: this.config.name,
      description: this.config.description,
      emoji: this.config.emoji,
      agentCount: this.agents.size,
      agentNames: Array.from(this.agents.keys()),
      loadedAt: this._loadedAt,
      invocationCount: this._invocationCount,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
    };
  }

  /** Get agent count */
  get agentCount(): number {
    return this.agents.size;
  }

  /** Get invocation count */
  get invocationCount(): number {
    return this._invocationCount;
  }

  /** Get loaded timestamp */
  get loadedAt(): number {
    return this._loadedAt;
  }
}

// ── RappterManager ───────────────────────────────────────────────────────────

export class RappterManager {
  private souls = new Map<string, RappterSoul>();
  private defaultAgents: Map<string, BasicAgent>;
  private store: SoulStore;

  constructor(defaultAgents?: Map<string, BasicAgent>, store?: SoulStore) {
    this.defaultAgents = defaultAgents ?? new Map();
    this.store = store ?? new SoulStore();
  }

  /** Load a soul from config. With persist: true, also save the config to disk. */
  async loadSoul(config: RappterSoulConfig, options?: { persist?: boolean }): Promise<RappterSoul> {
    if (this.souls.has(config.id)) {
      throw new Error(`Soul already loaded: ${config.id}`);
    }

    const soul = await RappterSoul.load(
      config,
      { agents: this.defaultAgents },
      (params, chain) => this.summonInternal(params, chain),
    );
    this.souls.set(config.id, soul);

    if (options?.persist) {
      await this.store.save(config);
    }

    return soul;
  }

  /** Unload a soul, freeing resources */
  async unloadSoul(soulId: string): Promise<boolean> {
    const soul = this.souls.get(soulId);
    if (!soul) return false;

    await soul.unload();
    this.souls.delete(soulId);
    return true;
  }

  /** Reload a soul — unload then re-load with same config */
  async reloadSoul(soulId: string): Promise<RappterSoul> {
    const soul = this.souls.get(soulId);
    if (!soul) throw new Error(`Soul not found: ${soulId}`);

    const config = soul.config;
    await this.unloadSoul(soulId);
    return this.loadSoul(config);
  }

  /** Get a soul by ID */
  getSoul(soulId: string): RappterSoul | undefined {
    return this.souls.get(soulId);
  }

  /** List all loaded souls */
  listSouls(): RappterSoulInfo[] {
    return Array.from(this.souls.values()).map((soul) => {
      const status = soul.getStatus();
      return {
        id: status.id,
        name: status.name,
        description: status.description,
        emoji: status.emoji,
        agentCount: status.agentCount,
      };
    });
  }

  /** Load a soul from a built-in template */
  async loadTemplate(
    templateId: string,
    overrides?: Partial<RappterSoulConfig>,
  ): Promise<RappterSoul> {
    const template = getTemplate(templateId);
    if (!template) {
      const available = listTemplates().map(t => t.templateId).join(', ');
      throw new Error(`Template not found: ${templateId}. Available: ${available}`);
    }
    const config = templateToConfig(template, overrides);
    return this.loadSoul(config);
  }

  /** List all available soul templates */
  listTemplates(category?: SoulTemplate['category']): SoulTemplate[] {
    return listTemplates(category);
  }

  // ── Persistence (backed by SoulStore, default ~/.openrappter/souls/) ──

  /**
   * Create and load a soul from a natural-language description.
   * Name is inferred from the description unless given; the id is the
   * kebab-case name (suffixed -2..-9 on collision); a systemPrompt is
   * derived so identity injection carries the persona to agents.
   */
  async createSoul(
    description: string,
    options?: { name?: string; emoji?: string; persist?: boolean; agents?: string[]; systemPrompt?: string },
  ): Promise<RappterSoul> {
    if (!description?.trim()) throw new Error('createSoul requires a description');

    const name = options?.name?.trim() || inferSoulName(description);
    const baseId = name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'soul';
    let id = baseId;
    for (let n = 2; this.souls.has(id) && n <= 9; n++) id = `${baseId}-${n}`;
    if (this.souls.has(id)) throw new Error(`Soul id space exhausted for: ${baseId}`);

    const config: RappterSoulConfig = {
      id,
      name,
      description: description.trim(),
      systemPrompt: options?.systemPrompt ?? `You are ${name}. ${description.trim()}`,
    };
    if (options?.emoji) config.emoji = options.emoji;
    if (options?.agents) config.agents = options.agents;

    return this.loadSoul(config, { persist: options?.persist });
  }

  /** Save a loaded soul's config to disk for persistence across restarts */
  async saveSoul(soulId: string): Promise<string> {
    const soul = this.souls.get(soulId);
    if (!soul) throw new Error(`Soul not found: ${soulId}`);
    return this.store.save(soul.config);
  }

  /** Save a raw config to disk (without loading it first) */
  async saveSoulConfig(config: RappterSoulConfig): Promise<string> {
    return this.store.save(config);
  }

  /** Delete a saved soul config from disk. The loaded soul (if any) stays loaded. */
  async deleteSavedSoul(soulId: string): Promise<boolean> {
    return this.store.remove(soulId);
  }

  /** List all saved soul configs from disk */
  async listSavedSouls(): Promise<RappterSoulConfig[]> {
    return this.store.list();
  }

  /** Load every saved config into the manager, reporting restored/skipped/failed IDs */
  async restoreSouls(): Promise<RestoreSoulsResult> {
    const result: RestoreSoulsResult = { restored: [], skipped: [], errors: [] };

    for (const config of await this.store.list()) {
      if (this.souls.has(config.id)) {
        result.skipped.push(config.id);
        continue;
      }
      try {
        await this.loadSoul(config);
        result.restored.push(config.id);
      } catch (err) {
        result.errors.push({ id: config.id, error: (err as Error).message });
      }
    }

    return result;
  }

  /** Load all saved souls from disk and start them */
  async loadSavedSouls(): Promise<RappterSoul[]> {
    const { restored } = await this.restoreSouls();
    return restored.map((id) => this.souls.get(id)!);
  }

  /**
   * Summon — the key method. Invoke one or more souls with a message.
   *
   * Modes:
   * - single: one rappter (first ID), error if not found
   * - all: parallel invoke all, return all results
   * - race: parallel invoke all, first response wins
   * - chain: sequential, each rappter's output becomes the next's input
   */
  async summon(params: SummonParams): Promise<SummonResult> {
    return this.summonInternal(params, []);
  }

  /**
   * Summon with an ancestry chain — soul-to-soul calls pass the caller's
   * chain so nested invocations inherit cycle/depth protection.
   */
  private async summonInternal(params: SummonParams, chain: string[]): Promise<SummonResult> {
    const start = Date.now();
    const { rappterIds, message, mode, sessionId } = params;

    // Validate all IDs exist
    const missing = rappterIds.filter((id) => !this.souls.has(id));
    if (missing.length > 0) {
      return {
        mode,
        results: [],
        totalDurationMs: Date.now() - start,
        error: `Soul(s) not found: ${missing.join(', ')}`,
      };
    }

    switch (mode) {
      case 'single':
        return this.summonSingle(rappterIds[0], message, sessionId, start, chain);
      case 'all':
        return this.summonAll(rappterIds, message, sessionId, start, chain);
      case 'race':
        return this.summonRace(rappterIds, message, sessionId, start, chain);
      case 'chain':
        return this.summonChain(rappterIds, message, sessionId, start, chain);
      default:
        return {
          mode,
          results: [],
          totalDurationMs: Date.now() - start,
          error: `Unknown mode: ${mode}`,
        };
    }
  }

  private async summonSingle(
    soulId: string,
    message: string,
    sessionId: string | undefined,
    start: number,
    chain: string[] = [],
  ): Promise<SummonResult> {
    const soul = this.souls.get(soulId)!;
    const result = await soul.invoke(message, { sessionId, chain });
    return {
      mode: 'single',
      results: [result],
      totalDurationMs: Date.now() - start,
    };
  }

  private async summonAll(
    rappterIds: string[],
    message: string,
    sessionId: string | undefined,
    start: number,
    chain: string[] = [],
  ): Promise<SummonResult> {
    const promises = rappterIds.map((id) => {
      const soul = this.souls.get(id)!;
      return soul.invoke(message, { sessionId, chain });
    });

    const results = await Promise.all(promises);
    return {
      mode: 'all',
      results,
      totalDurationMs: Date.now() - start,
    };
  }

  private async summonRace(
    rappterIds: string[],
    message: string,
    sessionId: string | undefined,
    start: number,
    chain: string[] = [],
  ): Promise<SummonResult> {
    const promises = rappterIds.map((id) => {
      const soul = this.souls.get(id)!;
      return soul.invoke(message, { sessionId, chain });
    });

    const winner = await Promise.race(promises);
    // Wait for remaining to finish (fire and forget)
    const allResults = await Promise.allSettled(promises);
    const results = allResults
      .filter((r): r is PromiseFulfilledResult<RappterInvokeResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    return {
      mode: 'race',
      results,
      totalDurationMs: Date.now() - start,
      winner: winner.soulId,
    };
  }

  private async summonChain(
    rappterIds: string[],
    message: string,
    sessionId: string | undefined,
    start: number,
    chain: string[] = [],
  ): Promise<SummonResult> {
    const results: RappterInvokeResult[] = [];
    let currentMessage = message;

    for (const id of rappterIds) {
      const soul = this.souls.get(id)!;
      const result = await soul.invoke(currentMessage, { sessionId, chain });
      results.push(result);

      if (result.error) break;

      // Pipe output as input to next soul
      currentMessage = result.result;
    }

    return {
      mode: 'chain',
      results,
      totalDurationMs: Date.now() - start,
    };
  }
}
