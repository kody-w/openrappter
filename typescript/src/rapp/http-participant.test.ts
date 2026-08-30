import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  buildChatEnvelope,
  ENVELOPE_REQUIRED_KEYS,
} from '../gateway/chat-envelope.js';
import {
  HttpRappParticipant,
  RAPP_CHAT_PROTOCOL,
  RAPP_PARTICIPANT_HEALTH_SCHEMA,
  RappParticipantAbortedError,
  RappParticipantHttpError,
  RappParticipantIdentityDriftError,
  RappParticipantProtocolError,
  RappParticipantTimeoutError,
} from './index.js';

const RAPPID = `rappid:@example/alpha:${'a'.repeat(64)}`;
const OTHER_RAPPID = `rappid:@example/other:${'b'.repeat(64)}`;
const LIVE_ID = 'rapp-42-a1b2c3d4';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function health(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: RAPP_PARTICIPANT_HEALTH_SCHEMA,
    status: 'ok',
    rappid: RAPPID,
    live_id: LIVE_ID,
    pid: 42,
    harness: {
      name: 'test-harness',
      displayName: 'Test Harness',
      version: '1.2.3',
    },
    protocol: RAPP_CHAT_PROTOCOL,
    model_authority: 'github-copilot',
    capabilities: ['chat', 'history', 'tools', 'voice', 'future-capability'],
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: RAPP_CHAT_PROTOCOL,
    status: 'success',
    response: 'hello',
    content: 'hello',
    session_id: 'session-1',
    sessionId: 'session-1',
    agent_logs: '',
    voice_mode: false,
    model: 'gpt-5',
    requested_model: 'gpt-5',
    rappid: RAPPID,
    live_id: LIVE_ID,
    ...overrides,
  };
}

describe('HttpRappParticipant', () => {
  it('discovers health, sends canonical chat, and preserves the conforming envelope', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith('/health')
        ? jsonResponse(health())
        : jsonResponse(envelope());
    }) as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000/',
      fetchImpl,
    });

    const result = await participant.chat({
      userInput: '  hello  ',
      sessionId: 'session-1',
      conversationHistory: [{ role: 'user', content: 'earlier' }],
      idempotencyKey: 'once',
    });

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:9000/health',
      'http://127.0.0.1:9000/chat',
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      user_input: 'hello',
      session_id: 'session-1',
      conversation_history: [{ role: 'user', content: 'earlier' }],
      idempotency_key: 'once',
    });
    expect(result).toEqual(envelope());
    expect(participant.descriptor).toMatchObject({
      rappid: RAPPID,
      liveId: LIVE_ID,
      pid: 42,
      endpoint: 'http://127.0.0.1:9000',
      protocol: RAPP_CHAT_PROTOCOL,
      modelAuthority: 'github-copilot',
      harness: { name: 'test-harness', version: '1.2.3' },
    });
    expect(participant.descriptor.capabilities).toMatchObject({
      chat: true,
      health: true,
      history: true,
      tools: true,
      streaming: false,
      voice: true,
    });
    expect(participant.descriptor.capabilities.extensions).toEqual(['future-capability']);
  });

  it('rejects malformed health instead of guessing missing identity', async () => {
    const fetchImpl = (async () =>
      jsonResponse(health({ live_id: undefined }))
    ) as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000',
      fetchImpl,
    });

    await expect(participant.status()).rejects.toBeInstanceOf(
      RappParticipantProtocolError,
    );
    await expect(participant.status()).rejects.toThrow(/live_id/);
  });

  it('times out a health request with a typed error', async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      })) as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000',
      healthTimeoutMs: 5,
      fetchImpl,
    });

    await expect(participant.status()).rejects.toBeInstanceOf(
      RappParticipantTimeoutError,
    );
  });

  it('honors a caller abort before performing network work', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000',
      fetchImpl,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(participant.status(controller.signal)).rejects.toBeInstanceOf(
      RappParticipantAbortedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports non-2xx without copying the remote body into the error', async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith('/health')
        ? jsonResponse(health())
        : new Response('authorization=secret-value', { status: 503 })
    ) as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000',
      fetchImpl,
    });

    const failure = participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    });
    await expect(failure).rejects.toBeInstanceOf(RappParticipantHttpError);
    await expect(failure).rejects.not.toThrow(/secret-value/);
  });

  it('rejects a stable RAPPID change between health and chat', async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith('/health')
        ? jsonResponse(health())
        : jsonResponse(envelope({ rappid: OTHER_RAPPID }))
    ) as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000',
      fetchImpl,
    });

    const failure = participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    });
    await expect(failure).rejects.toBeInstanceOf(
      RappParticipantIdentityDriftError,
    );
    await expect(failure).rejects.toMatchObject({ axis: 'rappid' });
  });

  it('rejects a live process change between health and chat', async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith('/health')
        ? jsonResponse(health())
        : jsonResponse(envelope({ live_id: 'rapp-42-deadbeef' }))
    ) as unknown as typeof fetch;
    const participant = new HttpRappParticipant({
      endpoint: 'http://127.0.0.1:9000',
      fetchImpl,
    });

    const failure = participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    });
    await expect(failure).rejects.toBeInstanceOf(
      RappParticipantIdentityDriftError,
    );
    await expect(failure).rejects.toMatchObject({ axis: 'liveId' });
  });
});

describe('participant identity envelope axes', () => {
  it('remain optional without changing the six frozen required keys', () => {
    const before = [...ENVELOPE_REQUIRED_KEYS];
    const value = buildChatEnvelope({
      content: 'hello',
      sessionId: 'session-1',
      extra: { rappid: RAPPID, live_id: LIVE_ID },
    });

    expect(value.rappid).toBe(RAPPID);
    expect(value.live_id).toBe(LIVE_ID);
    expect(ENVELOPE_REQUIRED_KEYS).toEqual(before);
    expect(ENVELOPE_REQUIRED_KEYS).toEqual([
      'response',
      'session_id',
      'agent_logs',
      'voice_mode',
      'model',
      'requested_model',
    ]);

    const here = dirname(fileURLToPath(import.meta.url));
    const contract = JSON.parse(
      readFileSync(resolve(here, '../../../contracts/rapp-chat-v1.json'), 'utf8'),
    ) as { response: { success: { required: string[] } } };
    expect(contract.response.success.required).not.toContain('rappid');
    expect(contract.response.success.required).not.toContain('live_id');
  });
});
