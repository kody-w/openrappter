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
 */
export function sanitizeMessages<T extends { role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>(
  messages: T[],
): T[] {
  const availableIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableIds.add(tc.id);
      }
    }
  }
  return messages.filter(msg => {
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
