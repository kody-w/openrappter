// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../services/gateway.js';
import '../components/rappids.js';

interface RappidElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}

const fixture = {
  rappid: 'rappid:@kody-w/quantum-continuity:' + '8'.repeat(64),
  name: 'quantum-continuity',
  displayName: 'Quanta',
  species: 'Quantum continuity RAPPID',
  lifecycleStage: 'baby',
  localOnly: true,
  stats: {
    frameHeight: 2,
    displayHeightMm: 420,
    totalWeightBytes: 4096,
    verifiedWeightBytes: 4096,
    residentWeightBytes: 3072,
    linkedWeightBytes: 1024,
    weightComplete: true,
    uniqueFrames: 2,
    uniqueAssets: 3,
  },
  traits: {
    continuity: 0.97,
    curiosity: 0.84,
  },
  dimensions: [
    { name: 'memory', status: 'active' },
    { name: 'sonic', status: 'active', mediaTypes: ['audio/midi'] },
  ],
  sonic: {
    wakeCall: true,
    midiDna: true,
    autocomplete: true,
  },
};

async function settle(element: RappidElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('openrappter-rappids', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('renders exact creature stats and dimension state from the gateway', async () => {
    vi.spyOn(gateway, 'call').mockResolvedValue([fixture]);
    const element = document.createElement('openrappter-rappids') as RappidElement;
    document.body.append(element);
    await settle(element);

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Quanta');
    expect(text).toContain('4.00 KiB');
    expect(text).toContain('2 frames');
    expect(text).toContain('0.42 m');
    expect(text).toContain('memory · active');
    expect(text).toContain('sonic · active');
    expect(gateway.call).toHaveBeenCalledWith('rappid.list');
  });

  it('keeps autocomplete non-authoritative until an approved append', async () => {
    const proposal = {
      id: 'proposal-1',
      rappid: fixture.rappid,
      dimension: 'stats',
      title: 'A third verified frame',
      summary: 'Preview only.',
      predictedStats: { ...fixture.stats, frameHeight: 3 },
      evidence: ['Two accepted body frames'],
      authoritative: false,
      appendable: false,
    };
    vi.spyOn(gateway, 'call').mockImplementation(async (method) => {
      if (method === 'rappid.list') return [fixture];
      if (method === 'rappid.autocomplete') return proposal;
      throw new Error(`unexpected ${method}`);
    });
    const element = document.createElement('openrappter-rappids') as RappidElement;
    document.body.append(element);
    await settle(element);

    const preview = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Preview next frame'));
    preview?.click();
    await settle(element);

    expect(element.shadowRoot?.textContent).toContain('Non-authoritative autocomplete');
    const append = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Append verified growth frame'));
    expect(append?.disabled).toBe(true);
    expect(gateway.call).not.toHaveBeenCalledWith(
      'rappid.grow',
      expect.anything(),
    );
  });

  it('tries the verified lossless wake-call fallback when the preferred track fails', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(async (method, input) => {
      if (method === 'rappid.list') return [fixture];
      if (method === 'rappid.asset') {
        const asset = (input as { asset?: string }).asset;
        throw new Error(asset === 'wake-call' ? 'preferred unavailable' : 'fallback unavailable');
      }
      throw new Error(`unexpected ${method}`);
    });
    const element = document.createElement('openrappter-rappids') as RappidElement;
    document.body.append(element);
    await settle(element);

    const wake = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Wake call'));
    wake?.click();
    await settle(element);

    expect(gateway.call).toHaveBeenCalledWith('rappid.asset', {
      rappid: fixture.rappid,
      asset: 'wake-call',
    });
    expect(gateway.call).toHaveBeenCalledWith('rappid.asset', {
      rappid: fixture.rappid,
      asset: 'wake-call-lossless',
    });
    expect(element.shadowRoot?.textContent).toContain('lossless fallback failed');
  });
});
