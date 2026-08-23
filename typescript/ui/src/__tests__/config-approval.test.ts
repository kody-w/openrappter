import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/config.js';
import {
  createConfigState,
  reviewConfigPayload,
  saveReviewedConfig,
  updateConfigRaw,
  type ConfigState,
} from '../services/config.js';
import { gateway } from '../services/gateway.js';
import {
  handleDesktopUiCommand,
  snapshotDesktopUi,
} from '../services/desktop-control.js';

function state(
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): ConfigState {
  return {
    ...createConfigState(),
    client: {
      isConnected: true,
      call,
    } as never,
    raw: 'port: 18790\n',
    hash: 'base-hash',
    format: 'yaml',
    dirty: true,
  };
}

describe('configuration approval payload binding', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('canonicalizes and freezes exact payload/base/action hashes', async () => {
    const reviewed = await reviewConfigPayload(
      'port: 18790\r\n',
      'yaml',
      'base-hash',
    );
    expect(Object.isFrozen(reviewed)).toBe(true);
    expect(reviewed).toMatchObject({
      schema: 'openrappter-reviewed-config/1.0',
      action: 'config.set',
      raw: 'port: 18790\r\n',
      format: 'yaml',
      baseHash: 'base-hash',
    });
    expect(reviewed.reviewedConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reviewed.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(reviewConfigPayload(
      'port: 18791\r\n',
      'yaml',
      'base-hash',
    )).resolves.not.toMatchObject({ payloadHash: reviewed.payloadHash });
  });

  it('saves exactly the frozen reviewed snapshot on an unchanged base', async () => {
    let getCount = 0;
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'config.get') {
        getCount++;
        return getCount === 1
          ? { raw: 'port: 18790\n', hash: 'base-hash', format: 'yaml' }
          : { raw: 'port: 18790\n', hash: 'new-hash', format: 'yaml' };
      }
      if (method === 'config.set') {
        expect(params).toEqual({
          raw: 'port: 18790\n',
          baseHash: 'base-hash',
        });
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    });
    const config = state(call);
    const reviewed = await reviewConfigPayload(
      config.raw,
      config.format,
      config.hash,
    );
    await expect(saveReviewedConfig(config, reviewed)).resolves.toBe(true);
    expect(call.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(1);
    expect(config.hash).toBe('new-hash');
  });

  it('rejects semantic/local payload substitution before any save RPC', async () => {
    const call = vi.fn();
    const config = state(call);
    const reviewed = await reviewConfigPayload(
      config.raw,
      config.format,
      config.hash,
    );
    config.raw = 'port: 1\n';
    await expect(saveReviewedConfig(config, reviewed)).resolves.toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(config.error).toMatch(/reviewed payload changed/);
  });

  it('rejects a concurrent base change and requires re-review', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'config.get') {
        return { raw: 'changed: true\n', hash: 'other-base', format: 'yaml' };
      }
      throw new Error('config.set must not run');
    });
    const config = state(call);
    const reviewed = await reviewConfigPayload(
      config.raw,
      config.format,
      config.hash,
    );
    await expect(saveReviewedConfig(config, reviewed)).resolves.toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('config.get', {});
    expect(config.error).toMatch(/base config changed/);
  });

  it('rejects a stale approval bound to another action', async () => {
    const call = vi.fn();
    const config = state(call);
    const reviewed = await reviewConfigPayload(
      config.raw,
      config.format,
      config.hash,
    );
    const substituted = {
      ...reviewed,
      action: 'config.apply',
    } as unknown as typeof reviewed;
    await expect(saveReviewedConfig(config, substituted)).resolves.toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(config.error).toMatch(/reviewed payload changed/);
  });

  it('invalidates a pending review on raw and form edits', async () => {
    const element = document.createElement('openrappter-config') as HTMLElement &
      Record<string, unknown>;
    const internal = element as unknown as {
      configState: ConfigState;
      requestSaveApproval(): Promise<void>;
      handleInput(event: Event): void;
      patchConfig(path: string[], value: unknown): void;
      pendingSaveApproval: {
        approval: { actionFingerprint: string };
        reviewed: { payloadHash: string; baseHash: string };
      } | null;
      saveMessage: string;
    };
    internal.configState = state(vi.fn());
    await internal.requestSaveApproval();
    expect(internal.pendingSaveApproval).not.toBeNull();
    expect(internal.pendingSaveApproval!.approval.actionFingerprint).toContain(
      `config.set payload=${internal.pendingSaveApproval!.reviewed.payloadHash}`,
    );
    expect(internal.pendingSaveApproval!.approval.actionFingerprint).toContain(
      `base=${internal.pendingSaveApproval!.reviewed.baseHash}`,
    );
    internal.handleInput({
      target: { value: 'port: 1\n' },
    } as unknown as Event);
    expect(internal.pendingSaveApproval).toBeNull();
    expect(internal.saveMessage).toMatch(/invalidated/);

    updateConfigRaw(internal.configState, 'port: 18790\n');
    internal.configState.hash = 'base-hash';
    await internal.requestSaveApproval();
    internal.patchConfig(['port'], 18791);
    expect(internal.pendingSaveApproval).toBeNull();
    expect(internal.saveMessage).toMatch(/re-review/);
  });

  it('semantic input cannot substitute a frozen payload or confirm it', async () => {
    vi.spyOn(gateway, 'isConnected', 'get').mockReturnValue(true);
    vi.spyOn(gateway, 'call').mockImplementation(async (method: string) => {
      if (method === 'config.get') {
        return {
          raw: 'port: 18790\n',
          hash: 'base-hash',
          format: 'yaml',
        } as never;
      }
      throw new Error(`unexpected ${method}`);
    });
    const element = document.createElement('openrappter-config') as HTMLElement &
      Record<string, unknown>;
    document.body.append(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const internal = element as unknown as {
      configState: ConfigState;
      mode: 'form' | 'raw';
      requestSaveApproval(): Promise<void>;
      pendingSaveApproval: unknown;
      saveMessage: string;
      requestUpdate(): void;
      updateComplete: Promise<unknown>;
    };
    internal.mode = 'raw';
    updateConfigRaw(internal.configState, 'port: 18791\n');
    await internal.requestSaveApproval();
    internal.requestUpdate();
    await internal.updateComplete;

    const snapshot = snapshotDesktopUi();
    const editor = snapshot.elements.find((control) =>
      control.tag === 'textarea');
    const confirm = snapshot.elements.find((control) =>
      control.text.includes('Confirm configuration save'));
    expect(editor?.disabled).toBe(true);
    expect(confirm).toBeDefined();

    await handleDesktopUiCommand({
      action: 'input',
      args: { ref: editor!.ref, value: 'port: 1\n' },
    });
    expect(internal.pendingSaveApproval).toBeNull();
    expect(internal.saveMessage).toMatch(/invalidated/);
    await expect(handleDesktopUiCommand({
      action: 'click',
      args: { ref: confirm!.ref },
    })).rejects.toThrow(/sensitive|expired/);
    expect(gateway.call).not.toHaveBeenCalledWith('config.set', expect.anything());
  });
});
