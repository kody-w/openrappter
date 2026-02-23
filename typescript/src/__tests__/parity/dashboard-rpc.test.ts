/**
 * Parity test: Dashboard RPC Methods
 *
 * Tests all RPC methods needed by the web dashboard UI pages.
 * Uses the MockServer pattern to capture and invoke registered handlers.
 */

import { describe, it, expect } from 'vitest';

// ── Helper: MockServer ──────────────────────────────────────────────────

interface MethodInfo {
  handler: (params: unknown, connection: unknown) => Promise<unknown>;
  requiresAuth: boolean;
}

function createMockServer() {
  const methods = new Map<string, MethodInfo>();
  return {
    methods,
    registerMethod<P = unknown, R = unknown>(
      name: string,
      handler: (params: P, connection: unknown) => Promise<R>,
      options?: { requiresAuth?: boolean },
    ): void {
      methods.set(name, {
        handler: handler as MethodInfo['handler'],
        requiresAuth: options?.requiresAuth ?? false,
      });
    },
    async call<R = unknown>(name: string, params: unknown = {}): Promise<R> {
      const m = methods.get(name);
      if (!m) throw new Error(`Method not registered: ${name}`);
      return m.handler(params, {}) as Promise<R>;
    },
  };
}

// ── agents.list ─────────────────────────────────────────────────────────

describe('Dashboard RPC — agents.list', () => {
  it('should return empty array when no agentList provided', async () => {
    const { registerAgentsMethods } = await import('../../gateway/methods/agents-methods.js');
    const server = createMockServer();
    registerAgentsMethods(server);

    const result = await server.call<unknown[]>('agents.list');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should return agent summaries from deps', async () => {
    const { registerAgentsMethods } = await import('../../gateway/methods/agents-methods.js');
    const server = createMockServer();
    const agents = [
      { name: 'ShellAgent', description: 'Shell commands', type: 'builtin' },
      { name: 'MemoryAgent', description: 'Memory ops', type: 'builtin' },
    ];
    registerAgentsMethods(server, { agentList: () => agents });

    const result = await server.call<unknown[]>('agents.list');
    expect(result).toEqual(agents);
    expect(result).toHaveLength(2);
  });
});

// ── chat.list / chat.delete ─────────────────────────────────────────────

describe('Dashboard RPC — chat.list / chat.delete', () => {
  it('should return empty array when no sessions exist', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    registerChatMethods(server);

    const result = await server.call<unknown[]>('chat.list');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should return session summaries with correct fields', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    const sessionStore = new Map();
    sessionStore.set('s1', {
      id: 's1',
      agentId: 'ShellAgent',
      messages: [
        { messageId: 'm1', role: 'user', content: 'hello', timestamp: 1000 },
        { messageId: 'm2', role: 'assistant', content: 'hi', timestamp: 1001 },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:01:00Z',
    });
    registerChatMethods(server, { sessionStore });

    const result = await server.call<Array<Record<string, unknown>>>('chat.list');
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('id', 's1');
    expect(result[0]).toHaveProperty('agentId', 'ShellAgent');
    expect(result[0]).toHaveProperty('messageCount', 2);
    expect(result[0]).toHaveProperty('createdAt');
    expect(result[0]).toHaveProperty('updatedAt');
  });

  it('should include all stored sessions', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    const sessionStore = new Map();
    for (let i = 0; i < 3; i++) {
      sessionStore.set(`s${i}`, {
        id: `s${i}`, agentId: 'A', messages: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });
    }
    registerChatMethods(server, { sessionStore });

    const result = await server.call<unknown[]>('chat.list');
    expect(result).toHaveLength(3);
  });

  it('should delete an existing session', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    const sessionStore = new Map();
    sessionStore.set('s1', {
      id: 's1', agentId: 'A', messages: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    registerChatMethods(server, { sessionStore });

    const result = await server.call<{ deleted: boolean }>('chat.delete', { sessionId: 's1' });
    expect(result.deleted).toBe(true);
    expect(sessionStore.has('s1')).toBe(false);
  });

  it('should return false when deleting nonexistent session', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    registerChatMethods(server);

    const result = await server.call<{ deleted: boolean }>('chat.delete', { sessionId: 'nope' });
    expect(result.deleted).toBe(false);
  });
});

