import { desktopBridge } from './desktop.js';
import { gateway } from './gateway.js';

export type PatientTransportStatus =
  | 'checking'
  | 'ready'
  | 'offline'
  | 'cors-blocked'
  | 'unauthorized'
  | 'timeout'
  | 'server-error';

export interface PatientTransportState {
  status: PatientTransportStatus;
  message: string;
  retryable: boolean;
}

export interface PatientReply {
  response: string;
  session_id: string;
  agent_logs: string;
  voice_response?: string;
  model?: string;
}

type TransportResult = {
  status: number;
  body: string;
  error?: 'offline' | 'cors-blocked' | 'timeout' | 'server-error';
};

export const PATIENT_TURN_TIMEOUT_MS = 15 * 60_000;
export const PATIENT_PROBE_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

let state: PatientTransportState = {
  status: 'checking',
  message: 'Checking gateway health on the patient chat transport…',
  retryable: false,
};
let probePromise: Promise<PatientTransportState> | undefined;
let activeTurn: Promise<PatientReply> | undefined;
let activeController: AbortController | undefined;

export function getPatientTransportState(): PatientTransportState {
  return { ...state };
}

export function cancelPatientRequest(): void {
  activeController?.abort();
  activeController = undefined;
  const desktop = desktopBridge();
  if (desktop) void desktop.patientChat({ action: 'cancel' }).catch(() => undefined);
}

export function probePatientTransport(
  _force = false,
): Promise<PatientTransportState> {
  if (probePromise) return probePromise;
  state = {
    status: 'checking',
    message: 'Checking gateway health on the patient chat transport…',
    retryable: false,
  };
  probePromise = (async () => {
    const result = await executeTransport({ action: 'probe' }, PATIENT_PROBE_TIMEOUT_MS);
    state = classifyTransport(result, true);
    return getPatientTransportState();
  })().finally(() => {
    probePromise = undefined;
  });
  return probePromise;
}

export function askPatient(
  userInput: string,
  sessionId?: string,
): Promise<PatientReply> {
  if (activeTurn) return activeTurn;
  activeTurn = (async () => {
    const readiness = state.status === 'ready'
      ? state
      : await probePatientTransport();
    if (readiness.status !== 'ready') {
      throw new Error(readiness.message);
    }
    activeController = new AbortController();
    const result = await executeTransport({
      action: 'send',
      userInput,
      ...(sessionId ? { sessionId } : {}),
    }, PATIENT_TURN_TIMEOUT_MS, activeController.signal);
    const classified = classifyTransport(result, false);
    if (classified.status !== 'ready') {
      state = classified;
      throw new Error(classified.message);
    }
    let reply: PatientReply;
    try {
      reply = parseReply(result.body);
    } catch {
      state = {
        status: 'server-error',
        message: 'Public patient chat returned a malformed response.',
        retryable: true,
      };
      throw new Error(state.message);
    }
    state = {
      status: 'ready',
      message: 'Public patient chat is ready.',
      retryable: false,
    };
    return reply;
  })().finally(() => {
    activeTurn = undefined;
    activeController = undefined;
  });
  return activeTurn;
}

