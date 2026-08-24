import { gateway } from './gateway.js';
import { desktopBridge } from './desktop.js';

export type CopilotAuthStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'needs-sign-in'
  | 'no-entitlement'
  | 'offline'
  | 'error';

export type CopilotModelStatus =
  | 'unknown'
  | 'model-checking'
  | 'ready'
  | 'model-not-supported'
  | 'offline'
  | 'error';

export interface CopilotModelState {
  status: CopilotModelStatus;
  code:
    | 'COPILOT_MODEL_UNKNOWN'
    | 'COPILOT_MODEL_CHECKING'
    | 'COPILOT_MODEL_READY'
    | 'COPILOT_MODEL_NOT_SUPPORTED'
    | 'COPILOT_MODEL_SELECTION_REQUIRED'
    | 'COPILOT_MODEL_CATALOG_EMPTY'
    | 'COPILOT_MODEL_OFFLINE'
    | 'COPILOT_MODEL_ERROR';
  message: string;
  availableModels: string[];
  configuredModel?: string;
  selectedModel?: string;
  recommendedModel?: string;
  explicitConfigured: boolean;
  retryable: boolean;
}

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
  model?: CopilotModelState;
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

export async function retryCopilotModel(): Promise<CopilotModelState> {
  return gateway.call<CopilotModelState>('auth.model.retry');
}

export async function selectCopilotModel(
  model: string,
): Promise<CopilotModelState> {
  return gateway.call<CopilotModelState>('auth.model.select', { model });
}

export function copilotActionsReady(state: CopilotAuthState): boolean {
  return state.status === 'ready' && state.model?.status === 'ready';
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

export async function openCopilotVerification(
  flow: CopilotLoginFlow,
): Promise<void> {
  const desktop = desktopBridge();
  if (desktop) {
    await desktop.openGithubDeviceLogin();
    return;
  }
  const opened = window.open(
    flow.verificationUri,
    '_blank',
    'noopener,noreferrer',
  );
  if (!opened) {
    throw new Error('Allow pop-ups for this page, then try GitHub sign-in again.');
  }
}

/** Typed seam for XPedition #442; onboarding may finish only when this is true. */
export function copilotOnboardingStep(state: CopilotAuthState): {
  complete: boolean;
  status: CopilotAuthStatus;
  code: CopilotAuthState['code'];
  message: string;
  modelStatus: CopilotModelStatus;
  modelCode: CopilotModelState['code'];
  legacyAvailable: true;
} {
  return {
    complete: copilotActionsReady(state),
    status: state.status,
    code: state.code,
    message: state.message,
    modelStatus: state.model?.status ?? 'unknown',
    modelCode: state.model?.code ?? 'COPILOT_MODEL_UNKNOWN',
    legacyAvailable: true,
  };
}
