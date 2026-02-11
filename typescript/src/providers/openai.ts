/**
 * OpenAI provider
 */

import type {
  LLMProvider,
  Message,
  ChatOptions,
  ProviderResponse,
  EmbeddingOptions,
} from './types.js';

const OPENAI_API_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_MAX_TOKENS = 4096;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIEmbeddingResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIProvider implements LLMProvider {
  id = 'openai';
  name = 'OpenAI';

  private apiKey: string | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? null;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ProviderResponse> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const openaiMessages: OpenAIMessage[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      tool_calls: msg.tool_calls,
      tool_call_id: msg.tool_call_id,
    }));

    const body: Record<string, unknown> = {
      model: options?.model ?? DEFAULT_MODEL,
      messages: openaiMessages,
      max_tokens: options?.max_tokens ?? DEFAULT_MAX_TOKENS,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices[0];

    return {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls ?? null,
      usage: {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      },
    };
  }

  async embed(texts: string[], options?: EmbeddingOptions): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const body: Record<string, unknown> = {
      model: options?.model ?? DEFAULT_EMBEDDING_MODEL,
      input: texts,
    };

    if (options?.dimensions) {
      body.dimensions = options.dimensions;
    }

    const response = await fetch(`${OPENAI_API_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI Embeddings API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    // Sort by index to ensure correct order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

export function createOpenAIProvider(apiKey?: string): OpenAIProvider {
  return new OpenAIProvider(apiKey);
}
