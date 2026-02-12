import type { LLMProvider, Message, ChatOptions, ProviderResponse } from './types.js';

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  async chat(
    messages: Message[],
    options?: ChatOptions
  ): Promise<ProviderResponse> {
    const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    const model = options?.model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Convert OpenAI-style messages to Gemini format
    const contents = messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    const requestBody = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.statusText} - ${error}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    // Extract the generated text from Gemini response
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '';

    return {
      content: text,
      tool_calls: null,
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount || 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.apiKey || process.env.GEMINI_API_KEY);
  }
}

export function createGeminiProvider(apiKey?: string): LLMProvider {
  return new GeminiProvider(apiKey);
}
