/**
 * Command registrations.
 *
 * Being exported here is not the same as being reachable. #159 registered
 * `config` and `doctor`; this pass registers `skills`, `agents`, `models`,
 * `update` and the delegating `rappterhub`/`clawhub`, and moves `gateway` onto
 * the daemon path in `index.ts`.
 *
 * Four modules are still deliberately unregistered, because registering them
 * would ship a command that lies:
 *
 * - `memory.ts` — `MemoryManager` holds chunks in two `Map`s and never touches
 *   disk, so `memory add` prints an id for a chunk that dies with the process
 *   and `memory list` can only ever say "No memories stored."
 * - `sessions.ts` — calls `sessions.list/get/delete/reset`; the gateway
 *   registers no method with a `sessions.` prefix at all (`chat.list`,
 *   `chat.session`, `chat.messages`, `chat.delete` are the real ones).
 * - `channels.ts` — sends `{channel}` where `channels.connect/disconnect`
 *   read `params.type`.
 * - `send.ts` — sends `{channel, message, target}` where `channels.send` reads
 *   `{channelId, conversationId, content}`, and calls `channels.broadcast`,
 *   which does not exist.
 * - `login.ts` — `initiateOAuthFlow` persists nothing, yet the command prints
 *   "Credentials have been saved to your config" and echoes 20 characters of
 *   the access token.
 */

export { registerConfigCommand } from './config.js';
export { registerCronCommand } from './cron.js';
export { registerSkillsCommand } from './skills.js';
export { registerSessionsCommand } from './sessions.js';
export { registerChannelsCommand } from './channels.js';
export { registerChannelCommand } from './channel.js';
export { registerAgentsCommand } from './agents.js';
export { registerSendCommand } from './send.js';
export { registerModelsCommand } from './models.js';
export { registerDoctorCommand } from './doctor.js';
export { registerUpdateCommand } from './update.js';
export { registerLoginCommand } from './login.js';
export { registerMemoryCommand } from './memory.js';
export { registerShowAndTellCommand } from './show-and-tell.js';
export { registerHubCommands } from './hubs.js';
export { launchBar } from './bar.js';
