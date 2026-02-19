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
