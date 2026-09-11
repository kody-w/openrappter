import type { ChatEnvelope } from '../../gateway/chat-envelope.js';
import { parseChatRequest } from '../../gateway/chat-request.js';
import {
  askBrainstem,
  BrainstemAbortedError,
  BrainstemUnavailableError,
  DEFAULT_BRAINSTEM_URL,
  resolveBrainstemUrl,
} from '../../gateway/brainstem-client.js';
import {
  DEFAULT_RAPP_CHAT_TIMEOUT_MS,
  DEFAULT_RAPP_HEALTH_TIMEOUT_MS,
  MAX_RAPP_REQUEST_TIMEOUT_MS,
  normalizeRappEndpoint,
  parseRappChatEnvelope,
} from '../http-participant.js';
import {
  RAPP_CHAT_PROTOCOL,
  RappParticipantAbortedError,
  RappParticipantHttpError,
  RappParticipantIdentityDriftError,
  RappParticipantProtocolError,
  RappParticipantTimeoutError,
  RappParticipantTransportError,
  type RappParticipant,
  type RappParticipantChatRequest,
  type RappParticipantDescriptor,
  type RappParticipantStatus,
} from '../participant.js';

const BRAINSTEM_CAPABILITIES = Object.freeze({
  chat: true,
  health: true,
  history: true,
  tools: true,
  streaming: false,
  voice: true,
  attachments: false,
  extensions: Object.freeze([]),
});

export const DEFAULT_BRAINSTEM_DESCRIPTOR: Readonly<RappParticipantDescriptor> =
  Object.freeze({
    // The legacy health response has no stable/live identity. Inventing one
    // from "brainstem", a port, or a random UUID would make deployment metadata
    // look like primary identity.
    rappid: null,
    liveId: null,
    pid: null,
    harness: Object.freeze({
      name: 'brainstem',
      displayName: 'Brainstem',
    }),
    endpoint: DEFAULT_BRAINSTEM_URL,
    protocol: RAPP_CHAT_PROTOCOL,
    modelAuthority: 'github-copilot',
    capabilities: BRAINSTEM_CAPABILITIES,
  });

export interface BrainstemParticipantOptions {
  baseUrl?: string | URL;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_RAPP_REQUEST_TIMEOUT_MS) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${MAX_RAPP_REQUEST_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeout;
}

function optionalString(value: unknown, field: string, endpoint: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      `${field} must be a non-empty string when present`,
    );
  }
  return value.trim();
}

/**
 * Compatibility participant for the existing Brainstem client.
 *
 * It deliberately does not replace `askBrainstem` or gateway routing. A later
 * integration can register this adapter when participant routing is introduced.
 */
export class BrainstemRappParticipant implements RappParticipant {
  private readonly configuredBaseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private currentDescriptor: Readonly<RappParticipantDescriptor>;

  constructor(options: BrainstemParticipantOptions = {}) {
    this.configuredBaseUrl = options.baseUrl === undefined
      ? undefined
      : normalizeRappEndpoint(options.baseUrl);
    this.timeoutMs = boundedTimeout(
      options.timeoutMs,
      DEFAULT_RAPP_CHAT_TIMEOUT_MS,
      'timeoutMs',
    );
    this.healthTimeoutMs = boundedTimeout(
      options.healthTimeoutMs,
      DEFAULT_RAPP_HEALTH_TIMEOUT_MS,
      'healthTimeoutMs',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env;
    this.currentDescriptor = Object.freeze({
      ...DEFAULT_BRAINSTEM_DESCRIPTOR,
      endpoint: this.configuredBaseUrl ?? DEFAULT_BRAINSTEM_DESCRIPTOR.endpoint,
    });
  }

  get descriptor(): Readonly<RappParticipantDescriptor> {
    return this.currentDescriptor;
  }

  async status(signal?: AbortSignal): Promise<RappParticipantStatus> {
    if (signal?.aborted) {
      throw new RappParticipantAbortedError('health', `${this.descriptor.endpoint}/health`);
    }
    const resolved = this.configuredBaseUrl ?? await this.resolveWithSignal(signal);
    const endpoint = normalizeRappEndpoint(resolved);
    const healthUrl = `${endpoint}/health`;
    const health = await this.fetchHealth(healthUrl, signal);
    if (!isRecord(health)) {
      throw new RappParticipantProtocolError(
        'health',
        endpoint,
        'body must be a JSON object',
      );
    }
    if (health.status !== 'ok' && health.status !== 'degraded') {
      throw new RappParticipantProtocolError(
        'health',
        endpoint,
        'status must be ok or degraded',
      );
    }

    const rappid = optionalString(health.rappid, 'rappid', endpoint);
    const liveId = optionalString(health.live_id, 'live_id', endpoint);
    const pid = health.pid === undefined || health.pid === null ? null : health.pid;
    const identityFields = [rappid !== null, liveId !== null, pid !== null];
    if (identityFields.some(Boolean) && !identityFields.every(Boolean)) {
      throw new RappParticipantProtocolError(
        'health',
        endpoint,
        'rappid, live_id, and pid must be published together',
      );
    }
    if (pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 0)) {
      throw new RappParticipantProtocolError(
        'health',
        endpoint,
        'pid must be a positive safe integer when present',
      );
    }
    if (liveId !== null && pid !== null) {
      const match = /^rapp-(\d+)-[a-z0-9]+$/i.exec(liveId);
      if (match === null || Number(match[1]) !== pid) {
        throw new RappParticipantProtocolError(
          'health',
          endpoint,
          'live_id must contain the published pid',
        );
      }
    }
    const protocol = optionalString(health.protocol, 'protocol', endpoint);
    if (protocol !== null && protocol !== RAPP_CHAT_PROTOCOL) {
      throw new RappParticipantProtocolError(
        'health',
        endpoint,
        `protocol must be ${RAPP_CHAT_PROTOCOL}`,
      );
    }
    const modelAuthority =
      optionalString(health.model_authority, 'model_authority', endpoint)
      ?? DEFAULT_BRAINSTEM_DESCRIPTOR.modelAuthority;
    const version = optionalString(health.version, 'version', endpoint);

    this.currentDescriptor = Object.freeze({
      ...DEFAULT_BRAINSTEM_DESCRIPTOR,
      rappid,
      liveId,
      pid: pid as number | null,
      endpoint,
      modelAuthority,
      harness: Object.freeze({
        ...DEFAULT_BRAINSTEM_DESCRIPTOR.harness!,
        ...(version === null ? {} : { version }),
      }),
    });
    return Object.freeze({
      status: health.status,
      descriptor: this.currentDescriptor,
      checkedAt: new Date().toISOString(),
    });
  }

