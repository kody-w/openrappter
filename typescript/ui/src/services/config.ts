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

export interface ReviewedConfigPayload {
  schema: 'openrappter-reviewed-config/1.0';
  action: 'config.set';
  raw: string;
  format: 'yaml' | 'json';
  baseHash: string;
  reviewedConfigHash: string;
  payloadHash: string;
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure config review hashing is unavailable.');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function reviewConfigPayload(
  raw: string,
  format: 'yaml' | 'json',
  baseHash: string,
): Promise<Readonly<ReviewedConfigPayload>> {
  if (typeof raw !== 'string' || typeof baseHash !== 'string' || baseHash === '') {
    throw new Error('Config review requires an exact snapshot and current base hash.');
  }
  const reviewedConfigHash = await sha256(raw);
  const canonical = JSON.stringify({
    schema: 'openrappter-reviewed-config/1.0',
    action: 'config.set',
    raw,
    format,
    baseHash,
    reviewedConfigHash,
  });
  const payloadHash = await sha256(canonical);
  return Object.freeze({
    schema: 'openrappter-reviewed-config/1.0',
    action: 'config.set',
    raw,
    format,
    baseHash,
    reviewedConfigHash,
    payloadHash,
  });
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

export async function saveReviewedConfig(
  state: ConfigState,
  reviewed: Readonly<ReviewedConfigPayload>,
): Promise<boolean> {
  if (!state.client?.isConnected) return false;
  state.saving = true;
  state.error = null;
  try {
    const local = await reviewConfigPayload(
      state.raw,
      state.format,
      reviewed.baseHash,
    );
    if (
      local.raw !== reviewed.raw ||
      local.format !== reviewed.format ||
      local.reviewedConfigHash !== reviewed.reviewedConfigHash ||
      local.payloadHash !== reviewed.payloadHash ||
      reviewed.action !== 'config.set'
    ) {
      throw new Error(
        'Pending config approval is stale because the reviewed payload changed. Re-review required.',
      );
    }
    const current = await state.client.call<ConfigSnapshot>('config.get', {});
    if (current.hash !== reviewed.baseHash) {
      throw new Error(
        'Pending config approval is stale because the base config changed. Re-review required.',
      );
    }
    await state.client.call('config.set', {
      raw: reviewed.raw,
      baseHash: reviewed.baseHash,
    });
    state.dirty = false;
    await loadConfig(state);
    return true;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
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
