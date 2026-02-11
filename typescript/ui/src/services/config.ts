/**
 * Config controller — load, save, and apply configuration.
 */
import type { GatewayClient } from './gateway.js';
import type { ConfigSnapshot } from '../types.js';

export interface ConfigState {
  client: GatewayClient | null;
  raw: string;
  hash: string;
  format: 'yaml' | 'json';
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export function createConfigState(): ConfigState {
  return {
    client: null,
    raw: '',
    hash: '',
    format: 'yaml',
    dirty: false,
    loading: false,
    saving: false,
    error: null,
  };
}

export async function loadConfig(state: ConfigState): Promise<void> {
  if (!state.client?.isConnected) return;
  state.loading = true;
  state.error = null;
  try {
    const snap = await state.client.call<ConfigSnapshot>('config.get', {});
    state.raw = snap.raw ?? '';
    state.hash = snap.hash ?? '';
    state.format = snap.format ?? 'yaml';
    state.dirty = false;
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function saveConfig(state: ConfigState): Promise<boolean> {
  if (!state.client?.isConnected) return false;
  state.saving = true;
  state.error = null;
  try {
    await state.client.call('config.set', {
      raw: state.raw,
      baseHash: state.hash,
    });
    state.dirty = false;
    // Reload to get new hash
    await loadConfig(state);
    return true;
  } catch (err) {
    state.error = String(err);
    return false;
  } finally {
    state.saving = false;
  }
}

export async function applyConfig(state: ConfigState): Promise<boolean> {
  if (!state.client?.isConnected) return false;
  state.saving = true;
  state.error = null;
  try {
    await state.client.call('config.apply', {
      raw: state.raw,
      baseHash: state.hash,
    });
    state.dirty = false;
    await loadConfig(state);
    return true;
  } catch (err) {
    state.error = String(err);
    return false;
  } finally {
    state.saving = false;
  }
}

export function updateConfigRaw(state: ConfigState, raw: string): void {
  state.raw = raw;
  state.dirty = true;
}

export function resetConfig(state: ConfigState, original: string): void {
  state.raw = original;
  state.dirty = false;
}
