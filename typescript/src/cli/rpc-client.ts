import WebSocket from 'ws';
import { VERSION } from '../version.js';

/** How long a single RPC may take before the client gives up. */
const RPC_TIMEOUT_MS = 30_000;

export class RpcClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private idCounter = 0;

  async connect(port = 18790, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws.on('open', async () => {
        try {
          // Send connect handshake
          await this.call('connect', {
            client: { id: 'cli', version: VERSION, platform: process.platform, mode: 'cli' },
            auth: token ? { token } : undefined,
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.ws.on('message', (data: Buffer) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'res' && frame.id) {
            const p = this.pending.get(frame.id);
            if (p) {
              this.pending.delete(frame.id);
              if (frame.ok) p.resolve(frame.payload);
              else p.reject(new Error(frame.error?.message ?? 'RPC error'));
            }
          }
        } catch {}
      });
      this.ws.on('error', reject);
    });
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) throw new Error('Not connected');
    const id = `cli_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      // The timeout must be cleared on every exit path. An un-cleared
      // setTimeout keeps the Node event loop alive, so the CLI printed its
      // result immediately and then sat for the full 30s before exiting --
      // the response had already arrived, but the timer still held the
      // process open. Clearing it in both settle paths is what lets the
      // command exit as soon as its work is done.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method} did not respond within 30s`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
