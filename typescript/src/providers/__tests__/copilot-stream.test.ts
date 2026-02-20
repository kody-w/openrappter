import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { parseSSEStream } from '../copilot.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a ReadableStream from an array of string chunks */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

// ── parseSSEStream tests ─────────────────────────────────────────────────────

describe('parseSSEStream', () => {
  it('parses content deltas', async () => {
    const stream = makeStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events: Record<string, unknown>[] = [];
    for await (const event of parseSSEStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect((events[0].choices as any[])[0].delta.content).toBe('Hello');
    expect((events[1].choices as any[])[0].delta.content).toBe(' world');
  });

  it('handles [DONE] sentinel and stops iteration', async () => {
    const stream = makeStream([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"should not appear"}}]}\n\n',
    ]);

    const events: Record<string, unknown>[] = [];
    for await (const event of parseSSEStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect((events[0].choices as any[])[0].delta.content).toBe('A');
  });

  it('skips empty lines and comments', async () => {
    const stream = makeStream([
      ': this is a comment\n',
      '\n',
      'data: {"value":1}\n\n',
      '\n',
      ': another comment\n',
      'data: [DONE]\n\n',
    ]);

    const events: Record<string, unknown>[] = [];
    for await (const event of parseSSEStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(1);
  });

  it('handles chunks split across boundaries', async () => {
    // The JSON is split across two chunks
    const stream = makeStream([
      'data: {"ch',
      'oices":[{"delta":{"content":"split"}}]}\n\ndata: [DONE]\n\n',
    ]);

    const events: Record<string, unknown>[] = [];
    for await (const event of parseSSEStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect((events[0].choices as any[])[0].delta.content).toBe('split');
  });
});

// ── CopilotProvider.chatStream tests ────────────────────────────────────────

describe('CopilotProvider.chatStream', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchSSE(chunks: string[]) {
    const mockFn = vi.fn().mockResolvedValue({
      ok: true,
      body: makeStream(chunks),
    });
    globalThis.fetch = mockFn;
    return mockFn;
  }

  function mockFetchError(status: number, body: string) {
    const mockFn = vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve(body),
    });
    globalThis.fetch = mockFn;
    return mockFn;
  }

  async function createProvider() {
    const { CopilotProvider } = await import('../copilot.js');
    // Create with a token and inject a fake resolved token to skip auth
    const provider = new CopilotProvider({ githubToken: 'test-token' });
    // Inject cached token to bypass actual token exchange
    (provider as any).resolvedToken = {
      token: 'fake-api-token',
      expiresAt: Date.now() + 3600 * 1000,
      baseUrl: 'https://api.test.com',
      source: 'test',
    };
    return provider;
  }

  it('yields content deltas with done: false', async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const provider = await createProvider();
    const deltas: import('../types.js').StreamDelta[] = [];
    for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }

    // Should have: "Hello", " there", and final done=true
    const contentDeltas = deltas.filter(d => d.content);
    expect(contentDeltas).toHaveLength(2);
    expect(contentDeltas[0].content).toBe('Hello');
    expect(contentDeltas[1].content).toBe(' there');
    expect(contentDeltas.every(d => d.done === false)).toBe(true);
  });

  it('assembles tool call chunks across deltas', async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Shell","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"ls\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const provider = await createProvider();
    const deltas: import('../types.js').StreamDelta[] = [];
    for await (const delta of provider.chatStream([{ role: 'user', content: 'list files' }])) {
      deltas.push(delta);
    }

    const toolDeltas = deltas.filter(d => d.tool_calls);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    // First tool delta should have the id and name
    expect(toolDeltas[0].tool_calls![0].id).toBe('call_1');
    expect(toolDeltas[0].tool_calls![0].function?.name).toBe('Shell');
  });

  it('sets done: true on final chunk', async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const provider = await createProvider();
    const deltas: import('../types.js').StreamDelta[] = [];
    for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }

    const last = deltas[deltas.length - 1];
    expect(last.done).toBe(true);
    expect(last.finish_reason).toBe('stop');
  });

  it('handles empty/role-only deltas by skipping them', async () => {
    mockFetchSSE([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const provider = await createProvider();
    const deltas: import('../types.js').StreamDelta[] = [];
    for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }

    // Role-only and empty deltas should be skipped; content + final done
    const contentDeltas = deltas.filter(d => d.content);
    expect(contentDeltas).toHaveLength(1);
    expect(contentDeltas[0].content).toBe('ok');
  });

  it('throws on HTTP error', async () => {
    mockFetchError(500, 'Internal Server Error');

    const provider = await createProvider();

    await expect(async () => {
      for await (const _ of provider.chatStream([{ role: 'user', content: 'hi' }])) {
        // should not reach here
      }
    }).rejects.toThrow('Copilot API error: HTTP 500');
  });
});
