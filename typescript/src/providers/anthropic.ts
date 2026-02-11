/**
 * Anthropic Claude provider
 */

import type {
  LLMProvider,
  Message,
  ChatOptions,
  ProviderResponse,
  ToolCall,
  Tool,
} from './types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: string }>;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicProvider implements LLMProvider {
  id = 'anthropic';
  name = 'Anthropic Claude';

  private apiKey: string | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ProviderResponse> {
    if (!this.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    // Extract system message
    const systemMessage = messages.find((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    // Convert messages to Anthropic format
    const anthropicMessages = this.convertMessages(otherMessages);

    // Convert tools to Anthropic format
    const anthropicTools = options?.tools
      ? this.convertTools(options.tools)
      : undefined;

    const body: Record<string, unknown> = {
      model: options?.model ?? DEFAULT_MODEL,
      max_tokens: options?.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (anthropicTools && anthropicTools.length > 0) {
      body.tools = anthropicTools;
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    return this.convertResponse(data);
  }

  private convertMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant message with tool calls
          result.push({
            role: 'assistant',
            content: msg.tool_calls.map((tc) => ({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        // Tool result - append to last user message or create new
        const lastMsg = result[result.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Array<{ type: 'tool_result'; tool_use_id: string; content: string }>).push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          });
        } else {
          result.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content,
              },
            ],
          });
        }
      }
    }

    return result;
  }

  private convertTools(tools: Tool[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  private convertResponse(data: AnthropicResponse): ProviderResponse {
    let content: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content = block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      usage: {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
      },
    };
  }
}

export function createAnthropicProvider(apiKey?: string): AnthropicProvider {
  return new AnthropicProvider(apiKey);
}