async function executeTransport(
  request:
    | { action: 'probe' }
    | { action: 'send'; userInput: string; sessionId?: string },
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<TransportResult> {
  const desktop = desktopBridge();
  if (desktop) return desktop.patientChat(request);
  if (location.protocol === 'file:') {
    return { status: 0, body: '', error: 'cors-blocked' };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const target = resolveHostedUrl(request.action);
  if (!target) {
    clearTimeout(timer);
    return { status: 0, body: '', error: 'cors-blocked' };
  }
  const crossOrigin = new URL(target).origin !== location.origin;
  try {
    const response = await fetch(target, {
      method: request.action === 'probe' ? 'GET' : 'POST',
      headers: request.action === 'send'
        ? {
            ...gateway.httpAuthHeaders(),
            'Content-Type': 'application/json',
          }
        : gateway.httpAuthHeaders(),
      body: request.action === 'send'
        ? JSON.stringify({
            user_input: request.userInput,
            ...(request.sessionId ? { session_id: request.sessionId } : {}),
          })
        : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    return {
      status: response.status,
      body: await boundedResponseText(response),
    };
  } catch (error) {
    return {
      status: 0,
      body: '',
      error: controller.signal.aborted
        ? 'timeout'
        : error instanceof TypeError
          ? (crossOrigin ? 'cors-blocked' : 'offline')
          : 'server-error',
    };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function classifyTransport(
  result: TransportResult,
  probe: boolean,
): PatientTransportState {
  if (result.error === 'timeout') {
    return {
      status: 'timeout',
      message: 'Public patient chat timed out. Retry the connection.',
      retryable: true,
    };
  }
  if (result.error === 'offline') {
    return {
      status: 'offline',
      message: 'The public patient chat endpoint is offline or unreachable.',
      retryable: true,
    };
  }
  if (result.error === 'cors-blocked') {
    return {
      status: 'cors-blocked',
      message: 'The configured patient chat endpoint is blocked by origin or mixed-content policy.',
      retryable: true,
    };
  }
  if (result.error === 'server-error') {
    return {
      status: 'server-error',
      message: 'The public patient chat response exceeded safe bounds.',
      retryable: true,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      status: 'unauthorized',
      message: 'The public patient chat endpoint rejected authentication.',
      retryable: true,
    };
  }
  if (result.status >= 500 || result.status === 0) {
    return {
      status: 'server-error',
      message: 'The public patient chat endpoint is unavailable.',
      retryable: true,
    };
  }
  if (probe && result.status !== 200) {
    return {
      status: 'server-error',
      message: 'Gateway health is not ready on the patient chat transport.',
      retryable: true,
    };
  }
  if (probe && !healthResponseIsReady(result.body)) {
    return {
      status: 'server-error',
      message: 'Gateway health returned an invalid or degraded response.',
      retryable: true,
    };
  }
  if (!probe && (result.status < 200 || result.status >= 300)) {
    return {
      status: 'server-error',
      message: `Public patient chat failed (HTTP ${result.status}).`,
      retryable: true,
    };
  }
  return {
    status: 'ready',
    message: probe
      ? 'Gateway health is ready on the public patient chat transport.'
      : 'Public patient chat is ready.',
    retryable: false,
  };
}

function parseReply(text: string): PatientReply {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Public patient chat returned a malformed response.');
  }
  if (
    body.status === 'error'
    || typeof body.response !== 'string'
    || typeof body.session_id !== 'string'
    || typeof body.agent_logs !== 'string'
  ) {
    throw new Error('Public patient chat returned an invalid response.');
  }
  return {
    response: body.response,
    session_id: body.session_id,
    agent_logs: body.agent_logs,
    ...(typeof body.voice_response === 'string'
      ? { voice_response: body.voice_response }
      : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('Public patient chat response is too large.');
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('Public patient chat response is too large.');
  }
  return text;
}

function resolveHostedUrl(action: 'probe' | 'send'): string | null {
  const configured = import.meta.env.VITE_GATEWAY_URL;
  const pathname = action === 'probe' ? '/health' : '/chat';
  if (!configured) return new URL(pathname, location.origin).href;
  try {
    const url = new URL(configured);
    if (url.username || url.password) return null;
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (location.protocol === 'https:' && url.protocol !== 'https:') return null;
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }

}

function healthResponseIsReady(text: string): boolean {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const checks = value.checks;
    return value.status === 'ok'
      && typeof value.version === 'string'
      && typeof value.uptime === 'number'
      && typeof value.timestamp === 'string'
      && Boolean(checks)
      && typeof checks === 'object'
      && (checks as Record<string, unknown>).gateway === true;
  } catch {
    return false;
  }
}
