/**
 * Message sanitization utilities for safe history truncation.
 *
 * Prevents orphaned `tool` messages that lack a preceding `assistant`
 * message with matching `tool_calls` — which the Copilot/OpenAI API rejects.
 */

import type { Message } from './types.js';

/**
 * Drop any `tool` messages whose `tool_call_id` has no matching
 * `assistant` message with a corresponding `tool_calls` entry.
 * Also drop `tool_calls` from assistant messages where the
 * tool response messages are missing (prevents HTTP 400).
 */
export function sanitizeMessages<T extends { role: string; content?: string | null; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>(
  messages: T[],
): T[] {
  // Collect all tool_call_ids that have responses
  const respondedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      respondedIds.add(msg.tool_call_id);
    }
  }

  // Collect all tool_call_ids from assistant messages
  const availableIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableIds.add(tc.id);
      }
    }
  }

  return messages.map(msg => {
    // For assistant messages with tool_calls: remove any tool_calls
    // that don't have a matching tool response
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const validCalls = msg.tool_calls.filter(tc => respondedIds.has(tc.id));
      if (validCalls.length === 0) {
        // All tool_calls are orphaned — strip them entirely
        const { tool_calls, ...rest } = msg as Record<string, unknown>;
        return rest as T;
      }
      if (validCalls.length < msg.tool_calls.length) {
        // Some are orphaned — keep only the ones with responses
        return { ...msg, tool_calls: validCalls };
      }
    }
    return msg;
  }).filter(msg => {
    // Drop orphan tool messages (no matching assistant tool_calls)
    if (msg.role === 'tool') {
      return msg.tool_call_id != null && availableIds.has(msg.tool_call_id);
    }
    return true;
  });
}

/**
 * Truncate conversation history while preserving the system message
 * and ensuring no orphaned tool messages at the truncation boundary.
 *
 * Keeps `history[0]` (system message) + last `keep` messages, then
 * sanitizes to drop any tool messages whose assistant was truncated.
 */
export function truncateHistory(history: Message[], keep: number): Message[] {
  if (history.length <= keep + 1) return history;
  const system = history[0];
  const tail = history.slice(-keep);
  return [system, ...sanitizeMessages(tail)];
}
