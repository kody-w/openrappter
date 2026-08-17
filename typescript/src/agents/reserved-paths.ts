/**
 * The agent subdirectories a conforming kernel never auto-loads.
 *
 * These live in their own module, apart from `AgentRegistry`, because the rule
 * is needed by code that must not drag the registry's dependencies along.
 * `AgentRegistry` imports the logger, which imports `chalk`; the dashboard UI
 * package runs its gateway integration test against `GatewayServer` with only
 * `typescript/ui`'s dependencies installed, so anything reachable from the
 * gateway that pulls in a root-only package breaks that suite. Keeping the two
 * reserved-directory rules dependency-free lets both the registry and the
 * `agents.files.*` guards share one definition instead of duplicating it.
 *
 * `AgentRegistry` re-exports both names, so existing importers are unaffected.
 */

/**
 * Subdirectories a conforming kernel never auto-loads.
 *
 * KERNEL §2.3 freezes both names. Honouring them is not a spec nicety: without
 * it, moving an agent into `disabled_agents/` does not disable it, and "how do I
 * turn one off" is the very next question after drag-and-drop loading.
 */
export const RESERVED_AGENT_DIRS = ['experimental_agents', 'disabled_agents'] as const;

/** True when `file` sits inside a reserved subdirectory of the agents tree. */
export function isReservedAgentPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  return parts.some(seg => (RESERVED_AGENT_DIRS as readonly string[]).includes(seg));
}
