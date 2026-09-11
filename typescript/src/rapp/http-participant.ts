import {
  ENVELOPE_REQUIRED_KEYS,
  type ChatEnvelope,
} from '../gateway/chat-envelope.js';
import { parseChatRequest } from '../gateway/chat-request.js';
import {
  RAPP_CHAT_PROTOCOL,
  RAPP_PARTICIPANT_HEALTH_SCHEMA,
  RappParticipantAbortedError,
  RappParticipantHttpError,
  RappParticipantIdentityDriftError,
  RappParticipantProtocolError,
  RappParticipantTimeoutError,
  RappParticipantTransportError,
  type RappHarnessMetadata,
  type RappParticipant,
  type RappParticipantCapabilities,
  type RappParticipantChatRequest,
  type RappParticipantDescriptor,
  type RappParticipantOperation,
  type RappParticipantStatus,
} from './participant.js';

export const DEFAULT_RAPP_HEALTH_TIMEOUT_MS = 1_500;
export const DEFAULT_RAPP_CHAT_TIMEOUT_MS = 120_000;
export const MAX_RAPP_REQUEST_TIMEOUT_MS = 300_000;

const KNOWN_CAPABILITIES = [
  'chat',
  'health',
  'history',
  'tools',
  'streaming',
  'voice',
  'attachments',
] as const;

type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

export interface HttpRappParticipantOptions {
  endpoint: string | URL;
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
  healthTimeoutMs?: number;
  chatTimeoutMs?: number;
  /**
   * Optional pre-admission expectation. Health remains authoritative and must
   * match any identity supplied here.
   */
  expectedIdentity?: {
    rappid?: string;
    liveId?: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_RAPP_REQUEST_TIMEOUT_MS) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${MAX_RAPP_REQUEST_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeout;
}

export function normalizeRappEndpoint(endpoint: string | URL): string {
  const parsed = endpoint instanceof URL ? new URL(endpoint.href) : new URL(endpoint);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('RAPP participant endpoint must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('RAPP participant endpoint must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError('RAPP participant endpoint must not contain a query or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

function endpointPath(endpoint: string, path: 'health' | 'chat'): string {
  return `${endpoint}/${path}`;
}

function parseCapabilities(
  value: unknown,
  endpoint: string,
): Readonly<RappParticipantCapabilities> {
  const declared = new Set<string>();

  if (Array.isArray(value)) {
    for (const capability of value) {
      if (typeof capability !== 'string' || capability.trim().length === 0) {
        throw new RappParticipantProtocolError(
          'health',
          endpoint,
          'capabilities must contain non-empty strings',
        );
      }
      declared.add(capability.trim());
    }
  } else if (isRecord(value)) {
    for (const [capability, enabled] of Object.entries(value)) {
      if (capability === 'extensions') {
        if (!Array.isArray(enabled) || enabled.some((item) =>
          typeof item !== 'string' || item.trim().length === 0)) {
          throw new RappParticipantProtocolError(
            'health',
            endpoint,
            'capabilities.extensions must contain non-empty strings',
          );
        }
        for (const extension of enabled) declared.add(extension.trim());
        continue;
      }
      if (typeof enabled !== 'boolean') {
        throw new RappParticipantProtocolError(
          'health',
          endpoint,
          `capability ${capability} must be boolean`,
        );
      }
      if (enabled) declared.add(capability);
    }
  } else {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'capabilities must be an array or object',
    );
  }

  if (!declared.has('chat')) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'capabilities must declare chat',
    );
  }

  const known = new Set<string>(KNOWN_CAPABILITIES);
  const extensions = [...declared].filter((item) => !known.has(item)).sort();
  const enabled = (name: KnownCapability): boolean =>
    name === 'health' || declared.has(name);

  return Object.freeze({
    chat: enabled('chat'),
    health: enabled('health'),
    history: enabled('history'),
    tools: enabled('tools'),
    streaming: enabled('streaming'),
    voice: enabled('voice'),
    attachments: enabled('attachments'),
    extensions: Object.freeze(extensions),
  });
}

function parseHarness(value: unknown, endpoint: string): Readonly<RappHarnessMetadata> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'harness must be an object when present',
    );
  }
  const name = nonEmptyString(value.name);
  if (name === null) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'harness.name must be a non-empty string',
    );
  }
  const displayName = value.displayName === undefined
    ? undefined
    : nonEmptyString(value.displayName);
  const version = value.version === undefined ? undefined : nonEmptyString(value.version);
  if (value.displayName !== undefined && displayName === null) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'harness.displayName must be a non-empty string',
    );
  }
  if (value.version !== undefined && version === null) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'harness.version must be a non-empty string',
    );
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'harness.metadata must be an object',
    );
  }
  const harness: RappHarnessMetadata = { name };
  if (displayName !== undefined && displayName !== null) {
    harness.displayName = displayName;
  }
  if (version !== undefined && version !== null) {
    harness.version = version;
  }
  if (value.metadata !== undefined) {
    harness.metadata = Object.freeze({ ...value.metadata });
  }
  return Object.freeze(harness);
}

