import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { executePatientChatRequest } from '../dist/patient-chat.js';

const token = 'a'.repeat(64);

test('mediates only the authoritative exact public /chat route', async () => {
  let captured;
  const result = await executePatientChatRequest({
    request: { action: 'send', userInput: 'hello', sessionId: 'session-1' },
    gatewayOrigin: 'http://127.0.0.1:32123',
    gatewayToken: token,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('{"response":"ok"}', { status: 200 });
    },
  });

  test('uses the same authoritative base and port for side-effect-free health', async () => {
    let captured;
    const result = await executePatientChatRequest({
      request: { action: 'probe' },
      gatewayOrigin: 'http://127.0.0.1:32123',
      gatewayToken: token,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({
          status: 'ok',
          version: '1.13.0',
          uptime: 10,
          timestamp: '2026-08-23T00:00:00.000Z',
          checks: { gateway: true },
        }), { status: 200 });
      },
    });
    assert.equal(result.status, 200);
    assert.equal(captured.url, 'http://127.0.0.1:32123/health');
    assert.equal(captured.init.method, 'GET');
    assert.equal(captured.init.body, undefined);
    assert.equal(captured.init.headers.Origin, 'http://127.0.0.1:32123');
  });
  assert.equal(result.status, 200);
  assert.equal(captured.url, 'http://127.0.0.1:32123/chat');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Origin, 'http://127.0.0.1:32123');
  assert.match(captured.init.body, /"user_input":"hello"/);
  assert.doesNotMatch(captured.init.body, /url|path|agent/);
});

test('rejects arbitrary renderer URL/path fields and invalid gateway origins', async () => {
  await assert.rejects(() => executePatientChatRequest({
    request: { action: 'probe', url: 'https://evil.example/chat' },
    gatewayOrigin: 'http://127.0.0.1:32123',
    gatewayToken: token,
  }), /accepts no endpoint/);
  await assert.rejects(() => executePatientChatRequest({
    request: { action: 'probe' },
    gatewayOrigin: 'https://evil.example:32123',
    gatewayToken: token,
  }), /origin is invalid/);
});

test('classifies stale port refusal, timeout, and authorization response', async () => {
  const offline = await executePatientChatRequest({
    request: { action: 'probe' },
    gatewayOrigin: 'http://127.0.0.1:39999',
    gatewayToken: token,
    fetchImpl: async () => {
      throw new TypeError('connection refused');
    },
  });
  assert.deepEqual(offline, { status: 0, body: '', error: 'offline' });

  const timeout = await executePatientChatRequest({
    request: { action: 'probe' },
    gatewayOrigin: 'http://127.0.0.1:32123',
    gatewayToken: token,
    timeoutMs: 1,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('timeout', 'AbortError'));
      }, { once: true });
    }),
  });
  assert.deepEqual(timeout, { status: 0, body: '', error: 'timeout' });

  const unauthorized = await executePatientChatRequest({
    request: { action: 'probe' },
    gatewayOrigin: 'http://127.0.0.1:32123',
    gatewayToken: token,
    fetchImpl: async () => new Response('', { status: 401 }),
  });
  assert.equal(unauthorized.status, 401);
});
