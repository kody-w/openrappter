/**
 * Monotonic elapsed time for Show-and-Tell events.
 *
 * `sequence` is the order of a session and stays authoritative. `timestamp`
 * is wall-clock, which is what a person recognises but is also what a daylight
 * saving change, an NTP correction, or a laptop resuming from sleep moves
 * backwards. Timing evidence — "this step took eleven seconds", "there is a
 * four minute gap here" — is read off `elapsedMs`, which advances from a
 * process-local monotonic clock and never goes backwards.
 *
 * A session is written by more than one process (the agent and the detached
 * collector, in either runtime), and monotonic clocks are not comparable
 * across processes. Each process therefore anchors itself once per session
 * against the session's recorded `startedAt`, then advances that anchor
 * monotonically. Cross-process elapsed values agree to within the wall-clock
 * skew at anchor time; within a process they are exact.
 */

interface SessionAnchor {
  baseMs: number;
  monotonicMs: number;
  lastMs: number;
}

const MAX_TRACKED_SESSIONS = 64;
const anchors = new Map<string, SessionAnchor>();

export function monotonicNowMs(): number {
  return performance.now();
}

/**
 * Elapsed milliseconds since `startedAt` for `sessionId`, monotonically
 * non-decreasing within this process.
 */
export function sessionElapsedMs(
  sessionId: string,
  startedAt: number,
  now = Date.now(),
  monotonic = monotonicNowMs(),
): number {
  const anchor = anchors.get(sessionId);
  if (!anchor) {
    const baseMs = Math.max(0, Math.trunc(now - startedAt));
    if (anchors.size >= MAX_TRACKED_SESSIONS) {
      const oldest = anchors.keys().next();
      if (!oldest.done) anchors.delete(oldest.value);
    }
    anchors.set(sessionId, { baseMs, monotonicMs: monotonic, lastMs: baseMs });
    return baseMs;
  }
  const elapsed =
    anchor.baseMs + Math.max(0, Math.trunc(monotonic - anchor.monotonicMs));
  anchor.lastMs = Math.max(anchor.lastMs, elapsed);
  return anchor.lastMs;
}

/** Drops anchors so a re-created session id starts from its own `startedAt`. */
export function resetSessionClock(sessionId?: string): void {
  if (sessionId === undefined) anchors.clear();
  else anchors.delete(sessionId);
}