// ── chat.messages ───────────────────────────────────────────────────────

describe('Dashboard RPC — chat.messages', () => {
  it('should return messages for a session', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    const sessionStore = new Map();
    const messages = [
      { messageId: 'm1', role: 'user', content: 'hello', timestamp: 1000 },
      { messageId: 'm2', role: 'assistant', content: 'hi', timestamp: 1001 },
      { messageId: 'm3', role: 'user', content: 'bye', timestamp: 1002 },
    ];
    sessionStore.set('s1', { id: 's1', messages });
    registerChatMethods(server, { sessionStore });

    const result = await server.call<Array<Record<string, unknown>>>('chat.messages', { sessionId: 's1' });
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveProperty('messageId', 'm1');
    expect(result[2]).toHaveProperty('messageId', 'm3');
  });

  it('should respect limit parameter', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    const sessionStore = new Map();
    const messages = [
      { messageId: 'm1', role: 'user', content: 'a', timestamp: 1000 },
      { messageId: 'm2', role: 'assistant', content: 'b', timestamp: 1001 },
      { messageId: 'm3', role: 'user', content: 'c', timestamp: 1002 },
    ];
    sessionStore.set('s1', { id: 's1', messages });
    registerChatMethods(server, { sessionStore });

    const result = await server.call<Array<Record<string, unknown>>>('chat.messages', { sessionId: 's1', limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('messageId', 'm2');
    expect(result[1]).toHaveProperty('messageId', 'm3');
  });

  it('should throw on missing session', async () => {
    const { registerChatMethods } = await import('../../gateway/methods/chat-methods.js');
    const server = createMockServer();
    registerChatMethods(server);

    await expect(server.call('chat.messages', { sessionId: 'nope' })).rejects.toThrow('Session not found');
  });
});

// ── channels.* ──────────────────────────────────────────────────────────

describe('Dashboard RPC — channels.*', () => {
  it('should return empty array when no channelRegistry', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    registerChannelsMethods(server);

    const result = await server.call<unknown[]>('channels.list');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should return channel statuses from registry', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    const statuses = [{ type: 'slack', connected: true }, { type: 'discord', connected: false }];
    registerChannelsMethods(server, {
      channelRegistry: {
        getStatusList: () => statuses,
        connectChannel: async () => {},
        disconnectChannel: async () => {},
        probeChannel: async () => ({ ok: true, latencyMs: 42 }),
        configureChannel: () => {},
      },
    });

    const result = await server.call<unknown[]>('channels.list');
    expect(result).toEqual(statuses);
  });

  it('should connect a channel', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    let connectedType = '';
    registerChannelsMethods(server, {
      channelRegistry: {
        getStatusList: () => [],
        connectChannel: async (type: string) => { connectedType = type; },
        disconnectChannel: async () => {},
        probeChannel: async () => ({ ok: true, latencyMs: 0 }),
        configureChannel: () => {},
      },
    });

    const result = await server.call<{ connected: boolean }>('channels.connect', { type: 'slack' });
    expect(result.connected).toBe(true);
    expect(connectedType).toBe('slack');
  });

  it('should disconnect a channel', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    let disconnectedType = '';
    registerChannelsMethods(server, {
      channelRegistry: {
        getStatusList: () => [],
        connectChannel: async () => {},
        disconnectChannel: async (type: string) => { disconnectedType = type; },
        probeChannel: async () => ({ ok: true, latencyMs: 0 }),
        configureChannel: () => {},
      },
    });

    const result = await server.call<{ disconnected: boolean }>('channels.disconnect', { type: 'discord' });
    expect(result.disconnected).toBe(true);
    expect(disconnectedType).toBe('discord');
  });

  it('should probe a channel', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    registerChannelsMethods(server, {
      channelRegistry: {
        getStatusList: () => [],
        connectChannel: async () => {},
        disconnectChannel: async () => {},
        probeChannel: async () => ({ ok: true, latencyMs: 55 }),
        configureChannel: () => {},
      },
    });

    const result = await server.call<{ ok: boolean; latencyMs: number }>('channels.probe', { type: 'slack' });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBe(55);
  });

  it('should configure a channel', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    let configuredWith: Record<string, unknown> = {};
    registerChannelsMethods(server, {
      channelRegistry: {
        getStatusList: () => [],
        connectChannel: async () => {},
        disconnectChannel: async () => {},
        probeChannel: async () => ({ ok: true, latencyMs: 0 }),
        configureChannel: (_type: string, config: Record<string, unknown>) => { configuredWith = config; },
      },
    });

    const result = await server.call<{ configured: boolean }>('channels.configure', {
      type: 'slack',
      config: { token: 'xoxb-test' },
    });
    expect(result.configured).toBe(true);
    expect(configuredWith).toEqual({ token: 'xoxb-test' });
  });
});

