// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/rappid-card.js';
import { gateway } from '../services/gateway.js';

interface CardElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}

const scenario = {
  name: 'valid-test',
  profile: 'rappid-card-test/1',
  kind: 'body.debug-card',
  physical: false,
  expected: { ok: true, step: null, reason_contains: null },
};

const frame = {
  spec: 'rapp/1',
  kind: 'body.debug-card',
  stream_id: `rappid:@synthetic/card-subject:${'a'.repeat(64)}`,
  payload_hash: 'b'.repeat(64),
  payload: {
    profile: 'rappid-card-test/1',
    rappid: `rappid:@synthetic/card-subject:${'a'.repeat(64)}`,
    classification: 'public',
    key_id: `rappid:@synthetic/rappid-card-test:${'c'.repeat(64)}`,
    endpoint_origin: 'https://cards.example',
    requested_scope: ['memory-read'],
    inventory: [
      {
        part: 'engram',
        space: 'rapp/1:egg',
        hash: 'd'.repeat(64),
        bytes: 74,
        required: true,
      },
    ],
  },
};

function response(verification?: {
  ok: boolean;
  step: string | null;
  reason: string;
  result: { status: string; runtime_policy_seq: number; authority_seq: number; revocation_seq: number } | null;
}) {
  return {
    scenario: 'valid-test',
    exact_link:
      `rappid://link/rappid%3A%40synthetic%2Fcard-subject%3A${'a'.repeat(64)}`
      + `?m=${'b'.repeat(64)}&e=https%3A%2F%2Fcards.example%2Fx.rappid-card.json`
      + '&n=valid-test-card-0001',
    qr_svg: '<svg viewBox="0 0 21 21"><path d="M0 0h1v1H0z"/></svg>',
    frame,
    expected: scenario.expected,
    verification,
    provenance: 'rapp-1 commit 392f850',
  };
}

async function settle(element: CardElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('openrappter-rappid-card PR9 surface', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('loads scenario/frame/exact-link preview without verification', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.card.production-status') {
        return { available: false, status: 'unavailable', reason: 'live-adapter-required', required_adapters: [] };
      }
      if (method === 'rappid.card.scenarios') return [scenario];
      if (method === 'rappid.card.preview') return response();
      throw new Error(`unexpected ${method}`);
    });
    const element = document.createElement('openrappter-rappid-card') as CardElement;
    document.body.append(element);
    await settle(element);
    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('RAPP/1 PR9');
    expect(text).toContain('body.debug-card');
    expect(text).toContain('rappid-card-test/1');
    expect(text).toContain('preview');
    expect(text).toContain('Production verification unavailable');
    expect(gateway.call).not.toHaveBeenCalledWith('rappid.card.verify', expect.anything());
  });

  it('requires a separate explicit verify action and renders awake', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.card.production-status') {
        return { available: false, status: 'unavailable', reason: 'live-adapter-required', required_adapters: [] };
      }
      if (method === 'rappid.card.scenarios') return [scenario];
      if (method === 'rappid.card.preview') return response();
      if (method === 'rappid.card.verify') {
        return response({
          ok: true,
          step: null,
          reason: 'awake',
          result: {
            status: 'awake',
            runtime_policy_seq: 7,
            authority_seq: 11,
            revocation_seq: 13,
          },
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    const element = document.createElement('openrappter-rappid-card') as CardElement;
    document.body.append(element);
    await settle(element);
    const button = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((entry) => entry.textContent?.includes('Explicitly run'));
    button?.click();
    await settle(element);
    expect(gateway.call).toHaveBeenCalledWith('rappid.card.verify', {
      scenario: 'valid-test',
      approve: true,
    });
    expect(element.shadowRoot?.textContent).toContain('awake');
  });

  it('renders the declared refusal step', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.card.production-status') {
        return { available: false, status: 'unavailable', reason: 'live-adapter-required', required_adapters: [] };
      }
      if (method === 'rappid.card.scenarios') return [scenario];
      if (method === 'rappid.card.preview') return response();
      if (method === 'rappid.card.verify') {
        return response({
          ok: false,
          step: 'signature',
          reason: 'unknown signing key',
          result: null,
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    const element = document.createElement('openrappter-rappid-card') as CardElement;
    document.body.append(element);
    await settle(element);
    const button = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((entry) => entry.textContent?.includes('Explicitly run'));
    button?.click();
    await settle(element);
    expect(element.shadowRoot?.textContent).toContain('signature');
    expect(element.shadowRoot?.textContent).toContain('unknown signing key');
  });
});
