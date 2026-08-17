import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { BrainstemAgent, __manifest__ } from '../BrainstemAgent.js';
import { resetBrainstemDiscovery } from '../../gateway/brainstem-client.js';

/**
 * The assistant consulting the brainstem, without a brainstem.
 *
 * #226 let a person choose which brain answers; #229 gave the Python assistant
 * an agent so it could ask on its own. Without this one the gap was not
 * academic — the web UI and the Bar both talk to this runtime, so the human
 * could switch brains while the assistant they were talking to could not, and
 * "ask the brainstem and tell me what it said" was exactly the case that failed.
 *
 * The transport is shared with `chat.send`, so discovery, the `user_input`
 * spelling and envelope validation are covered by the client's own tests. What
 * is specific here is what the assistant hands back: an answer that is
 * attributed, and a failure that stays actionable instead of being flattened
 * into "something went wrong".
 */

const ENVELOPE = {
  response: 'The brainstem knows about Nicolas.',
  session_id: 'session-1',
  agent_logs: '',
  voice_mode: false,
  model: 'claude-opus-4.6',
  requested_model: 'auto',
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch);
}

function healthyThen(body: unknown, status = 200) {
  return (url: string) => {
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('BrainstemAgent', () => {
  beforeEach(() => resetBrainstemDiscovery());
  afterEach(() => vi.unstubAllGlobals());

  it('declares exactly the capability it uses', () => {
    // R4/R5: the conformance gate reads capabilities out of the syntax tree and
    // fails both under- and over-declaration.
    expect(__manifest__.schema).toBe('rapp-agent/1.0');
    expect(__manifest__.name).toBe('@openrappter/brainstem');
    expect(__manifest__.capabilities).toEqual(['network']);
  });

  it('constructs with no arguments, so discovery can register it', () => {
    // The built-in loader calls `new` with no arguments; a constructor that
    // needed one would be skipped with a logged warning and the agent would
    // silently not exist.
    expect(new BrainstemAgent().name).toBe('Brainstem');
  });

  it('asks for a question rather than sending an empty one', async () => {
    const result = await new BrainstemAgent().perform({ message: '   ' });
    expect(result).toMatch(/No question given/);
  });

  it('attributes the answer to the brainstem and names the model', async () => {
    stubFetch(healthyThen(ENVELOPE));

    const result = await new BrainstemAgent().perform({ message: 'what do you know?' });

    expect(result).toContain('The brainstem knows about Nicolas.');
    // A brainstem reply and this runtime's own reply are the same shape, so an
    // unlabelled one is indistinguishable from something the assistant worked
    // out itself.
    expect(result).toMatch(/^Brainstem \(/);
    expect(result).toContain('claude-opus-4.6');
    expect(result).toContain('session-1');
  });

  it('passes the session through so follow-ups continue the same thread', async () => {
    let sent: Record<string, unknown> = {};
    stubFetch((url, init) => {
      if (url.endsWith('/health')) return new Response('{"status":"ok"}');
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(ENVELOPE), {
        headers: { 'content-type': 'application/json' },
      });
    });

    await new BrainstemAgent().perform({ message: 'and then?', session_id: 'abc' });

    expect(sent.session_id).toBe('abc');
    // Both spellings, because the kernel this mirrors requires `user_input`.
    expect(sent.message).toBe('and then?');
    expect(sent.user_input).toBe('and then?');
  });

  it('keeps a failure actionable and says where it looked', async () => {
    stubFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const result = await new BrainstemAgent().perform({ message: 'hello' });

    // Flattening this into "something went wrong" would strip the one thing
    // that makes it fixable: which addresses were tried, and the command.
    expect(result).toMatch(/python -m openrappter\.brainstem/);
    expect(result).toContain('127.0.0.1:7072');
    expect(result).toContain('127.0.0.1:7071');
  });

  it('does not list candidate addresses when one was given', async () => {
    stubFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const result = await new BrainstemAgent().perform({
      message: 'hello',
      base_url: 'http://127.0.0.1:9999',
    });

    expect(result).toContain('9999');
    expect(result).not.toContain('Addresses tried');
  });

  it('refuses JSON that is not a chat envelope', async () => {
    // Something answering on that port is not the brainstem answering, and
    // passing its words back as the brainstem's is the worst outcome here.
    stubFetch(healthyThen({ ok: true, service: 'something-else' }));

    const result = await new BrainstemAgent().perform({ message: 'hello' });

    expect(result).toMatch(/not a chat envelope/);
  });
});
