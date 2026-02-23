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

// ── RappterSoul ──────────────────────────────────────────────────────────────

export class RappterSoul {
  readonly id: string;
  readonly config: RappterSoulConfig;
  private agents: Map<string, BasicAgent>;
  private _loadedAt: number;
  private _invocationCount: number = 0;

  private constructor(config: RappterSoulConfig, agents: Map<string, BasicAgent>) {
    this.id = config.id;
    this.config = config;
    this.agents = agents;
    this._loadedAt = Date.now();
  }

  /**
   * Load a soul from config + a default agent pool.
   * Applies whitelist/blacklist filtering to produce the soul's agent set.
   */
  static async load(
    config: RappterSoulConfig,
    defaults: { agents: Map<string, BasicAgent> },
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

    return new RappterSoul(config, agentMap);
  }

  /**
   * Core async function — this IS the rappter.
   * Invokes agents with the given message and returns the result.
   */
  async invoke(message: string, _options?: { sessionId?: string }): Promise<RappterInvokeResult> {
    this._invocationCount++;
    const start = Date.now();

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

      // Execute all agents and collect results
      const results: Record<string, unknown> = {};
      for (const [name, agent] of agentEntries) {
        const agentResult = await agent.execute({ query: message });
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

  constructor(defaultAgents?: Map<string, BasicAgent>) {
    this.defaultAgents = defaultAgents ?? new Map();
  }

  /** Load a soul from config */
  async loadSoul(config: RappterSoulConfig): Promise<RappterSoul> {
    if (this.souls.has(config.id)) {
      throw new Error(`Soul already loaded: ${config.id}`);
    }

    const soul = await RappterSoul.load(config, { agents: this.defaultAgents });
    this.souls.set(config.id, soul);
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
        return this.summonSingle(rappterIds[0], message, sessionId, start);
      case 'all':
        return this.summonAll(rappterIds, message, sessionId, start);
      case 'race':
        return this.summonRace(rappterIds, message, sessionId, start);
      case 'chain':
        return this.summonChain(rappterIds, message, sessionId, start);
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
  ): Promise<SummonResult> {
    const soul = this.souls.get(soulId)!;
    const result = await soul.invoke(message, { sessionId });
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
  ): Promise<SummonResult> {
    const promises = rappterIds.map((id) => {
      const soul = this.souls.get(id)!;
      return soul.invoke(message, { sessionId });
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
  ): Promise<SummonResult> {
    const promises = rappterIds.map((id) => {
      const soul = this.souls.get(id)!;
      return soul.invoke(message, { sessionId });
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
  ): Promise<SummonResult> {
    const results: RappterInvokeResult[] = [];
    let currentMessage = message;

    for (const id of rappterIds) {
      const soul = this.souls.get(id)!;
      const result = await soul.invoke(currentMessage, { sessionId });
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