// ── cron.* ──────────────────────────────────────────────────────────────

describe('Dashboard RPC — cron.*', () => {
  it('should return empty cron list by default', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    const result = await server.call<unknown[]>('cron.list');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should add a job with generated id', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    const result = await server.call<Record<string, unknown>>('cron.add', {
      schedule: '*/5 * * * *',
      action: 'health-check',
      enabled: true,
    });
    expect(result).toHaveProperty('id');
    expect(typeof result.id).toBe('string');
    expect(result.schedule).toBe('*/5 * * * *');
    expect(result.action).toBe('health-check');
    expect(result.enabled).toBe(true);
  });

  it('should list added jobs', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    await server.call('cron.add', { schedule: '0 * * * *', action: 'a', enabled: true });
    await server.call('cron.add', { schedule: '0 0 * * *', action: 'b', enabled: false });

    const list = await server.call<unknown[]>('cron.list');
    expect(list).toHaveLength(2);
  });

  it('should enable/disable a job', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    const job = await server.call<{ id: string }>('cron.add', {
      schedule: '* * * * *', action: 'test', enabled: true,
    });
    const result = await server.call<{ enabled: boolean }>('cron.enable', {
      jobId: job.id, enabled: false,
    });
    expect(result.enabled).toBe(false);
  });

  it('should run a job', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    const job = await server.call<{ id: string }>('cron.add', {
      schedule: '* * * * *', action: 'test', enabled: true,
    });
    const result = await server.call<{ triggered: boolean }>('cron.run', { jobId: job.id });
    expect(result.triggered).toBe(true);
  });

  it('should remove a job', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    const job = await server.call<{ id: string }>('cron.add', {
      schedule: '* * * * *', action: 'test', enabled: true,
    });
    const result = await server.call<{ removed: boolean }>('cron.remove', { jobId: job.id });
    expect(result.removed).toBe(true);

    const list = await server.call<unknown[]>('cron.list');
    expect(list).toHaveLength(0);
  });

  it('should throw on run for nonexistent job', async () => {
    const { registerCronMethods } = await import('../../gateway/methods/cron-methods.js');
    const server = createMockServer();
    registerCronMethods(server);

    await expect(server.call('cron.run', { jobId: 'nope' })).rejects.toThrow();
  });
});

// ── skills.* ────────────────────────────────────────────────────────────

describe('Dashboard RPC — skills.*', () => {
  it('should return empty skills list when no registry', async () => {
    const { registerSkillsMethods } = await import('../../gateway/methods/skills-methods.js');
    const server = createMockServer();
    registerSkillsMethods(server);

    const result = await server.call<unknown[]>('skills.list');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should return skills from registry', async () => {
    const { registerSkillsMethods } = await import('../../gateway/methods/skills-methods.js');
    const server = createMockServer();
    const skills = [
      { id: 'sk1', name: 'code-review', version: '1.0.0', enabled: true, source: 'clawhub' },
      { id: 'sk2', name: 'deploy', version: '2.1.0', enabled: false, source: 'local' },
    ];
    registerSkillsMethods(server, {
      skillRegistry: {
        install: async () => ({ name: '', version: '', installed: true }),
        update: async () => [],
        list: () => skills,
        toggle: (id: string, enabled: boolean) => ({ id, enabled }),
      },
    });

    const result = await server.call<unknown[]>('skills.list');
    expect(result).toEqual(skills);
    expect(result).toHaveLength(2);
  });

  it('should toggle a skill', async () => {
    const { registerSkillsMethods } = await import('../../gateway/methods/skills-methods.js');
    const server = createMockServer();
    registerSkillsMethods(server, {
      skillRegistry: {
        install: async () => ({ name: '', version: '', installed: true }),
        update: async () => [],
        list: () => [],
        toggle: (id: string, enabled: boolean) => ({ id, enabled }),
      },
    });

    const result = await server.call<{ id: string; enabled: boolean }>('skills.toggle', {
      id: 'sk1', enabled: false,
    });
    expect(result.id).toBe('sk1');
    expect(result.enabled).toBe(false);
  });

  it('should throw on toggle without registry', async () => {
    const { registerSkillsMethods } = await import('../../gateway/methods/skills-methods.js');
    const server = createMockServer();
    registerSkillsMethods(server);

    await expect(server.call('skills.toggle', { id: 'sk1', enabled: true })).rejects.toThrow();
  });
});

