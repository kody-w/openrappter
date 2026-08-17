/**
 * Zen streaming — the live state behind the `zen.*` RPC methods.
 *
 * A "zen session" is an ambient terminal screen (Bar pong, a ZenScreen
 * subclass, …) whose ANSI frames are relayed to browsers. The producer is a
 * *client* of the gateway, not the gateway itself: `openrappter bar --tui`
 * runs in its own process and reaches the daemon over WebSocket. That is why
 * this hub is fed by an RPC ingest method (`zen.publish`) rather than by the
 * process-local `globalPeerStream` singleton in `peer-stream.ts` — writes to
 * that singleton happen in the Bar's process and can never be observed by the
 * daemon's `zen.sessions`, so a viewer wired to it would list nothing, forever.
 *
 * Everything here is derived from what a connection actually did:
 *   - a session exists only while a producer connection keeps publishing to it
 *   - `viewerCount` is the number of connections currently subscribed, counted
 *     from the viewer map rather than an incremented integer, so it cannot
 *     drift when a browser closes its tab without calling `zen.unsubscribe`
 *   - dropping a connection releases its viewer slots and ends the sessions it
 *     produced
 */

import type { ConnectionInfo } from './types.js';

/** What `ui/src/components/zen.ts` renders for each card. */
export interface ZenSessionSummary {
  id: string;
  name: string;
  startedAt: string;
  frameCount: number;
  viewerCount: number;
}

interface ZenSessionState {
  id: string;
  name: string;
  startedAt: string;
  frameCount: number;
  lastFrame: string;
  producerId: string;
}

export type ZenBroadcast = (
  event: string,
  payload: unknown,
  filter?: (conn: ConnectionInfo) => boolean,
) => void;

/** Frames are rendered terminals, not uploads. 256 KiB is ~10x a 4k-wide screen. */
export const ZEN_MAX_FRAME_BYTES = 256 * 1024;

export class ZenStreamHub {
  private sessions = new Map<string, ZenSessionState>();
  /** connection id → session ids that connection is watching. */
  private viewers = new Map<string, Set<string>>();

  constructor(private readonly broadcast: ZenBroadcast) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  name(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.name;
  }

  lastFrame(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.lastFrame ?? null;
  }

  viewerCount(sessionId: string): number {
    let count = 0;
    for (const watched of this.viewers.values()) {
      if (watched.has(sessionId)) count++;
    }
    return count;
  }

  isViewer(connectionId: string, sessionId: string): boolean {
    return this.viewers.get(connectionId)?.has(sessionId) ?? false;
  }

  list(): ZenSessionSummary[] {
    // `lastFrame` is deliberately not included: a list of screens should not
    // carry a screenful of ANSI per entry.
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      startedAt: s.startedAt,
      frameCount: s.frameCount,
      viewerCount: this.viewerCount(s.id),
    }));
  }

  /** Record a frame, creating the session on first publish. */
  publish(
    sessionId: string,
    frame: string,
    producerId: string,
    name?: string,
  ): { frameNumber: number; viewerCount: number; created: boolean } {
    let session = this.sessions.get(sessionId);
    const created = !session;
    if (!session) {
      session = {
        id: sessionId,
        name: name?.trim() || sessionId,
        startedAt: new Date().toISOString(),
        frameCount: 0,
        lastFrame: '',
        producerId,
      };
      this.sessions.set(sessionId, session);
    } else {
      // Ownership follows the live publisher so a restarted producer can
      // resume a session id it previously owned.
      session.producerId = producerId;
      if (name?.trim()) session.name = name.trim();
    }

    session.frameCount++;
    session.lastFrame = frame;

    if (created) {
      this.broadcast('zen.session.start', { id: session.id, name: session.name });
    }
    const sid = session.id;
    this.broadcast(
      'zen.frame',
      { sessionId: sid, frame, frameNumber: session.frameCount },
      (conn) => this.isViewer(conn.id, sid),
    );

    return {
      frameNumber: session.frameCount,
      viewerCount: this.viewerCount(sessionId),
      created,
    };
  }

  /** End a session and drop every viewer's interest in it. */
  end(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false;
    for (const [connId, watched] of this.viewers) {
      watched.delete(sessionId);
      if (watched.size === 0) this.viewers.delete(connId);
    }
    this.broadcast('zen.session.end', { id: sessionId });
    return true;
  }

  addViewer(connectionId: string, sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    let watched = this.viewers.get(connectionId);
    if (!watched) {
      watched = new Set();
      this.viewers.set(connectionId, watched);
    }
    watched.add(sessionId);
    return true;
  }

  removeViewer(connectionId: string, sessionId: string): boolean {
    const watched = this.viewers.get(connectionId);
    if (!watched) return false;
    const removed = watched.delete(sessionId);
    if (watched.size === 0) this.viewers.delete(connectionId);
    return removed;
  }

  /**
   * Release everything a dropped connection held: its viewer slots, and the
   * sessions it was producing. Without this a closed browser tab counts as a
   * viewer forever and a killed Bar leaves a session that never ends.
   */
  releaseConnection(connectionId: string): { released: string[]; ended: string[] } {
    const released = [...(this.viewers.get(connectionId) ?? [])];
    this.viewers.delete(connectionId);

    const ended: string[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.producerId === connectionId) {
        this.end(session.id);
        ended.push(session.id);
      }
    }
    return { released, ended };
  }
}

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: ConnectionInfo) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

