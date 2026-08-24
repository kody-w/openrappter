export type DesktopPatientChatRequest =
  | { action: 'probe' }
  | { action: 'send'; userInput: string; sessionId?: string }
  | { action: 'cancel' };

export interface DesktopPatientChatResult {
  status: number;
  body: string;
  error?: 'offline' | 'timeout' | 'server-error';
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function executePatientChatRequest(options: {
  request: DesktopPatientChatRequest;
  gatewayOrigin: string;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DesktopPatientChatResult> {
  const origin = new URL(options.gatewayOrigin);
  if (
    origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || !/^\d+$/.test(origin.port)
    || origin.pathname !== '/'
  ) {
    throw new Error('Desktop patient gateway origin is invalid.');
  }
  if (!/^[0-9a-f]{64}$/i.test(options.gatewayToken)) {
    throw new Error('Desktop patient gateway credential is invalid.');
  }
  const request = validateRequest(options.request);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? (request.action === 'probe' ? 8_000 : 15 * 60_000),
  );
  try {
    const body = request.action === 'send'
      ? JSON.stringify({
          user_input: request.userInput,
          ...(request.sessionId ? { session_id: request.sessionId } : {}),
        })
      : undefined;
    if (body && Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error('Patient chat request is too large.');
    }
    const response = await (options.fetchImpl ?? fetch)(
      `${origin.origin}/chat`,
      {
        method: request.action === 'probe' ? 'HEAD' : 'POST',
        headers: {
          Authorization: `Bearer ${options.gatewayToken}`,
          Origin: origin.origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      },
    );
    return {
      status: response.status,
      body: request.action === 'probe'
        ? ''
        : await boundedResponseText(response, MAX_RESPONSE_BYTES),
    };
  } catch (error) {
    return {
      status: 0,
      body: '',
      error: controller.signal.aborted
        ? 'timeout'
        : error instanceof TypeError
          ? 'offline'
          : 'server-error',
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

function validateRequest(value: DesktopPatientChatRequest): DesktopPatientChatRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid patient chat request.');
  }
  if (value.action === 'cancel') {
    throw new Error('Patient chat cancellation is handled by the desktop bridge.');
  }
  if (value.action === 'probe') {
    if (Object.keys(value).some((key) => key !== 'action')) {
      throw new Error('Patient chat probe accepts no endpoint or payload.');
    }
    return { action: 'probe' };
  }
  if (
    value.action !== 'send'
    || typeof value.userInput !== 'string'
    || !value.userInput.trim()
    || value.userInput.length > 12_000
    || (value.sessionId !== undefined
      && (typeof value.sessionId !== 'string' || value.sessionId.length > 256))
    || Object.keys(value).some((key) =>
      !['action', 'userInput', 'sessionId'].includes(key)
    )
  ) {
    throw new Error('Invalid patient chat request.');
  }
  return {
    action: 'send',
    userInput: value.userInput,
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
  };
}

async function boundedResponseText(
  response: Response,
  limit: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('Patient chat response is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('Patient chat response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