// ── connections.list ────────────────────────────────────────────────────

describe('Dashboard RPC — connections.list', () => {
  it('should return empty array when no connectionList provided', async () => {
    const { registerConnectionsMethods } = await import('../../gateway/methods/connections-methods.js');
    const server = createMockServer();
    registerConnectionsMethods(server);

    const result = await server.call<unknown[]>('connections.list');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should return connection info from deps', async () => {
    const { registerConnectionsMethods } = await import('../../gateway/methods/connections-methods.js');
    const server = createMockServer();
    const connections = [
      { id: 'c1', connectedAt: '2026-01-01', authenticated: true, subscriptions: [], deviceId: 'd1', deviceType: 'cli' },
      { id: 'c2', connectedAt: '2026-01-01', authenticated: false, subscriptions: ['chat'], deviceId: undefined, deviceType: undefined },
    ];
    registerConnectionsMethods(server, { connectionList: () => connections });

    const result = await server.call<unknown[]>('connections.list');
    expect(result).toEqual(connections);
    expect(result).toHaveLength(2);
  });
});

// ── channels.send ───────────────────────────────────────────────────────

describe('Dashboard RPC — channels.send', () => {
  it('should send a message via registry', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    let sentParams: Record<string, unknown> = {};
    registerChannelsMethods(server, {
      channelRegistry: {
        getStatusList: () => [],
        connectChannel: async () => {},
        disconnectChannel: async () => {},
        probeChannel: async () => ({ ok: true, latencyMs: 0 }),
        configureChannel: () => {},
        sendMessage: async (params) => { sentParams = params; return { sent: true }; },
      },
    });

    const result = await server.call<{ sent: boolean }>('channels.send', {
      channelId: 'slack', conversationId: 'c1', content: 'hello',
    });
    expect(result.sent).toBe(true);
    expect(sentParams).toHaveProperty('channelId', 'slack');
    expect(sentParams).toHaveProperty('content', 'hello');
  });

  it('should throw without registry', async () => {
    const { registerChannelsMethods } = await import('../../gateway/methods/channels-methods.js');
    const server = createMockServer();
    registerChannelsMethods(server);

    await expect(server.call('channels.send', {
      channelId: 'slack', conversationId: 'c1', content: 'hello',
    })).rejects.toThrow();
  });
});

// ── agents.files.read / agents.files.write ──────────────────────────────

describe('Dashboard RPC — agents.files.read / agents.files.write', () => {
  it('should read an agent file via registry', async () => {
    const { registerAgentsMethods } = await import('../../gateway/methods/agents-methods.js');
    const server = createMockServer();
    registerAgentsMethods(server, {
      agentRegistry: {
        getMetadata: async () => null,
        listAgentFiles: async () => [],
        getAgentFile: async () => ({ name: '', content: '', language: '' }),
        readAgentFile: async (_agentId: string, _path: string) => ({ content: 'file contents here' }),
        writeAgentFile: async () => ({ written: true as const }),
      },
    });

    const result = await server.call<{ content: string }>('agents.files.read', {
      agentId: 'ShellAgent', path: 'src/index.ts',
    });
    expect(result.content).toBe('file contents here');
  });

  it('should throw agents.files.read without registry', async () => {
    const { registerAgentsMethods } = await import('../../gateway/methods/agents-methods.js');
    const server = createMockServer();
    registerAgentsMethods(server);

    await expect(server.call('agents.files.read', {
      agentId: 'ShellAgent', path: 'src/index.ts',
    })).rejects.toThrow();
  });

  it('should write an agent file via registry', async () => {
    const { registerAgentsMethods } = await import('../../gateway/methods/agents-methods.js');
    const server = createMockServer();
    let writtenPath = '';
    let writtenContent = '';
    registerAgentsMethods(server, {
      agentRegistry: {
        getMetadata: async () => null,
        listAgentFiles: async () => [],
        getAgentFile: async () => ({ name: '', content: '', language: '' }),
        readAgentFile: async () => ({ content: '' }),
        writeAgentFile: async (_agentId: string, path: string, content: string) => {
          writtenPath = path;
          writtenContent = content;
          return { written: true as const };
        },
      },
    });

    const result = await server.call<{ written: boolean }>('agents.files.write', {
      agentId: 'ShellAgent', path: 'src/helper.ts', content: 'new code',
    });
    expect(result.written).toBe(true);
    expect(writtenPath).toBe('src/helper.ts');
    expect(writtenContent).toBe('new code');
  });

  it('should throw agents.files.write without registry', async () => {
    const { registerAgentsMethods } = await import('../../gateway/methods/agents-methods.js');
    const server = createMockServer();
    registerAgentsMethods(server);

    await expect(server.call('agents.files.write', {
      agentId: 'ShellAgent', path: 'src/index.ts', content: 'x',
    })).rejects.toThrow();
  });
});

