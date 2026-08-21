import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerRappidCardMethods } from './rappid-card-methods.js';

type Handler = (params: Record<string, unknown>) => Promise<unknown>;
const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function registrar() {
  const methods = new Map<string, Handler>();
  const auth = new Map<string, boolean>();
  const dataDir = join(process.cwd(), `.pr9-gateway-${process.pid}-${roots.length}`);
  roots.push(dataDir);
  mkdirSync(dataDir, { recursive: true });
  registerRappidCardMethods({
    registerMethod(name, handler, options) {
      methods.set(name, (params) =>
        (handler as (value: Record<string, unknown>, connection: unknown) => Promise<unknown>)(
          params,
          {},
        ));
      auth.set(name, options?.requiresAuth === true);
    },
  }, { dataDir });
  return { methods, auth };
}

describe('PR9 RAPPID card gateway methods', () => {
  it('registers only authenticated test-vector methods', () => {
    const { methods, auth } = registrar();
    expect([...methods.keys()].sort()).toEqual([
      'rappid.card.preview',
      'rappid.card.production-status',
      'rappid.card.scenarios',
      'rappid.card.verify',
    ]);
    expect([...auth.values()]).toEqual([true, true, true, true]);
  });

  it('reports production unavailable without accepting caller evidence', async () => {
    const { methods } = registrar();
    await expect(methods.get('rappid.card.production-status')!({
      trust: 'attacker',
      now_utc: 'attacker',
    })).resolves.toMatchObject({
      available: false,
      status: 'unavailable',
      reason: 'live-adapter-required',
    });
  });

  it('lists all 63 scenarios and previews exact frame/link/QR wire names', async () => {
    const { methods } = registrar();
    const scenarios = await methods.get('rappid.card.scenarios')!({}) as unknown[];
    expect(scenarios).toHaveLength(63);
    const preview = await methods.get('rappid.card.preview')!({
      scenario: 'physical-payload-reproduction',
    }) as Record<string, unknown>;
    expect(preview).toMatchObject({
      scenario: 'physical-payload-reproduction',
      provenance: 'rapp-1 commit 4751cd8291d0e4ca935d435fdcc2374a2b2628f9',
      expected: { ok: true, step: null },
      frame: { kind: 'body.debug-card', spec: 'rapp/1' },
    });
    expect(String(preview.exact_link)).toMatch(/^rappid:\/\/link\//);
    expect(String(preview.qr_svg)).toContain('<svg');
  });

  it('requires explicit approval and exposes exact verifier step', async () => {
    const { methods } = registrar();
    await expect(methods.get('rappid.card.verify')!({
      scenario: 'valid-test',
    })).rejects.toThrow('approve=true');
    const valid = await methods.get('rappid.card.verify')!({
      scenario: 'valid-test',
      approve: true,
    }) as { verification: { ok: boolean; step: string | null } };
    const expired = await methods.get('rappid.card.verify')!({
      scenario: 'expired',
      approve: true,
    }) as { verification: { ok: boolean; step: string | null } };
    expect(valid.verification).toMatchObject({ ok: true, step: null });
    expect(expired.verification).toMatchObject({ ok: false, step: 'expiry' });
  });
});
