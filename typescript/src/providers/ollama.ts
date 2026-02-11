/**
 * Ollama provider for local LLMs
 */

import type {
  LLMProvider,
  Message,
  ChatOptions,
  ProviderResponse,
  EmbeddingOptions,
} from './types.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: 'assistant';
    content: string;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
}

interface OllamaListResponse {
  models: OllamaModel[];
}

export class OllamaProvider implements LLMProvider {
  id = 'ollama';
  name = 'Ollama (Local)';

  private baseUrl: string;
  private defaultModel: string;

  constructor(options?: { baseUrl?: string; model?: string }) {
    this.baseUrl = options?.baseUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
    this.defaultModel = options?.model ?? DEFAULT_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<OllamaModel[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to list Ollama models: ${response.status}`);
    }
    const data = (await response.json()) as OllamaListResponse;
    return data.models;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ProviderResponse> {
    // Convert messages to Ollama format (no tool support in basic Ollama)
    const ollamaMessages: OllamaMessage[] = messages
      .filter((m) => m.role !== 'tool')
      .map((msg) => ({
        role: msg.role === 'tool' ? 'user' : msg.role,
        content: msg.content,
      }));

    const body: Record<string, unknown> = {
      model: options?.model ?? this.defaultModel,
      messages: ollamaMessages,
      stream: false,
    };

    if (options?.temperature !== undefined) {
      body.options = { temperature: options.temperature };
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    return {
      content: data.message.content,
      tool_calls: null, // Ollama doesn't support tool calling natively
      usage: {
        input_tokens: data.prompt_eval_count ?? 0,
        output_tokens: data.eval_count ?? 0,
      },
    };
  }

  async embed(texts: string[], options?: EmbeddingOptions): Promise<number[][]> {
    const model = options?.model ?? DEFAULT_EMBEDDING_MODEL;
    const embeddings: number[][] = [];

    // Ollama processes embeddings one at a time
    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama Embeddings API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as OllamaEmbeddingResponse;
      embeddings.push(data.embedding);
    }

    return embeddings;
  }
}

export function createOllamaProvider(options?: {
  baseUrl?: string;
  model?: string;
}): OllamaProvider {
  return new OllamaProvider(options);
}
