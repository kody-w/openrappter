import { describe, it, expect, vi } from 'vitest';
import { handleCommand } from './interactive.js';

// Minimal mock of Assistant with clearConversation
function makeMockAssistant() {
  return {
    clearConversation: vi.fn(),
    getResponseStreaming: vi.fn(),
  } as any;
}

describe('handleCommand', () => {
  it('/help returns help text', () => {
    const assistant = makeMockAssistant();
    const result = handleCommand('/help', assistant, 'test-key');
    expect(result).toContain('/help');
    expect(result).toContain('/new');
    expect(result).toContain('/quit');
  });

  it('/quit returns "quit"', () => {
    const assistant = makeMockAssistant();
    const result = handleCommand('/quit', assistant, 'test-key');
    expect(result).toBe('quit');
  });

  it('/exit returns "quit"', () => {
    const assistant = makeMockAssistant();
    const result = handleCommand('/exit', assistant, 'test-key');
    expect(result).toBe('quit');
  });

  it('/new calls clearConversation and returns message', () => {
    const assistant = makeMockAssistant();
    const result = handleCommand('/new', assistant, 'conv-123');
    expect(assistant.clearConversation).toHaveBeenCalledWith('conv-123');
    expect(result).toContain('New conversation');
  });

  it('/unknown returns unknown command message', () => {
    const assistant = makeMockAssistant();
    const result = handleCommand('/foobar', assistant, 'test-key');
    expect(result).toContain('Unknown command');
    expect(result).toContain('/foobar');
  });

  it('/reset clears conversation same as /new', () => {
    const assistant = makeMockAssistant();
    const result = handleCommand('/reset', assistant, 'conv-456');
    expect(assistant.clearConversation).toHaveBeenCalledWith('conv-456');
    expect(result).toContain('New conversation');
  });
});
