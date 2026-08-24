// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { copilotOnboardingStep } from '../services/copilot-auth.js';

describe('Copilot auth adapter contract', () => {
  it('allows XPedition onboarding to complete only when entitlement is ready', () => {
    expect(copilotOnboardingStep({
      status: 'ready',
      code: 'COPILOT_READY',
      message: 'ready',
      retryable: false,
      model: {
        status: 'ready',
        code: 'COPILOT_MODEL_READY',
        message: 'model ready',
        availableModels: ['verified-model'],
        selectedModel: 'verified-model',
        explicitConfigured: true,
        retryable: false,
      },
    })).toMatchObject({ complete: true, legacyAvailable: true });

    for (const state of [
      {
        status: 'needs-sign-in' as const,
        code: 'COPILOT_TOKEN_EXPIRED' as const,
      },
      {
        status: 'no-entitlement' as const,
        code: 'COPILOT_NO_ENTITLEMENT' as const,
      },
      {
        status: 'offline' as const,
        code: 'COPILOT_OFFLINE' as const,
      },
    ]) {
      expect(copilotOnboardingStep({
        ...state,
        message: 'unavailable',
        retryable: true,
      })).toMatchObject({
        complete: false,
        status: state.status,
        code: state.code,
        legacyAvailable: true,
      });
    }

    expect(copilotOnboardingStep({
      status: 'ready',
      code: 'COPILOT_READY',
      message: 'credential ready',
      retryable: false,
      model: {
        status: 'model-not-supported',
        code: 'COPILOT_MODEL_NOT_SUPPORTED',
        message: 'choose a supported model',
        availableModels: ['verified-model'],
        configuredModel: 'unsupported-model',
        explicitConfigured: true,
        retryable: true,
      },
    })).toMatchObject({
      complete: false,
      modelStatus: 'model-not-supported',
      modelCode: 'COPILOT_MODEL_NOT_SUPPORTED',
      legacyAvailable: true,
    });
  });
});
