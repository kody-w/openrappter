/**
 * Token usage, read from the only place this runtime actually records it.
 *
 * The Bar's usage screen calls `usage.stats` and `usage.history`. Neither name
 * existed on the live gateway, so the screen showed a transport error. The
 * temptation is to register `gateway/methods/usage-methods.ts`, which declares
 * `usage.status`/`usage.cost` against an optional `usageTracker` dependency
 * that nothing in this repository ever constructs — with no tracker it answers
 * `{ totalRequests: 0, totalTokens: 0, totalCost: 0 }` forever. A usage screen
 * that confidently reports zero tokens is worse than one that reports an
 * error: the number looks measured and is not.
 *
 * The real record of token consumption is the Flight Recorder. Every provider
 * call that returns a `ProviderResponse` with `usage` writes a
 * `provider.attempt.completed` event carrying
 * `metadata.usage = { input_tokens, output_tokens }` — see
 * `providers/recorded-chat.ts`, `providers/registry.ts`, `agents/Assistant.ts`
 * and `chat.ts`. That is what this module aggregates.
 *
 * PRIVACY. The Flight Recorder deliberately stores no prompt or response text
 * unless an operator opts in, and it HMACs session identifiers before they
 * ever reach the ledger. This module narrows further rather than relying on
 * that: it reads only `metadata.usage.{input_tokens,output_tokens}`,
 * `providerId`, `model`, `timestamp` and the event id, and it never copies
 * `sessionId` (even in hashed form), `payload`, or any other metadata key into
 * an RPC response. Nothing derived from user content can leave through here.
 *
 * COST. This repository contains no price table for any provider, and the
 * default backend is a Copilot subscription with no per-token price at all.
 * Cost is therefore reported as `costAvailable: false` with `totalCost: 0`
 * rather than as a computed figure. `$0.0000` presented as a measurement would
 * be the same fiction in a different font.
 */

import type { FlightEvent, FlightEventQuery } from '../flight-recorder/types.js';

/** The one event kind that carries provider-reported token counts. */
export const USAGE_EVENT_KIND = 'provider.attempt.completed';

/** Ledger queries are capped at 10,000 rows; page rather than truncate. */
const PAGE_SIZE = 1_000;

/** Never walk the ledger forever if retention is configured very high. */
const MAX_PAGES = 100;

export interface UsageRecorderLike {
  health(): Promise<{ enabled: boolean; initialized: boolean }>;
  query(query?: FlightEventQuery): Promise<FlightEvent[]>;
}

/**
 * Raised when there is no recorded activity to report — as opposed to a
 * recorded zero. The gateway turns this into an RPC error so the Bar shows
 * "usage recording is off" instead of a fabricated zero row.
 */
export class UsageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageUnavailableError';
  }
}

export interface UsageStatsResult {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Always 0. See `costAvailable`. */
  totalCost: number;
  /** False: no price table exists in this runtime. Never fabricate a cost. */
  costAvailable: boolean;
  requestCount: number;
  /** How many of `requestCount` actually reported token counts. */
  requestsWithTokenCounts: number;
  period: string;
  source: 'flight-recorder';
  /** True when the ledger held more events than this reader would walk. */
  truncated: boolean;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

export interface UsageBucket {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageEntryResult {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  costAvailable: boolean;
}

export interface UsageQueryOptions {
  /** ISO-8601 instant, or epoch milliseconds. */
  since?: string | number;
  limit?: number;
}

/**
 * Extract provider-reported token counts from a recorded event.
 *
 * Returns null when the attempt reported no usage — streaming attempts in
 * `Assistant.ts` do not, and a provider is free to omit it. A missing count is
 * not a zero count, and conflating the two is how a usage screen quietly
 * under-reports.
 */
export function readUsageTokens(
  event: Pick<FlightEvent, 'metadata'>,
): { promptTokens: number; completionTokens: number } | null {
  const usage = (event.metadata as Record<string, unknown> | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const prompt = numeric(record.input_tokens ?? record.prompt_tokens ?? record.promptTokens);
  const completion = numeric(
    record.output_tokens ?? record.completion_tokens ?? record.completionTokens,
  );
  if (prompt === null && completion === null) return null;
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 };
}

function numeric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function normalizeSince(since: string | number | undefined): string | undefined {
  if (since === undefined) return undefined;
  if (typeof since === 'number') {
    if (!Number.isFinite(since)) throw new Error('since must be a finite epoch-millisecond value');
    return new Date(since).toISOString();
  }
  const trimmed = since.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`since is not a valid ISO-8601 timestamp: ${since}`);
  return new Date(parsed).toISOString();
}

async function assertRecording(recorder: UsageRecorderLike): Promise<void> {
  const health = await recorder.health();
  if (!health.enabled) {
    throw new UsageUnavailableError(
      'Usage is not being recorded: the Flight Recorder is disabled, so there are no token counts to report. '
        + 'Set OPENRAPPTER_FLIGHT_RECORDER=1 and restart the gateway to record provider token usage.',
    );
  }
  if (!health.initialized) {
    throw new UsageUnavailableError(
      'Usage is not being recorded: the Flight Recorder is enabled but failed to initialize its ledger. '
        + 'Run `openrappter flight status` for the underlying error.',
    );
  }
}

/**
 * Walk every recorded provider attempt, oldest first, in bounded pages.
 *
 * `applied` is called per event; the return value reports whether the walk hit
 * `MAX_PAGES` and therefore stopped short of the whole ledger.
 */
async function walkUsageEvents(
  recorder: UsageRecorderLike,
  since: string | undefined,
  visit: (event: FlightEvent) => void,
): Promise<boolean> {
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await recorder.query({
      kind: USAGE_EVENT_KIND,
      order: 'asc',
      limit: PAGE_SIZE,
      offset,
      ...(since === undefined ? {} : { since }),
    });
    for (const event of events) visit(event);
    if (events.length < PAGE_SIZE) return false;
    offset += events.length;
  }
  return true;
}

