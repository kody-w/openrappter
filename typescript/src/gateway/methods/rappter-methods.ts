/**
 * Rappter RPC methods — soul lifecycle + multi-rappter summon via gateway
 */

import type { RappterManager, RappterSoulConfig, SummonParams, SummonResult, RappterSoulInfo, RappterSoulStatus, RestoreSoulsResult } from '../rappter-manager.js';
import type { SoulTemplate } from '../soul-templates/index.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

export function registerRappterMethods(
  server: MethodRegistrar,
  deps?: Record<string, unknown>,
): void {
  const getManager = (): RappterManager => {
    const manager = deps?.rappterManager as RappterManager | undefined;
    if (!manager) throw new Error('RappterManager not configured');
    return manager;
  };

  // List all loaded souls
  server.registerMethod<void, { souls: RappterSoulInfo[] }>(
    'rappter.list',
    async () => {
      const manager = getManager();
      return { souls: manager.listSouls() };
    },
  );

  // Summon one or more rappters
  server.registerMethod<SummonParams, SummonResult>(
    'rappter.summon',
    async (params) => {
      const manager = getManager();
      return manager.summon(params);
    },
    { requiresAuth: true },
  );

  // Load a new soul (persist: true also saves the config to ~/.openrappter/souls/)
  server.registerMethod<{ config: RappterSoulConfig; persist?: boolean }, { soul: RappterSoulInfo }>(
    'rappter.load',
    async (params) => {
      const manager = getManager();
      const soul = await manager.loadSoul(params.config, { persist: params.persist });
      const status = soul.getStatus();
      return {
        soul: {
          id: status.id,
          name: status.name,
          description: status.description,
          emoji: status.emoji,
          agentCount: status.agentCount,
        },
      };
    },
    { requiresAuth: true },
  );

  // Unload a soul
  server.registerMethod<{ rappterId: string }, { unloaded: boolean }>(
    'rappter.unload',
    async (params) => {
      const manager = getManager();
      const unloaded = await manager.unloadSoul(params.rappterId);
      return { unloaded };
    },
    { requiresAuth: true },
  );

  // Reload a soul (hot-reload)
  server.registerMethod<{ rappterId: string }, { soul: RappterSoulInfo }>(
    'rappter.reload',
    async (params) => {
      const manager = getManager();
      const soul = await manager.reloadSoul(params.rappterId);
      const status = soul.getStatus();
      return {
        soul: {
          id: status.id,
          name: status.name,
          description: status.description,
          emoji: status.emoji,
          agentCount: status.agentCount,
        },
      };
    },
    { requiresAuth: true },
  );

  // Detailed soul status
  server.registerMethod<{ rappterId: string }, RappterSoulStatus>(
    'rappter.status',
    async (params) => {
      const manager = getManager();
      const soul = manager.getSoul(params.rappterId);
      if (!soul) throw new Error(`Soul not found: ${params.rappterId}`);
      return soul.getStatus();
    },
  );

  // ── Soul Templates ──

  // List available templates
  server.registerMethod<{ category?: string }, { templates: SoulTemplate[] }>(
    'rappter.templates',
    async (params) => {
      const manager = getManager();
      const templates = manager.listTemplates(params.category as SoulTemplate['category']);
      return { templates };
    },
  );

  // Load a soul from a template
  server.registerMethod<
    { templateId: string; overrides?: Partial<RappterSoulConfig> },
    { soul: RappterSoulInfo }
  >(
    'rappter.load-template',
    async (params) => {
      const manager = getManager();
      const soul = await manager.loadTemplate(params.templateId, params.overrides);
      const status = soul.getStatus();
      return {
        soul: {
          id: status.id,
          name: status.name,
          description: status.description,
          emoji: status.emoji,
          agentCount: status.agentCount,
        },
      };
    },
    { requiresAuth: true },
  );

  // Create a soul from a natural-language description
  server.registerMethod<
    { description: string; name?: string; emoji?: string; persist?: boolean },
    { soul: RappterSoulInfo }
  >(
    'rappter.create',
    async (params) => {
      const manager = getManager();
      const soul = await manager.createSoul(params.description, {
        name: params.name,
        emoji: params.emoji,
        persist: params.persist,
      });
      const status = soul.getStatus();
      return {
        soul: {
          id: status.id,
          name: status.name,
          description: status.description,
          emoji: status.emoji,
          agentCount: status.agentCount,
        },
      };
    },
    { requiresAuth: true },
  );

  // ── Soul Persistence ──

  // Persist a loaded soul's config to disk
  server.registerMethod<{ rappterId: string }, { saved: boolean; path: string }>(
    'rappter.save',
    async (params) => {
      const manager = getManager();
      const path = await manager.saveSoul(params.rappterId);
      return { saved: true, path };
    },
    { requiresAuth: true },
  );

  // List persisted soul configs on disk
  server.registerMethod<void, { configs: RappterSoulConfig[] }>(
    'rappter.persisted',
    async () => {
      const manager = getManager();
      return { configs: await manager.listSavedSouls() };
    },
  );

  // Load all persisted souls into the manager
  server.registerMethod<void, RestoreSoulsResult>(
    'rappter.restore',
    async () => {
      const manager = getManager();
      return manager.restoreSouls();
    },
    { requiresAuth: true },
  );

  // Delete a soul's persisted config (loaded soul stays loaded)
  server.registerMethod<{ rappterId: string }, { forgotten: boolean }>(
    'rappter.forget',
    async (params) => {
      const manager = getManager();
      const forgotten = await manager.deleteSavedSoul(params.rappterId);
      return { forgotten };
    },
    { requiresAuth: true },
  );
}
