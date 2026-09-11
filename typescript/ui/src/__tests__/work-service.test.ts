import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { framedGateway } from './fixtures/work-rapp-fixture.js';
import { isWorkVerified } from '../services/work-rapp.js';
import {
  WorkService, evidenceUrl, isMethodUnavailable, localViewerUrl,
  type WorkWorkspace,
} from '../services/work.js';

const workspace: WorkWorkspace = {
  id: 'finance', agentId: 'Finance', name: 'Finance workspace',
  rootPath: '/workspaces/finance/files', memoryPath: '/workspaces/finance/memory',
  isolation: 'dedicated', status: 'idle',
};

describe('typed RAPP Work gateway service', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it('uses workspace.list/get and preserves independent workspace metadata', async () => {
    const call = vi.fn(framedGateway(async (method) => method === 'workspace.list' ? { workspaces: [workspace] } : { workspace }));
    const service = new WorkService({ call });
    expect(await service.listWorkspaces()).toMatchObject({ state: 'live', data: [workspace] });
    const result = await service.getWorkspace('finance');
    expect(result).toMatchObject({ state: 'live', data: workspace });
    expect(result.state === 'live' && isWorkVerified(result.data.rapp)).toBe(true);
    expect(call).toHaveBeenCalledWith('workspace.list');
    expect(call).toHaveBeenCalledWith('workspace.get', { workspaceId: 'finance' });
  });

  it('rejects a workspace response for a different selection', async () => {
    const service = new WorkService({ call: vi.fn().mockResolvedValue(workspace) });
    expect(await service.getWorkspace('operations')).toMatchObject({ state: 'error' });
  });

  it('never invents workspace isolation or presence', async () => {
    const service = new WorkService({
      call: vi.fn().mockResolvedValue([{ id: 'unknown', agentId: 'Unknown' }]),
    });
    expect(await service.listWorkspaces()).toMatchObject({
      state: 'live', data: [{ isolation: 'unknown', status: 'unknown' }],
    });
  });

  it('calls VM status/start/stop without executing local commands or inventing a result', async () => {
    const status = { id: 'omarchy', name: 'Omarchy', state: 'stopped', local: true };
    const call = vi.fn(framedGateway(async (method) =>
      ({ ...status, state: method === 'vm.start' ? 'running' : 'stopped' })));
    const service = new WorkService({ call });
    expect(await service.vmStatus()).toMatchObject({ state: 'live', data: status });
    expect(await service.startVm()).toMatchObject({ state: 'live', data: { state: 'running', local: true } });
    expect(await service.stopVm()).toMatchObject({ state: 'live', data: { state: 'stopped', local: true } });
    expect(call.mock.calls.map(([method]) => method)).toEqual(['vm.status', 'work.rapp.verify', 'work.rapp.commit', 'work.rapp.commit']);
    expect(call).toHaveBeenLastCalledWith('work.rapp.commit', expect.objectContaining({ method: 'vm.stop', subject: 'vm:omarchy' }));
  });

  it.each(['workspace.list', 'workspace.get', 'vm.status'])(
    'represents unavailable %s as a capability gap, never a successful demo mutation',
    async (method) => {
      const failure = Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
      const service = new WorkService({ call: vi.fn().mockRejectedValue(failure) });
      const result = await ({
        'workspace.list': () => service.listWorkspaces(),
        'workspace.get': () => service.getWorkspace('finance'),
        'vm.status': () => service.vmStatus(),
      }[method]!());
      expect(result).toMatchObject({ state: 'unavailable', method });
      expect(result).not.toHaveProperty('data');
    },
  );

  it.each(['startVm', 'stopVm'] as const)('blocks %s without verified frames and submits no legacy mutation', async (method) => {
    const call = vi.fn();
    const result = await new WorkService({ call })[method]();
    expect(result).toMatchObject({ state: 'error', detail: expect.stringContaining('Nothing was submitted') });
    expect(call).not.toHaveBeenCalled();
  });

  it('handles an unavailable canonical commit adapter without falling back to vm.start', async () => {
    const framed = framedGateway(async () => ({ id: 'omarchy', name: 'Omarchy', state: 'stopped', local: true }));
    const call = vi.fn(async (method, params) => {
      if (method === 'work.rapp.commit') throw Object.assign(new Error('Method not found: work.rapp.commit'), { code: -32601 });
      return framed(method, params);
    });
    const service = new WorkService({ call });
    await service.vmStatus();
    expect(await service.startVm()).toMatchObject({ state: 'unavailable', method: 'work.rapp.commit' });
    expect(call.mock.calls.some(([method]) => method === 'vm.start')).toBe(false);
  });

  it.each([
    new Error('Not connected'),
    new Error('Request timed out'),
    Object.assign(new Error('Method not found: workspace.list'), { code: -32000 }),
    Object.assign(new Error('Unauthorized'), { code: -32000 }),
  ])('does not disguise transport or authorization failures as unavailable methods', async (error) => {
    const service = new WorkService({ call: vi.fn().mockRejectedValue(error) });
    expect(await service.listWorkspaces()).toMatchObject({ state: 'error' });
    expect(isMethodUnavailable(error, 'workspace.list')).toBe(false);
  });

  it('recognizes only an exact legacy missing-method error without a code', () => {
    expect(isMethodUnavailable(new Error('Method not found: workspace.list'), 'workspace.list')).toBe(true);
    expect(isMethodUnavailable(new Error('Method not found: something.else'), 'workspace.list')).toBe(false);
  });

  it('keeps empty live lists empty and rejects malformed responses', async () => {
    const call = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce({ error: 'broken' });
    const service = new WorkService({ call });
    expect(await service.listWorkspaces()).toEqual({ state: 'live', data: [] });
    expect(await service.vmStatus()).toMatchObject({ state: 'error' });
  });

  it('requires a matching acknowledged approval decision', async () => {
    let invalid = true;
    const call = vi.fn(framedGateway(async (method, params) => method === 'exec.pending'
      ? [{ id: 'review', command: 'save draft', status: 'pending' }]
      : invalid ? { ok: false }
      : { ok: true, approvalId: params?.approvalId, approved: params?.approved, status: params?.approved ? 'approved' : 'denied' }));
    const service = new WorkService({ call });
    await service.pendingApprovals();
    expect(await service.respondToApproval('review', true)).toMatchObject({ state: 'error' });
    invalid = false;
    await service.pendingApprovals();
    expect(await service.respondToApproval('review', true)).toMatchObject({ state: 'live' });
    await service.pendingApprovals();
    expect(await service.respondToApproval('review', false)).toMatchObject({ state: 'live' });
    expect(call).toHaveBeenLastCalledWith('work.rapp.commit', expect.objectContaining({
      method: 'exec.respond', params: { approvalId: 'review', approved: false },
    }));
  });
});

describe('local computer and evidence links', () => {
  it.each([
    'http://127.0.0.1:6080/vnc.html',
    'http://localhost:6080/',
    'http://[::1]:6080/',
  ])('accepts a loopback viewer: %s', (url) => {
    expect(localViewerUrl(url)).toBe(url);
  });

  it.each([
    'https://hosted-browser.example/vnc',
    'http://localhost.attacker.example/',
    'http://127.0.0.1@attacker.example/',
    'http://user:password@localhost/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '/vnc.html',
  ])('refuses non-local or unsafe viewer URL: %s', (url) => {
    expect(localViewerUrl(url)).toBeNull();
  });

  it('only makes safe evidence URLs clickable', () => {
    expect(evidenceUrl('https://example.org/report')).toBe('https://example.org/report');
    expect(evidenceUrl('javascript:alert(1)')).toBeNull();
    expect(evidenceUrl('file:///private/report')).toBeNull();
  });
});
