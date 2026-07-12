/**
 * Gateway RPC methods registry
 *
 * IMPORTANT — canonical registration path:
 * `GatewayServer` (`../server.ts`) does NOT call `registerAllMethods` below.
 * Its `registerBuiltInMethods()` is the single canonical, production
 * registration path and is the authoritative source for `chat.*`,
 * `channels.*`, `cron.*`, `connections.list`, and `config.get`/`config.set`
 * — those handlers are wired to the server's real `sessionStore`,
 * `channelRegistry`, and `cronStore`/`cronService`.
 *
 * The modules aggregated here (and `registerAllMethods` itself) are
 * standalone, independently unit-tested RPC method implementations kept
 * for parity/reference testing. Several re-declare method names that
 * overlap with `GatewayServer`'s built-ins using their own local,
 * disconnected dependencies (e.g. an isolated `Map` session store rather
 * than the live one). If you ever wire `registerAllMethods` into
 * `GatewayServer`, register it *before* `registerBuiltInMethods()` so the
 * real, stateful implementations win — never after, and never for the
 * overlapping names without first reconciling behavior, or the gateway
 * will silently serve two divergent implementations of the same method.
 */

import { registerChatMethods } from './chat-methods.js';
import { registerModelsMethods } from './models-methods.js';
import { registerBrowserMethods } from './browser-methods.js';
import { registerTtsMethods } from './tts-methods.js';
import { registerNodesMethods } from './nodes-methods.js';
import { registerExecMethods } from './exec-methods.js';
import { registerUsageMethods } from './usage-methods.js';
import { registerLogsMethods } from './logs-methods.js';
import { registerSessionMethods } from './session-methods.js';
import { registerSkillsMethods } from './skills-methods.js';
import { registerConfigMethods } from './config-methods.js';
import { registerCronMethods } from './cron-methods.js';
import { registerAgentsMethods } from './agents-methods.js';
import { registerShowcaseMethods } from './showcase-methods.js';
import { registerChannelsMethods } from './channels-methods.js';
import { registerConnectionsMethods } from './connections-methods.js';
import { registerSystemMethods } from './system-methods.js';
import { registerRappterMethods } from './rappter-methods.js';
import { registerExperimentalMethods } from './experimental-methods.js';
import { registerAuthMethods } from './auth-methods.js';
import { registerZenMethods } from './zen-methods.js';
import { registerBackupMethods } from './backup-methods.js';
import { registerTwinMethods } from './twin-methods.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

/**
 * Register all RPC methods with the gateway server
 * @param server - Gateway server instance
 * @param deps - Optional dependencies for method implementations
 */
export function registerAllMethods(
  server: MethodRegistrar,
  deps?: Record<string, unknown>
): void {
  registerChatMethods(server);
  registerModelsMethods(server, deps);
  registerBrowserMethods(server, deps);
  registerTtsMethods(server, deps);
  registerNodesMethods(server, deps);
  registerExecMethods(server, deps);
  registerUsageMethods(server, deps);
  registerLogsMethods(server);
  registerSessionMethods(server, deps);
  registerSkillsMethods(server, deps);
  registerConfigMethods(server, deps);
  registerCronMethods(server, deps);
  registerAgentsMethods(server, deps);
  registerShowcaseMethods(server, deps);
  registerChannelsMethods(server, deps);
  registerConnectionsMethods(server, deps);
  registerSystemMethods(server, deps);
  registerRappterMethods(server, deps);
  registerExperimentalMethods(server, deps);
  registerAuthMethods(server, deps);
  registerZenMethods(server, deps);
  registerBackupMethods(server, deps);
  registerTwinMethods(server, deps);
}

// Re-export individual registration functions
export {
  registerChatMethods,
  registerModelsMethods,
  registerBrowserMethods,
  registerTtsMethods,
  registerNodesMethods,
  registerExecMethods,
  registerUsageMethods,
  registerLogsMethods,
  registerSessionMethods,
  registerSkillsMethods,
  registerConfigMethods,
  registerCronMethods,
  registerAgentsMethods,
  registerShowcaseMethods,
  registerChannelsMethods,
  registerConnectionsMethods,
  registerSystemMethods,
  registerRappterMethods,
  registerExperimentalMethods,
  registerAuthMethods,
  registerZenMethods,
  registerBackupMethods,
  registerTwinMethods,
};
