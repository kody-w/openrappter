/**
 * Gateway WebSocket Client — matches the canonical `GatewayServer` wire
 * protocol (`typescript/src/gateway/server.ts`): frame-based messages of
 * the shape `{ type: 'req' | 'res' | 'event', ... }`, a `connect`
 * handshake that carries `client` info and an optional `auth` credential
 * (`{ token, password }`), and out-of-band `event` broadcasts.
 *
 * Streaming responses (`{ id, streaming: true, chunk?, done?, result?, error? }`)
 * mirror the server's `StreamingResponse` type (see gateway/types.ts) and
 * intentionally omit the `type` wrapper, matching that contract exactly.
 */

export type EventCallback = (data: unknown) => void;

/** Minimal structural subset of the DOM `WebSocket` this client depends on.
 * Allows deterministic test doubles to be injected via `webSocketImpl`
 * instead of monkey-patching `globalThis.WebSocket`. */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

interface GatewayLocation {
  protocol: string;
  host: string;
}

export function gatewayUrlFromLocation(
  location: GatewayLocation | undefined = globalThis.location,
  path = '',
): string {
  if (!location?.host) return '';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const normalizedPath = path
    ? `/${path.replace(/^\/+/, '')}`
    : '';
  return `${protocol}//${location.host}${normalizedPath}`;
}

export interface GatewayClientOptions {
  url?: string;
  token?: string;
  password?: string;
  maxReconnectAttempts?: number;
  /** Default timeout (ms) for request()/call()/callStream(). 0 disables. */
  requestTimeoutMs?: number;
  /** Inactivity timeout for streaming calls. Refreshed by every stream frame. */
  streamIdleTimeoutMs?: number;
  /** Hard upper bound for a streaming call, even while chunks are arriving. */
  streamOverallTimeoutMs?: number;
  /** Injectable WebSocket implementation for deterministic testing. */
  webSocketImpl?: WebSocketCtor;
}

export interface CancellationRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cancel?: CancellationRequest;
}

export interface StreamRequestOptions extends RequestOptions {
  /** Alias-compatible stream idle timeout; falls back to timeoutMs/default. */
  idleTimeoutMs?: number;
  /** Hard stream duration limit. 0 disables. */
  overallTimeoutMs?: number;
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

export interface StreamFrame {
  id: string;
  streaming: true;
  chunk?: string;
  toolOutput?: unknown;
  done?: boolean;
  error?: { code: number; message: string; data?: unknown };
  result?: unknown;
  /** Wire-compatibility alias for `result`. */
  payload?: unknown;
}

type StreamChunkCallback = (frame: StreamFrame) => void;

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  overallTimer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
  cancel?: CancellationRequest;
  onChunk?: StreamChunkCallback;
  idleTimeoutMs?: number;
  method?: string;
  generation: number;
  settled: boolean;
  streaming: boolean;
}

interface ConnectAttempt {
  generation: number;
  socket: WebSocketLike;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

class GatewayResponseError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'GatewayResponseError';
  }
}

const WS_OPEN = 1;

export class GatewayClient {
  private ws: WebSocketLike | null = null;
  private webSocketImpl?: WebSocketCtor;
  private url: string;
  private token: string | null;
  private password: string | null;
  private pendingRequests = new Map<string, PendingRequest>();
  private eventListeners = new Map<string, Set<EventCallback>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private baseDelay = 800;
  private maxDelay = 15_000;
  private connected = false;
  private authenticated = false;
  private stopped = false;
  private requestId = 0;
  private requestTimeoutMs: number;
  private streamIdleTimeoutMs: number;
  private streamOverallTimeoutMs: number;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAttempt: ConnectAttempt | null = null;
  private _onStatusChange: ((connected: boolean) => void) | null = null;
  connId: string | null = null;

  constructor(opts?: GatewayClientOptions) {
    const configuredUrl = import.meta.env.VITE_GATEWAY_URL;
    const configuredPath = import.meta.env.VITE_GATEWAY_PATH;
    this.url = opts?.url
      ?? configuredUrl
      ?? gatewayUrlFromLocation(globalThis.location, configuredPath);
    this.token = opts?.token
      ?? import.meta.env.VITE_GATEWAY_TOKEN
      ?? null;
    this.password = opts?.password
      ?? import.meta.env.VITE_GATEWAY_PASSWORD
      ?? null;
    this.maxReconnectAttempts = opts?.maxReconnectAttempts ?? 10;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 15_000;
    this.streamIdleTimeoutMs = opts?.streamIdleTimeoutMs ?? this.requestTimeoutMs;
    this.streamOverallTimeoutMs = opts?.streamOverallTimeoutMs ?? 10 * 60_000;
    this.webSocketImpl = opts?.webSocketImpl;
  }

