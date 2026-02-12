import WebSocket from 'ws';

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
            client: { id: 'cli', version: '1.4.0', platform: process.platform, mode: 'cli' },
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
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('RPC timeout'));
        }
      }, 30000);
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
