import { gateway } from './gateway.js';

export type CopilotAuthStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'needs-sign-in'
  | 'no-entitlement'
  | 'offline'
  | 'error';

export interface CopilotAuthState {
  status: CopilotAuthStatus;
  code:
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
  message: string;
  retryable: boolean;
  action?: 'sign-in' | 'retry';
  username?: string;
  checkedAt?: string;
}

export interface CopilotLoginFlow {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
}

export interface CopilotLoginPoll {
  status: 'pending' | 'success' | 'error';
  username?: string;
  error?: string;
  auth: CopilotAuthState;
}

const offlineState: CopilotAuthState = {
  status: 'offline',
  code: 'COPILOT_OFFLINE',
  message: 'Copilot could not be reached. Local health and estate tools remain available.',
  retryable: true,
  action: 'retry',
};

let activeFlow: CopilotLoginFlow | null = null;
let startingFlow: Promise<CopilotLoginFlow> | null = null;

export async function loadCopilotAuthState(): Promise<CopilotAuthState> {
  try {
    const state = await gateway.call<CopilotAuthState>('auth.status');
    return state.status === 'unknown'
      ? gateway.call<CopilotAuthState>('auth.check')
      : state;
  } catch {
    return offlineState;
  }
}

export async function retryCopilotAuth(): Promise<CopilotAuthState> {
  try {
    return await gateway.call<CopilotAuthState>('auth.check');
  } catch {
    return offlineState;
  }
}

export function beginCopilotSignIn(): Promise<CopilotLoginFlow> {
  if (activeFlow) return Promise.resolve(activeFlow);
  if (startingFlow) return startingFlow;
  startingFlow = gateway.call<CopilotLoginFlow>('auth.login')
    .then((flow) => {
      activeFlow = flow;
      return flow;
    })
    .finally(() => {
      startingFlow = null;
    });
  return startingFlow;
}

export async function pollCopilotSignIn(
  flow: CopilotLoginFlow,
): Promise<CopilotLoginPoll> {
  const result = await gateway.call<CopilotLoginPoll>('auth.poll', {
    deviceCode: flow.deviceCode,
  });
  if (result.status !== 'pending') activeFlow = null;
  return result;
}

export async function cancelCopilotSignIn(
  flow: CopilotLoginFlow,
): Promise<void> {
  if (activeFlow?.deviceCode === flow.deviceCode) activeFlow = null;
  await gateway.call('auth.cancel', { deviceCode: flow.deviceCode });
}

/** Typed seam for XPedition #442; onboarding may finish only when this is true. */
export function copilotOnboardingStep(state: CopilotAuthState): {
  complete: boolean;
  status: CopilotAuthStatus;
  code: CopilotAuthState['code'];
  message: string;
  legacyAvailable: true;
} {
  return {
    complete: state.status === 'ready',
    status: state.status,
    code: state.code,
    message: state.message,
    legacyAvailable: true,
  };
}
