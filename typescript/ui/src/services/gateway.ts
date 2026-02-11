/**
 * Gateway WebSocket Client — frame-based protocol (type: req/res/event)
 * with connect handshake, event subscriptions, and reconnect backoff.
 */

export type EventCallback = (data: unknown) => void;

export interface GatewayClientOptions {
  url?: string;
  token?: string;
  password?: string;
  maxReconnectAttempts?: number;
}

interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string | null;
  private password: string | null;
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventListeners = new Map<string, Set<EventCallback>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private baseDelay = 800;
  private maxDelay = 15_000;
  private connected = false;
  private stopped = false;
  private requestId = 0;
  private _onStatusChange: ((connected: boolean) => void) | null = null;
  connId: string | null = null;

  constructor(opts?: GatewayClientOptions) {
    this.url = opts?.url ?? `ws://${globalThis.location?.hostname ?? 'localhost'}:18789`;
    this.token = opts?.token ?? null;
    this.password = opts?.password ?? null;
    this.maxReconnectAttempts = opts?.maxReconnectAttempts ?? 10;
  }

  set onStatusChange(fn: ((connected: boolean) => void) | null) {
    this._onStatusChange = fn;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }

      this.ws.onopen = async () => {
        this.reconnectAttempts = 0;
        try {
          await this.sendConnect();
          this.connected = true;
          this._onStatusChange?.(true);
          if (!settled) { settled = true; resolve(); }
        } catch (e) {
          if (!settled) { settled = true; reject(e); }
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this._onStatusChange?.(false);
        this.flushPending(new Error('Connection closed'));
        if (!this.stopped) this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('WebSocket error')); }
      };

      this.ws.onmessage = (ev) => {
        this.handleMessage(ev.data as string);
      };
    });
  }

  private async sendConnect(): Promise<void> {
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openrappter-ui',
        version: '1.0.0',
        platform: navigator.platform ?? 'web',
        mode: 'webchat',
      },
    };

    if (this.token || this.password) {
      params.auth = {
        ...(this.token ? { token: this.token } : {}),
        ...(this.password ? { password: this.password } : {}),
      };
    }

    const hello = await this.request<{ connId?: string; server?: { connId?: string } }>('connect', params);
    this.connId = (hello as any)?.server?.connId ?? null;
  }

  disconnect(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseDelay * Math.pow(1.7, this.reconnectAttempts - 1),
      this.maxDelay,
    );
    setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch(() => {
        // Reconnect failures handled by onclose → scheduleReconnect
      });
    }, delay);
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pendingRequests) {
      p.reject(err);
    }
    this.pendingRequests.clear();
  }

  private handleMessage(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.type === 'event') {
      this.handleEvent(frame as unknown as EventFrame);
      return;
    }

    if (frame.type === 'res') {
      this.handleResponse(frame as unknown as ResponseFrame);
      return;
    }
  }

  private handleResponse(res: ResponseFrame): void {
    const pending = this.pendingRequests.get(res.id);
    if (!pending) return;
    this.pendingRequests.delete(res.id);
    if (res.ok) {
      pending.resolve(res.payload);
    } else {
      pending.reject(new Error(res.error?.message ?? 'Request failed'));
    }
  }

  private handleEvent(evt: EventFrame): void {
    const listeners = this.eventListeners.get(evt.event);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(evt.payload); } catch { /* swallow */ }
      }
    }
    const wildcardListeners = this.eventListeners.get('*');
    if (wildcardListeners) {
      for (const cb of wildcardListeners) {
        try { cb({ event: evt.event, payload: evt.payload }); } catch { /* swallow */ }
      }
    }
  }

  // Send a request and await its response
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = `req_${++this.requestId}_${Date.now()}`;
    const frame = { type: 'req', id, method, params };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  // Alias for backward compat
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>(method, params);
  }

  // Subscribe to gateway events
  async subscribe(events: string[]): Promise<void> {
    await this.request('subscribe', { events });
  }

  on(event: string, callback: EventCallback): void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }
}

// Singleton
export const gateway = new GatewayClient();