// ── config.apply ────────────────────────────────────────────────────────

describe('Dashboard RPC — config.apply', () => {
  it('should apply config via configManager', async () => {
    const { registerConfigMethods } = await import('../../gateway/methods/config-methods.js');
    const server = createMockServer();
    let appliedRaw = '';
    registerConfigMethods(server, {
      configManager: {
        apply: async (raw: string) => { appliedRaw = raw; return { applied: true }; },
      },
    });

    const result = await server.call<{ applied: boolean }>('config.apply', {
      raw: '{"server":{"port":9090}}',
    });
    expect(result.applied).toBe(true);
    expect(appliedRaw).toBe('{"server":{"port":9090}}');
  });

  it('should fallback to in-memory store without configManager', async () => {
    const { registerConfigMethods } = await import('../../gateway/methods/config-methods.js');
    const server = createMockServer();
    registerConfigMethods(server);

    const result = await server.call<{ applied: boolean }>('config.apply', {
      raw: '{"server":{"port":4000}}',
    });
    expect(result.applied).toBe(true);
  });
});

// ── system status / health ──────────────────────────────────────────────

describe('Dashboard RPC — status / health', () => {
  it('should return status with correct shape', async () => {
    const { registerSystemMethods } = await import('../../gateway/methods/system-methods.js');
    const server = createMockServer();
    registerSystemMethods(server, {
      getStatus: () => ({
        running: true, port: 8080, connections: 3, uptime: 12345,
        version: '1.9.0', startedAt: '2026-01-01T00:00:00Z',
      }),
    });

    const result = await server.call<Record<string, unknown>>('status');
    expect(result).toHaveProperty('running', true);
    expect(result).toHaveProperty('port', 8080);
    expect(result).toHaveProperty('connections', 3);
    expect(result).toHaveProperty('uptime');
    expect(result).toHaveProperty('version', '1.9.0');
    expect(result).toHaveProperty('startedAt');
  });

  it('should return default status when no provider', async () => {
    const { registerSystemMethods } = await import('../../gateway/methods/system-methods.js');
    const server = createMockServer();
    registerSystemMethods(server);

    const result = await server.call<Record<string, unknown>>('status');
    expect(result).toHaveProperty('running');
    expect(result).toHaveProperty('version');
  });

  it('should return health with correct shape', async () => {
    const { registerSystemMethods } = await import('../../gateway/methods/system-methods.js');
    const server = createMockServer();
    registerSystemMethods(server, {
      getHealth: () => ({
        status: 'ok', version: '1.9.0', uptime: 5000,
        timestamp: Date.now(), checks: { gateway: 'ok', agents: 'ok' },
      }),
    });

    const result = await server.call<Record<string, unknown>>('health');
    expect(result).toHaveProperty('status', 'ok');
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('uptime');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('checks');
    expect(typeof result.checks).toBe('object');
  });

  it('should return default health when no provider', async () => {
    const { registerSystemMethods } = await import('../../gateway/methods/system-methods.js');
    const server = createMockServer();
    registerSystemMethods(server);

    const result = await server.call<Record<string, unknown>>('health');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('version');
  });
});
