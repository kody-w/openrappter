import type { IMessageConfig } from './imessage.js';
import type { ChannelRegistry, ChannelStatusInfo } from './registry.js';

const LEGACY_CHANNELS = [
  { id: 'signal', type: 'signal' },
  { id: 'matrix', type: 'matrix' },
  { id: 'teams', type: 'teams' },
  { id: 'googlechat', type: 'googlechat' },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readIMessageConfig(rawConfig: unknown): IMessageConfig {
  const root = isRecord(rawConfig) ? rawConfig : {};
  const channels = isRecord(root.channels) ? root.channels : {};
  const raw = isRecord(channels.imessage) ? channels.imessage : {};

  const mode =
    raw.mode === 'bluebubbles' || raw.mode === 'applescript'
      ? raw.mode
      : 'applescript';
  const pollInterval =
    typeof raw.pollInterval === 'number'
    && Number.isFinite(raw.pollInterval)
    && raw.pollInterval >= 250
      ? Math.floor(raw.pollInterval)
      : undefined;
  const staleAfterMs =
    typeof raw.staleAfterMs === 'number'
    && Number.isFinite(raw.staleAfterMs)
    && raw.staleAfterMs >= 60_000
    && raw.staleAfterMs <= 30 * 24 * 60 * 60 * 1000
      ? Math.floor(raw.staleAfterMs)
      : undefined;

  return {
    enabled: raw.enabled === true,
    mode,
    allowFrom: Array.isArray(raw.allowFrom)
      ? raw.allowFrom.filter((entry): entry is string => typeof entry === 'string')
      : [],
    pollInterval,
    staleAfterMs,
  };
}

export function listGatewayChannelStatuses(
  registry: ChannelRegistry,
): ChannelStatusInfo[] {
  const registered = registry.getStatusList();
  const legacy: ChannelStatusInfo[] = LEGACY_CHANNELS.map(channel => ({
    id: channel.id,
    type: channel.type,
    connected: false,
    configured: false,
    running: false,
    messageCount: 0,
  }));
  return [...registered, ...legacy];
}
