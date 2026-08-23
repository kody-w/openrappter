import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { GatewayServer } from '../../gateway/server.js';

/**
 * The dormant method modules stay dormant.
 *
 * `gateway/methods/*.ts` holds standalone RPC modules. Only the explicitly
 * production-wired modules below are invoked by
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
const SERVER = resolve(__dirname, '../../gateway/server.ts');

/**
 * The production modules `GatewayServer` is meant to invoke.
 *
 * Anything else being called is the bug this file exists to catch. Listed
 * explicitly so wiring a sixth is a deliberate edit here, not a silent one.
 */
const INTENTIONALLY_INVOKED = new Set([
  'registerAuthMethods',
  'registerBackupMethods',
  'registerRappterMethods',
  'registerRappidMethods',
  'registerRappidCardMethods',
  'registerShowcaseMethods',
  'registerSurgeonMethods',
]);

/** Every `registerXMethods` export under gateway/methods, with its file. */
function registerFunctions(): Array<{ file: string; fn: string }> {
  const found: Array<{ file: string; fn: string }> = [];
  for (const file of readdirSync(METHODS_DIR)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const source = readFileSync(join(METHODS_DIR, file), 'utf-8');
    for (const match of source.matchAll(/export function (register[A-Za-z]+)/g)) {
      found.push({ file, fn: match[1] });
    }
  }
  return found;
}

/** Is this function actually called in server.ts (ignoring comments)? */
function invokedByServer(fn: string): boolean {
  const source = readFileSync(SERVER, 'utf-8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n');
  return new RegExp(`\\b${fn}\\s*\\(`).test(source);
}

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
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
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

  it('invokes no dormant module, one at a time either', () => {
    // The registerAllMethods check above only covers the one-line shortcut.
    // Wiring a single module directly — `registerChannelsMethods(this)` —
    // passed every assertion in this file, while that module declares
    // channels.connect and channels.list, which the real server already
    // registers. It would have overridden real handlers with disconnected
    // demos, which is exactly what the doc comment on registerBuiltInMethods
    // warns about.
    const unexpected = registerFunctions()
      .filter(({ fn }) => !INTENTIONALLY_INVOKED.has(fn) && invokedByServer(fn))
      .map(({ file, fn }) => `${fn} (${file})`)
      .sort();
    expect(unexpected).toEqual([]);
  });

  it('the intentionally-invoked modules really are invoked', () => {
    // Guards the list above. If one is renamed or dropped, this fails rather
    // than silently shrinking the set of things anyone is checking.
    const missing = [...INTENTIONALLY_INVOKED].filter((fn) => !invokedByServer(fn)).sort();
    expect(missing).toEqual([]);
  });

  it('finds register functions to check', () => {
    // A rename that makes the scan match nothing would leave both assertions
    // above passing over an empty list.
    expect(registerFunctions().length).toBeGreaterThan(15);
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
