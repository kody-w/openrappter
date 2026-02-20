/**
 * Provider types for LLM integration
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ChatOptions {
  model?: string;
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
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
    type: 'api-key' | 'oauth';
    token_env?: string;
    token?: string;
  };
  fallbacks?: string[];
}
