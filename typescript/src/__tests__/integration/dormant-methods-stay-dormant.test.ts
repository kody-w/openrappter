import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

/**
 * The dormant method modules stay dormant.
 *
 * `gateway/methods/*.ts` holds 25 standalone RPC modules. Only 5 are invoked by
 * `GatewayServer`; the rest declare the same method names against their own
 * disconnected dependencies. The doc comment on `registerBuiltInMethods` warns
 * that wiring them would "silently duplicate or override the real, wired
 * handlers with divergent implementations".
 *
 * That warning is the whole risk here. The obvious way to "fix" a missing
 * method is to call `registerAllMethods` — and it would appear to work: the
 * name would resolve, and `client-rpc-coverage.test.ts` would go green, because
 * that test proves a name is *registered*, not that the handler is *real*.
 *
 * This was measured, not assumed. In #189 the agent swapped its real zen
 * implementation for `registerZenMethods` and recorded the result: 14 of its
 * contract tests failed while the coverage guard still passed.
 *
 * So this pins the other half. These names exist only inside the dormant
 * modules — three separate agents rejected them in #182, #183 and #184 as the
 * wrong names, backed by dependencies nothing supplies, returning hardcoded
 * values. If any of them starts resolving on a running server, something wired
 * the demos in.
 */

const METHODS_DIR = resolve(__dirname, '../../gateway/methods');

/** Names that appear only in the dormant modules and in no real handler. */
const DEMO_ONLY = [
  'exec.approval.request',
  'exec.approval.resolve',
  'exec.approvals.get',
  'exec.approvals.set',
  'usage.status',
  'usage.cost',
  'logs.tail',
  'config.patch',
] as const;

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function registered(): Promise<Set<string>> {
  const port = await reserveTestPort();
  server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
  server.setSurgeonService({} as never);
  server.setRappterManager({} as never);
  await server.start();
  return new Set((server as unknown as { methods: Map<string, unknown> }).methods.keys());
}

describe('the dormant RPC method modules stay out of the gateway', () => {
  it('GatewayServer never calls registerAllMethods', () => {
    // The single line that would wire all 25 modules at once.
    const source = readFileSync(resolve(__dirname, '../../gateway/server.ts'), 'utf-8');
    const invocations = source
      .split('\n')
      .filter((line) => /registerAllMethods\s*\(/.test(line))
      .filter((line) => !line.trimStart().startsWith('*'));
    expect(invocations).toEqual([]);
  });

  it('answers none of the demo-only method names', async () => {
    const have = await registered();
    const leaked = DEMO_ONLY.filter((name) => have.has(name)).sort();
    expect(leaked).toEqual([]);
  });

  it('the demo-only names really are declared in those modules', () => {
    // Guards the list above. If these modules are deleted or renamed, the
    // assertion behind them becomes vacuous and should be revisited rather
    // than left passing over names nothing declares any more.
    const declared = readdirSync(METHODS_DIR)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(METHODS_DIR, file), 'utf-8'))
      .join('\n');
    const missing = DEMO_ONLY.filter((name) => !declared.includes(`'${name}'`)).sort();
    expect(missing).toEqual([]);
  });
});