function assertLiveIdBindsPid(
  liveId: string,
  pid: number,
  endpoint: string,
): void {
  const match = /^rapp-(\d+)-[a-z0-9]+$/i.exec(liveId);
  if (match === null || Number(match[1]) !== pid) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'live_id must be rapp-<pid>-<incarnation> and contain the published pid',
    );
  }
}

export function parseRappParticipantHealth(
  value: unknown,
  endpoint: string,
  checkedAt = new Date().toISOString(),
): RappParticipantStatus {
  if (!isRecord(value)) {
    throw new RappParticipantProtocolError('health', endpoint, 'body must be a JSON object');
  }
  if (value.schema !== RAPP_PARTICIPANT_HEALTH_SCHEMA) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      `schema must be ${RAPP_PARTICIPANT_HEALTH_SCHEMA}`,
    );
  }
  if (value.status !== 'ok' && value.status !== 'degraded') {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'status must be ok or degraded',
    );
  }

  const rappid = nonEmptyString(value.rappid);
  const liveId = nonEmptyString(value.live_id);
  const pid = value.pid;
  const protocol = nonEmptyString(value.protocol);
  const modelAuthority = nonEmptyString(value.model_authority);

  if (rappid === null) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'rappid must be a non-empty string',
    );
  }
  if (liveId === null) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'live_id must be a non-empty string',
    );
  }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'pid must be a positive safe integer',
    );
  }
  assertLiveIdBindsPid(liveId, pid as number, endpoint);
  if (protocol !== RAPP_CHAT_PROTOCOL) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      `protocol must be ${RAPP_CHAT_PROTOCOL}`,
    );
  }
  if (modelAuthority === null) {
    throw new RappParticipantProtocolError(
      'health',
      endpoint,
      'model_authority must be a non-empty string',
    );
  }

  const descriptor: RappParticipantDescriptor = Object.freeze({
    rappid,
    liveId,
    pid: pid as number,
    harness: parseHarness(value.harness, endpoint),
    endpoint,
    protocol: RAPP_CHAT_PROTOCOL,
    modelAuthority,
    capabilities: parseCapabilities(value.capabilities, endpoint),
  });
  return Object.freeze({
    status: value.status,
    descriptor,
    checkedAt,
  });
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  endpoint: string,
): string {
  if (typeof record[key] !== 'string') {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      `${key} must be a string`,
    );
  }
  return record[key] as string;
}

