// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadReleaseRing: vi.fn(),
  previewReleaseRing: vi.fn(),
  applyReleaseRing: vi.fn(),
}));

vi.mock('../services/release-rings.js', () => ({
  RELEASE_RINGS: ['stable', 'beta', 'canary', 'alpha', 'nightly'],
  compareSemVer: vi.fn(),
  ...mocks,
}));

import '../components/release-ring-switcher.js';

type Element = HTMLElement & { updateComplete: Promise<boolean> };
const stable = {
  ring: 'stable',
  version: '2.0.0',
  commit: 'a'.repeat(40),
  status: 'published',
  reason: null,
  selected: true,
  nonStable: false,
  olderThanCurrent: false,
  canApply: true,
};
const beta = {
  ...stable,
  ring: 'beta',
  version: '1.9.8',
  commit: 'b'.repeat(40),
  selected: false,
  nonStable: true,
  olderThanCurrent: true,
};

async function settle(element: Element): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('release ring switcher', () => {
  beforeEach(() => {
    mocks.loadReleaseRing.mockResolvedValue({
      allowedRings: ['stable', 'beta', 'canary', 'alpha', 'nightly'],
      selectedRing: 'stable',
      currentVersion: '2.0.0',
      resolved: stable,
    });
    mocks.previewReleaseRing.mockResolvedValue(beta);
    mocks.applyReleaseRing.mockResolvedValue({
      applied: true,
      selectedRing: 'beta',
      resolved: { ...beta, selected: true },
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('lists only the five rings and displays the exact selected identity', async () => {
    const element = document.createElement('openrappter-release-ring-switcher') as Element;
    document.body.append(element);
    await settle(element);
    const options = Array.from(element.shadowRoot!.querySelectorAll('option')).map(
      option => option.value,
    );
    expect(options).toEqual(['stable', 'beta', 'canary', 'alpha', 'nightly']);
    expect(element.shadowRoot!.textContent).toContain('2.0.0');
    expect(element.shadowRoot!.textContent).toContain('a'.repeat(40));
    expect(element.shadowRoot!.textContent).toContain('published');
  });

  it('warns on non-stable/older selection and never applies on a stray change', async () => {
    const element = document.createElement('openrappter-release-ring-switcher') as Element;
    document.body.append(element);
    await settle(element);
    const select = element.shadowRoot!.querySelector('select')!;
    select.value = 'beta';
    select.dispatchEvent(new Event('change'));
    await settle(element);
    expect(mocks.previewReleaseRing).toHaveBeenCalledWith('beta');
    expect(mocks.applyReleaseRing).not.toHaveBeenCalled();
    expect(element.shadowRoot!.textContent).toContain('non-stable');
    expect(element.shadowRoot!.textContent).toContain('older than installed');
    expect(element.shadowRoot!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });

  it('requires downgrade acknowledgement and an explicit Apply click', async () => {
    const element = document.createElement('openrappter-release-ring-switcher') as Element;
    document.body.append(element);
    await settle(element);
    const select = element.shadowRoot!.querySelector('select')!;
    select.value = 'beta';
    select.dispatchEvent(new Event('change'));
    await settle(element);
    const approval = element.shadowRoot!.querySelector<HTMLInputElement>('.approval input')!;
    approval.checked = true;
    approval.dispatchEvent(new Event('change'));
    await settle(element);
    const apply = element.shadowRoot!.querySelector<HTMLButtonElement>('button')!;
    expect(apply.disabled).toBe(false);
    apply.click();
    await settle(element);
    expect(mocks.applyReleaseRing).toHaveBeenCalledExactlyOnceWith('beta', true);
    expect(element.shadowRoot!.textContent).toContain('No package was downloaded');
  });

  it('shows disabled status and cannot apply it', async () => {
    mocks.previewReleaseRing.mockResolvedValueOnce({
      ...beta,
      ring: 'canary',
      status: 'disabled',
      reason: 'No rollout receipt exists.',
      canApply: false,
      olderThanCurrent: false,
    });
    const element = document.createElement('openrappter-release-ring-switcher') as Element;
    document.body.append(element);
    await settle(element);
    const select = element.shadowRoot!.querySelector('select')!;
    select.value = 'canary';
    select.dispatchEvent(new Event('change'));
    await settle(element);
    expect(element.shadowRoot!.textContent).toContain('No rollout receipt exists.');
    expect(element.shadowRoot!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });
});
