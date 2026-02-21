import { describe, it, expect } from 'vitest';
import { sanitizeMessages, truncateHistory } from '../messages.js';
import type { Message } from '../types.js';

describe('sanitizeMessages', () => {
  it('passes valid tool-call sequence through unchanged', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Shell', arguments: '{}' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc1' },
      { role: 'assistant', content: 'done' },
    ];
    expect(sanitizeMessages(messages)).toEqual(messages);
  });

  it('drops orphaned tool message with no preceding tool_calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan', tool_call_id: 'tc_missing' },
      { role: 'assistant', content: 'done' },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(2);
    expect(result.find(m => m.role === 'tool')).toBeUndefined();
  });

  it('keeps tool message with matching assistant tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Shell', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'tc1' },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('tool');
  });

  it('keeps multiple tool results from a single assistant with multiple tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'Shell', arguments: '{}' } },
          { id: 'tc2', type: 'function', function: { name: 'Memory', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'r1', tool_call_id: 'tc1' },
      { role: 'tool', content: 'r2', tool_call_id: 'tc2' },
      { role: 'assistant', content: 'All done' },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result.filter(m => m.role === 'tool')).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(sanitizeMessages([])).toEqual([]);
  });

  it('passes pure chat messages (no tool messages) through unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
      { role: 'assistant', content: 'goodbye' },
    ];
    expect(sanitizeMessages(messages)).toEqual(messages);
  });
});

describe('truncateHistory', () => {
  it('keeps system message at index 0', () => {
    const history: Message[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 50 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
        content: `msg ${i}`,
      })),
    ];
    const result = truncateHistory(history, 40);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('system prompt');
    // system + at most 40 tail messages (possibly fewer after sanitization)
    expect(result.length).toBeLessThanOrEqual(41);
  });

  it('never orphans tool messages at truncation boundary', () => {
    // Build history: system + 20 user/assistant pairs + a tool-call pair at position 21-22 + more messages
    const history: Message[] = [
      { role: 'system', content: 'system prompt' },
    ];

    // Fill with enough messages that truncation will cut into the tool-call pair
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `q${i}` });
      history.push({ role: 'assistant', content: `a${i}` });
    }

    // Add a tool-call pair that will straddle the truncation boundary
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'boundary_tc', type: 'function', function: { name: 'Shell', arguments: '{}' } }],
    });
    history.push({ role: 'tool', content: 'result', tool_call_id: 'boundary_tc' });

    // Pad with more messages so the tool-call pair is near the boundary
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `late_q${i}` });
      history.push({ role: 'assistant', content: `late_a${i}` });
    }

    const result = truncateHistory(history, 40);

    // Verify no orphaned tool messages
    const toolMsgs = result.filter(m => m.role === 'tool');
    for (const tm of toolMsgs) {
      const hasMatchingAssistant = result.some(
        m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === tm.tool_call_id),
      );
      expect(hasMatchingAssistant).toBe(true);
    }
  });
});
