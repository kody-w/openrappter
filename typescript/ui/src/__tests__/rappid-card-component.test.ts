// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/rappid-card.js';
import { gateway } from '../services/gateway.js';

interface CardElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}

const fixtures = [
  {
    name: 'valid',
    label: 'Valid card',
    description: 'A valid synthetic card.',
    transport: 'virtual',
    expectedState: 'awake',
    expectedError: null,
  },
  {
    name: 'challenge-failure',
    label: 'Continuity challenge failure',
    description: 'Challenge fails after hydration.',
    transport: 'virtual',
    expectedState: 'failed',
    expectedError: 'challenge_failed',
  },
];

function run(state: 'preview' | 'awake' | 'failed') {
  return {
    fixture: 'valid',
    exactDeepLink:
      'rappid://link/rappid:@openrappter/virtual-debug-card:'
      + 'a'.repeat(64)
      + '?m='
      + 'b'.repeat(64)
      + '&e=fixture-habitat&n='
      + 'c'.repeat(32),
    qrSvg: '<svg viewBox="0 0 21 21"><path d="M0 0h1v1H0z"/></svg>',
    simulation: {
      state,
      outcome: state === 'awake' ? 'awake' : state === 'failed' ? 'failed' : 'pending',
      error:
        state === 'failed'
          ? { code: 'challenge_failed', message: 'continuity challenge verification failed' }
          : null,
      preview: {
        rappid: 'rappid:@openrappter/virtual-debug-card:' + 'a'.repeat(64),
        profile: 'rappid-card-test/1',
        endpoint: 'fixture-habitat',
        issuerKeyId: 'fixture-signing-1',
        classification: 'public',
        scopes: ['identity:read'],
        parts: [
          {
            name: 'identity',
            hash: 'd'.repeat(64),
            bytes: 42,
            mediaType: 'application/json',
            required: true,
          },
        ],
      },
      hydrated: state === 'awake'
        ? [{ name: 'identity', hash: 'd'.repeat(64), bytes: 42, mediaType: 'application/json' }]
        : [],
      audit: [
        { seq: 1, state: 'parsed', event: 'link.parsed', detail: 'fixture-habitat' },
        { seq: 2, state, event: state === 'awake' ? 'card.awake' : 'preview.ready', detail: 'fixture' },
      ],
    },
  };
}

async function settle(element: CardElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('openrappter-rappid-card', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('loads fixture selection, exact link, real QR, and preview without hydration', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.card.fixtures') return fixtures;
      if (method === 'rappid.card.preview') return run('preview');
      throw new Error(`unexpected method ${method}`);
    });
    const element = document.createElement('openrappter-rappid-card') as CardElement;
    document.body.append(element);
    await settle(element);

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Virtual RAPPID Debug Card');
    expect(text).toContain('rappid-card-test/1');
    expect(text).toContain('preview');
    expect(element.shadowRoot?.querySelector('img')?.src).toContain('data:image/svg+xml');
    expect(gateway.call).toHaveBeenCalledWith('rappid.card.preview', {
      fixture: 'valid',
    });
    expect(gateway.call).not.toHaveBeenCalledWith(
      'rappid.card.simulate',
      expect.anything(),
    );
  });

  it('sends a separate explicit approval and renders awake', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.card.fixtures') return fixtures;
      if (method === 'rappid.card.preview') return run('preview');
      if (method === 'rappid.card.simulate') return run('awake');
      throw new Error(`unexpected method ${method}`);
    });
    const element = document.createElement('openrappter-rappid-card') as CardElement;
    document.body.append(element);
    await settle(element);

    const approve = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Explicitly approve'));
    approve?.click();
    await settle(element);

    expect(gateway.call).toHaveBeenCalledWith('rappid.card.simulate', {
      fixture: 'valid',
      approve: true,
    });
    expect(element.shadowRoot?.textContent).toContain('awake');
  });

  it('renders a visible challenge failure state', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.card.fixtures') return fixtures;
      if (method === 'rappid.card.preview') return run('preview');
      if (method === 'rappid.card.simulate') return run('failed');
      throw new Error(`unexpected method ${method}`);
    });
    const element = document.createElement('openrappter-rappid-card') as CardElement;
    document.body.append(element);
    await settle(element);

    const approve = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Explicitly approve'));
    approve?.click();
    await settle(element);

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('failed');
    expect(text).toContain('challenge_failed');
  });
});
