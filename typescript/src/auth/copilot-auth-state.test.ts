import { describe, expect, it, vi } from 'vitest';
import { CopilotTokenError } from '../providers/copilot-token.js';
import {
  CopilotAuthStateService,
  classifyCopilotAuthFailure,
} from './copilot-auth-state.js';

describe('CopilotAuthStateService', () => {
  it.each([
    [new CopilotTokenError('http-401', 401), 'needs-sign-in', 'COPILOT_HTTP_401'],
    [new CopilotTokenError('http-403', 403), 'no-entitlement', 'COPILOT_HTTP_403'],
    [new CopilotTokenError('expired-token', 401), 'needs-sign-in', 'COPILOT_TOKEN_EXPIRED'],
    [new CopilotTokenError('no-entitlement', 403), 'no-entitlement', 'COPILOT_NO_ENTITLEMENT'],
    [new CopilotTokenError('offline'), 'offline', 'COPILOT_OFFLINE'],
    [new DOMException('cancelled', 'AbortError'), 'needs-sign-in', 'COPILOT_AUTH_CANCELLED'],
    [new Error('device code expired'), 'needs-sign-in', 'COPILOT_AUTH_TIMEOUT'],
  ] as const)('classifies %s safely', (error, status, code) => {
    expect(classifyCopilotAuthFailure(error)).toMatchObject({ status, code });
  });

  it('marks ready only after Copilot accepts the credential', async () => {
    const validate = vi.fn(async () => undefined);
    const auth = new CopilotAuthStateService(validate);

    await expect(auth.check('mock-github-token', 'octocat')).resolves.toMatchObject({
      status: 'ready',
      code: 'COPILOT_READY',
      username: 'octocat',
    });
    expect(validate).toHaveBeenCalledOnce();
  });

  it('supports retry after an offline check', async () => {
    const validate = vi.fn()
      .mockRejectedValueOnce(new CopilotTokenError('offline'))
      .mockResolvedValueOnce(undefined);
    const auth = new CopilotAuthStateService(validate);

    expect(await auth.check('mock-github-token')).toMatchObject({ status: 'offline' });
    expect(await auth.check('mock-github-token')).toMatchObject({ status: 'ready' });
  });

  it('deduplicates concurrent checks and never exposes the credential', async () => {
    let finish!: () => void;
    const validate = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const auth = new CopilotAuthStateService(validate);
    const first = auth.check('mock-secret-token');
    const second = auth.check('mock-secret-token');
    finish();
    const states = await Promise.all([first, second]);

    expect(validate).toHaveBeenCalledOnce();
    expect(JSON.stringify(states)).not.toContain('mock-secret-token');
  });

  it('redacts unknown provider errors to a stable safe message', () => {
    const secret = 'ghu_mock_private_value';
    const state = classifyCopilotAuthFailure(
      new Error(`provider failed with token ${secret}`),
    );
    expect(state.code).toBe('COPILOT_AUTH_ERROR');
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it('does not let a late ready completion cross a credential generation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = new CopilotAuthStateService(async () => {
      await gate;
    });
    const generation = auth.captureGeneration();
    const pending = auth.check('stale-token', 'stale-user', { generation });

    auth.advanceGeneration();
    auth.needsSignIn('COPILOT_SIGN_IN_REQUIRED', false);
    release();

    await expect(pending).resolves.toMatchObject({
      status: 'needs-sign-in',
    });
    expect(auth.current()).toMatchObject({
      status: 'needs-sign-in',
      code: 'COPILOT_SIGN_IN_REQUIRED',
    });
  });
});
