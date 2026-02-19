import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { matchAndExecuteAgent } from '../../chat.js';
import { BasicAgent } from '../../agents/index.js';

// Create mock agents
function createMockAgent(name: string, description: string, executeResult?: string): BasicAgent {
  const agent = {
    name,
    metadata: { name, description, parameters: {} },
    execute: vi.fn().mockResolvedValue(executeResult ?? JSON.stringify({ status: 'ok', response: `${name} result` })),
    perform: vi.fn(),
    slosh: vi.fn(),
    getSignal: vi.fn(),
    context: {},
    lastDataSlush: null,
  } as unknown as BasicAgent;
  return agent;
}

describe('matchAndExecuteAgent', () => {
  let agents: Map<string, BasicAgent>;
  let shellAgent: BasicAgent;
  let memoryAgent: BasicAgent;

  beforeEach(() => {
    agents = new Map();
    shellAgent = createMockAgent('Shell', 'Execute shell commands and file operations');
    memoryAgent = createMockAgent('Memory', 'Store and retrieve memories');
    agents.set('Shell', shellAgent);
    agents.set('Memory', memoryAgent);
  });

  it('should match Shell agent for shell keywords', async () => {
    const result = await matchAndExecuteAgent('run ls command', agents);
    expect(result).not.toBeNull();
    expect(shellAgent.execute).toHaveBeenCalledWith({ query: 'run ls command' });
  });

  it('should match Memory agent for memory keywords', async () => {
    const result = await matchAndExecuteAgent('remember this for later', agents);
    expect(result).not.toBeNull();
    expect(memoryAgent.execute).toHaveBeenCalledWith({ query: 'remember this for later' });
  });

  it('should return null for unmatched messages', async () => {
    const result = await matchAndExecuteAgent('hello', agents);
    expect(result).toBeNull();
  });

  it('should handle agent execution errors', async () => {
    const errorAgent = createMockAgent('Shell', 'shell agent');
    (errorAgent.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('exec failed'));
    agents.set('Shell', errorAgent);

    const result = await matchAndExecuteAgent('run bash command', agents);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('exec failed');
  });

  it('should match dynamic agents by description', async () => {
    const customAgent = createMockAgent('Weather', 'fetch weather forecast data');
    agents.set('Weather', customAgent);

    const result = await matchAndExecuteAgent('get weather forecast', agents);
    expect(result).not.toBeNull();
    expect(customAgent.execute).toHaveBeenCalled();
  });

  it('should return null for empty agents map', async () => {
    const result = await matchAndExecuteAgent('hello world', new Map());
    expect(result).toBeNull();
  });
});