export function parseRappChatEnvelope(value: unknown, endpoint: string): ChatEnvelope {
  if (!isRecord(value)) {
    throw new RappParticipantProtocolError('chat', endpoint, 'body must be a JSON object');
  }
  for (const key of ENVELOPE_REQUIRED_KEYS) {
    if (!(key in value)) {
      throw new RappParticipantProtocolError(
        'chat',
        endpoint,
        `missing frozen envelope key ${key}`,
      );
    }
  }

  if (value.schema !== RAPP_CHAT_PROTOCOL) {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      `schema must be ${RAPP_CHAT_PROTOCOL}`,
    );
  }
  if (value.status !== 'success') {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'status must be success',
    );
  }

  requireString(value, 'response', endpoint);
  const sessionId = requireString(value, 'session_id', endpoint);
  requireString(value, 'agent_logs', endpoint);
  requireString(value, 'model', endpoint);
  requireString(value, 'requested_model', endpoint);
  requireString(value, 'content', endpoint);
  const camelSessionId = requireString(value, 'sessionId', endpoint);
  if (typeof value.voice_mode !== 'boolean') {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'voice_mode must be boolean',
    );
  }
  if (camelSessionId !== sessionId) {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'sessionId must equal session_id',
    );
  }
  if (value.voice_response !== undefined && typeof value.voice_response !== 'string') {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'voice_response must be a string when present',
    );
  }
  if (value.rappid !== undefined && nonEmptyString(value.rappid) === null) {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'rappid must be a non-empty string when present',
    );
  }
  if (value.live_id !== undefined && nonEmptyString(value.live_id) === null) {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'live_id must be a non-empty string when present',
    );
  }
  if ('assistant_response' in value) {
    throw new RappParticipantProtocolError(
      'chat',
      endpoint,
      'assistant_response is forbidden by the RAPP chat contract',
    );
  }
  return value as ChatEnvelope;
}

export class HttpRappParticipant implements RappParticipant {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Headers;
  private readonly healthTimeoutMs: number;
  private readonly chatTimeoutMs: number;
  private readonly expectedIdentity: HttpRappParticipantOptions['expectedIdentity'];
  private currentDescriptor: Readonly<RappParticipantDescriptor>;

  constructor(options: HttpRappParticipantOptions) {
    const endpoint = normalizeRappEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = new Headers(options.headers);
    this.healthTimeoutMs = boundedTimeout(
      options.healthTimeoutMs,
      DEFAULT_RAPP_HEALTH_TIMEOUT_MS,
      'healthTimeoutMs',
    );
    this.chatTimeoutMs = boundedTimeout(
      options.chatTimeoutMs,
      DEFAULT_RAPP_CHAT_TIMEOUT_MS,
      'chatTimeoutMs',
    );
    this.expectedIdentity = options.expectedIdentity;
    this.currentDescriptor = Object.freeze({
      rappid: options.expectedIdentity?.rappid ?? null,
      liveId: options.expectedIdentity?.liveId ?? null,
      pid: null,
      harness: null,
      endpoint,
      protocol: RAPP_CHAT_PROTOCOL,
      modelAuthority: null,
      capabilities: Object.freeze({
        chat: true,
        health: true,
        history: false,
        tools: false,
        streaming: false,
        voice: false,
        attachments: false,
        extensions: Object.freeze([]),
      }),
    });
  }

  get descriptor(): Readonly<RappParticipantDescriptor> {
    return this.currentDescriptor;
  }

  async status(signal?: AbortSignal): Promise<RappParticipantStatus> {
    const endpoint = endpointPath(this.currentDescriptor.endpoint, 'health');
    const body = await this.fetchJson(
      'health',
      endpoint,
      { method: 'GET', headers: this.headers },
      this.healthTimeoutMs,
      signal,
    );
    const status = parseRappParticipantHealth(
      body,
      this.currentDescriptor.endpoint,
    );
    this.assertExpectedIdentity(status.descriptor);
    this.currentDescriptor = status.descriptor;
    return status;
  }

