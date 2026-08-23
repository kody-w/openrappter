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
  });
});