function emptyBucket(): UsageBucket {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addToBucket(
  buckets: Record<string, UsageBucket>,
  key: string,
  prompt: number,
  completion: number,
): void {
  const bucket = (buckets[key] ??= emptyBucket());
  bucket.requests += 1;
  bucket.promptTokens += prompt;
  bucket.completionTokens += completion;
  bucket.totalTokens += prompt + completion;
}

/** Aggregate recorded provider attempts into the Bar's usage summary. */
export async function collectUsageStats(
  recorder: UsageRecorderLike,
  options: UsageQueryOptions = {},
): Promise<UsageStatsResult> {
  await assertRecording(recorder);
  const since = normalizeSince(options.since);

  let promptTokens = 0;
  let completionTokens = 0;
  let requestCount = 0;
  let requestsWithTokenCounts = 0;
  const byProvider: Record<string, UsageBucket> = {};
  const byModel: Record<string, UsageBucket> = {};

  const truncated = await walkUsageEvents(recorder, since, (event) => {
    requestCount += 1;
    const tokens = readUsageTokens(event);
    if (!tokens) return;
    requestsWithTokenCounts += 1;
    promptTokens += tokens.promptTokens;
    completionTokens += tokens.completionTokens;
    addToBucket(byProvider, event.providerId ?? 'unknown', tokens.promptTokens, tokens.completionTokens);
    addToBucket(byModel, event.model ?? 'unknown', tokens.promptTokens, tokens.completionTokens);
  });

  return {
    totalTokens: promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    totalCost: 0,
    costAvailable: false,
    requestCount,
    requestsWithTokenCounts,
    period: since ? `since ${since}` : 'all recorded activity',
    source: 'flight-recorder',
    truncated,
    byProvider,
    byModel,
  };
}

/**
 * The most recent recorded provider attempts that reported token counts.
 *
 * Attempts without usage are omitted rather than listed as zero-token rows:
 * the entry would claim a measurement the provider never made.
 */
export async function collectUsageHistory(
  recorder: UsageRecorderLike,
  options: UsageQueryOptions = {},
): Promise<UsageEntryResult[]> {
  await assertRecording(recorder);
  const since = normalizeSince(options.since);
  const limit = Math.max(0, Math.min(Math.trunc(options.limit ?? 50), 500));
  if (limit === 0) return [];

  const entries: UsageEntryResult[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES && entries.length < limit; page++) {
    const events = await recorder.query({
      kind: USAGE_EVENT_KIND,
      order: 'desc',
      limit: PAGE_SIZE,
      offset,
      ...(since === undefined ? {} : { since }),
    });
    for (const event of events) {
      const tokens = readUsageTokens(event);
      if (!tokens) continue;
      entries.push({
        id: event.id,
        timestamp: event.timestamp,
        model: event.model ?? event.providerId ?? 'unknown',
        provider: event.providerId ?? 'unknown',
        tokens: tokens.promptTokens + tokens.completionTokens,
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        cost: 0,
        costAvailable: false,
      });
      if (entries.length >= limit) break;
    }
    if (events.length < PAGE_SIZE) break;
    offset += events.length;
  }
  return entries;
}
