import {
  CopilotTokenError,
  resolveCopilotApiToken,
} from '../providers/copilot-token.js';
import type { CopilotModelState } from './copilot-model-state.js';

export type CopilotAuthStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'needs-sign-in'
  | 'no-entitlement'
  | 'offline'
  | 'error';

export type CopilotAuthCode =
  | 'COPILOT_AUTH_UNKNOWN'
  | 'COPILOT_AUTH_CHECKING'
  | 'COPILOT_READY'
  | 'COPILOT_SIGN_IN_REQUIRED'
  | 'COPILOT_HTTP_401'
  | 'COPILOT_HTTP_403'
  | 'COPILOT_TOKEN_EXPIRED'
  | 'COPILOT_NO_ENTITLEMENT'
  | 'COPILOT_OFFLINE'
  | 'COPILOT_AUTH_CANCELLED'
  | 'COPILOT_AUTH_TIMEOUT'
  | 'COPILOT_AUTH_ERROR';

export interface CopilotAuthState {
  status: CopilotAuthStatus;
  code: CopilotAuthCode;
  message: string;
  retryable: boolean;
  action?: 'sign-in' | 'retry';
  username?: string;
  checkedAt?: string;
  model?: CopilotModelState;
}

export const INITIAL_COPILOT_AUTH_STATE: CopilotAuthState = {
  status: 'unknown',
  code: 'COPILOT_AUTH_UNKNOWN',
  message: 'GitHub Copilot access has not been checked yet.',
  retryable: true,
  action: 'retry',
};

export class CopilotAuthUnavailableError extends Error {
  readonly state: CopilotAuthState;

  constructor(state: CopilotAuthState) {
    super(state.message);
    this.name = 'CopilotAuthUnavailableError';
    this.state = state;
  }
}

function checked(state: Omit<CopilotAuthState, 'checkedAt'>): CopilotAuthState {
  return { ...state, checkedAt: new Date().toISOString() };
}

export function classifyCopilotAuthFailure(error: unknown): CopilotAuthState {
  if (error instanceof CopilotAuthUnavailableError) return error.state;

  if (error instanceof CopilotTokenError) {
    if (error.reason === 'http-401') {
      return checked({
        status: 'needs-sign-in',
        code: 'COPILOT_HTTP_401',
        message: 'GitHub rejected this credential (HTTP 401). Sign in again to use Copilot.',
        retryable: true,
        action: 'sign-in',
      });
    }
    if (error.reason === 'http-403') {
      return checked({
        status: 'no-entitlement',
        code: 'COPILOT_HTTP_403',
        message: 'GitHub denied Copilot access (HTTP 403). Verify the selected account or sign in again.',
        retryable: true,
        action: 'sign-in',
      });
    }
    if (error.reason === 'expired-token') {
      return checked({
        status: 'needs-sign-in',
        code: 'COPILOT_TOKEN_EXPIRED',
        message: 'Your GitHub sign-in expired or was revoked. Sign in again to use Copilot.',
        retryable: true,
        action: 'sign-in',
      });
    }
    if (error.reason === 'no-entitlement') {
      return checked({
        status: 'no-entitlement',
        code: 'COPILOT_NO_ENTITLEMENT',
        message: 'This GitHub account does not have Copilot API access. Sign in with a Copilot-enabled account.',
        retryable: true,
        action: 'sign-in',
      });
    }
    if (error.reason === 'offline') {
      return checked({
        status: 'offline',
        code: 'COPILOT_OFFLINE',
        message: 'Copilot could not be reached. Local health and estate tools remain available.',
        retryable: true,
        action: 'retry',
      });
    }
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return checked({
      status: 'needs-sign-in',
      code: 'COPILOT_AUTH_CANCELLED',
      message: 'GitHub Copilot sign-in was cancelled.',
      retryable: true,
      action: 'sign-in',
    });
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/timed?\s*out|device code expired/.test(message)) {
    return checked({
      status: 'needs-sign-in',
      code: 'COPILOT_AUTH_TIMEOUT',
      message: 'GitHub Copilot sign-in timed out. Try signing in again.',
      retryable: true,
      action: 'sign-in',
    });
  }
  if (/cancel|access_denied/.test(message)) {
    return checked({
      status: 'needs-sign-in',
      code: 'COPILOT_AUTH_CANCELLED',
      message: 'GitHub Copilot sign-in was cancelled.',
      retryable: true,
      action: 'sign-in',
    });
  }
  if (/network|fetch failed|enotfound|econnrefused|offline/.test(message)) {
    return checked({
      status: 'offline',
      code: 'COPILOT_OFFLINE',
      message: 'Copilot could not be reached. Local health and estate tools remain available.',
      retryable: true,
      action: 'retry',
    });
  }
  if (/\b403\b|no entitlement|does not have copilot/.test(message)) {
    return checked({
      status: 'no-entitlement',
      code: 'COPILOT_NO_ENTITLEMENT',
      message: 'This GitHub account does not have Copilot API access. Sign in with a Copilot-enabled account.',
      retryable: true,
      action: 'sign-in',
    });
  }
  if (/\b401\b|expired|revoked|not authenticated/.test(message)) {
    return checked({
      status: 'needs-sign-in',
      code: 'COPILOT_TOKEN_EXPIRED',
      message: 'Your GitHub sign-in expired or was revoked. Sign in again to use Copilot.',
      retryable: true,
      action: 'sign-in',
    });
  }

  return checked({
    status: 'error',
    code: 'COPILOT_AUTH_ERROR',
    message: 'GitHub Copilot authentication could not be verified.',
    retryable: true,
    action: 'retry',
  });
}