  set onStatusChange(fn: ((connected: boolean) => void) | null) {
    this._onStatusChange = fn;
  }

  /** Update stored credentials without reconnecting. Used by authenticate()/
   * authenticateWithToken() and available for callers that want to prime
   * credentials before the first connect(). */
  setCredentials(creds: { token?: string | null; password?: string | null }): void {
    if (creds.token !== undefined) this.token = creds.token;
    if (creds.password !== undefined) this.password = creds.password;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.cancelReconnectTimer();
    if (this.isConnected) return;
    if (!this.url) {
      return Promise.reject(new Error('Gateway URL unavailable outside a browser'));
    }

    const WsCtor = this.webSocketImpl
      ?? ((globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket);
    if (!WsCtor) {
      return Promise.reject(new Error('No WebSocket implementation available'));
    }

    const previousSocket = this.ws;
    const previousAttempt = this.connectAttempt;
    const generation = ++this.generation;
    const superseded = new Error('Connection superseded');
    this.ws = null;
    this.connectAttempt = null;
    if (previousAttempt && !previousAttempt.settled) {
      previousAttempt.settled = true;
      previousAttempt.reject(superseded);
    }
    this.flushPending(superseded);
    previousSocket?.close();

    let socket: WebSocketLike;
    try {
      socket = new WsCtor(this.url);
      this.ws = socket;
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }

    return new Promise((resolve, reject) => {
      const attempt: ConnectAttempt = {
        generation,
        socket,
        settled: false,
        resolve,
        reject,
      };
      this.connectAttempt = attempt;

      socket.onopen = () => {
        if (generation !== this.generation || this.ws !== socket) return;
        this.performHandshake(generation).then(() => {
          if (
            attempt.settled
            || generation !== this.generation
            || this.ws !== socket
          ) {
            return;
          }
          attempt.settled = true;
          this.connectAttempt = null;
          attempt.resolve();
        }).catch((error: unknown) => {
          if (
            attempt.settled
            || generation !== this.generation
            || this.ws !== socket
          ) {
            return;
          }

          const failure = error instanceof Error ? error : new Error(String(error));
          attempt.settled = true;
          this.connectAttempt = null;
          attempt.reject(failure);

          // Keep an unauthorized socket open so authenticate() can retry the
          // handshake in place. Transport/protocol failures get a bounded
          // reconnect attempt instead.
          if (!(failure instanceof GatewayResponseError && failure.code === -32000)) {
            this.handleSocketTermination(generation, socket, failure);
            socket.close();
          }
        });
      };

      socket.onclose = () => {
        this.handleSocketTermination(
          generation,
          socket,
          new Error('Connection closed'),
        );
      };

      socket.onerror = () => {
        if (generation !== this.generation || this.ws !== socket) return;
        this.handleSocketTermination(
          generation,
          socket,
          new Error('WebSocket error'),
        );
        socket.close();
      };

      socket.onmessage = (ev) => {
        if (generation !== this.generation || this.ws !== socket) return;
        this.handleMessage(ev.data as string, generation);
      };
    });
  }

  /** Sends the `connect` handshake frame (client info + optional auth
   * credential) and waits for the server's ok/error response. Matches
   * `GatewayServer.handleConnect` exactly, including that it may be
   * re-sent on the same socket to retry with different credentials as
   * long as the connection has not yet authenticated. */
  private async performHandshake(generation = this.generation): Promise<void> {
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openrappter-ui',
        version: '1.0.0',
        platform: (globalThis as unknown as { navigator?: { platform?: string } }).navigator?.platform ?? 'web',
        mode: 'webchat',
      },
    };

    if (this.token || this.password) {
      params.auth = {
        ...(this.token ? { token: this.token } : {}),
        ...(this.password ? { password: this.password } : {}),
      };
    }