  async chat(
    request: RappParticipantChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatEnvelope> {
    const candidateBody: Record<string, unknown> = {
      user_input: request.userInput,
      conversation_history: request.conversationHistory,
      ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotency_key: request.idempotencyKey }),
    };
    const parsedRequest = parseChatRequest(candidateBody);
    if (!parsedRequest.ok) {
      throw new RappParticipantProtocolError(
        'chat',
        this.currentDescriptor.endpoint,
        `request is invalid: ${parsedRequest.error}`,
      );
    }
    const body: Record<string, unknown> = {
      user_input: parsedRequest.value.userInput,
      conversation_history: parsedRequest.value.conversationHistory,
      ...(parsedRequest.value.sessionId === undefined
        ? {}
        : { session_id: parsedRequest.value.sessionId }),
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotency_key: request.idempotencyKey }),
    };
    const health = await this.status(signal);

    const headers = new Headers(this.headers);
    headers.set('content-type', 'application/json');
    const responseBody = await this.fetchJson(
      'chat',
      endpointPath(this.currentDescriptor.endpoint, 'chat'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      this.chatTimeoutMs,
      signal,
    );
    const envelope = parseRappChatEnvelope(responseBody, this.currentDescriptor.endpoint);
    const responseRappid = nonEmptyString(envelope.rappid);
    const responseLiveId = nonEmptyString(envelope.live_id);
    if (responseRappid === null || responseLiveId === null) {
      throw new RappParticipantProtocolError(
        'chat',
        this.currentDescriptor.endpoint,
        'managed participant replies must include rappid and live_id',
      );
    }
    if (responseRappid !== health.descriptor.rappid) {
      throw new RappParticipantIdentityDriftError(
        'chat',
        this.currentDescriptor.endpoint,
        'rappid',
        health.descriptor.rappid!,
        responseRappid,
      );
    }
    if (responseLiveId !== health.descriptor.liveId) {
      throw new RappParticipantIdentityDriftError(
        'chat',
        this.currentDescriptor.endpoint,
        'liveId',
        health.descriptor.liveId!,
        responseLiveId,
      );
    }
    return envelope;
  }

  private assertExpectedIdentity(descriptor: Readonly<RappParticipantDescriptor>): void {
    const expectedRappid = this.expectedIdentity?.rappid;
    if (expectedRappid !== undefined && descriptor.rappid !== expectedRappid) {
      throw new RappParticipantIdentityDriftError(
        'health',
        descriptor.endpoint,
        'rappid',
        expectedRappid,
        descriptor.rappid!,
      );
    }
    const expectedLiveId = this.expectedIdentity?.liveId;
    if (expectedLiveId !== undefined && descriptor.liveId !== expectedLiveId) {
      throw new RappParticipantIdentityDriftError(
        'health',
        descriptor.endpoint,
        'liveId',
        expectedLiveId,
        descriptor.liveId!,
      );
    }
  }

  private async fetchJson(
    operation: RappParticipantOperation,
    endpoint: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    if (callerSignal?.aborted) {
      throw new RappParticipantAbortedError(operation, endpoint);
    }

    const controller = new AbortController();
    let timedOut = false;
    let rejectGate: ((reason: Error) => void) | undefined;
    const gate = new Promise<never>((_resolve, reject) => {
      rejectGate = reject;
    });
    const onAbort = (): void => {
      controller.abort();
      rejectGate?.(new RappParticipantAbortedError(operation, endpoint));
    };
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectGate?.(new RappParticipantTimeoutError(operation, endpoint, timeoutMs));
    }, timeoutMs);

    const request = (async (): Promise<unknown> => {
      const response = await this.fetchImpl(endpoint, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new RappParticipantHttpError(operation, endpoint, response.status);
      }
      try {
        return await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new RappParticipantProtocolError(
          operation,
          endpoint,
          'body is not valid JSON',
        );
      }
    })();

    try {
      return await Promise.race([request, gate]);
    } catch (error) {
      if (error instanceof RappParticipantAbortedError
        || error instanceof RappParticipantTimeoutError
        || error instanceof RappParticipantHttpError
        || error instanceof RappParticipantProtocolError) {
        throw error;
      }
      if (callerSignal?.aborted) {
        throw new RappParticipantAbortedError(operation, endpoint);
      }
      if (timedOut) {
        throw new RappParticipantTimeoutError(operation, endpoint, timeoutMs);
      }
      throw new RappParticipantTransportError(operation, endpoint, error);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }
}
