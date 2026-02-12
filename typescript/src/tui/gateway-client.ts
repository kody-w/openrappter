import { EventEmitter } from 'events';
import WebSocket from 'ws';

export class TuiGatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private idCounter = 0;
  connected = false;

  async connect(url: string, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', async () => {
        try {
          await this.call('connect', {
            client: { id: 'tui', version: '1.4.0', platform: process.platform, mode: 'tui' },
            auth: token ? { token } : undefined,
          });
          this.connected = true;
          this.emit('connected');
          resolve();
        } catch (e) { reject(e); }
      });
      this.ws.on('message', (data: Buffer) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'res' && frame.id) {
            const p = this.pending.get(frame.id);
            if (p) { this.pending.delete(frame.id); frame.ok ? p.resolve(frame.payload) : p.reject(new Error(frame.error?.message)); }
          } else if (frame.type === 'event') {
            this.emit(frame.event, frame.payload);
          }
        } catch {}
      });
      this.ws.on('close', () => { this.connected = false; this.emit('disconnected'); });
      this.ws.on('error', (err) => { this.emit('error', err); reject(err); });
    });
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) throw new Error('Not connected');
    const id = `tui_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Timeout')); } }, 30000);
    });
  }

  subscribe(events: string[]): Promise<unknown> { return this.call('subscribe', { events }); }
  disconnect(): void { if (this.ws) { this.ws.close(); this.ws = null; } }
}
