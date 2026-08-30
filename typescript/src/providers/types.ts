/**
 * Provider types for LLM integration
 */

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * The tool's name on a `role: 'tool'` result message.
   *
   * `rapp-runtime-parity/1.0` §2.3 fixes the tool result message shape exactly:
   * `{ tool_call_id, role, name, content }`. We were omitting `name`.
   */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  /** Concrete model reported by the provider, when the provider reveals it. */
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  /**
   * Tool-call log lines, for providers that run their own tool loop.
   *
   * The Copilot CLI executes tools inside itself and returns only prose, so it
   * has no `tool_calls` to hand back — but the calls still went through our MCP
   * server. This carries them so `agent_logs` (PARITY §2.3) is not empty for a
   * turn in which an agent demonstrably ran.
   */
  agent_logs?: string[];
}

export interface ChatOptions {
  model?: string;
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Internal: prevents infinite retry loops on auth errors */
  _isRetry?: boolean;
  signal?: AbortSignal;
  /** Copilot request origin. Inferred from the conversation when omitted. */
  initiator?: "user" | "agent";
  /** Copilot request intent header. Invalid values fall back safely. */
  intent?: string;
  /** Mark a request that contains vision input. */
  vision?: boolean;
}

export interface StreamDelta {
  content?: string;
  /** Concrete provider-reported model, when present in the stream. */
  model?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  done: boolean;
  finish_reason?: string;
}

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
}

/**
 * Base interface for LLM providers
 */
export interface LLMProvider {
  /** Unique provider identifier */
  id: string;

  /** Human-readable provider name */
  name: string;

  /**
   * Send a chat message and get a response
   */
  chat(messages: Message[], options?: ChatOptions): Promise<ProviderResponse>;

  /**
   * Stream a chat response when supported.
   */
  chatStream?(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamDelta>;

  /**
   * Generate embeddings for texts (optional)
   */
  embed?(texts: string[], options?: EmbeddingOptions): Promise<number[][]>;

  /**
   * Check if the provider is available and configured
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  id: string;
  provider: string;
  model: string;
  auth: {
    type: "api-key" | "oauth";
    token_env?: string;
    token?: string;
  };
  fallbacks?: string[];
}