export class CopilotAuthStateService {
  private state: CopilotAuthState = INITIAL_COPILOT_AUTH_STATE;
  private generation = 0;
  private active?: {
    generation: number;
    token: string;
    controller: AbortController;
    promise: Promise<CopilotAuthState>;
  };

  constructor(
    private readonly validateAccess: (
      token: string,
      signal?: AbortSignal,
    ) => Promise<unknown> = (token, signal) =>
      resolveCopilotApiToken({ githubToken: token, signal }),
  ) {}

  current(): CopilotAuthState {
    return { ...this.state };
  }

  captureGeneration(): number {
    return this.generation;
  }

  advanceGeneration(): number {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = undefined;
    return this.generation;
  }

  checking(generation = this.generation): CopilotAuthState {
    if (generation !== this.generation) return this.current();
    this.state = {
      status: 'checking',
      code: 'COPILOT_AUTH_CHECKING',
      message: 'Verifying GitHub Copilot access…',
      retryable: false,
    };
    return this.current();
  }

  markReady(
    username?: string,
    generation = this.generation,
  ): CopilotAuthState {
    if (generation !== this.generation) return this.current();
    this.state = checked({
      status: 'ready',
      code: 'COPILOT_READY',
      message: username
        ? `GitHub Copilot is ready for ${username}.`
        : 'GitHub Copilot is ready.',
      retryable: false,
      ...(username ? { username } : {}),
    });
    return this.current();
  }

  needsSignIn(
    code: 'COPILOT_SIGN_IN_REQUIRED' | 'COPILOT_AUTH_CANCELLED' =
      'COPILOT_SIGN_IN_REQUIRED',
    advance = true,
  ): CopilotAuthState {
    if (advance) this.advanceGeneration();
    this.state = checked({
      status: 'needs-sign-in',
      code,
      message: code === 'COPILOT_AUTH_CANCELLED'
        ? 'GitHub Copilot sign-in was cancelled.'
        : 'Sign in with a GitHub account that has Copilot enabled.',
      retryable: true,
      action: 'sign-in',
    });
    return this.current();
  }

  reportFailure(
    error: unknown,
    generation = this.generation,
  ): CopilotAuthState {
    if (generation !== this.generation) return this.current();
    this.state = classifyCopilotAuthFailure(error);
    return this.current();
  }

  async check(
    token: string | null | undefined,
    username?: string,
    options: {
      generation?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<CopilotAuthState> {
    const generation = options.generation ?? this.generation;
    if (generation !== this.generation) return this.current();
    if (!token) return this.needsSignIn('COPILOT_SIGN_IN_REQUIRED', false);
    if (
      this.active
      && this.active.generation === generation
      && this.active.token === token
    ) return this.active.promise;

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
    this.checking(generation);
    const operation = {
      generation,
      token,
      controller,
      promise: Promise.resolve(this.current()),
    };
    operation.promise = (async () => {
      try {
        await this.validateAccess(token, controller.signal);
        if (
          generation === this.generation
          && !controller.signal.aborted
        ) this.markReady(username, generation);
      } catch (error) {
        if (
          generation === this.generation
          && !controller.signal.aborted
        ) this.reportFailure(error, generation);
      } finally {
        options.signal?.removeEventListener('abort', abort);
        if (this.active === operation) this.active = undefined;
      }
      return this.current();
    })();
    this.active = operation;
    return operation.promise;
  }

  requireReady(): void {
    if (this.state.status !== 'ready') {
      throw new CopilotAuthUnavailableError(this.current());
    }
  }
}
