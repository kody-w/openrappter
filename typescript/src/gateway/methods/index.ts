/**
 * Gateway RPC methods registry
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
  registerConfigMethods(server);
  registerCronMethods(server, deps);
  registerAgentsMethods(server, deps);
  registerShowcaseMethods(server, deps);
  registerChannelsMethods(server, deps);
  registerConnectionsMethods(server, deps);
  registerSystemMethods(server, deps);
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
};
