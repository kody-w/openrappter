/**
 * Tests for all controller services.
 * Uses a mock GatewayClient.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GatewayClient } from '../services/gateway.js';

// --- Mock Client Factory ---

function createMockClient(responses: Record<string, unknown> = {}): GatewayClient {
  return {
    isConnected: true,
    isAuthenticated: false,
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method in responses) {
        const val = responses[method];
        if (val instanceof Error) throw val;
        return val;
      }
      throw new Error(`Unmocked method: ${method}`);
    }),
    callStream: vi.fn(async (method: string, params?: Record<string, unknown>, onStream?: (r: any) => void) => {
      if (method in responses) {
        const val = responses[method];
        if (val instanceof Error) throw val;
        return val;
      }
      throw new Error(`Unmocked method: ${method}`);
    }),
    on: vi.fn(),
    off: vi.fn(),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    authenticate: vi.fn(async () => true),
    authenticateWithToken: vi.fn(async () => true),
    onStatusChange: null,
  } as unknown as GatewayClient;
}

// ===== Chat Controller =====

import {
  createChatState,
  loadChatHistory,
  sendChatMessage,
  loadSessions,
  deleteSession,
} from '../services/chat.js';

describe('Chat Controller', () => {
  it('createChatState returns default state', () => {
    const s = createChatState();
    expect(s.messages).toEqual([]);
    expect(s.sessionId).toBeNull();
    expect(s.sending).toBe(false);
    expect(s.error).toBeNull();
  });

  it('loadChatHistory populates messages', async () => {
    const msgs = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: '2025-01-01' },
      { id: 'm2', role: 'assistant', content: 'hello', timestamp: '2025-01-01' },
    ];
    const client = createMockClient({ 'chat.messages': msgs });
    const state = createChatState();
    state.client = client;

    await loadChatHistory(state, 'session-1');

    expect(state.messages).toEqual(msgs);
    expect(state.sessionId).toBe('session-1');
    expect(state.error).toBeNull();
  });

  it('loadChatHistory handles error', async () => {
    const client = createMockClient({ 'chat.messages': new Error('fail') });
    const state = createChatState();
    state.client = client;

    await loadChatHistory(state, 's1');
    expect(state.error).toContain('fail');
  });

  it('loadChatHistory does nothing when disconnected', async () => {
    const client = createMockClient();
    (client as any).isConnected = false;
    const state = createChatState();
    state.client = client;

    await loadChatHistory(state, 's1');
    expect(state.messages).toEqual([]);
  });

  it('sendChatMessage sets sending state', async () => {
    const client = createMockClient({
      agent: { sessionId: 's1', content: 'hi back' },
    });
    const state = createChatState();
    state.client = client;

    const result = await sendChatMessage(state, 'hello');
    expect(state.sending).toBe(false);
    expect(state.streaming).toBe(false);
    expect(result?.sessionId).toBe('s1');
    expect(state.sessionId).toBe('s1');
  });

  it('sendChatMessage rejects empty message', async () => {
    const state = createChatState();
    state.client = createMockClient();
    const result = await sendChatMessage(state, '  ');
    expect(result).toBeNull();
  });

  it('sendChatMessage handles error', async () => {
    const client = createMockClient({ agent: new Error('timeout') });
    const state = createChatState();
    state.client = client;

    const result = await sendChatMessage(state, 'hello');
    expect(result).toBeNull();
    expect(state.error).toContain('timeout');
    expect(state.sending).toBe(false);
  });

  it('loadSessions returns session list', async () => {
    const sessions = [
      { id: 's1', agentId: 'assistant', messageCount: 5, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
    ];
    const client = createMockClient({ 'chat.list': sessions });
    const result = await loadSessions(client);
    expect(result).toEqual(sessions);
  });

  it('loadSessions returns empty when disconnected', async () => {
    const client = createMockClient();
    (client as any).isConnected = false;
    const result = await loadSessions(client);
    expect(result).toEqual([]);
  });

  it('deleteSession returns true on success', async () => {
    const client = createMockClient({ 'chat.delete': { deleted: true } });
    expect(await deleteSession(client, 's1')).toBe(true);
  });
});

// ===== Config Controller =====

import {
  createConfigState,
  loadConfig,
  saveConfig,
  applyConfig,
  updateConfigRaw,
  resetConfig,
} from '../services/config.js';

describe('Config Controller', () => {
  it('createConfigState returns defaults', () => {
    const s = createConfigState();
    expect(s.raw).toBe('');
    expect(s.dirty).toBe(false);
    expect(s.loading).toBe(false);
  });

  it('loadConfig populates state from gateway', async () => {
    const snap = { raw: 'port: 18790', hash: 'abc', format: 'yaml' };
    const client = createMockClient({ 'config.get': snap });
    const state = createConfigState();
    state.client = client;

    await loadConfig(state);
    expect(state.raw).toBe('port: 18790');
    expect(state.hash).toBe('abc');
    expect(state.format).toBe('yaml');
    expect(state.dirty).toBe(false);
    expect(state.loading).toBe(false);
  });

  it('loadConfig handles error', async () => {
    const client = createMockClient({ 'config.get': new Error('denied') });
    const state = createConfigState();
    state.client = client;

    await loadConfig(state);
    expect(state.error).toContain('denied');
    expect(state.loading).toBe(false);
  });

  it('saveConfig sends raw+hash and reloads', async () => {
    const client = createMockClient({
      'config.set': { ok: true },
      'config.get': { raw: 'new', hash: 'xyz', format: 'yaml' },
    });
    const state = createConfigState();
    state.client = client;
    state.raw = 'new';
    state.hash = 'old';
    state.dirty = true;

    const result = await saveConfig(state);
    expect(result).toBe(true);
    expect(state.dirty).toBe(false);
    expect(state.hash).toBe('xyz');
    expect(client.call).toHaveBeenCalledWith('config.set', { raw: 'new', baseHash: 'old' });
  });

  it('applyConfig sends to config.apply', async () => {
    const client = createMockClient({
      'config.apply': { ok: true },
      'config.get': { raw: 'applied', hash: 'new', format: 'yaml' },
    });
    const state = createConfigState();
    state.client = client;
    state.raw = 'applied';
    state.hash = 'old';

    expect(await applyConfig(state)).toBe(true);
    expect(client.call).toHaveBeenCalledWith('config.apply', { raw: 'applied', baseHash: 'old' });
  });

  it('updateConfigRaw sets dirty', () => {
    const state = createConfigState();
    updateConfigRaw(state, 'changed');
    expect(state.raw).toBe('changed');
    expect(state.dirty).toBe(true);
  });

  it('resetConfig reverts and clears dirty', () => {
    const state = createConfigState();
    state.raw = 'modified';
    state.dirty = true;
    resetConfig(state, 'original');
    expect(state.raw).toBe('original');
    expect(state.dirty).toBe(false);
  });
});

// ===== Channels Controller =====

import {
  createChannelsState,
  loadChannels,
  sendChannelMessage,
} from '../services/channels.js';

describe('Channels Controller', () => {
  it('createChannelsState returns defaults', () => {
    const s = createChannelsState();
    expect(s.channels).toEqual([]);
    expect(s.loading).toBe(false);
  });

  it('loadChannels populates from gateway', async () => {
    const channels = [
      { id: 'discord', type: 'discord', connected: true },
      { id: 'slack', type: 'slack', connected: false },
    ];
    const client = createMockClient({ 'channels.list': channels });
    const state = createChannelsState();
    state.client = client;

    await loadChannels(state);
    expect(state.channels).toEqual(channels);
    expect(state.loading).toBe(false);
  });

  it('loadChannels handles error', async () => {
    const client = createMockClient({ 'channels.list': new Error('net err') });
    const state = createChannelsState();
    state.client = client;

    await loadChannels(state);
    expect(state.channels).toEqual([]);
    expect(state.error).toContain('net err');
  });

  it('sendChannelMessage returns sent status', async () => {
    const client = createMockClient({ 'channels.send': { sent: true } });
    const result = await sendChannelMessage(client, {
      channelId: 'discord',
      conversationId: 'c1',
      content: 'hello',
    });
    expect(result).toBe(true);
  });
});

// ===== Cron Controller =====

import {
  createCronState,
  loadCronJobs,
  toggleCronJob,
  runCronJob,
} from '../services/cron.js';

describe('Cron Controller', () => {
  it('createCronState returns defaults', () => {
    const s = createCronState();
    expect(s.jobs).toEqual([]);
  });

  it('loadCronJobs populates from gateway', async () => {
    const jobs = [{ id: 'j1', name: 'backup', schedule: '0 0 * * *', enabled: true }];
    const client = createMockClient({ 'cron.list': jobs });
    const state = createCronState();
    state.client = client;

    await loadCronJobs(state);
    expect(state.jobs).toEqual(jobs);
  });

  it('toggleCronJob updates local state', async () => {
    const client = createMockClient({ 'cron.enable': { enabled: false } });
    const state = createCronState();
    state.client = client;
    state.jobs = [{ id: 'j1', name: 'test', schedule: '* * * * *', enabled: true }];

    await toggleCronJob(state, 'j1', false);
    expect(state.jobs[0].enabled).toBe(false);
  });

  it('runCronJob returns triggered status', async () => {
    const client = createMockClient({ 'cron.run': { triggered: true } });
    expect(await runCronJob(client, 'j1')).toBe(true);
  });
});

// ===== Logs Controller =====

import {
  createLogsState,
  addLogEntry,
  clearLogs,
  toggleLevel,
  getFilteredLogs,
} from '../services/logs.js';

describe('Logs Controller', () => {
  it('createLogsState returns defaults with all levels', () => {
    const s = createLogsState();
    expect(s.logs).toEqual([]);
    expect(s.levelFilter.size).toBe(4);
    expect(s.levelFilter.has('debug')).toBe(true);
    expect(s.levelFilter.has('info')).toBe(true);
    expect(s.levelFilter.has('warn')).toBe(true);
    expect(s.levelFilter.has('error')).toBe(true);
  });

  it('addLogEntry appends and caps at maxEntries', () => {
    const state = createLogsState();
    state.maxEntries = 3;

    addLogEntry(state, { timestamp: '1', level: 'info', source: 'a', message: 'm1' });
    addLogEntry(state, { timestamp: '2', level: 'info', source: 'a', message: 'm2' });
    addLogEntry(state, { timestamp: '3', level: 'info', source: 'a', message: 'm3' });
    addLogEntry(state, { timestamp: '4', level: 'info', source: 'a', message: 'm4' });

    expect(state.logs).toHaveLength(3);
    expect(state.logs[0].message).toBe('m2');
    expect(state.logs[2].message).toBe('m4');
  });

  it('clearLogs empties the array', () => {
    const state = createLogsState();
    addLogEntry(state, { timestamp: '1', level: 'info', source: 'a', message: 'hi' });
    clearLogs(state);
    expect(state.logs).toEqual([]);
  });

  it('toggleLevel adds and removes levels', () => {
    const state = createLogsState();
    toggleLevel(state, 'debug');
    expect(state.levelFilter.has('debug')).toBe(false);
    toggleLevel(state, 'debug');
    expect(state.levelFilter.has('debug')).toBe(true);
  });

  it('getFilteredLogs returns only matching levels', () => {
    const state = createLogsState();
    addLogEntry(state, { timestamp: '1', level: 'info', source: 'a', message: 'info msg' });
    addLogEntry(state, { timestamp: '2', level: 'debug', source: 'a', message: 'debug msg' });
    addLogEntry(state, { timestamp: '3', level: 'error', source: 'a', message: 'error msg' });

    toggleLevel(state, 'debug'); // remove debug
    const filtered = getFilteredLogs(state);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((l) => l.level)).toEqual(['info', 'error']);
  });
});

// ===== Presence Controller =====

import {
  createPresenceState,
  loadStatus,
  loadHealth,
  loadConnections,
} from '../services/presence.js';

describe('Presence Controller', () => {
  it('createPresenceState returns defaults', () => {
    const s = createPresenceState();
    expect(s.status).toBeNull();
    expect(s.health).toBeNull();
    expect(s.connections).toEqual([]);
  });

  it('loadStatus populates from gateway', async () => {
    const status = {
      running: true,
      port: 18790,
      connections: 2,
      uptime: 3600,
      version: '1.2.0',
      startedAt: '2025-01-01',
    };
    const client = createMockClient({ status });
    const state = createPresenceState();
    state.client = client;

    await loadStatus(state);
    expect(state.status).toEqual(status);
    expect(state.error).toBeNull();
  });

  it('loadHealth populates from gateway', async () => {
    const health = {
      status: 'ok',
      version: '1.2.0',
      uptime: 3600,
      timestamp: '2025-01-01',
      checks: { gateway: true },
    };
    const client = createMockClient({ health });
    const state = createPresenceState();
    state.client = client;

    await loadHealth(state);
    expect(state.health?.status).toBe('ok');
  });

  it('loadConnections populates from gateway', async () => {
    const conns = [
      { id: 'c1', connectedAt: '2025-01-01', authenticated: true },
    ];
    const client = createMockClient({ 'connections.list': conns });
    const state = createPresenceState();
    state.client = client;

    await loadConnections(state);
    expect(state.connections).toEqual(conns);
  });

  it('loadStatus handles error', async () => {
    const client = createMockClient({ status: new Error('fail') });
    const state = createPresenceState();
    state.client = client;

    await loadStatus(state);
    expect(state.error).toContain('fail');
  });
});
