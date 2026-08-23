/**
 * Command registrations.
 *
 * Being exported here is not the same as being reachable. #159 registered
 * `config` and `doctor`; a later pass registered `skills`, `agents`, `models`,
 * `update` and the delegating `rappterhub`/`clawhub`, and moved `gateway` onto
 * the daemon path in `index.ts`.
 *
 * Six of the exports below are still deliberately unregistered, because
 * registering them would ship a command that lies or duplicates one that
 * already works. Verified against the running gateway and the OAuth flow, not
 * by reading — `dormant-cli-commands-stay-dormant.test.ts` pins them:
 *
 * - `memory.ts` (`registerMemoryCommand`) — `MemoryManager` holds chunks in two
 *   `Map`s and never touches disk, so `memory add` prints an id for a chunk
 *   that dies with the process and `memory list` can only ever say "No memories
 *   stored." Filed as #204.
 * - `sessions.ts` (`registerSessionsCommand`) — calls `sessions.list/get/delete`,
 *   none of which the gateway registers (the real listing methods are
 *   `chat.list`, `chat.session`, `chat.messages`, `chat.delete`); `sessions.reset`
 *   IS registered but reads `sessionKey`, not the `{id}` this sends, so even
 *   that throws "sessionKey required".
 * - `channels.ts` (`registerChannelsCommand`) — sends `{channel}` where
 *   `channels.connect`/`channels.disconnect` read `params.type`, so both pass
 *   `undefined` to the registry.
 * - `send.ts` (`registerSendCommand`) — sends `{channel, message, target}` where
 *   `channels.send` reads `{channelId, conversationId, content}`, and `--all`
 *   calls `channels.broadcast`, which the gateway does not register.
 * - `login.ts` (`registerLoginCommand`) — `initiateOAuthFlow` persists nothing,
 *   yet the command prints "Credentials have been saved to your config." (The
 *   token-prefix echo was removed in #178; the false "saved" claim remains.)
 */

export { registerConfigCommand } from './config.js';
export { registerCronCommand } from './cron.js';
export { registerSkillsCommand } from './skills.js';
export { registerSessionsCommand } from './sessions.js';
export { registerChannelsCommand } from './channels.js';
export { registerAgentsCommand } from './agents.js';
export { registerSendCommand } from './send.js';
export { registerModelsCommand } from './models.js';
export { registerDoctorCommand } from './doctor.js';
export { registerUpdateCommand } from './update.js';
export { registerLoginCommand } from './login.js';
export { registerMemoryCommand } from './memory.js';
export { registerShowAndTellCommand } from './show-and-tell.js';
export { registerRappidCardCommand } from './rappid-card.js';
export { registerHubCommands } from './hubs.js';
export { launchBar } from './bar.js';
