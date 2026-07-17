import { describe, expect, it } from 'vitest';
import { IMessageChannel } from './imessage.js';
import {
  listGatewayChannelStatuses,
  readIMessageConfig,
} from './imessage-gateway.js';
import { ChannelRegistry } from './registry.js';

describe('iMessage gateway configuration', () => {
  it('reads only typed raw channels.imessage settings', () => {
    expect(readIMessageConfig({
      channels: {
        imessage: {
          enabled: true,
          mode: 'bluebubbles',
          allowFrom: ['+15551234567', 42],
          pollInterval: 1250.9,
          staleAfterMs: 900_000.9,
          ignored: 'value',
        },
      },
    })).toEqual({
      enabled: true,
      mode: 'bluebubbles',
      allowFrom: ['+15551234567'],
      pollInterval: 1250,
      staleAfterMs: 900_000,
    });
  });

  it('defaults malformed or absent settings to disabled and fail-closed', () => {
    expect(readIMessageConfig({
      channels: {
        imessage: {
          enabled: 'yes',
          mode: 'shell',
          allowFrom: 'everyone',
          pollInterval: 10,
          staleAfterMs: 10,
        },
      },
    })).toEqual({
      enabled: false,
      mode: 'applescript',
      allowFrom: [],
      pollInterval: undefined,
      staleAfterMs: undefined,
    });
  });

  it('lists exactly one real iMessage registry entry', () => {
    const registry = new ChannelRegistry();
    registry.register(new IMessageChannel({
      enabled: false,
      mode: 'applescript',
      allowFrom: [],
    }));

    const statuses = listGatewayChannelStatuses(registry);
    expect(statuses.filter(status => status.type === 'imessage')).toEqual([
      expect.objectContaining({
        id: 'imessage',
        connected: false,
        configured: false,
        running: false,
      }),
    ]);
  });
});
