import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RappWork } from '../components/work.js';
import { webcrypto } from 'node:crypto';
import { framedGateway } from './fixtures/work-rapp-fixture.js';

const client = vi.hoisted(() => ({ call: vi.fn(), dispatch: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('../services/gateway.js', () => ({ gateway: { call: client.dispatch, on: client.on, off: client.off } }));
import '../components/work.js';

const workspaces = [
  { id: 'finance', agentId: 'Finance', name: 'Finance workspace', rootPath: '/work/finance/files', memoryPath: '/work/finance/memory', isolation: 'dedicated', status: 'active' },
  { id: 'operations', agentId: 'Operations', name: 'Operations workspace', rootPath: '/work/operations/files', memoryPath: '/work/operations/memory', isolation: 'dedicated', status: 'idle' },
];
const threads = [
  { id: 'finance-thread', agentId: 'Finance', title: 'Cashflow review', messageCount: 2, createdAt: '2026-09-11T13:00:00Z', updatedAt: '2026-09-11T13:02:00Z' },
  { id: 'operations-thread', agentId: 'Operations', title: 'Client handoff', messageCount: 1, createdAt: '2026-09-11T13:00:00Z', updatedAt: '2026-09-11T13:01:00Z' },
];
const approval = { id: 'approval-1', command: 'write draft.md', description: 'Create a draft for review', status: 'pending' };
const messages = [{
  id: 'message-1', role: 'assistant', content: 'A cashflow finding with a reported source.', timestamp: '2026-09-11T13:02:00Z',
  citations: [{ id: 'source-1', title: 'Ledger', source: 'ledger.csv · row 42', excerpt: 'Reported data', url: 'https://example.org/ledger' }],
  toolCalls: [{ id: 'tool-1', name: 'read_file', status: 'success', arguments: {}, result: 'Local ledger receipt' }],
}];

function unavailable(method: string) {
  return Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

function rpc(method: string, params?: Record<string, unknown>): unknown {
  switch (method) {
    case 'agents.list': return [{ id: 'Finance', description: 'Financial analysis' }, { id: 'Operations', description: 'Business operations' }];
    case 'workspace.list': return { workspaces };
    case 'workspace.get': return { workspace: workspaces.find((item) => item.id === params?.workspaceId) };
    case 'chat.list': return threads;
    case 'chat.messages': return params?.sessionId === 'finance-thread' ? messages
      : [{ id: 'ops-message', role: 'user', content: 'Operations-only brief.', timestamp: '2026-09-11T13:00:00Z' }];
    case 'exec.pending': return [approval];
    case 'exec.respond': return { ok: true, approvalId: params?.approvalId, approved: params?.approved, status: params?.approved ? 'approved' : 'denied' };
    case 'vm.status': return { id: 'omarchy', name: 'Omarchy', state: 'stopped', local: true };
    default: throw unavailable(method);
  }
}

async function settle(element: RappWork) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await element.updateComplete;
  }
}

async function mount(connected = true) {
  const element = document.createElement('rapp-work');
  element.connected = connected;
  document.body.append(element);
  await settle(element);
  return element;
}

function button(element: RappWork, label: string) {
  const found = [...element.shadowRoot!.querySelectorAll('button')]
    .find((item) => item.textContent?.trim() === label);
  expect(found, `Button ${label} exists`).toBeDefined();
  return found!;
}

function text(element: RappWork) { return element.shadowRoot!.textContent ?? ''; }

describe('RAPP Work business dashboard', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-11T14:00:00Z'));
    client.call.mockReset().mockImplementation(async (method, params) => rpc(method, params));
    client.dispatch.mockReset().mockImplementation(framedGateway((method, params) =>
      params === undefined ? client.call(method) : client.call(method, params)));
    client.on.mockClear();
    client.off.mockClear();
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders branding, persistent roster, business threads, approvals, evidence, and run receipts', async () => {
    const element = await mount();
    for (const label of ['RAPP Work', 'Your local AI workforce.', 'Your workforce', 'Work threads', 'Task / run timeline', 'Needs your approval', 'Evidence & citations', 'Local computer']) {
      expect(text(element)).toContain(label);
    }
    expect(text(element)).toContain('Cashflow review');
    expect(text(element)).toContain('Local ledger receipt');
    expect(element.shadowRoot!.querySelectorAll('.agent')).toHaveLength(2);
    expect(element.shadowRoot!.querySelector('[data-demo]')).toBeNull();
    expect(text(element)).not.toMatch(/patient|dinosaur|Operating room|September operating review/);
    expect(element.shadowRoot!.querySelectorAll('.timeline li')).toHaveLength(2);
    expect(element.shadowRoot!.querySelector('.evidence-item a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps agent files, memory, presence, and threads separate when switching the roster', async () => {
    const element = await mount();
    expect(text(element)).toContain('Active');
    expect(text(element)).toContain('Idle');
    expect(text(element)).toContain('/work/finance/files');
    expect(text(element)).toContain('/work/finance/memory');
    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-agent-id="Operations"]')!.click();
    await settle(element);
    expect(text(element)).toContain('/work/operations/files');
    expect(text(element)).toContain('/work/operations/memory');
    expect(text(element)).toContain('Operations-only brief.');
    expect(text(element)).not.toContain('/work/finance/files');
    expect(text(element)).not.toContain('A cashflow finding');
    expect(client.call).toHaveBeenCalledWith('workspace.get', { workspaceId: 'operations' });
    expect(element.shadowRoot!.querySelector('[data-agent-id="Operations"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps citation numbers aligned with the evidence panel across multiple messages and tool receipts', async () => {
    client.call.mockImplementation(async (method, params) => method === 'chat.messages' ? [
      ...messages,
      {
        id: 'second-message', role: 'assistant', content: 'A second sourced finding.', timestamp: '2026-09-11T13:03:00Z',
        citations: [{ id: 'second-source', title: 'Second source', source: 'second.csv', excerpt: 'Second reported value.' }],
      },
    ] : rpc(method, params));
    const element = await mount();
    const chips = [...element.shadowRoot!.querySelectorAll('.citation-chip')].map((chip) => chip.textContent);
    expect(chips).toEqual(['[1] Ledger', '[3] Second source']);
    const entries = [...element.shadowRoot!.querySelectorAll('.evidence-item summary')].map((entry) => entry.textContent);
    expect(entries).toEqual(['[1] Ledger', '[2] read_file · success', '[3] Second source']);
  });

  it('shows a clearly labeled, non-actionable demo only when workspace.list is unavailable', async () => {
    client.call.mockImplementation(async (method, params) => {
      if (method === 'workspace.list' || method === 'vm.status') throw unavailable(method);
      return rpc(method, params);
    });
    const element = await mount();
    expect(text(element)).toContain('Local demo · read-only');
    expect(text(element)).toContain('no work is running');
    expect(text(element)).toContain('Example paths · not created');
    expect(text(element)).toContain('September operating review');
    expect(text(element)).toContain('Example source · not verified');
    expect(button(element, 'Approve (demo)').disabled).toBe(true);
    expect(button(element, 'Start VM').disabled).toBe(true);
    button(element, 'Approve (demo)').click();
    button(element, 'Start VM').click();
    expect(client.call.mock.calls.some(([method]) => ['exec.respond', 'vm.start', 'agent'].includes(method))).toBe(false);
    button(element, 'Use gateway data · 1 live approvals').click();
    await settle(element);
    expect(text(element)).toContain('Cashflow review');
    expect(text(element)).not.toContain('September operating review');
    expect(text(element)).toContain('Workspace not reported');
    expect(button(element, 'Approve').disabled).toBe(false);
  });

  it.each([
    new Error('Request timed out'),
    Object.assign(new Error('Unauthorized'), { code: -32000 }),
    new Error('Not connected'),
  ])('does not turn a gateway failure into a successful demo', async (failure) => {
    client.call.mockImplementation(async (method, params) => {
      if (method === 'workspace.list') throw failure;
      return rpc(method, params);
    });
    const element = await mount();
    expect(element.shadowRoot!.querySelector('[data-demo]')).toBeNull();
    expect(text(element)).not.toContain('September operating review');
    expect(text(element)).toContain(failure.message);
  });

  it('keeps an empty live gateway empty instead of adding example workers or approvals', async () => {
    client.call.mockImplementation(async (method) => method === 'vm.status' ? rpc(method) : []);
    const element = await mount();
    expect(element.shadowRoot!.querySelectorAll('.agent')).toHaveLength(0);
    expect(element.shadowRoot!.querySelector('[data-demo]')).toBeNull();
    expect(text(element)).toContain('No pending approvals.');
    expect(text(element)).toContain('No source receipts were supplied');
  });

  it('does not hide other authorization errors behind a missing-workspace demo', async () => {
    client.call.mockImplementation(async (method, params) => {
      if (method === 'workspace.list') throw unavailable(method);
      if (method === 'agents.list') throw Object.assign(new Error('Unauthorized agent roster'), { code: -32000 });
      return rpc(method, params);
    });
    const element = await mount();
    expect(element.shadowRoot!.querySelector('[data-demo]')).toBeNull();
    expect(text(element)).toContain('Unauthorized agent roster');
    expect(text(element)).toContain('Resolve the live data errors');
    expect(text(element)).not.toContain('September operating review');
  });

  it('treats missing workspace details as a local capability gap, not a reason to replace live work', async () => {
    client.call.mockImplementation(async (method, params) => {
      if (method === 'workspace.get') throw unavailable(method);
      return rpc(method, params);
    });
    const element = await mount();
    expect(text(element)).toContain('Workspace details unavailable');
    expect(text(element)).toContain('/work/finance/files');
    expect(text(element)).toContain('Cashflow review');
    expect(element.shadowRoot!.querySelector('[data-demo]')).toBeNull();
  });

  it('flags a shared path instead of claiming workspace isolation', async () => {
    const shared = workspaces.map((item) => ({ ...item, rootPath: '/work/shared' }));
    client.call.mockImplementation(async (method, params) => {
      if (method === 'workspace.list') return shared;
      if (method === 'workspace.get') return shared.find((item) => item.id === params?.workspaceId);
      return rpc(method, params);
    });
    const element = await mount();
    expect(text(element)).toContain('Shared path detected');
    expect(text(element)).not.toContain('Independent workspace');
  });

  it('discards stale thread loads rather than crossing agent boundaries', async () => {
    let resolveFinance!: (value: unknown) => void;
    client.call.mockImplementation(async (method, params) => {
      if (method === 'chat.messages' && params?.sessionId === 'finance-thread') {
        return new Promise((resolve) => { resolveFinance = resolve; });
      }
      return rpc(method, params);
    });
    const element = await mount();
    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-agent-id="Operations"]')!.click();
    await settle(element);
    resolveFinance(messages);
    await settle(element);
    expect(text(element)).toContain('Operations-only brief.');
    expect(text(element)).not.toContain('A cashflow finding');
    expect(text(element)).not.toContain('/work/finance/files');
  });

  it('discards late capability responses after disconnection and stops all polling', async () => {
    let rejectWorkspaces!: (reason: unknown) => void;
    client.call.mockImplementation(async (method, params) => {
      if (method === 'workspace.list') return new Promise((_, reject) => { rejectWorkspaces = reject; });
      return rpc(method, params);
    });
    const element = await mount();
    element.connected = false;
    await settle(element);
    rejectWorkspaces(unavailable('workspace.list'));
    await settle(element);
    expect(element.shadowRoot!.querySelector('[data-demo]')).toBeNull();
    expect(text(element)).not.toContain('September operating review');
    const calls = client.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.call).toHaveBeenCalledTimes(calls);
    expect(button(element, 'Start VM').disabled).toBe(true);
  });

  it('connects a running, confirmed-local VM to a loopback viewer without a cloud browser', async () => {
    client.call.mockImplementation(async (method, params) => method === 'vm.status'
      ? { id: 'omarchy', state: 'running', local: true, viewerUrl: 'http://127.0.0.1:6080/vnc.html' }
      : rpc(method, params));
    const element = await mount();
    const frame = element.shadowRoot!.querySelector('iframe');
    expect(frame?.title).toBe('Live local Omarchy desktop');
    expect(frame?.src).toBe('http://127.0.0.1:6080/vnc.html');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(frame?.hasAttribute('data-desktop-private')).toBe(true);
    expect(text(element)).toContain('On your machine. Not in a hosted browser.');
    expect(text(element)).toContain('Shared screen');
    expect(button(element, 'Stop VM').disabled).toBe(false);
    expect(button(element, 'Stop VM').dataset.desktopSensitive).toBe('vm-control');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.call.mock.calls.filter(([method]) => method === 'vm.status')).toHaveLength(2);
  });

  it.each([
    { state: 'running', local: false, viewerUrl: 'http://localhost:6080/' },
    { state: 'running', local: true, viewerUrl: 'https://hosted-browser.example/' },
  ])('does not embed an unconfirmed or remote display', async (status) => {
    client.call.mockImplementation(async (method, params) => method === 'vm.status' ? status : rpc(method, params));
    const element = await mount();
    expect(element.shadowRoot!.querySelector('iframe')).toBeNull();
  });

  it('does not manufacture a running VM when vm.start is unavailable', async () => {
    const element = await mount();
    button(element, 'Start VM').click();
    await settle(element);
    expect(client.dispatch).toHaveBeenCalledWith('work.rapp.commit', expect.objectContaining({ method: 'vm.start', params: {} }));
    expect(text(element)).toContain('Start not confirmed.');
    expect(text(element)).toContain('Your local computer is stopped');
    expect(button(element, 'Stop VM').disabled).toBe(true);
  });

  it('uses confirmed VM transitions and never changes stopped directly to running optimistically', async () => {
    let resolveStart!: (value: unknown) => void;
    client.call.mockImplementation(async (method, params) => method === 'vm.start'
      ? new Promise((resolve) => { resolveStart = resolve; }) : rpc(method, params));
    const element = await mount();
    button(element, 'Start VM').click();
    await settle(element);
    expect(text(element)).toContain('Waiting for gateway confirmation');
    expect(button(element, 'Stop VM').disabled).toBe(true);
    resolveStart({ state: 'starting', local: true });
    await settle(element);
    expect(text(element)).toContain('starting · Shared screen');
    expect(button(element, 'Stop VM').disabled).toBe(true);
  });

  it('keeps a live approval pending until an explicit, matching gateway receipt arrives', async () => {
    let resolveDecision!: (value: unknown) => void;
    let decided = false;
    client.call.mockImplementation(async (method, params) => {
      if (method === 'exec.respond') return new Promise((resolve) => { resolveDecision = resolve; });
      if (method === 'exec.pending' && decided) return [];
      return rpc(method, params);
    });
    const element = await mount();
    expect(button(element, 'Approve').dataset.desktopSensitive).toBe('execution-approval');
    button(element, 'Approve').click();
    await settle(element);
    expect(button(element, 'Approve').disabled).toBe(true);
    expect(element.shadowRoot!.querySelectorAll('.approval')).toHaveLength(1);
    expect(client.call).toHaveBeenCalledWith('exec.respond', { approvalId: 'approval-1', approved: true });
    decided = true;
    resolveDecision({ ok: true, approvalId: 'approval-1', approved: true, status: 'approved' });
    await settle(element);
    expect(text(element)).toContain('Gateway confirmed: approved.');
    expect(element.shadowRoot!.querySelectorAll('.approval')).toHaveLength(0);
    element.connected = false;
    await settle(element);
    expect(text(element)).not.toContain('Gateway confirmed: approved.');
  });

  it('keeps an approval visible on unavailable or failed mutation and labels unknown ownership', async () => {
    client.call.mockImplementation(async (method, params) => {
      if (method === 'exec.respond') throw unavailable(method);
      return rpc(method, params);
    });
    const element = await mount();
    expect(text(element)).toContain('Agent not supplied by gateway');
    button(element, 'Deny').click();
    await settle(element);
    expect(client.call).toHaveBeenCalledWith('exec.respond', { approvalId: 'approval-1', approved: false });
    expect(element.shadowRoot!.querySelectorAll('.approval')).toHaveLength(1);
    expect(text(element)).toContain('Decision not confirmed.');
    expect(text(element)).toContain('Method not found: exec.respond');
    expect(text(element)).not.toContain('Gateway confirmed:');
  });

  it('does not let the UI act on expired approvals', async () => {
    client.call.mockImplementation(async (method, params) => method === 'exec.pending'
      ? [{ ...approval, expiresAt: Date.now() - 1000 }] : rpc(method, params));
    const element = await mount();
    expect(button(element, 'Approve').disabled).toBe(true);
    expect(button(element, 'Deny').disabled).toBe(true);
    expect(text(element)).toContain('Expired.');
  });

  it('navigates to real chat threads but never passes example session IDs to the gateway', async () => {
    const element = await mount();
    const navigate = vi.fn();
    element.addEventListener('navigate', navigate);
    button(element, 'Open compatibility Chat →').click();
    expect(navigate.mock.calls[0][0].detail).toEqual({ view: 'chat', sessionId: 'finance-thread' });
    button(element, 'Compatibility Chat ↗').click();
    expect(navigate.mock.calls[1][0].detail).toEqual({ view: 'chat' });
    expect(client.call.mock.calls.some(([method]) => method === 'agent')).toBe(false);
  });

  it('cleans up event listeners and polling when removed', async () => {
    const element = await mount();
    const subscriptions = [...client.on.mock.calls];
    element.remove();
    const calls = client.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.call).toHaveBeenCalledTimes(calls);
    for (const [event, callback] of subscriptions) {
      expect(client.off).toHaveBeenCalledWith(event, callback);
    }
  });

  it('labels missing RAPP/1 integration and blocks VM/approval mutations without fallback', async () => {
    const framed = client.dispatch.getMockImplementation()!;
    client.dispatch.mockImplementation(async (method, params) => {
      if (method === 'work.rapp.verify') throw unavailable(method);
      return framed(method, params);
    });
    const element = await mount();
    expect(text(element)).toContain('RAPP/1 verification is per item');
    expect(button(element, 'Approve').disabled).toBe(true);
    expect(button(element, 'Start VM').disabled).toBe(true);
    for (const badge of element.shadowRoot!.querySelectorAll('rapp-verification')) {
      expect(badge.shadowRoot?.querySelector('[data-rapp-status="verified"]')).toBeNull();
    }
    button(element, 'Approve').click();
    button(element, 'Start VM').click();
    expect(client.dispatch.mock.calls.some(([method]) => ['work.rapp.commit', 'vm.start', 'exec.respond'].includes(method))).toBe(false);
  });

  it('shows per-surface verification only after real canonical fixture frames are scanned and hash-checked', async () => {
    const element = await mount();
    for (const selector of [
      '[data-agent-id="Finance"]', '.workspace-boundary', '.message', '.timeline',
      '.computer', '.approval', '.evidence-item',
    ]) {
      const badges = [...element.shadowRoot!.querySelector(selector)!.querySelectorAll('rapp-verification')];
      expect(badges.some((badge) => badge.shadowRoot?.querySelector('[data-rapp-status="verified"]')), selector).toBe(true);
    }
    expect(client.dispatch.mock.calls.some(([method]) => method === 'work.rapp.verify')).toBe(true);
    expect(button(element, 'Approve').disabled).toBe(false);
    expect(button(element, 'Start VM').disabled).toBe(false);
  });

  it('does not display a verified badge or enable an action when frame evidence is tampered', async () => {
    const framed = client.dispatch.getMockImplementation()!;
    client.dispatch.mockImplementation(async (method, params) => {
      const result = await framed(method, params);
      if (method === 'work.rapp.verify') {
        const scan = JSON.parse(JSON.stringify(result));
        scan.memory.frames[1].frame_hash = 'f'.repeat(64);
        return scan;
      }
      return result;
    });
    const element = await mount();
    expect(button(element, 'Approve').disabled).toBe(true);
    expect(button(element, 'Start VM').disabled).toBe(true);
    const badges = [...element.shadowRoot!.querySelectorAll('rapp-verification')];
    expect(badges.some((badge) => badge.shadowRoot?.querySelector('[data-rapp-status="invalid"]'))).toBe(true);
    expect(badges.some((badge) => badge.shadowRoot?.querySelector('[data-rapp-status="verified"]'))).toBe(false);
  });

  it('resumes reads and polling when the same element is reattached', async () => {
    const element = await mount();
    element.remove();
    client.call.mockClear();
    document.body.append(element);
    await settle(element);
    expect(client.call).toHaveBeenCalledWith('workspace.list');
    expect(client.call).toHaveBeenCalledWith('vm.status');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.call.mock.calls.filter(([method]) => method === 'vm.status')).toHaveLength(2);
  });

  it('updates observed activity for only the matching agent and keeps partial text off screen', async () => {
    client.call.mockImplementation(async (method, params) => method === 'workspace.list'
      ? workspaces.map((item) => ({ ...item, status: 'idle' })) : rpc(method, params));
    const element = await mount();
    const onChat = client.on.mock.calls.find(([event]) => event === 'chat')![1];
    onChat({ sessionKey: 'operations-thread', state: 'delta', message: { content: 'UNCOMMITTED DELTA' } });
    await settle(element);
    expect(element.shadowRoot!.querySelector('[data-agent-id="Operations"] .presence')?.textContent).toContain('Active');
    expect(element.shadowRoot!.querySelector('[data-agent-id="Finance"] .presence')?.textContent).toContain('Idle');
    expect(text(element)).not.toContain('UNCOMMITTED DELTA');
    onChat({ sessionKey: 'operations-thread', state: 'final' });
    await settle(element);
    expect(element.shadowRoot!.querySelector('[data-agent-id="Operations"] .presence')?.textContent).toContain('Idle');
  });
});
