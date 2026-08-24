import { describe, expect, it, vi } from 'vitest';
import { CopilotModelStateService } from './copilot-model-state.js';

describe('CopilotModelStateService', () => {
  it('requires confirmation when an explicit configured model is unsupported', async () => {
    const service = new CopilotModelStateService();
    const state = await service.check({
      accountId: 'octocat',
      endpoint: 'https://api.example',
      configuredModel: 'unsupported-model',
      explicitConfigured: true,
      discover: async () => ({
        models: ['supported-model'],
        defaultModel: 'supported-model',
      }),
    });
    expect(state).toMatchObject({
      status: 'model-not-supported',
      code: 'COPILOT_MODEL_NOT_SUPPORTED',
      configuredModel: 'unsupported-model',
      recommendedModel: 'supported-model',
    });
    expect(state.selectedModel).toBeUndefined();
  });

  it('uses the endpoint default only when no model was explicitly configured', async () => {
    const service = new CopilotModelStateService();
    await expect(service.check({
      accountId: 'octocat',
      endpoint: 'https://api.example',
      explicitConfigured: false,
      discover: async () => ({
        models: ['endpoint-default', 'other-model'],
        defaultModel: 'endpoint-default',
      }),
    })).resolves.toMatchObject({
      status: 'ready',
      selectedModel: 'endpoint-default',
      explicitConfigured: false,
    });
  });

  it('reports empty and offline catalogs truthfully', async () => {
    const empty = new CopilotModelStateService();
    await expect(empty.check({
      accountId: 'one',
      endpoint: 'https://api.example',
      explicitConfigured: false,
      discover: async () => ({ models: [] }),
    })).resolves.toMatchObject({
      status: 'error',
      code: 'COPILOT_MODEL_CATALOG_EMPTY',
    });

    const offline = new CopilotModelStateService();
    await expect(offline.check({
      accountId: 'one',
      endpoint: 'https://api.example',
      explicitConfigured: false,
      discover: async () => {
        throw new TypeError('fetch failed');
      },
    })).resolves.toMatchObject({
      status: 'offline',
      code: 'COPILOT_MODEL_OFFLINE',
    });
  });

  it('deduplicates catalog calls and ignores a stale account race', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discover = vi.fn(async () => {
      await gate;
      return { models: ['old-model'], defaultModel: 'old-model' };
    });
    const service = new CopilotModelStateService();
    const first = service.check({
      accountId: 'old-account',
      endpoint: 'https://old.example',
      explicitConfigured: false,
      discover,
    });
    const duplicate = service.check({
      accountId: 'old-account',
      endpoint: 'https://old.example',
      explicitConfigured: false,
      discover,
    });
    expect(discover).toHaveBeenCalledOnce();
    service.invalidateCredential();
    release();
    await Promise.all([first, duplicate]);
    expect(service.current()).toMatchObject({ status: 'unknown' });
  });

  it('rolls selection back when atomic persistence fails', async () => {
    const service = new CopilotModelStateService();
    await service.check({
      accountId: 'octocat',
      endpoint: 'https://api.example',
      configuredModel: 'old-unsupported',
      explicitConfigured: true,
      discover: async () => ({
        models: ['new-supported'],
        defaultModel: 'new-supported',
      }),
    });
    await expect(service.select('new-supported', async () => {
      throw new Error('injected persistence failure');
    })).rejects.toThrow('could not be saved');
    expect(service.current()).toMatchObject({
      status: 'model-not-supported',
      configuredModel: 'old-unsupported',
    });
  });

  it('refreshes once to a new endpoint default for an unconfigured model', async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce({
        models: ['old-default'],
        defaultModel: 'old-default',
      })
      .mockResolvedValueOnce({
        models: ['new-default'],
        defaultModel: 'new-default',
      });
    const service = new CopilotModelStateService();
    await service.check({
      accountId: 'octocat',
      endpoint: 'https://api.example',
      explicitConfigured: false,
      discover,
    });
    await expect(service.refreshAfterUnsupported('old-default'))
      .resolves.toBe('new-default');
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