export interface ZenStreamDeps {
  hub: ZenStreamHub;
  /** True only for a live WebSocket connection, which is the only transport
   * that can receive the `zen.frame` events a subscription promises. */
  isLiveConnection: (connectionId: string) => boolean;
}

function requireSessionId(params: { sessionId?: string } | undefined): string {
  const sessionId = params?.sessionId?.trim();
  if (!sessionId) throw new Error('sessionId required');
  return sessionId;
}

/**
 * Wire `zen.*` onto a hub owned by the caller.
 *
 * Registered from `GatewayServer.registerBuiltInMethods` with that server's
 * own hub — unlike `methods/zen-methods.ts`, which is never registered and
 * talks to a singleton no gateway ever writes to.
 */
export function registerZenStreamMethods(
  server: MethodRegistrar,
  deps: ZenStreamDeps,
): void {
  const { hub, isLiveConnection } = deps;

  server.registerMethod('zen.sessions', async () => ({ sessions: hub.list() }));

  server.registerMethod(
    'zen.subscribe',
    async (params: { sessionId?: string }, conn) => {
      const sessionId = requireSessionId(params);
      if (!hub.has(sessionId)) throw new Error(`Unknown zen session: ${sessionId}`);

      const lastFrame = hub.lastFrame(sessionId) ?? undefined;
      const name = hub.name(sessionId);

      // Saying `subscribed: true` to a caller that cannot receive events would
      // be a success report over nothing: HTTP has no channel for `zen.frame`.
      if (!isLiveConnection(conn.id)) {
        return {
          subscribed: false,
          sessionId,
          name,
          lastFrame,
          reason:
            'zen.subscribe streams over WebSocket; poll zen.lastframe from HTTP instead',
        };
      }

      hub.addViewer(conn.id, sessionId);
      return {
        subscribed: true,
        sessionId,
        name,
        lastFrame,
        viewerCount: hub.viewerCount(sessionId),
      };
    },
  );

  server.registerMethod(
    'zen.unsubscribe',
    async (params: { sessionId?: string }, conn) => {
      const sessionId = requireSessionId(params);
      const removed = hub.removeViewer(conn.id, sessionId);
      return {
        unsubscribed: true,
        sessionId,
        wasSubscribed: removed,
        viewerCount: hub.viewerCount(sessionId),
      };
    },
  );

  server.registerMethod(
    'zen.lastframe',
    async (params: { sessionId?: string }) => {
      const sessionId = requireSessionId(params);
      const frame = hub.lastFrame(sessionId);
      if (frame === null) throw new Error(`Unknown zen session: ${sessionId}`);
      return { sessionId, frame };
    },
  );

  server.registerMethod(
    'zen.publish',
    async (
      params: { sessionId?: string; name?: string; frame?: string },
      conn,
    ) => {
      const sessionId = requireSessionId(params);
      // A session lives exactly as long as the connection producing it. An
      // HTTP publisher has no connection to close, so its session could only
      // ever be cleaned up by a caller remembering to send `zen.end`.
      if (!isLiveConnection(conn.id)) {
        throw new Error('zen.publish requires a WebSocket connection');
      }
      const frame = params?.frame;
      if (typeof frame !== 'string') throw new Error('frame required');
      if (Buffer.byteLength(frame, 'utf-8') > ZEN_MAX_FRAME_BYTES) {
        throw new Error(`frame exceeds ${ZEN_MAX_FRAME_BYTES} bytes`);
      }
      const { frameNumber, viewerCount } = hub.publish(
        sessionId,
        frame,
        conn.id,
        params.name,
      );
      return { published: true, sessionId, frameNumber, viewerCount };
    },
    { requiresAuth: true },
  );

  server.registerMethod(
    'zen.end',
    async (params: { sessionId?: string }) => {
      const sessionId = requireSessionId(params);
      return { ended: hub.end(sessionId), sessionId };
    },
    { requiresAuth: true },
  );
}
