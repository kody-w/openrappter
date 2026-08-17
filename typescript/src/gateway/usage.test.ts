/**
 * Unit cover for the parts of `gateway/usage.ts` a live gateway cannot
 * conveniently produce — a recorder that is enabled but failed to open its
 * ledger, a provider that reports a partial or malformed usage object, and a
 * ledger larger than one query page.
 *
 * The wire contract itself is proved in `__tests__/usage-live.test.ts`
 * against a started `GatewayServer`; this file is deliberately narrow and
 * proves nothing about registration.
 */

import { describe, expect, it } from 'vitest';
import type { FlightEvent, FlightEventQuery } from '../flight-recorder/types.js';
import {
  collectUsageHistory,
  collectUsageStats,
  readUsageTokens,
  UsageUnavailableError,
  type UsageRecorderLike,
} from './usage.js';

function event(overrides: Partial<FlightEvent> = {}): FlightEvent {
  return {
    schema: 'openrappter-event/1.0',
    id: `evt-${Math.random().toString(16).slice(2)}`,
    sequence: 1,
    traceId: 'trace',
    parentId: null,
    timestamp: new Date().toISOString(),
    status: 'success',
    kind: 'provider.attempt.completed',
    source: 'assistant',
    providerId: 'copilot',
    model: 'gpt-4o',
    metadata: {},
    contentHash: 'hash',
    ...overrides,
  } as FlightEvent;
}

function stubRecorder(
  events: FlightEvent[],
  health: { enabled: boolean; initialized: boolean } = { enabled: true, initialized: true },
): UsageRecorderLike {
  return {
    health: async () => health,
    query: async (query: FlightEventQuery = {}) => {
      const offset = query.offset ?? 0;
      const limit = query.limit ?? events.length;
      const ordered = query.order === 'desc' ? [...events].reverse() : events;
      return ordered.slice(offset, offset + limit);
    },
  };
}

describe('readUsageTokens tells missing apart from zero', () => {
  it('returns null when the attempt reported no usage at all', () => {
    expect(readUsageTokens({ metadata: {} })).toBeNull();
    expect(readUsageTokens({ metadata: { streaming: true } })).toBeNull();
  });

  it('returns null for a usage object with no recognisable counts', () => {
    expect(readUsageTokens({ metadata: { usage: { cached: 4 } } })).toBeNull();
  });

  it('accepts a genuine zero', () => {
    expect(readUsageTokens({ metadata: { usage: { input_tokens: 0, output_tokens: 0 } } }))
      .toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('fills only the half a provider omitted', () => {
    expect(readUsageTokens({ metadata: { usage: { input_tokens: 12 } } }))
      .toEqual({ promptTokens: 12, completionTokens: 0 });
  });

  it('ignores counts that are not finite non-negative numbers', () => {
    expect(readUsageTokens({ metadata: { usage: { input_tokens: -5, output_tokens: 3 } } }))
      .toEqual({ promptTokens: 0, completionTokens: 3 });
    expect(readUsageTokens({ metadata: { usage: { input_tokens: 'lots' } } })).toBeNull();
    expect(readUsageTokens({ metadata: { usage: { input_tokens: Number.NaN } } })).toBeNull();
  });
});

describe('usage refuses rather than guessing when the ledger is unusable', () => {
  it('names the disabled recorder and how to turn it on', async () => {
    const recorder = stubRecorder([], { enabled: false, initialized: false });
    await expect(collectUsageStats(recorder)).rejects.toBeInstanceOf(UsageUnavailableError);
    await expect(collectUsageStats(recorder)).rejects.toThrow(/OPENRAPPTER_FLIGHT_RECORDER=1/);
    await expect(collectUsageHistory(recorder)).rejects.toThrow(/Usage is not being recorded/);
  });

  it('distinguishes "enabled but the ledger did not open" from "disabled"', async () => {
    // This is the case that would otherwise report a serene zero while the
    // recorder is failing to write anything at all.
    const recorder = stubRecorder([], { enabled: true, initialized: false });
    await expect(collectUsageStats(recorder)).rejects.toThrow(/failed to initialize/);
    await expect(collectUsageHistory(recorder)).rejects.toThrow(/flight status/);
  });
});

describe('usage totals cover a ledger larger than one query page', () => {
  it('pages until the ledger is exhausted rather than summing the first page', async () => {
    const events = Array.from({ length: 2_500 }, () =>
      event({ metadata: { usage: { input_tokens: 2, output_tokens: 1 } } }));
    const stats = await collectUsageStats(stubRecorder(events));
    expect(stats.requestCount).toBe(2_500);
    expect(stats.totalTokens).toBe(2_500 * 3);
    expect(stats.truncated).toBe(false);
  });
});

describe('usage history is bounded and honest about what it lists', () => {
  it('caps the requested limit', async () => {
    const events = Array.from({ length: 900 }, () =>
      event({ metadata: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect(await collectUsageHistory(stubRecorder(events), { limit: 5 })).toHaveLength(5);
    expect(await collectUsageHistory(stubRecorder(events), { limit: 10_000 })).toHaveLength(500);
    expect(await collectUsageHistory(stubRecorder(events), { limit: 0 })).toEqual([]);
  });

  it('falls back to the provider id when a provider named no model', async () => {
    const entries = await collectUsageHistory(stubRecorder([
      event({ model: undefined, providerId: 'ollama', metadata: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]));
    expect(entries[0].model).toBe('ollama');
  });

  it('rejects a `since` that is not a timestamp instead of silently ignoring it', async () => {
    await expect(collectUsageStats(stubRecorder([]), { since: 'yesterday-ish' }))
      .rejects.toThrow(/not a valid ISO-8601 timestamp/);
  });

  it('accepts epoch milliseconds and reports the window it used', async () => {
    const stats = await collectUsageStats(stubRecorder([]), { since: 1_700_000_000_000 });
    expect(stats.period).toBe('since 2023-11-14T22:13:20.000Z');
  });
});
