/**
 * `contracts/rapp-chat-v1.json`, executed against the TypeScript `/chat`.
 *
 * The contract is the shared RAPP/1 chat surface, and until now it was read by
 * exactly one file -- `python/tests/test_openrappter_brainstem.py` -- which
 * loaded it and asserted a single thing:
 *
 *     assert contract["brand"] == "RAPP + X™"
 *
 * Every other assertion in that test was a hardcoded literal, so the `required`
 * arrays -- the actual contract -- constrained nothing. Appending a required
 * key named `a_field_nothing_emits` to the success response left the suite
 * green. TypeScript did not read the file at all.
 *
 * So the tests here drive every assertion off the parsed contract. Adding a key
 * to `required` must fail this file until the gateway emits it, and removing
 * one must stop it being checked. Nothing below names a response field except
 * where the contract fixes its literal value.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT = resolve(__dirname, '../../../../contracts/rapp-chat-v1.json');

interface ChatContract {
  brand: string;
  endpoint: { method: string; path: string };
  request: {
    canonical_input: string;
    required_one_of: string[];
    aliases: Record<string, string>;
  };
  response: {
    success: { required: string[]; properties: Record<string, string> };
    error: { required: string[]; properties: Record<string, string> };
  };
}

const contract: ChatContract = JSON.parse(readFileSync(CONTRACT, 'utf-8'));

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Start a gateway whose agent echoes the prompt it was handed. */
async function startGateway(): Promise<number> {
  const port = await reserveTestPort();
  server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
  server.setAgentHandler(async (request) => ({
    // `sessionId` is required by AgentResponse; the gateway echoes whatever the
    // handler returns, so a stub that omits it is not a conforming handler.
    sessionId: request.sessionId ?? '',
    content: `echo:${request.message}`,
    agentLogs: [],
  }));
  await server.start();
  return port;
}

async function postChat(
  port: number,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${contract.endpoint.path}`, {
    method: contract.endpoint.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Literal values the contract fixes, e.g. `"status": "success"`. */
function fixedValues(properties: Record<string, string>): [string, string][] {
  return Object.entries(properties).filter(
    ([, spec]) => spec !== 'string' && spec !== 'boolean' && !spec.endsWith('?'),
  );
}

describe('rapp-chat-v1: the success envelope', () => {
  it('carries every key the contract requires', async () => {
    const port = await startGateway();
    const { status, body } = await postChat(port, {
      [contract.request.canonical_input]: 'hello',
      session_id: 'contract-session',
    });

    expect(status).toBe(200);
    const missing = contract.response.success.required.filter((k) => !(k in body));
    expect(missing, `contract requires these and /chat omitted them`).toEqual([]);
  });

  it('uses the literal values the contract fixes', async () => {
    const port = await startGateway();
    const { body } = await postChat(port, {
      [contract.request.canonical_input]: 'hello',
      session_id: 'contract-session',
    });

    for (const [key, value] of fixedValues(contract.response.success.properties)) {
      expect(body[key], `${key} is fixed by the contract`).toBe(value);
    }
  });

  it('echoes the session id back under both spellings', async () => {
    const port = await startGateway();
    const { body } = await postChat(port, {
      [contract.request.canonical_input]: 'hello',
      session_id: 'contract-session',
    });
    expect(body.session_id).toBe('contract-session');
    expect(body.sessionId).toBe(body.session_id);
  });
});

describe('rapp-chat-v1: the error envelope', () => {
  it('carries every key the contract requires', async () => {
    const port = await startGateway();
    // Empty input is a documented 400.
    const { status, body } = await postChat(port, {
      [contract.request.canonical_input]: '   ',
    });

    expect(status).toBe(400);
    const missing = contract.response.error.required.filter((k) => !(k in body));
    expect(missing, `contract requires these on error and /chat omitted them`).toEqual([]);
  });

  it('uses the literal values the contract fixes', async () => {
    const port = await startGateway();
    const { body } = await postChat(port, { [contract.request.canonical_input]: '   ' });
    for (const [key, value] of fixedValues(contract.response.error.properties)) {
      expect(body[key], `${key} is fixed by the contract`).toBe(value);
    }
  });
});

describe('rapp-chat-v1: request aliases', () => {
  it('accepts each alias the contract declares', async () => {
    const port = await startGateway();
    const canonical = await postChat(port, {
      [contract.request.canonical_input]: 'hello',
      session_id: 's',
      conversation_history: [],
    });

    for (const [alias, target] of Object.entries(contract.request.aliases)) {
      const payload: Record<string, unknown> = {
        [contract.request.canonical_input]: 'hello',
        session_id: 's',
        conversation_history: [],
      };
      // Move the value from the spec key onto its alias.
      payload[alias] = payload[target];
      delete payload[target];
      if (target === contract.request.canonical_input) {
        delete payload[contract.request.canonical_input];
        payload[alias] = 'hello';
      }

      const aliased = await postChat(port, payload);
      expect(aliased.status, `alias ${alias} -> ${target}`).toBe(200);
      expect(aliased.body.response, `alias ${alias} -> ${target}`).toBe(
        canonical.body.response,
      );
    }
  });

  it('accepts a request carrying only an alias for the input', async () => {
    const port = await startGateway();
    for (const key of contract.request.required_one_of) {
      const { status } = await postChat(port, { [key]: 'hello' });
      expect(status, `${key} alone should be accepted`).toBe(200);
    }
  });

  it('prefers the canonical key over its alias when both are sent', async () => {
    const port = await startGateway();
    const aliasForInput = Object.entries(contract.request.aliases)
      .find(([, target]) => target === contract.request.canonical_input)?.[0];
    expect(aliasForInput, 'contract should declare an alias for the input').toBeTruthy();

    const { body } = await postChat(port, {
      [contract.request.canonical_input]: 'from-spec-key',
      [aliasForInput!]: 'from-alias',
    });
    // The precedence recorded in the contract, and the divergence #335 closed.
    expect(body.response).toContain('from-spec-key');
    expect(body.response).not.toContain('from-alias');
  });
});
