/**
 * A channel alias must not route around the registry. — #121
 *
 * #103 established that a hatched twin shares the device but never a MOUTH, and
 * #115 closed the Telegram half by refusing to `connect()` on a twin. Both
 * channels also guard their own send:
 *
 *   imessage.ts:654  if (!this.connected) throw ...
 *   telegram.ts:110  if (this.status !== 'connected') throw ...
 *
 * `MessageAgent` is loaded on every rappter including twins, and is described to
 * the model as "Send messages to people via iMessage, Telegram, Slack, Discord".
 * Its direct-send fallback bypassed all of the above. Measured against a
 * registry shaped like a twin's — telegram registered, never connected:
 *
 *   channelId=telegram -> "Telegram channel not connected"        guarded
 *   channelId=tg       -> "No TELEGRAM_BOT_TOKEN set"             DIRECT SENDER
 *
 * The registry holds it under `telegram`, so `get('tg')` missed and control fell
 * to `sendTelegramDirect`, which reads TELEGRAM_BOT_TOKEN from the environment
 * and POSTs to the Telegram API — no registry, no connection check, no twin
 * awareness. "No TELEGRAM_BOT_TOKEN set" is the proof the path was reached; it
 * stopped only because the token is unset here, the same configuration accident
 * that hid #115.
 *
 * #115 gated `connect()` and #120's structural test pins `.connect(` call sites.
 * Both are about CONNECTING, and this sends without ever connecting — so
 * neither could see it. Same shape as #113 -> #119 and #114 -> #118: the fix
 * addressed one case of a defect that was general.
 */

import { describe, it, expect } from 'vitest';
import { MessageAgent } from '../../agents/MessageAgent.js';

/** A registry shaped like a daemon's: channels registered, none connected. */
function twinRegistry() {
  const attempted: string[] = [];
  return {
    attempted,
    registry: {
      get: (id: string) => (['telegram', 'imessage'].includes(id) ? { id } : undefined),
      sendMessage: async ({ channelId }: { channelId: string }) => {
        attempted.push(channelId);
        throw new Error(`${channelId} channel is not connected`);
      },
    },
  };
}

async function send(agent: MessageAgent, channelId: string) {
  return String(await (agent as unknown as {
    perform(a: Record<string, unknown>): Promise<unknown>;
  }).perform({ action: 'send', channelId, conversationId: '000', content: 'probe' }));
}

describe('MessageAgent does not route around a registry that exists', () => {
  it('resolves `tg` to the registered telegram channel — the actual defect', async () => {
    const { registry, attempted } = twinRegistry();
    const out = await send(new MessageAgent(registry as never), 'tg');

    // It must reach the channel and be refused BY the channel, not slip past it.
    expect(attempted).toEqual(['telegram']);
    expect(out).toContain('not connected');
    // The tell that it reached the direct sender instead.
    expect(out).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('resolves `imsg` the same way', async () => {
    const { registry, attempted } = twinRegistry();
    const out = await send(new MessageAgent(registry as never), 'imsg');
    expect(attempted).toEqual(['imessage']);
    expect(out).toContain('not connected');
  });

  it('treats an unknown channel as a refusal, not a reason to try another road', async () => {
    // A registry that exists and lacks the channel is a "no". Falling through
    // to a direct sender on a lookup miss is what made the alias exploitable.
    const { registry, attempted } = twinRegistry();
    const out = await send(new MessageAgent(registry as never), 'slack');
    expect(attempted).toEqual([]);
    expect(out).toContain('Channel not found');
    expect(out).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('does not reach the direct sender when the registry simply lacks telegram', async () => {
    // The case that actually separates the two halves of the fix. `slack` could
    // not: with the miss falling through, the direct branch matches neither
    // telegram nor imessage and returns "Channel not found" anyway, so that
    // test passed against the broken code. A negative control caught it.
    //
    // Here the registry exists and has no telegram, so a fall-through WOULD
    // reach `sendTelegramDirect` and try to send with the environment token.
    const attempted: string[] = [];
    const registry = {
      get: (id: string) => (id === 'imessage' ? { id } : undefined),
      sendMessage: async ({ channelId }: { channelId: string }) => {
        attempted.push(channelId);
      },
    };

    for (const id of ['telegram', 'tg']) {
      const out = await send(new MessageAgent(registry as never), id);
      expect(out, id).toContain('Channel not found');
      expect(out, id).not.toContain('TELEGRAM_BOT_TOKEN');
    }
    expect(attempted).toEqual([]);
  });

  it('still sends directly when there is genuinely no registry', async () => {
    // Interactive mode. The fallback is legitimate here — there is nothing to
    // bypass — so the fix must not remove it, only stop it standing in for a
    // registry that said no.
    const out = await send(new MessageAgent(), 'tg');
    expect(out).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('keeps the canonical ids working', async () => {
    const { registry, attempted } = twinRegistry();
    await send(new MessageAgent(registry as never), 'telegram');
    await send(new MessageAgent(registry as never), 'imessage');
    // One registry, two sends — both must have reached their own channel.
    expect(attempted).toEqual(['telegram', 'imessage']);
  });
});
