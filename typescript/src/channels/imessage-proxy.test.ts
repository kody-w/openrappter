import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMessageProxyChannel } from './imessage-proxy.js';

const roots: string[] = [];

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openrappter-imessage-proxy-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('IMessageProxyChannel', () => {
  it('reports a fresh ready heartbeat as connected', () => {
    const root = home();
    const state = path.join(root, 'imessage', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({
      lifecycle: 'running',
      ready: true,
      updated_at: Date.now() / 1000,
      processed: 7,
    }));

    const channel = new IMessageProxyChannel(root);
    expect(channel.connected).toBe(true);
    expect(channel.getInfo().messageCount).toBe(7);
  });

  it('fails closed when the heartbeat is stale', () => {
    const root = home();
    const state = path.join(root, 'imessage', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({
      lifecycle: 'running',
      ready: true,
      updated_at: Date.now() / 1000 - 60,
    }));

    expect(new IMessageProxyChannel(root).connected).toBe(false);
  });

  it('rejects direct sends that bypass the privacy sidecar', async () => {
    const channel = new IMessageProxyChannel(home());
    await expect(channel.send('chat', {
      channel: 'imessage',
      content: 'hello',
    })).rejects.toThrow('trust-scoped');
  });
});
