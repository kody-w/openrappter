import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAINSTEM_URL } from '../../gateway/brainstem-client.js';
import { RAPP_CHAT_PROTOCOL } from '../participant.js';
import {
  BrainstemRappParticipant,
  DEFAULT_BRAINSTEM_DESCRIPTOR,
} from './brainstem.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BrainstemRappParticipant', () => {
  it('has a truthful default descriptor without inventing primary identity', () => {
    expect(DEFAULT_BRAINSTEM_DESCRIPTOR).toMatchObject({
      rappid: null,
      liveId: null,
      pid: null,
      endpoint: DEFAULT_BRAINSTEM_URL,
      protocol: RAPP_CHAT_PROTOCOL,
      modelAuthority: 'github-copilot',
      harness: {
        name: 'brainstem',
        displayName: 'Brainstem',
      },
      capabilities: {
        chat: true,
        health: true,
        history: true,
        tools: true,
        streaming: false,
        voice: true,
        attachments: false,
      },
    });
  });

  it('wraps the existing Brainstem compatibility request shape', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/health')) {
        calls.push({ url: String(url) });
        return jsonResponse({ status: 'ok', version: '1.13.0' });
      }
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        schema: RAPP_CHAT_PROTOCOL,
        status: 'success',
        response: 'from brainstem',
        content: 'from brainstem',
        session_id: 'session-1',
        sessionId: 'session-1',
        agent_logs: '',
        voice_mode: false,
        model: 'gpt-5',
        requested_model: 'gpt-5',
      });
    }) as unknown as typeof fetch;
    const participant = new BrainstemRappParticipant({
      baseUrl: 'http://127.0.0.1:7071/',
      fetchImpl,
    });

    const result = await participant.chat({
      userInput: 'hello',
      sessionId: 'session-1',
      conversationHistory: [],
      idempotencyKey: 'once',
    });

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:7071/health',
      'http://127.0.0.1:7071/chat',
    ]);
    expect(calls[1].body).toMatchObject({
      user_input: 'hello',
      message: 'hello',
      session_id: 'session-1',
      conversation_history: [],
      idempotency_key: 'once',
    });
    expect(result.response).toBe('from brainstem');
    expect(participant.descriptor).toMatchObject({
      rappid: null,
      liveId: null,
      pid: null,
      endpoint: 'http://127.0.0.1:7071',
      harness: { name: 'brainstem', version: '1.13.0' },
    });
  });
});
