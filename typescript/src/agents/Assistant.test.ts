/**
 * Tests for the Assistant class — direct Copilot API agent routing.
 *
 * These tests mock the CopilotProvider to verify:
 * - Agent metadata is converted to OpenAI-compatible tools
 * - System prompt includes agent list + memory context
 * - Tool-call loop executes agents and feeds results back
 * - Multi-turn conversation history is maintained
 * - Graceful shutdown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Assistant } from './Assistant.js';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

// ── Mock the CopilotProvider ─────────────────────────────────────────────────

let chatCallCount = 0;
let capturedMessages: unknown[] = [];
let capturedOptions: unknown = {};
let mockChatResponses: Array<{ content: string | null; tool_calls?: unknown[] }> = [];

const mockChat = vi.fn(async (messages: unknown[], options?: unknown) => {
  capturedMessages = [...(messages as unknown[])]; // snapshot — history mutates after call
  capturedOptions = options;
  const idx = Math.min(chatCallCount, mockChatResponses.length - 1);
  chatCallCount++;
  return mockChatResponses[idx] ?? { content: 'Hello!', tool_calls: null };
});

vi.mock('../providers/copilot.js', () => ({
  CopilotProvider: vi.fn(() => ({
    chat: mockChat,
  })),
  COPILOT_DEFAULT_MODEL: 'gpt-4.1',
}));

// ── Mock the workspace module ────────────────────────────────────────────────

let mockWorkspaceFiles: Array<{ name: string; path: string; content?: string; missing: boolean }> = [];
let mockOnboardingCompleted = false;

vi.mock('./workspace.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    ensureWorkspace: vi.fn(async () => {}),
    loadWorkspaceFiles: vi.fn(async () => mockWorkspaceFiles),
    isOnboardingCompleted: vi.fn(async () => mockOnboardingCompleted),
    WORKSPACE_DIR: '/tmp/test-workspace',
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

class StubAgent extends BasicAgent {
  private result: string;
  constructor(name: string, description: string, result: string) {
    const meta: AgentMetadata = {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Input query' },
        },
        required: [],
      },
    };
    super(name, meta);
    this.result = result;
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return this.result;
  }
}

function makeAgents(...agents: StubAgent[]): Map<string, BasicAgent> {
  const map = new Map<string, BasicAgent>();
  for (const a of agents) map.set(a.name, a);
  return map;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Assistant (direct Copilot API)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatCallCount = 0;
    capturedMessages = [];
    capturedOptions = {};
    mockChatResponses = [{ content: 'Hello!', tool_calls: undefined }];
    mockWorkspaceFiles = [];
    mockOnboardingCompleted = false;
  });

  it('sends messages via CopilotProvider.chat with tools', async () => {
    const shell = new StubAgent('Shell', 'Run commands', '{}');
    const memory = new StubAgent('Memory', 'Store facts', '{}');
    const assistant = new Assistant(makeAgents(shell, memory));

    await assistant.getResponse('hi');

    expect(mockChat).toHaveBeenCalledTimes(1);
    const opts = capturedOptions as { tools?: unknown[] };
    expect(opts.tools).toHaveLength(2);
    const toolNames = (opts.tools as { function: { name: string } }[]).map(t => t.function.name);
    expect(toolNames).toContain('Shell');
    expect(toolNames).toContain('Memory');
  });

  it('includes system prompt with agent list and identity', async () => {
    const shell = new StubAgent('Shell', 'Execute shell commands', '{}');
    const assistant = new Assistant(makeAgents(shell), {
      name: 'TestBot',
      description: 'a test assistant',
    });

    await assistant.getResponse('test');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('TestBot');
    expect(systemMsg!.content).toContain('a test assistant');
    expect(systemMsg!.content).toContain('Shell');
    expect(systemMsg!.content).toContain('Execute shell commands');
  });

  it('includes memory context in system prompt when provided', async () => {
    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('hi', undefined, 'User prefers dark mode.');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('User prefers dark mode.');
    expect(systemMsg!.content).toContain('memory_context');
  });

  it('sends user message in the messages array', async () => {
    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('what is the weather?');

    const messages = capturedMessages as { role: string; content: string }[];
    const userMsg = messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('what is the weather?');
  });

  it('handles tool-call loop: executes agent and feeds result back', async () => {
    const shell = new StubAgent('Shell', 'Run commands', '{"status":"ok","output":"foo.txt"}');

    // First response: LLM calls the Shell tool
    // Second response: LLM produces final text
    mockChatResponses = [
      {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Shell', arguments: '{"query":"ls"}' },
        }],
      },
      { content: 'Here are your files: foo.txt', tool_calls: undefined },
    ];

    const assistant = new Assistant(makeAgents(shell));
    const result = await assistant.getResponse('list files');

    expect(result.content).toBe('Here are your files: foo.txt');
    expect(result.agentLogs).toHaveLength(1);
    expect(result.agentLogs[0]).toContain('Shell');
    expect(result.agentLogs[0]).toContain('foo.txt');
    expect(mockChat).toHaveBeenCalledTimes(2);

    // Verify the tool result was fed back as a tool message
    const secondCallMessages = mockChat.mock.calls[1][0] as { role: string; content: string; tool_call_id?: string }[];
    const toolMsg = secondCallMessages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe('call_1');
    expect(toolMsg!.content).toContain('foo.txt');
  });

  it('handles agent errors gracefully in tool-call loop', async () => {
    class ErrorAgent extends BasicAgent {
      constructor() {
        super('Broken', {
          name: 'Broken',
          description: 'Always fails',
          parameters: { type: 'object', properties: {}, required: [] },
        });
      }
      async perform(): Promise<string> {
        throw new Error('Something broke');
      }
    }

    mockChatResponses = [
      {
        content: null,
        tool_calls: [{
          id: 'call_err',
          type: 'function',
          function: { name: 'Broken', arguments: '{}' },
        }],
      },
      { content: 'The agent encountered an error.', tool_calls: undefined },
    ];

    const agents = new Map<string, BasicAgent>();
    agents.set('Broken', new ErrorAgent());
    const assistant = new Assistant(agents);

    const result = await assistant.getResponse('break');

    expect(result.content).toBe('The agent encountered an error.');
    expect(result.agentLogs[0]).toContain('Error: Something broke');
  });

  it('returns non-streaming content from response', async () => {
    const assistant = new Assistant(makeAgents(), { streaming: false });
    mockChatResponses = [{ content: 'Direct response', tool_calls: undefined }];

    const result = await assistant.getResponse('hello');

    expect(result.content).toBe('Direct response');
  });

  it('passes model config to provider.chat', async () => {
    const assistant = new Assistant(makeAgents(), { model: 'gpt-4o' });
    await assistant.getResponse('hi');
    expect((capturedOptions as { model?: string }).model).toBe('gpt-4o');
  });

  it('stop() clears conversations', async () => {
    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('hi', undefined, undefined, 'conv-1');
    await assistant.stop();
    // After stop, a new conversation should start fresh
    chatCallCount = 0;
    await assistant.getResponse('hi again', undefined, undefined, 'conv-1');
    // Should only have system + user (no history from before stop)
    const messages = capturedMessages as { role: string }[];
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('maintains multi-turn conversation history', async () => {
    const assistant = new Assistant(makeAgents());

    mockChatResponses = [{ content: 'First reply', tool_calls: undefined }];
    await assistant.getResponse('message 1', undefined, undefined, 'conv-42');

    chatCallCount = 0;
    mockChatResponses = [{ content: 'Second reply', tool_calls: undefined }];
    await assistant.getResponse('message 2', undefined, undefined, 'conv-42');

    // Second call should include history: system, user1, assistant1, user2
    const messages = capturedMessages as { role: string; content: string }[];
    expect(messages.filter(m => m.role === 'user')).toHaveLength(2);
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(1); // first reply
    expect(messages[messages.length - 1].content).toBe('message 2');
  });

  it('different conversation keys have separate history', async () => {
    const assistant = new Assistant(makeAgents());

    mockChatResponses = [{ content: 'Reply A', tool_calls: undefined }];
    await assistant.getResponse('msg A', undefined, undefined, 'conv-A');

    chatCallCount = 0;
    mockChatResponses = [{ content: 'Reply B', tool_calls: undefined }];
    await assistant.getResponse('msg B', undefined, undefined, 'conv-B');

    // conv-B should only have system + user (no history from conv-A)
    const messages = capturedMessages as { role: string; content: string }[];
    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe('msg B');
  });

  it('calls onDelta with final content', async () => {
    const assistant = new Assistant(makeAgents());
    mockChatResponses = [{ content: 'Hello world', tool_calls: undefined }];

    const deltas: string[] = [];
    const result = await assistant.getResponse('hi', (delta) => deltas.push(delta));

    expect(result.content).toBe('Hello world');
    expect(deltas).toEqual(['Hello world']);
  });

  it('setAgents replaces the agent map', async () => {
    const assistant = new Assistant(makeAgents());
    const shell = new StubAgent('Shell', 'Run commands', '{}');
    assistant.setAgents(makeAgents(shell));

    await assistant.getResponse('hi');

    const opts = capturedOptions as { tools?: unknown[] };
    expect(opts.tools).toHaveLength(1);
  });

  it('handles unknown agent in tool call', async () => {
    mockChatResponses = [
      {
        content: null,
        tool_calls: [{
          id: 'call_unknown',
          type: 'function',
          function: { name: 'NonExistent', arguments: '{}' },
        }],
      },
      { content: 'Agent not found.', tool_calls: undefined },
    ];

    const assistant = new Assistant(makeAgents());
    const result = await assistant.getResponse('test');

    expect(result.content).toBe('Agent not found.');
    expect(result.agentLogs[0]).toContain('Unknown agent: NonExistent');
  });

  it('respects maxToolRounds limit', async () => {
    // Always return tool calls — should stop after maxToolRounds
    mockChatResponses = Array(15).fill({
      content: null,
      tool_calls: [{
        id: 'call_loop',
        type: 'function',
        function: { name: 'Shell', arguments: '{"query":"ls"}' },
      }],
    });

    const shell = new StubAgent('Shell', 'Run commands', 'ok');
    const assistant = new Assistant(makeAgents(shell), { maxToolRounds: 3 });
    const result = await assistant.getResponse('loop');

    // Should have called chat exactly 3 times (the max)
    expect(mockChat).toHaveBeenCalledTimes(3);
    expect(result.content).toContain('ran out of tool-call rounds');
  });

  // ── Workspace integration tests ──────────────────────────────────────────

  it('system prompt includes workspace context when files exist', async () => {
    mockWorkspaceFiles = [
      { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Be genuinely helpful.', missing: false },
      { name: 'IDENTITY.md', path: '/tmp/IDENTITY.md', content: '- **Name:** Luna', missing: false },
      { name: 'USER.md', path: '/tmp/USER.md', content: '- **Name:** Kody', missing: false },
    ];

    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('hi');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('workspace');
    expect(systemMsg!.content).toContain('Be genuinely helpful.');
  });

  it('system prompt includes SOUL.md instruction when present', async () => {
    mockWorkspaceFiles = [
      { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Soul content here.', missing: false },
    ];

    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('test');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('SOUL.md is your foundation');
  });

  it('identity name from IDENTITY.md overrides config name in system prompt', async () => {
    mockWorkspaceFiles = [
      { name: 'IDENTITY.md', path: '/tmp/IDENTITY.md', content: '- **Name:** Luna', missing: false },
    ];

    const assistant = new Assistant(makeAgents(), { name: 'openrappter' });
    await assistant.getResponse('hi');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('You are Luna');
    expect(assistant.identity?.name).toBe('Luna');
  });

  it('bootstrap content excluded when onboarding completed', async () => {
    mockWorkspaceFiles = [
      { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Soul content.', missing: false },
      { name: 'BOOTSTRAP.md', path: '/tmp/BOOTSTRAP.md', content: 'Bootstrap instructions.', missing: false },
    ];
    mockOnboardingCompleted = true;

    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('hi');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).not.toContain('Bootstrap instructions.');
  });

  it('memory context works alongside workspace context', async () => {
    mockWorkspaceFiles = [
      { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Soul content.', missing: false },
      { name: 'IDENTITY.md', path: '/tmp/IDENTITY.md', content: '- **Name:** Luna', missing: false },
    ];

    const assistant = new Assistant(makeAgents());
    await assistant.getResponse('hi', undefined, 'User likes cats.');

    const messages = capturedMessages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('User likes cats.');
    expect(systemMsg!.content).toContain('memory_context');
    expect(systemMsg!.content).toContain('Soul content.');
  });
});
