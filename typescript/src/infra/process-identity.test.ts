import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetCurrentLiveIdentityForTest,
  assertIdentityBinding,
  currentLiveIdentity,
  declareCurrentLiveIdentity,
  deriveLiveId,
} from './process-identity.js';

const RAPPID_A = `rappid:@openrappter/alpha:${'a'.repeat(64)}`;
const RAPPID_B = `rappid:@openrappter/alpha:${'b'.repeat(64)}`;

afterEach(() => {
  __resetCurrentLiveIdentityForTest();
});

describe('PID-linked live RAPP identity', () => {
  it('is deterministic for the same stable RAPPID, PID, and incarnation', () => {
    const first = deriveLiveId(RAPPID_A, 4242, 'start-a');
    const second = deriveLiveId(RAPPID_A, 4242, 'start-a');

    expect(second).toBe(first);
  });

  it('uses the exact PID prefix and a short deterministic suffix', () => {
    expect(deriveLiveId(RAPPID_A, 4242, 'start-a'))
      .toMatch(/^rapp-4242-[0-9a-f]{16}$/);
  });

  it('changes when the stable RAPPID or incarnation changes', () => {
    const original = deriveLiveId(RAPPID_A, 4242, 'start-a');

    expect(deriveLiveId(RAPPID_B, 4242, 'start-a')).not.toBe(original);
    expect(deriveLiveId(RAPPID_A, 4242, 'start-b')).not.toBe(original);
  });

  it('does not reuse a live ID when the operating system reuses a PID', () => {
    const previousProcess = deriveLiveId(RAPPID_A, 4242, 'previous-start');
    const replacementProcess = deriveLiveId(RAPPID_A, 4242, 'replacement-start');

    expect(replacementProcess).not.toBe(previousProcess);
  });

  it('declares one idempotent binding and rejects stable or incarnation drift', () => {
    const setTitle = vi.fn();
    const first = declareCurrentLiveIdentity(RAPPID_A, {
      incarnation: 'start-a',
      setProcessTitle: setTitle,
    });
    const again = declareCurrentLiveIdentity(RAPPID_A, {
      incarnation: 'start-a',
      setProcessTitle: vi.fn(),
    });

    expect(again).toBe(first);
    expect(currentLiveIdentity()).toBe(first);
    expect(setTitle).toHaveBeenCalledOnce();
    expect(() => declareCurrentLiveIdentity(RAPPID_B, {
      incarnation: 'start-a',
      setProcessTitle: vi.fn(),
    })).toThrow(/identity drift/i);
    expect(() => declareCurrentLiveIdentity(RAPPID_A, {
      incarnation: 'start-b',
      setProcessTitle: vi.fn(),
    })).toThrow(/identity drift/i);
  });

  it('passes the live ID to the process-title setter', () => {
    const setTitle = vi.fn();
    const identity = declareCurrentLiveIdentity(RAPPID_A, {
      incarnation: 'start-a',
      setProcessTitle: setTitle,
    });

    expect(identity.liveId).toMatch(new RegExp(`^rapp-${process.pid}-[0-9a-f]{16}$`));
    expect(setTitle).toHaveBeenCalledWith(identity.liveId);
  });

  it('keeps the binding authoritative when setting the process title fails', () => {
    const identity = declareCurrentLiveIdentity(RAPPID_A, {
      incarnation: 'start-a',
      setProcessTitle: () => {
        throw new Error('unsupported');
      },
    });

    expect(currentLiveIdentity()).toBe(identity);
    expect(assertIdentityBinding(identity)).toBe(identity);
  });

  it('rejects a forged binding', () => {
    expect(() => assertIdentityBinding({
      rappid: RAPPID_A,
      liveId: 'rapp-forged',
      pid: process.pid,
      incarnation: 'start-a',
    })).toThrow(/not bound/i);
  });
});
