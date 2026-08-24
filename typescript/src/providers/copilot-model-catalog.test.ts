import { describe, expect, it, vi } from 'vitest';
import { discoverCopilotModelCatalog } from './copilot-model-catalog.js';

describe('discoverCopilotModelCatalog', () => {
  it('returns only the endpoint catalog and its explicit default', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'allowed-one' },
        { id: 'allowed-two', is_default: true },
      ],
    }), { status: 200 }));
    await expect(discoverCopilotModelCatalog({
      resolved: {
        token: 'mock-api-token',
        expiresAt: Date.now() + 60_000,
        source: 'test',
        baseUrl: 'https://api.example',
      },
      fetchImpl,
    })).resolves.toEqual({
      catalog: {
        models: ['allowed-one', 'allowed-two'],
        defaultModel: 'allowed-two',
      },
      endpoint: 'https://api.example',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
