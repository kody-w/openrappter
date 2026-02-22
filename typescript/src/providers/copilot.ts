/**
 * GitHub Copilot provider — direct API integration, no CLI dependency.
 *
 * Uses the Copilot token exchange to get an API token, then hits
 * the OpenAI-compatible chat completions endpoint directly.
 *
 * Token flow:
 *   GITHUB_TOKEN → Copilot API token (cached) → OpenAI-compatible API
 */

import type { LLMProvider, Message, ChatOptions, ProviderResponse, Tool, ToolCall, StreamDelta } from './types.js';
import {
  resolveCopilotApiToken,
  DEFAULT_COPILOT_API_BASE_URL,
  type ResolvedCopilotToken,
} from './copilot-token.js';

// ── Default models ───────────────────────────────────────────────────────────

export const COPILOT_DEFAULT_MODELS = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'o1',
  'o1-mini',
  'o3-mini',
] as const;

export const COPILOT_DEFAULT_MODEL = 'gpt-4.1';

// ── OpenAI-compatible request/response types ─────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
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

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;
        if (trimmed.startsWith('data: ')) {
          yield JSON.parse(trimmed.slice(6));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class CopilotProvider implements LLMProvider {
  readonly id = 'copilot';
  readonly name = 'GitHub Copilot';

  private githubToken: string | null = null;
  private resolvedToken: ResolvedCopilotToken | null = null;

  constructor(options?: { githubToken?: string }) {
    this.githubToken = options?.githubToken ?? null;
  }

  /** Resolve the GitHub token from constructor, env, or gh CLI */
  private getGithubToken(): string | null {
    if (this.githubToken) return this.githubToken;

    // Check environment variables (same order as openclaw)
    return (
      process.env.COPILOT_GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      null
    );
  }

  /** Get a valid Copilot API token, exchanging if needed */
  private async ensureToken(): Promise<ResolvedCopilotToken> {
    // Return cached token if still valid
    if (this.resolvedToken && this.resolvedToken.expiresAt - Date.now() > 5 * 60 * 1000) {
      return this.resolvedToken;
    }

    const githubToken = this.getGithubToken();
    if (!githubToken) {
      throw new Error(
        'No GitHub token found. Set GITHUB_TOKEN, run `gh auth login`, or run `openrappter onboard`.',
      );
    }

    this.resolvedToken = await resolveCopilotApiToken({ githubToken });
    return this.resolvedToken;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ProviderResponse> {
    const { token, baseUrl } = await this.ensureToken();
    const model = options?.model ?? COPILOT_DEFAULT_MODEL;

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
      body.tools = options.tools.map((t: Tool): OpenAITool => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.max_tokens != null) body.max_tokens = options.max_tokens;

    const url = `${baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        // Copilot API requires recognized editor headers
        'Editor-Version': 'vscode/1.96.2',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Copilot API error: HTTP ${res.status}${errBody ? ` — ${errBody}` : ''}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error('Copilot API returned no choices');
    }

    const toolCalls: ToolCall[] | null = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })) ?? null;

    return {
      content: choice.message.content,
      tool_calls: toolCalls,
      usage: data.usage
        ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamDelta> {
    const { token, baseUrl } = await this.ensureToken();
    const model = options?.model ?? COPILOT_DEFAULT_MODEL;

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
      body.tools = options.tools.map((t: Tool): OpenAITool => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.max_tokens != null) body.max_tokens = options.max_tokens;

    const url = `${baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'text/event-stream',
        'Editor-Version': 'vscode/1.96.2',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Copilot API error: HTTP ${res.status}${errBody ? ` — ${errBody}` : ''}`);
    }

    if (!res.body) {
      throw new Error('Copilot API returned no response body');
    }

    let lastFinishReason: string | undefined;

    for await (const event of parseSSEStream(res.body)) {
      const choices = event.choices as Array<{
        delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
        finish_reason?: string;
      }> | undefined;

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
        tool_calls: delta.tool_calls?.map(tc => ({
          index: tc.index,
          id: tc.id,
          type: tc.type as 'function' | undefined,
          function: tc.function ? { name: tc.function.name, arguments: tc.function.arguments } : undefined,
        })),
        done: false,
      };
    }

    yield { done: true, finish_reason: lastFinishReason };
  }

  async isAvailable(): Promise<boolean> {
    const token = this.getGithubToken();
    if (!token) return false;

    try {
      await this.ensureToken();
      return true;
    } catch {
      return false;
    }
  }
}

export function createCopilotProvider(options?: { githubToken?: string }): LLMProvider {
  return new CopilotProvider(options);
}
