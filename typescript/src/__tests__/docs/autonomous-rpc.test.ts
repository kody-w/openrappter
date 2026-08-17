import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

/**
 * `docs/AUTONOMOUS.md` hands an autonomous agent a list of RPC methods to
 * call. It listed `config.schema`, which only exists in
 * `gateway/methods/config-methods.ts` — a module deliberately never registered
 * — so an agent following the documentation got method-not-found.
 *
 * The list is now checked against a real started GatewayServer. Methods are
 * registered in `start()` rather than the constructor, so a test that only
 * constructs one reports every method missing and proves nothing.
 */

const DOC = resolve(__dirname, '../../../../docs/AUTONOMOUS.md');

/** The backticked method names from the "Useful methods:" sentence. */
function documentedMethods(): string[] {
  const text = readFileSync(DOC, 'utf-8');
  const start = text.indexOf('Useful methods:');
  if (start === -1) throw new Error('AUTONOMOUS.md no longer lists useful methods');
  const sentence = text.slice(start, text.indexOf('.\n', start));
  return [...sentence.matchAll(/`([a-z]+\.[a-zA-Z]+)`/g)].map((match) => match[1]);
}

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function registeredMethods(): Promise<Set<string>> {
  const port = await reserveTestPort();
  server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
  await server.start();
  const registry = (server as unknown as {
    methods: Map<string, unknown>;
  }).methods;
  return new Set(registry.keys());
}

describe('the RPC methods AUTONOMOUS.md tells an agent to call', () => {
  it('finds a non-empty list in the document', () => {
    // Guards the parser: if the sentence is reworded and this silently matches
    // nothing, the test below would pass over an empty list.
    expect(documentedMethods().length).toBeGreaterThan(4);
  });

  it('are all registered by a running gateway', async () => {
    const registered = await registeredMethods();
    const missing = documentedMethods().filter((method) => !registered.has(method));
    expect(missing).toEqual([]);
  });
});
