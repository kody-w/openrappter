/**
 * Chrome DevTools Protocol transport — the legs the Google Voice provider never had.
 *
 * The telephony stack has been complete above the wire for a while: it can
 * negotiate, evaluate constraints, decide, and escalate. What it could not do is
 * touch a phone line, because `GoogleVoiceDriver` was only ever a type. The only
 * implementation in the tree was a fake in a test file.
 *
 * WHY CDP AND NOT A BROWSER LIBRARY
 *
 * The point of the Google Voice path is that it costs nothing and keeps
 * everything on the machine. Adding Playwright or Puppeteer would pull a browser
 * download into a project that deliberately has neither, and would drive a
 * *fresh* profile — which is signed into nothing. The whole value here is the
 * session the owner already has.
 *
 * So this attaches to the owner's real Chrome over the DevTools Protocol using
 * `ws`, which openrappter already depends on. No new package, no second browser,
 * no credential stored anywhere: the cookie that authenticates Google Voice
 * stays in the owner's profile where it already was.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not start, restart, or kill the owner's browser. Chrome only exposes a
 * debugging port when it is started with one, and forcing that would mean
 * terminating a running browser and every unsaved thing in it. If the port is
 * not open, this reports exactly how to open it and stops. An automation layer
 * that closes your windows to get its job done is not a good trade.
 */

import { WebSocket } from 'ws';

export interface CdpOptions {
  /** DevTools port. Chrome must already be running with --remote-debugging-port. */
  port?: number;
  host?: string;
  /** Per-command timeout. */
  timeoutMs?: number;
}

export interface CdpTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

/** Thrown when Chrome is reachable but has no debugging port open. */
export class ChromeNotDebuggableError extends Error {
  constructor(port: number) {
    super(
      `No Chrome DevTools endpoint on port ${port}.\n` +
        `openrappter will not restart your browser to open one.\n\n` +
        `Quit Chrome, then start it once with:\n` +
        `  open -a "Google Chrome" --args --remote-debugging-port=${port}\n\n` +
        `Your profile, and the Google Voice session in it, are unchanged.`,
    );
    this.name = 'ChromeNotDebuggableError';
  }
}

/** A single attached page. Only what the Google Voice driver actually needs. */
export interface PageSurface {
  /** Evaluate an expression in the page and return its JSON value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
  /** Detach the debugger. The owner's tab is left exactly as it was. */
  close(): Promise<void>;
  /**
   * Close the actual browser tab.
   *
   * Only ever correct for a tab we opened ourselves. `close()` deliberately does
   * not do this: the common case is attaching to a tab the owner already had
   * open, and closing that would be destructive. But a tab we created and then
   * merely detached from is litter left in someone else's browser — which is the
   * same category of side effect as restarting it.
   */
  closeTab(): Promise<void>;
  /** True when this session opened the tab, rather than attaching to an existing one. */
  readonly opened: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class CdpPage implements PageSurface {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private readonly timeoutMs: number;
  private readonly targetId: string;
  private readonly endpoint: string;
  readonly opened: boolean;

  constructor(ws: WebSocket, timeoutMs: number, targetId: string, endpoint: string, opened: boolean) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.targetId = targetId;
    this.endpoint = endpoint;
    this.opened = opened;
    this.ws.on('message', (raw: Buffer | string) => this.onMessage(String(raw)));
    this.ws.on('close', () => this.failAll(new Error('DevTools connection closed')));
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
    else p.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // Google Voice is a trusted-types app; user-gesture context keeps
      // input events acceptable to it.
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`page threw: ${d}`);
    }
    return r.result?.value as T;
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    // Settle on the app being interactive rather than a fixed sleep, so a slow
    // machine is waited for and a fast one is not punished.
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.evaluate<boolean>('document.readyState === "complete"').catch(() => false);
      if (ready) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async close(): Promise<void> {
    // Closes the DevTools socket only. The owner's tab stays exactly as it was.
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  async closeTab(): Promise<void> {
    await this.close();
    try {
      await fetch(`${this.endpoint}/json/close/${this.targetId}`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* the tab is already gone, which is the outcome we wanted */
    }
  }
}

export class ChromeSession {
  private readonly port: number;
  private readonly host: string;
  private readonly timeoutMs: number;

  constructor(options: CdpOptions = {}) {
    this.port = options.port ?? 9222;
    this.host = options.host ?? '127.0.0.1';
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Is a DevTools endpoint listening? Never throws. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.targets();
      return true;
    } catch {
      return false;
    }
  }

  async targets(): Promise<CdpTarget[]> {
    const res = await fetch(`http://${this.host}:${this.port}/json/list`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (!res || !res.ok) throw new ChromeNotDebuggableError(this.port);
    return (await res.json()) as CdpTarget[];
  }

  /**
   * Attach to a tab whose URL matches, or open one. Reusing a matching tab
   * matters: the owner may already have Google Voice open, and opening a second
   * copy of a messaging app is a good way to send from the wrong thread.
   */
  async page(matchUrl: string, openIfMissing?: string): Promise<PageSurface> {
    const targets = await this.targets();
    let target = targets.find((t) => t.type === 'page' && t.url.includes(matchUrl));
    let opened = false;

    if (!target && openIfMissing) {
      opened = true;
      const res = await fetch(
        `http://${this.host}:${this.port}/json/new?${encodeURIComponent(openIfMissing)}`,
        { method: 'PUT', signal: AbortSignal.timeout(5000) },
      ).catch(() => null);
      if (res?.ok) target = (await res.json()) as CdpTarget;
      if (!target) {
        const again = await this.targets();
        target = again.find((t) => t.type === 'page' && t.url.includes(matchUrl));
      }
    }

    if (!target) throw new Error(`no Chrome tab matching "${matchUrl}"`);

    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('DevTools socket did not open')), this.timeoutMs);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', (e: Error) => {
        clearTimeout(t);
        reject(e);
      });
    });

    const page = new CdpPage(
      ws, this.timeoutMs, target.id, `http://${this.host}:${this.port}`, opened,
    );
    await page.evaluate('1');
    return page;
  }
}
