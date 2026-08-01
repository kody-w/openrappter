/**
 * The digital twin — a rappter that is *you*.
 *
 * The engine is public; the consciousness is local. The profile lives in a
 * vault outside every git repository, written owner-only, and the only export
 * path carries counts rather than values.
 */

export * from './types.js';
export * from './vault.js';
export * from './soul.js';
export { registerTwinCommands } from './cli.js';
