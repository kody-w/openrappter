/**
 * Simulation provider — a scripted person on the other end of the line.
 *
 * This exists so the negotiation loop, the approval gate and the hotline can be
 * proven end to end in CI, with no phone number, no API key and no cost. The
 * real providers are thin adapters around the same interface; if the logic works
 * here it works there.
 */

import type { CallHandle, CallProvider, DialRequest } from '../types.js';

export interface ScriptedPeer {
  /** Matched against the number dialled, or '*' as a catch-all. */
  number: string;
  /** Said first, when the agent's opener arrives. */
  greeting?: string;
  /**
   * Replies, in order. Each entry may be a fixed string or a function of what
   * the agent just said, so a scripted peer can hold out for a better offer.
   */
  replies: (string | ((heard: string, turn: number) => string | null))[];
  /** Keypad input this peer will enter, in order, when asked for digits. */
  digits?: string[];
  /** Simulates nobody picking up. */
  noAnswer?: boolean;
}

export interface SimulationOptions {
  peers: ScriptedPeer[];
  /** Artificial latency, useful for exercising timeouts. Default 0. */
  latencyMs?: number;
}

interface SessionState {
  peer: ScriptedPeer;
  replyIndex: number;
  digitIndex: number;
  lastHeard: string;
  ended: boolean;
}

export class SimulationProvider implements CallProvider {
  readonly name = 'simulation';

  private readonly options: SimulationOptions;
  private readonly sessions = new Map<string, SessionState>();
  private counter = 0;

  /** Every utterance in the order it happened — handy for assertions. */
  readonly wire: { callId: string; from: 'agent' | 'peer'; text: string }[] = [];

  constructor(options: SimulationOptions) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private findPeer(to: string): ScriptedPeer | undefined {
    return this.options.peers.find((p) => p.number === to) ?? this.options.peers.find((p) => p.number === '*');
  }

  async dial(request: DialRequest): Promise<CallHandle> {
    const peer = this.findPeer(request.to);
    if (!peer) throw new Error(`simulation: nobody scripted at ${request.to}`);

    const handle: CallHandle = {
      id: `sim_${++this.counter}`,
      provider: this.name,
      to: request.to,
      direction: 'outbound',
      externalId: `sim-ext-${this.counter}`,
    };

    this.sessions.set(handle.id, {
      peer,
      replyIndex: 0,
      digitIndex: 0,
      lastHeard: '',
      ended: Boolean(peer.noAnswer),
    });

    return handle;
  }

  /** Register an inbound call, as a provider webhook would. */
  async receive(from: string): Promise<CallHandle> {
    const peer = this.findPeer(from);
    if (!peer) throw new Error(`simulation: nobody scripted at ${from}`);

    const handle: CallHandle = {
      id: `sim_in_${++this.counter}`,
      provider: this.name,
      to: from,
      direction: 'inbound',
    };

    this.sessions.set(handle.id, { peer, replyIndex: 0, digitIndex: 0, lastHeard: '', ended: false });
    return handle;
  }

  private session(handle: CallHandle): SessionState {
    const session = this.sessions.get(handle.id);
    if (!session) throw new Error(`simulation: unknown call ${handle.id}`);
    return session;
  }

  async say(handle: CallHandle, text: string): Promise<void> {
    const session = this.session(handle);
    session.lastHeard = text;
    this.wire.push({ callId: handle.id, from: 'agent', text });
    await this.pause();
  }

  async listen(handle: CallHandle): Promise<string | null> {
    const session = this.session(handle);
    await this.pause();

    if (session.ended || session.peer.noAnswer) return null;

    if (session.replyIndex === 0 && session.peer.greeting) {
      session.replyIndex = 1;
      this.wire.push({ callId: handle.id, from: 'peer', text: session.peer.greeting });
      return session.peer.greeting;
    }

    const scriptIndex = session.peer.greeting ? session.replyIndex - 1 : session.replyIndex;
    const entry = session.peer.replies[scriptIndex];
    session.replyIndex += 1;

    if (entry === undefined) {
      session.ended = true;
      return null;
    }

    const text = typeof entry === 'function' ? entry(session.lastHeard, scriptIndex) : entry;
    if (text === null) {
      session.ended = true;
      return null;
    }

    this.wire.push({ callId: handle.id, from: 'peer', text });
    return text;
  }

  async readDigits(handle: CallHandle, count: number): Promise<string | null> {
    const session = this.session(handle);
    await this.pause();

    const entry = session.peer.digits?.[session.digitIndex];
    session.digitIndex += 1;
    if (entry === undefined) return null;

    this.wire.push({ callId: handle.id, from: 'peer', text: `[dtmf ${entry}]` });
    return entry.slice(0, count);
  }

  async hangup(handle: CallHandle): Promise<void> {
    const session = this.sessions.get(handle.id);
    if (session) session.ended = true;
  }

  /** Everything said on one call, in order. */
  transcriptFor(callId: string): { from: 'agent' | 'peer'; text: string }[] {
    return this.wire.filter((entry) => entry.callId === callId).map(({ from, text }) => ({ from, text }));
  }

  private pause(): Promise<void> {
    const latency = this.options.latencyMs ?? 0;
    return latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve();
  }
}
