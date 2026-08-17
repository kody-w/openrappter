import { describe, it, expect, beforeEach } from 'vitest';

import {
  askBrainstem,
  brainstemBaseUrl,
  BrainstemUnavailableError,
  BrainstemAbortedError,
  DEFAULT_BRAINSTEM_URL,
  resolveBrainstemUrl,
  resetBrainstemDiscovery,
} from '../brainstem-client.js';
import { normalizeChatTarget, CHAT_TARGETS } from '../server.js';

/**
 * One chat, two brains.
 *
 * The brainstem runs as its own process speaking HTTP `POST /chat`, while the
 * gateway speaks WebSocket `chat.send`. Holding a conversation across both used
 * to mean two chat windows. They can share one, because both return the same
 * frozen envelope — `rapp-runtime-parity/1.0` §2.4 — so a reply from either
 * renders identically.
 *
 * What has to be right for that to be safe rather than merely convenient: an
 * unknown target must not quietly answer from the wrong brain, and a brainstem
 * that is not running must say so in a way a person can act on. Both replies
 * look the same on the wire, so neither failure would be visible otherwise.
 */

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const envelope = {
  response: 'Hello from the brainstem.',
  session_id: 'session-1',
  agent_logs: '',
  voice_mode: false,
  model: 'copilot:auto',
  requested_model: 'auto',
};

describe('chat target resolution', () => {
  it('defaults to the local runtime when nothing is asked for', () => {
    expect(normalizeChatTarget(undefined)).toBe('openrappter');
    expect(normalizeChatTarget(null)).toBe('openrappter');
    expect(normalizeChatTarget('')).toBe('openrappter');
  });

  it('accepts every target it advertises', () => {
    // Anti-vacuity: if CHAT_TARGETS were emptied this loop would assert nothing.
    expect(CHAT_TARGETS.length).toBeGreaterThan(1);
    for (const target of CHAT_TARGETS) {
      expect(normalizeChatTarget(target)).toBe(target);
    }
  });

  it('refuses an unknown target rather than falling back', () => {
    // A typo must not silently answer from a different brain: the two replies
    // are the same shape, so the caller could not tell.
    expect(() => normalizeChatTarget('brainstm')).toThrow(/Unknown chat target/);
    expect(() => normalizeChatTarget('BRAINSTEM')).toThrow(/Unknown chat target/);
    expect(() => normalizeChatTarget(42)).toThrow(/Unknown chat target/);
  });
});

describe('brainstemBaseUrl', () => {
  it('is loopback unless configured', () => {
    expect(brainstemBaseUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_BRAINSTEM_URL);
    expect(DEFAULT_BRAINSTEM_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('honours an override and trims a trailing slash', () => {
    const env = { OPENRAPPTER_BRAINSTEM_URL: 'http://192.168.1.9:7071/' } as NodeJS.ProcessEnv;
    expect(brainstemBaseUrl(env)).toBe('http://192.168.1.9:7071');
  });

  it('ignores a blank override', () => {
    expect(brainstemBaseUrl({ OPENRAPPTER_BRAINSTEM_URL: '   ' } as NodeJS.ProcessEnv))
      .toBe(DEFAULT_BRAINSTEM_URL);
  });
});

describe('askBrainstem', () => {
  it('posts the kernel shape and returns the envelope unchanged', async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return jsonResponse(envelope);
    }) as unknown as typeof fetch;

    const result = await askBrainstem({
      message: 'hello',
      sessionId: 'session-1',
      baseUrl: 'http://127.0.0.1:7072',
      fetchImpl,
    });

    expect(seen!.url).toBe('http://127.0.0.1:7072/chat');
    // Both spellings. A live RAPP kernel answered
    // `400 {"error":"user_input is required"}` to a message-only body, and
    // every unit test here passed against a fake that accepted `message`, so
    // only the end-to-end run caught it.
    expect(seen!.body).toEqual({
      message: 'hello',
      user_input: 'hello',
      session_id: 'session-1',
    });
    // Passed through, not reshaped: rewriting it here would be a second place
    // for the two runtimes to drift.
    expect(result).toEqual(envelope);
  });

  it('omits the session when there is not one, rather than sending null', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(envelope);
    }) as unknown as typeof fetch;

    await askBrainstem({ message: 'hi', fetchImpl, baseUrl: 'http://127.0.0.1:7072' });

    expect('session_id' in body).toBe(false);
  });

  it('carries a voice seam through when the brainstem split one', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ ...envelope, voice_mode: true, voice_response: 'spoken part' })
    ) as unknown as typeof fetch;

    const result = await askBrainstem({ message: 'hi', fetchImpl });

    expect(result.voice_response).toBe('spoken part');
    expect(result.voice_mode).toBe(true);
  });

  it('says the brainstem is not running, and how to start it', async () => {
    // The overwhelmingly common failure. "fetch failed" would be useless.
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7072');
    }) as unknown as typeof fetch;

    await expect(askBrainstem({ message: 'hi', fetchImpl, baseUrl: 'http://127.0.0.1:7072' }))
      .rejects.toThrow(BrainstemUnavailableError);

    await expect(askBrainstem({ message: 'hi', fetchImpl, baseUrl: 'http://127.0.0.1:7072' }))
      .rejects.toThrow(/python -m openrappter\.brainstem/);
  });

  it('reports an HTTP failure with its status and body', async () => {
    const fetchImpl = (async () =>
      new Response('no model configured', { status: 503 })
    ) as unknown as typeof fetch;

    await expect(askBrainstem({ message: 'hi', fetchImpl })).rejects.toThrow(/503/);
    await expect(askBrainstem({ message: 'hi', fetchImpl })).rejects.toThrow(/no model configured/);
  });

  it('rejects a body that is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    ) as unknown as typeof fetch;

    await expect(askBrainstem({ message: 'hi', fetchImpl })).rejects.toThrow(/not JSON/);
  });

  it('rejects JSON that is not a chat envelope', async () => {
    // Something answered on that port. That is not the same as the brainstem
    // answering, and treating it as a reply would put another service's words
    // in the assistant's mouth.
    const fetchImpl = (async () =>
      jsonResponse({ ok: true, service: 'something-else' })
    ) as unknown as typeof fetch;

    await expect(askBrainstem({ message: 'hi', fetchImpl })).rejects.toThrow(/not a chat envelope/);
  });
});