    const hello = await this.request<{ server?: { connId?: string } }>('connect', params);
    if (generation !== this.generation || !this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error('Connection replaced during handshake');
    }
    this.connId = hello?.server?.connId ?? null;
    this.authenticated = true;
    this.reconnectAttempts = 0;
    this.cancelReconnectTimer();
    this.setConnected(true);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this._onStatusChange?.(connected);
  }

  /** Authenticate (or re-authenticate) with a password. If the connection
   * has already completed its handshake this is a no-op that resolves
   * true; otherwise it retries the `connect` handshake on the existing
   * socket with the given password, per the canonical auth-retry flow. */
  async authenticate(password: string): Promise<boolean> {
    this.password = password;
    if (this.authenticated) return true;
    try {
      await this.performHandshake();
      return true;
    } catch {
      return false;
    }
  }

  async authenticateWithToken(token: string): Promise<boolean> {
    this.token = token;
    if (this.authenticated) return true;
    try {
      await this.performHandshake();
      return true;
    } catch {
      return false;
    }
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  disconnect(): void {
    this.stopped = true;
    this.cancelReconnectTimer();
    const socket = this.ws;
    ++this.generation;
    this.ws = null;
    if (this.connectAttempt && !this.connectAttempt.settled) {
      this.connectAttempt.settled = true;
      this.connectAttempt.reject(new Error('Connection closed'));
    }
    this.connectAttempt = null;
    this.authenticated = false;
    this.connId = null;
    this.setConnected(false);
    this.flushPending(new Error('Connection closed'));
    socket?.close();
  }

  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WS_OPEN;
  }

  private scheduleReconnect(): void {
    if (
      this.stopped
      || this.reconnectTimer
      || this.isConnected
      || this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseDelay * Math.pow(1.7, this.reconnectAttempts - 1),
      this.maxDelay,
    );
    const scheduledGeneration = this.generation;
    const timer = setTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      if (
        this.stopped
        || scheduledGeneration !== this.generation
        || this.isConnected
      ) {
        return;
      }
      this.connect().catch(() => {
        // Transport failures schedule the next bounded attempt.
      });
    }, delay);
    this.reconnectTimer = timer;
  }

  private cancelReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private handleSocketTermination(
    generation: number,
    socket: WebSocketLike,
    error: Error,
  ): void {
    if (generation !== this.generation || this.ws !== socket) return;
    this.ws = null;
    this.authenticated = false;
    this.connId = null;
    this.setConnected(false);

    const attempt = this.connectAttempt;
    if (attempt && attempt.generation === generation && !attempt.settled) {
      attempt.settled = true;
      attempt.reject(error);
      this.connectAttempt = null;
    }
    this.flushPending(error, generation);
    this.scheduleReconnect();
  }

  private flushPending(err: Error, generation?: number): void {
    for (const [id, p] of this.pendingRequests) {
      if (generation !== undefined && p.generation !== generation) continue;
      p.settled = true;
      this.clearPendingDeadlines(p);
      this.pendingRequests.delete(id);
      p.reject(err);
    }
  }

  private clearPendingDeadlines(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.overallTimer) clearTimeout(pending.overallTimer);
    pending.abortCleanup?.();
  }

  private takePending(id: string, generation: number): PendingRequest | undefined {
    const pending = this.pendingRequests.get(id);
    if (!pending || pending.settled || pending.generation !== generation) return undefined;
    pending.settled = true;
    this.pendingRequests.delete(id);
    this.clearPendingDeadlines(pending);
    return pending;
  }

  private rejectPending(
    id: string,
    generation: number,
    error: Error,
    cancelServerWork = false,
  ): void {
    const pending = this.takePending(id, generation);
    if (!pending) return;
    pending.reject(error);
    if (cancelServerWork && pending.cancel) {
      this.sendCancellation(pending.cancel);
    }
  }

  private sendCancellation(cancel: CancellationRequest): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const frame = {
      type: 'req',
      id: `cancel_${++this.requestId}_${Date.now()}`,
      method: cancel.method,
      params: cancel.params,
    };
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // Cancellation is best effort; the original request is already settled.
    }
  }

  private armIdleDeadline(
    id: string,
    pending: PendingRequest,
    timeoutMs: number,
    method: string,
  ): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = timeoutMs > 0
      ? setTimeout(() => {
        this.rejectPending(
          id,
          pending.generation,
          new Error(`Stream idle timed out: ${method}`),
          true,
        );
      }, timeoutMs)
      : undefined;
  }

  private handleMessage(raw: string, generation: number): void {
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
      this.handleResponse(frame as unknown as ResponseFrame, generation);
      return;
    }

    // Streaming deltas intentionally omit `type` (see StreamFrame contract).
    if (typeof frame.id === 'string' && frame.streaming === true) {
      this.handleStreamFrame(frame as unknown as StreamFrame, generation);
    }
  }

  private handleResponse(res: ResponseFrame, generation: number): void {
    const pending = this.takePending(res.id, generation);
    if (!pending) return;
    if (res.ok) {
      pending.resolve(res.payload);
    } else {
      pending.reject(new GatewayResponseError(
        res.error?.message ?? 'Request failed',
        res.error?.code,
      ));
    }
  }

  private handleStreamFrame(frame: StreamFrame, generation: number): void {
    const pending = this.pendingRequests.get(frame.id);
    if (!pending || pending.settled || pending.generation !== generation || !pending.streaming) return;

    if (frame.error) {
      const terminal = this.takePending(frame.id, generation);
      terminal?.reject(new Error(frame.error.message ?? 'Stream error'));
      return;
    }

    if (frame.done) {
      const terminal = this.takePending(frame.id, generation);
      if (!terminal) return;
      try {
        terminal.onChunk?.(frame);
        const result = Object.prototype.hasOwnProperty.call(frame, 'result')
          ? frame.result
          : frame.payload;
        terminal.resolve(result);
      } catch (error) {
        terminal.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    this.armIdleDeadline(
      frame.id,
      pending,
      pending.idleTimeoutMs ?? this.streamIdleTimeoutMs,
      pending.method ?? 'stream',
    );
    try {
      pending.onChunk?.(frame);
    } catch (error) {
      this.rejectPending(
        frame.id,
        generation,
        error instanceof Error ? error : new Error(String(error)),
        true,
      );
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
  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = `req_${++this.requestId}_${Date.now()}`;
    const frame = { type: 'req', id, method, params };
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const generation = this.generation;

    return new Promise<T>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error(`Request aborted: ${method}`));
        return;
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.rejectPending(id, generation, new Error(`Request timed out: ${method}`), true);
        }, timeoutMs)
        : undefined;

      const pending: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cancel: options?.cancel,
        generation,
        settled: false,
        streaming: false,
      };
      if (options?.signal) {
        const onAbort = () => {
          this.rejectPending(id, generation, new Error(`Request aborted: ${method}`), true);
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }
      this.pendingRequests.set(id, pending);

      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (e) {
        this.takePending(id, generation)?.reject(e as Error);
      }
    });
  }

  // Alias for backward compat
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    return this.request<T>(method, params, options);
  }

  /** Sends a request with `params.stream = true` and forwards each
   * streaming delta frame to `onChunk` as it arrives. Resolves with the
   * terminal frame's `result` (`payload` remains a wire alias), or rejects
   * on the first streaming error. */
  callStream<T = unknown>(
    method: string,
    params: Record<string, unknown> | undefined,
    onChunk: StreamChunkCallback,
    options?: StreamRequestOptions,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = `req_${++this.requestId}_${Date.now()}`;
    const frame = { type: 'req', id, method, params: { ...(params ?? {}), stream: true } };
    const idleTimeoutMs = options?.idleTimeoutMs
      ?? options?.timeoutMs
      ?? this.streamIdleTimeoutMs;
    const overallTimeoutMs = options?.overallTimeoutMs ?? this.streamOverallTimeoutMs;
    const generation = this.generation;

    return new Promise<T>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error(`Request aborted: ${method}`));
        return;
      }
      const pending: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        cancel: options?.cancel,
        onChunk: onChunk as StreamChunkCallback,
        generation,
        settled: false,
        streaming: true,
        idleTimeoutMs,
        method,
      };
      this.armIdleDeadline(id, pending, idleTimeoutMs, method);
      pending.overallTimer = overallTimeoutMs > 0
        ? setTimeout(() => {
          this.rejectPending(
            id,
            generation,
            new Error(`Stream overall timed out: ${method}`),
            true,
          );
        }, overallTimeoutMs)
        : undefined;
      if (options?.signal) {
        const onAbort = () => {
          this.rejectPending(id, generation, new Error(`Request aborted: ${method}`), true);
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }
      this.pendingRequests.set(id, pending);

      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (e) {
        this.takePending(id, generation)?.reject(e as Error);
      }
    });
  }

  // Subscribe to gateway events
  async subscribe(events: string[]): Promise<void> {
    await this.request('subscribe', { events });
  }

  async unsubscribe(events: string[]): Promise<void> {
    await this.request('unsubscribe', { events });
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
