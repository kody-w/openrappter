/**
 * GitHub Copilot provider — direct API integration, no CLI dependency.
 *
 * Uses the Copilot token exchange to get an API token, then hits
 * the OpenAI-compatible chat completions endpoint directly.
 *
 * Token flow:
 *   GITHUB_TOKEN → Copilot API token (cached) → OpenAI-compatible API
 */

import type {
  LLMProvider,
  Message,
  ChatOptions,
  ProviderResponse,
  Tool,
  ToolCall,
  StreamDelta,
} from "./types.js";
import {
  CopilotAuthority,
  inferCopilotRequestContext,
} from "./copilot-authority.js";
import type { CopilotRequestContext } from "./copilot-authority.js";
import { COPILOT_DEFAULT_MODEL } from "./copilot-models.js";

export { COPILOT_DEFAULT_MODEL, COPILOT_DEFAULT_MODELS } from "./copilot-models.js";

// ── OpenAI-compatible request/response types ─────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatResponse {
  id: string;
  model?: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── SSE Stream Parser ────────────────────────────────────────────────────────

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") return;
        if (trimmed.startsWith("data: ")) {
          yield JSON.parse(trimmed.slice(6));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── 429 Retry Config ─────────────────────────────────────────────────────────

const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** Parse Retry-After header (seconds or HTTP-date) into ms to wait. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  return null;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class CopilotProvider implements LLMProvider {
  readonly id = "copilot";
  readonly name = "GitHub Copilot";

  private readonly authority: CopilotAuthority;

  constructor(options?: {
    githubToken?: string;
    allowAmbientCredentials?: boolean;
    authority?: CopilotAuthority;
  }) {
    this.authority = options?.authority ?? new CopilotAuthority({
      githubToken: options?.githubToken,
      allowAmbientCredentials: options?.allowAmbientCredentials,
    });
  }

  /**
   * Update the GitHub token at runtime (e.g. after device-code login).
   * Clears the cached Copilot API token so the next call re-exchanges.
   */
  setGithubToken(
    token: string | null,
    allowAmbientCredentials = true,
  ): void {
    this.authority.setCredential(token, {
      authoritative: token !== null || !allowAmbientCredentials,
    });
  }

  /** Invalidate the cached Copilot API token so the next call re-exchanges */
  invalidateToken(): void {
    this.authority.invalidate({ clearPersistentCache: true });
  }

  getAuthority(): CopilotAuthority {
    return this.authority;
  }

  /**
   * Fetch with automatic retry on 429 (rate-limit / quota exceeded).
   * Respects the Retry-After header when present; falls back to
   * exponential backoff with jitter.
   */
  private async fetchWithRateRetry(
    pathname: string,
    init: RequestInit,
    context: CopilotRequestContext,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      const res = await this.authority.fetch(pathname, init, context);

      if (res.status !== 429) return res;

      // Last attempt — don't wait, just surface the error
      if (attempt === RATE_LIMIT_MAX_RETRIES) return res;

      const retryMs =
        parseRetryAfter(res.headers.get("Retry-After")) ??
        Math.min(
          RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt) +
            Math.random() * 1_000,
          RATE_LIMIT_MAX_DELAY_MS,
        );

      await new Promise((r) => setTimeout(r, retryMs));
    }

    // unreachable, but satisfies tsc
    throw new Error("Rate-limit retry loop exited unexpectedly");
  }

  async chat(
    messages: Message[],
    options?: ChatOptions,
  ): Promise<ProviderResponse> {
    const model = options?.model ?? COPILOT_DEFAULT_MODEL;
    const requestContext = inferCopilotRequestContext(messages, options);

    // Convert to OpenAI format
    const openaiMessages: OpenAIMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls as OpenAIToolCall[] | undefined,
      tool_call_id: m.tool_call_id,
    }));

    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map(
        (t: Tool): OpenAITool => ({
          type: "function",
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        }),
      );
    }

    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.max_tokens != null) body.max_tokens = options.max_tokens;

    const res = await this.fetchWithRateRetry("/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    }, { ...requestContext, model, accept: "application/json" });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      // On auth errors, invalidate the cached Copilot token and retry once.
      // The GitHub token may still be valid — just the short-lived Copilot API
      // token expired or was revoked server-side.
      if ((res.status === 401 || res.status === 403) && !options?._isRetry) {
        this.invalidateToken();
        return this.chat(messages, {
          ...options,
          _isRetry: true,
        } as ChatOptions);
      }
      throw new Error(
        `Copilot API error: HTTP ${res.status}${errBody ? ` — ${errBody}` : ""}`,
      );
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error("Copilot API returned no choices");
    }

    const toolCalls: ToolCall[] | null =
      choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })) ?? null;

    return {
      content: choice.message.content,
      tool_calls: toolCalls,
      model: data.model,
      usage: data.usage
        ? {
            input_tokens: data.usage.prompt_tokens,
            output_tokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamDelta> {
    const model = options?.model ?? COPILOT_DEFAULT_MODEL;
    const requestContext = inferCopilotRequestContext(messages, options);

    const openaiMessages: OpenAIMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls as OpenAIToolCall[] | undefined,
      tool_call_id: m.tool_call_id,
    }));

    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      stream: true,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map(
        (t: Tool): OpenAITool => ({
          type: "function",
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        }),
      );
    }

    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.max_tokens != null) body.max_tokens = options.max_tokens;

    const res = await this.fetchWithRateRetry("/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    }, { ...requestContext, model, accept: "text/event-stream" });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if ((res.status === 401 || res.status === 403) && !options?._isRetry) {
        this.invalidateToken();
        yield* this.chatStream(messages, {
          ...options,
          _isRetry: true,
        } as ChatOptions);
        return;
      }
      throw new Error(
        `Copilot API error: HTTP ${res.status}${errBody ? ` — ${errBody}` : ""}`,
      );
    }

    if (!res.body) {
      throw new Error("Copilot API returned no response body");
    }

    let lastFinishReason: string | undefined;
    let reportedModel: string | undefined;

    for await (const event of parseSSEStream(res.body)) {
      if (typeof event.model === "string" && event.model.trim()) {
        reportedModel = event.model.trim();
      }
      const choices = event.choices as
        | Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }>
        | undefined;

      const choice = choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        lastFinishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) continue;

      // Skip role-only deltas (first chunk is often just { role: 'assistant' })
      if (!delta.content && !delta.tool_calls) continue;

      yield {
        content: delta.content ?? undefined,
        model: reportedModel,
        tool_calls: delta.tool_calls?.map((tc) => ({
          index: tc.index,
          id: tc.id,
          type: tc.type as "function" | undefined,
          function: tc.function
            ? { name: tc.function.name, arguments: tc.function.arguments }
            : undefined,
        })),
        done: false,
      };
    }

    yield {
      done: true,
      finish_reason: lastFinishReason,
      model: reportedModel,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.authority.isAvailable();
  }
}

export function createCopilotProvider(options?: {
  githubToken?: string;
}): LLMProvider {
  return new CopilotProvider(options);
}