describe('resolveBrainstemUrl', () => {
  beforeEach(() => resetBrainstemDiscovery());

  it('uses an explicit setting without probing anything', async () => {
    let probes = 0;
    const fetchImpl = (async () => { probes++; return new Response('{}'); }) as unknown as typeof fetch;

    const url = await resolveBrainstemUrl({
      env: { OPENRAPPTER_BRAINSTEM_URL: 'http://127.0.0.1:9999/' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(url).toBe('http://127.0.0.1:9999');
    // If someone has said where it is, quietly using a different one would be
    // worse than failing.
    expect(probes).toBe(0);
  });

  it('finds a brainstem sitting in the RAPP drop-in slot', async () => {
    // The installation this was written against has nothing on 7072 and a real
    // brainstem on 7071. A single hardcoded default would look broken there.
    const fetchImpl = (async (url: string | URL) =>
      String(url).includes('7071')
        ? new Response('{"status":"ok"}', { status: 200 })
        : Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;

    expect(await resolveBrainstemUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl }))
      .toBe('http://127.0.0.1:7071');
  });

  it('prefers this package own port when both answer', async () => {
    const fetchImpl = (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;
    expect(await resolveBrainstemUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl }))
      .toBe('http://127.0.0.1:7072');
  });

  it('names a concrete address when nothing answers', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await resolveBrainstemUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl }))
      .toBe(DEFAULT_BRAINSTEM_URL);
  });

  it('does not re-probe once it has found one', async () => {
    let probes = 0;
    const fetchImpl = (async () => { probes++; return new Response('{"status":"ok"}', { status: 200 }); }) as unknown as typeof fetch;

    await resolveBrainstemUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl });
    await resolveBrainstemUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl });

    expect(probes).toBe(1);
  });
});

describe('cancelling a brainstem request', () => {
  it('passes the caller signal to fetch, so the model stops generating', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse(envelope);
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    await askBrainstem({ message: 'hi', fetchImpl, signal: controller.signal, baseUrl: 'http://127.0.0.1:7072' });

    // Marking a run aborted only stops the gateway listening. Without a signal
    // on the request the brainstem keeps generating a reply nobody reads,
    // which on a hosted model is billed work.
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);

    controller.abort();
    expect(seenSignal!.aborted).toBe(true);
  });

  it('reports cancellation as cancellation, not as an unreachable brainstem', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      controller.abort();
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      void init;
      throw error;
    }) as unknown as typeof fetch;

    // Telling someone who pressed Stop that the brainstem is down, and offering
    // the command to start it, would be a confusing lie: it was reachable.
    await expect(
      askBrainstem({ message: 'hi', fetchImpl, signal: controller.signal }),
    ).rejects.toThrow(BrainstemAbortedError);
  });

  it('still reports an unreachable brainstem when nobody cancelled', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7072');
    }) as unknown as typeof fetch;

    await expect(
      askBrainstem({ message: 'hi', fetchImpl, signal: controller.signal }),
    ).rejects.toThrow(BrainstemUnavailableError);
  });

  it('still applies the timeout when no caller signal is given', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse(envelope);
    }) as unknown as typeof fetch;

    await askBrainstem({ message: 'hi', fetchImpl, timeoutMs: 5_000 });

    expect(seenSignal).toBeDefined();
  });
});