describe('chat auto-auth', () => {
  let mockRegistry: any;
  let mockAgents: Map<string, BasicAgent>;

  beforeEach(() => {
    vi.resetModules();
    mockAgents = new Map();
    mockRegistry = { getAllAgents: vi.fn().mockResolvedValue(mockAgents) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should trigger device code login when no provider and TTY', async () => {
    const mockDeviceCodeLogin = vi.fn().mockResolvedValue('ghu_test_token_123');
    const mockSaveEnv = vi.fn().mockResolvedValue(undefined);
    const mockLoadEnv = vi.fn().mockResolvedValue({});

    vi.doMock('../../providers/copilot-auth.js', () => ({ deviceCodeLogin: mockDeviceCodeLogin }));
    vi.doMock('../../env.js', () => ({
      saveEnv: mockSaveEnv,
      loadEnv: mockLoadEnv,
      HOME_DIR: '/tmp/.openrappter',
      CONFIG_FILE: '/tmp/.openrappter/config.json',
      ENV_FILE: '/tmp/.openrappter/.env',
      ensureHomeDir: vi.fn(),
    }));
    vi.doMock('../../copilot-check.js', () => ({
      hasCopilotAvailable: vi.fn().mockResolvedValue(false),
      resolveGithubToken: vi.fn().mockResolvedValue('ghu_test_token_123'),
    }));
    vi.doMock('../../providers/copilot.js', () => ({
      CopilotProvider: class {
        async chat() { return { content: 'Hello from copilot!' }; }
      },
    }));

    // Mock TTY
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { chat } = await import('../../chat.js');
      const result = await chat('hello', mockRegistry);
      expect(mockDeviceCodeLogin).toHaveBeenCalled();
      expect(result).toContain('Hello from copilot');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('should not attempt auth when no TTY (piped input)', async () => {
    const mockDeviceCodeLogin = vi.fn();

    vi.doMock('../../providers/copilot-auth.js', () => ({ deviceCodeLogin: mockDeviceCodeLogin }));
    vi.doMock('../../env.js', () => ({
      saveEnv: vi.fn(), loadEnv: vi.fn().mockResolvedValue({}),
      HOME_DIR: '/tmp/.openrappter', CONFIG_FILE: '/tmp/.openrappter/config.json',
      ENV_FILE: '/tmp/.openrappter/.env', ensureHomeDir: vi.fn(),
    }));
    vi.doMock('../../copilot-check.js', () => ({
      hasCopilotAvailable: vi.fn().mockResolvedValue(false),
      resolveGithubToken: vi.fn().mockResolvedValue(null),
    }));

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const { chat } = await import('../../chat.js');
      const result = await chat('hello', mockRegistry);
      expect(mockDeviceCodeLogin).not.toHaveBeenCalled();
      const parsed = JSON.parse(result);
      expect(parsed.response).toContain('No GitHub token');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('should re-auth on 404 auth error when TTY available', async () => {
    const mockDeviceCodeLogin = vi.fn().mockResolvedValue('ghu_new_token');
    const mockSaveEnv = vi.fn().mockResolvedValue(undefined);
    const mockLoadEnv = vi.fn().mockResolvedValue({});
    let callCount = 0;

    vi.doMock('../../providers/copilot-auth.js', () => ({ deviceCodeLogin: mockDeviceCodeLogin }));
    vi.doMock('../../env.js', () => ({
      saveEnv: mockSaveEnv, loadEnv: mockLoadEnv,
      HOME_DIR: '/tmp/.openrappter', CONFIG_FILE: '/tmp/.openrappter/config.json',
      ENV_FILE: '/tmp/.openrappter/.env', ensureHomeDir: vi.fn(),
    }));
    vi.doMock('../../copilot-check.js', () => ({
      hasCopilotAvailable: vi.fn().mockResolvedValue(true),
      resolveGithubToken: vi.fn().mockResolvedValue('ghu_old_token'),
    }));
    vi.doMock('../../providers/copilot.js', () => ({
      CopilotProvider: class {
        async chat() {
          callCount++;
          if (callCount === 1) throw new Error('HTTP 404 - not found');
          return { content: 'Success after re-auth!' };
        }
      },
    }));

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { chat } = await import('../../chat.js');
      const result = await chat('hello', mockRegistry);
      expect(mockDeviceCodeLogin).toHaveBeenCalled();
      expect(result).toContain('Success after re-auth');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('should return error JSON when re-auth fails on auth error', async () => {
    const mockDeviceCodeLogin = vi.fn().mockRejectedValue(new Error('User cancelled'));

    vi.doMock('../../providers/copilot-auth.js', () => ({ deviceCodeLogin: mockDeviceCodeLogin }));
    vi.doMock('../../env.js', () => ({
      saveEnv: vi.fn(), loadEnv: vi.fn().mockResolvedValue({}),
      HOME_DIR: '/tmp/.openrappter', CONFIG_FILE: '/tmp/.openrappter/config.json',
      ENV_FILE: '/tmp/.openrappter/.env', ensureHomeDir: vi.fn(),
    }));
    vi.doMock('../../copilot-check.js', () => ({
      hasCopilotAvailable: vi.fn().mockResolvedValue(true),
      resolveGithubToken: vi.fn().mockResolvedValue('ghu_expired'),
    }));
    vi.doMock('../../providers/copilot.js', () => ({
      CopilotProvider: class {
        async chat() { throw new Error('HTTP 401 unauthorized'); }
      },
    }));

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { chat } = await import('../../chat.js');
      const result = await chat('hello', mockRegistry);
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.response).toContain('expired or invalid');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('should return error JSON for auth error without TTY', async () => {
    vi.doMock('../../providers/copilot-auth.js', () => ({ deviceCodeLogin: vi.fn() }));
    vi.doMock('../../env.js', () => ({
      saveEnv: vi.fn(), loadEnv: vi.fn().mockResolvedValue({}),
      HOME_DIR: '/tmp/.openrappter', CONFIG_FILE: '/tmp/.openrappter/config.json',
      ENV_FILE: '/tmp/.openrappter/.env', ensureHomeDir: vi.fn(),
    }));
    vi.doMock('../../copilot-check.js', () => ({
      hasCopilotAvailable: vi.fn().mockResolvedValue(true),
      resolveGithubToken: vi.fn().mockResolvedValue('ghu_old'),
    }));
    vi.doMock('../../providers/copilot.js', () => ({
      CopilotProvider: class {
        async chat() { throw new Error('HTTP 403 forbidden'); }
      },
    }));

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const { chat } = await import('../../chat.js');
      const result = await chat('hello', mockRegistry);
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.response).toContain('openrappter onboard');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('resetChatProvider should clear cached provider', async () => {
    vi.doMock('../../providers/copilot-auth.js', () => ({ deviceCodeLogin: vi.fn() }));
    vi.doMock('../../env.js', () => ({
      saveEnv: vi.fn(), loadEnv: vi.fn().mockResolvedValue({}),
      HOME_DIR: '/tmp/.openrappter', CONFIG_FILE: '/tmp/.openrappter/config.json',
      ENV_FILE: '/tmp/.openrappter/.env', ensureHomeDir: vi.fn(),
    }));
    vi.doMock('../../copilot-check.js', () => ({
      hasCopilotAvailable: vi.fn().mockResolvedValue(true),
      resolveGithubToken: vi.fn().mockResolvedValue('ghu_token'),
    }));

    let providerCount = 0;
    vi.doMock('../../providers/copilot.js', () => ({
      CopilotProvider: class {
        id: number;
        constructor() { this.id = ++providerCount; }
        async chat() { return { content: `response-${this.id}` }; }
      },
    }));

    const { getChatProvider, resetChatProvider } = await import('../../chat.js');

    const p1 = await getChatProvider();
    const p2 = await getChatProvider();
    expect(p1).toBe(p2); // Same instance (cached)

    resetChatProvider();
    const p3 = await getChatProvider();
    expect(p3).not.toBe(p1); // New instance after reset
  });
});
