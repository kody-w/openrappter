/**
 * Presence / health controller.
 */
import type { GatewayClient } from './gateway.js';
import type { GatewayStatus, HealthResponse, ConnectionInfo } from '../types.js';

export interface PresenceState {
  client: GatewayClient | null;
  status: GatewayStatus | null;
  health: HealthResponse | null;
  connections: ConnectionInfo[];
  loading: boolean;
  error: string | null;
}

export function createPresenceState(): PresenceState {
  return {
    client: null,
    status: null,
    health: null,
    connections: [],
    loading: false,
    error: null,
  };
}

export async function loadStatus(state: PresenceState): Promise<void> {
  if (!state.client?.isConnected) return;
  state.loading = true;
  try {
    state.status = await state.client.call<GatewayStatus>('status');
    state.error = null;
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function loadHealth(state: PresenceState): Promise<void> {
  if (!state.client?.isConnected) return;
  try {
    state.health = await state.client.call<HealthResponse>('health');
  } catch (err) {
    state.error = String(err);
  }
}

export async function loadConnections(state: PresenceState): Promise<void> {
  if (!state.client?.isConnected) return;
  try {
    state.connections = await state.client.call<ConnectionInfo[]>('connections.list');
  } catch (err) {
    state.error = String(err);
  }
}
