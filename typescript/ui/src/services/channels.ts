/**
 * Channels controller — load status, send messages.
 */
import type { GatewayClient } from './gateway.js';
import type { ChannelStatus, SendMessageRequest } from '../types.js';

export interface ChannelsState {
  client: GatewayClient | null;
  channels: ChannelStatus[];
  loading: boolean;
  error: string | null;
}

export function createChannelsState(): ChannelsState {
  return { client: null, channels: [], loading: false, error: null };
}

export async function loadChannels(state: ChannelsState): Promise<void> {
  if (!state.client?.isConnected) return;
  state.loading = true;
  state.error = null;
  try {
    state.channels = await state.client.call<ChannelStatus[]>('channels.list');
  } catch (err) {
    state.error = String(err);
    state.channels = [];
  } finally {
    state.loading = false;
  }
}

export async function sendChannelMessage(
  client: GatewayClient,
  req: SendMessageRequest,
): Promise<boolean> {
  if (!client.isConnected) return false;
  const res = await client.call<{ sent: boolean }>('channels.send', req as unknown as Record<string, unknown>);
  return res.sent;
}
