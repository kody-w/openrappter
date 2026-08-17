/**
 * Zen frame publisher — the producer half of the `zen.*` gateway contract.
 *
 * A zen screen (Bar pong today) runs in its own process and reaches the
 * daemon over WebSocket, so publishing is an RPC, not a call into a
 * process-local singleton. Frames arrive at whatever rate the screen renders
 * at, which is faster than a gateway connection should be asked to carry:
 *
 *   - at most one publish is in flight at a time, so a slow or stalled
 *     gateway drops frames instead of queueing an ever-growing backlog of
 *     screens nobody will ever see
 *   - frames closer together than `minIntervalMs` are dropped, keeping the
 *     stream inside the gateway's frame budget
 *   - the newest frame always wins; a dropped frame is simply superseded
 *
 * Publishing stops after `maxConsecutiveFailures` errors, so a daemon without
 * `zen.publish` (an older build) costs one round of failed calls, not one per
 * rendered frame.
 */

export type ZenRpcCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export interface ZenPublisherOptions {
  call: ZenRpcCall;
  sessionId: string;
  name: string;
  /** Minimum gap between published frames. Default 100ms (10fps). */
  minIntervalMs?: number;
  maxConsecutiveFailures?: number;
  now?: () => number;
}

export interface ZenPublisherStats {
  published: number;
  dropped: number;
  failures: number;
  disabled: boolean;
  lastError?: string;
}

export interface ZenPublisher {
  publish(frame: string): void;
  end(): Promise<void>;
  readonly stats: ZenPublisherStats;
}

export function createZenPublisher(options: ZenPublisherOptions): ZenPublisher {
  const {
    call,
    sessionId,
    name,
    minIntervalMs = 100,
    maxConsecutiveFailures = 3,
    now = Date.now,
  } = options;

  let inFlight = false;
  let lastSentAt = -Infinity;
  let started = false;
  let consecutiveFailures = 0;
  const stats: ZenPublisherStats = {
    published: 0,
    dropped: 0,
    failures: 0,
    disabled: false,
  };

  return {
    stats,

    publish(frame: string): void {
      if (stats.disabled) return;
      if (inFlight || now() - lastSentAt < minIntervalMs) {
        stats.dropped++;
        return;
      }
      inFlight = true;
      lastSentAt = now();
      void Promise.resolve(
        call('zen.publish', { sessionId, name, frame }),
      ).then(
        () => {
          started = true;
          consecutiveFailures = 0;
          stats.published++;
        },
        (err: unknown) => {
          stats.failures++;
          stats.lastError = err instanceof Error ? err.message : String(err);
          if (++consecutiveFailures >= maxConsecutiveFailures) {
            stats.disabled = true;
          }
        },
      ).finally(() => {
        inFlight = false;
      });
    },

    async end(): Promise<void> {
      if (!started) return;
      started = false;
      try {
        await call('zen.end', { sessionId });
      } catch {
        // The gateway ends a session when its producer's connection drops, so
        // a failed goodbye is not a leak.
      }
    },
  };
}