  async chat(
    request: RappParticipantChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatEnvelope> {
    const requestBody = {
      user_input: request.userInput,
      conversation_history: request.conversationHistory,
      ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
    };
    const parsedRequest = parseChatRequest(requestBody);
    if (!parsedRequest.ok) {
      throw new RappParticipantProtocolError(
        'chat',
        this.descriptor.endpoint,
        `request is invalid: ${parsedRequest.error}`,
      );
    }
    const status = await this.status(signal);

    let response;
    try {
      response = await askBrainstem({
        message: parsedRequest.value.userInput,
        sessionId: parsedRequest.value.sessionId,
        idempotencyKey: request.idempotencyKey,
        conversationHistory: parsedRequest.value.conversationHistory,
        baseUrl: status.descriptor.endpoint,
        timeoutMs: this.timeoutMs,
        signal,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error instanceof BrainstemAbortedError) {
        throw new RappParticipantAbortedError(
          'chat',
          `${status.descriptor.endpoint}/chat`,
        );
      }
      if (error instanceof BrainstemUnavailableError) {
        throw new RappParticipantTransportError(
          'chat',
          `${status.descriptor.endpoint}/chat`,
          error,
        );
      }
      throw error;
    }

    const envelope = parseRappChatEnvelope(response, status.descriptor.endpoint);
    if (status.descriptor.rappid !== null) {
      if (envelope.rappid === undefined) {
        throw new RappParticipantProtocolError(
          'chat',
          status.descriptor.endpoint,
          'identity-aware Brainstem replies must include rappid',
        );
      }
      if (envelope.rappid !== status.descriptor.rappid) {
        throw new RappParticipantIdentityDriftError(
          'chat',
          status.descriptor.endpoint,
          'rappid',
          status.descriptor.rappid,
          envelope.rappid,
        );
      }
    }
    if (status.descriptor.liveId !== null) {
      if (envelope.live_id === undefined) {
        throw new RappParticipantProtocolError(
          'chat',
          status.descriptor.endpoint,
          'identity-aware Brainstem replies must include live_id',
        );
      }
      if (envelope.live_id !== status.descriptor.liveId) {
        throw new RappParticipantIdentityDriftError(
          'chat',
          status.descriptor.endpoint,
          'liveId',
          status.descriptor.liveId,
          envelope.live_id,
        );
      }
    }
    return envelope;
  }

  private async resolveWithSignal(signal?: AbortSignal): Promise<string> {
    if (signal === undefined) {
      return resolveBrainstemUrl({ env: this.env, fetchImpl: this.fetchImpl });
    }
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new RappParticipantAbortedError('health', `${this.descriptor.endpoint}/health`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void resolveBrainstemUrl({ env: this.env, fetchImpl: this.fetchImpl }).then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async fetchHealth(endpoint: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new RappParticipantAbortedError('health', endpoint);
    }
    const controller = new AbortController();
    let rejectGate: ((reason: Error) => void) | undefined;
    const gate = new Promise<never>((_resolve, reject) => {
      rejectGate = reject;
    });
    const onAbort = (): void => {
      controller.abort();
      rejectGate?.(new RappParticipantAbortedError('health', endpoint));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
      rejectGate?.(
        new RappParticipantTimeoutError('health', endpoint, this.healthTimeoutMs),
      );
    }, this.healthTimeoutMs);
    const request = (async (): Promise<unknown> => {
      const response = await this.fetchImpl(endpoint, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new RappParticipantHttpError('health', endpoint, response.status);
      }
      try {
        return await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new RappParticipantProtocolError(
          'health',
          endpoint,
          'body is not valid JSON',
        );
      }
    })();
    try {
      return await Promise.race([request, gate]);
    } catch (error) {
      if (
        error instanceof RappParticipantAbortedError
        || error instanceof RappParticipantTimeoutError
        || error instanceof RappParticipantHttpError
        || error instanceof RappParticipantProtocolError
      ) {
        throw error;
      }
      throw new RappParticipantTransportError('health', endpoint, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createBrainstemParticipant(
  options: BrainstemParticipantOptions = {},
): BrainstemRappParticipant {
  return new BrainstemRappParticipant(options);
}
