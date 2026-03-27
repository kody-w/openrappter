/**
 * PeerStreamManager — Capture and relay terminal ANSI frames over WebSocket.
 *
 * The gateway streams terminal frames to connected browsers. No PeerJS server
 * dep needed — the gateway IS the relay. Browsers can optionally upgrade to
 * P2P via PeerJS client-side for lower latency between viewers.
 *
 * Flow:
 *   ZenScreen.onFrame(buf) → PeerStreamManager.push(buf) → gateway broadcast
 *   Browser connects via WS → subscribes to 'zen.frame' events → renders ANSI
 *
 * Sessions allow multiple zen screens (pong, future games) running in parallel.
 */

export interface ZenStreamSession {
  id: string;
  name: string;
  startedAt: string;
  frameCount: number;
  viewerCount: number;
  lastFrame: string;
}

export type FrameBroadcaster = (event: string, payload: unknown) => void;

export class PeerStreamManager {
  private sessions = new Map<string, ZenStreamSession>();
  private broadcaster: FrameBroadcaster | null = null;

  /** Wire up to the gateway's broadcastEvent function. */
  setBroadcaster(fn: FrameBroadcaster): void {
    this.broadcaster = fn;
  }

  /** Create a new streaming session (e.g. when a zen screen starts). */
  createSession(id: string, name: string): ZenStreamSession {
    const session: ZenStreamSession = {
      id,
      name,
      startedAt: new Date().toISOString(),
      frameCount: 0,
      viewerCount: 0,
      lastFrame: '',
    };
    this.sessions.set(id, session);

    this.broadcaster?.('zen.session.start', { id, name });
    return session;
  }

  /** Push an ANSI frame to all subscribers of this session. */
  pushFrame(sessionId: string, frame: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.frameCount++;
    session.lastFrame = frame;

    this.broadcaster?.('zen.frame', {
      sessionId,
      frame,
      frameNumber: session.frameCount,
    });
  }

  /** Increment viewer count when a browser subscribes. */
  addViewer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.viewerCount++;
  }

  /** Decrement viewer count when a browser disconnects. */
  removeViewer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.viewerCount = Math.max(0, session.viewerCount - 1);
  }

  /** End a streaming session. */
  endSession(sessionId: string): void {
    this.broadcaster?.('zen.session.end', { id: sessionId });
    this.sessions.delete(sessionId);
  }

  /** List all active sessions. */
  listSessions(): ZenStreamSession[] {
    return Array.from(this.sessions.values());
  }

  /** Get a specific session. */
  getSession(sessionId: string): ZenStreamSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get the latest frame for a session (for late-joining viewers). */
  getLastFrame(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.lastFrame ?? null;
  }
}

/** Singleton — shared across the gateway. */
export const globalPeerStream = new PeerStreamManager();
