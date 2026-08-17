/**
 * Shared agent-result classifier.
 *
 * An agent reports failure in one of two ways:
 *   1. by throwing / rejecting, or
 *   2. by *resolving* with a structured envelope `{ "status": "error", ... }`.
 *
 * Case 2 is just as much a failure as case 1 — the same principle as a nonzero
 * shell exit being an error in both runtimes. Every composition layer (chain,
 * graph, broadcast, MCP, chat) classifies through this function so the two
 * runtimes cannot drift apart.
 *
 * Accepts either the raw JSON string an agent returned from `execute()` or an
 * already-parsed envelope object.
 *
 * Mirrors python/openrappter/result_status.py
 */
export function agentResultIsError(result: unknown): boolean {
  let envelope: unknown = result;

  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return false;
    }
  }

  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return false;
  }

  const status = (envelope as { status?: unknown }).status;
  return typeof status === "string" && status.toLowerCase() === "error";
}

/**
 * Human-readable reason for a failed agent result.
 *
 * Composition layers report a failed step's reason the same way whether the
 * agent threw (Error.message) or resolved with an error envelope. Reads
 * `message`, then `error`, then falls back.
 *
 * Mirrors python/openrappter/result_status.py
 */
export function agentResultErrorMessage(
  result: unknown,
  fallback = "agent returned an error envelope",
): string {
  let envelope: unknown = result;

  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return fallback;
    }
  }

  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return fallback;
  }

  for (const key of ["message", "error"] as const) {
    const value = (envelope as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return fallback;
}
