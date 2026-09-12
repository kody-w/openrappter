export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

export type ModelMessage =
  | { readonly role: "system" | "user" | "assistant"; readonly content: string }
  | { readonly role: "assistant"; readonly calls: readonly ToolCall[] }
  | { readonly role: "tool"; readonly callId: string; readonly content: string };

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ModelResponse =
  | { readonly kind: "final"; readonly text: string; readonly usage?: TokenUsage }
  | { readonly kind: "tool-calls"; readonly calls: readonly ToolCall[]; readonly usage?: TokenUsage };

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDescription[];
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** The SDK/HTTP driver must return proposals, never run a proposed tool itself. */
export interface CopilotTransport {
  complete(
    request: {
      readonly model: string;
      readonly messages: readonly ModelMessage[];
      readonly tools: readonly ToolDescription[];
      readonly maxOutputTokens: number;
      readonly automaticToolExecution: false;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export class ModelProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ModelProviderError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function json(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth > 32 || typeof value !== "object" || value === null || seen.has(value)) return false;
  if (!Array.isArray(value) && !record(value)) return false;
  seen.add(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  const valid = descriptors.every((descriptor) => "value" in descriptor
    && json(descriptor.value, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function name(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
}

export function parseModelResponse(value: unknown, maxToolCalls = 32): ModelResponse {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 128
    || !record(value) || !json(value) || JSON.stringify(value).length > 1_048_576) {
    throw new ModelProviderError("invalid_response");
  }
  let usage: TokenUsage | undefined;
  if (value.usage !== undefined) {
    if (!record(value.usage) || !Number.isSafeInteger(value.usage.inputTokens)
      || !Number.isSafeInteger(value.usage.outputTokens)
      || (value.usage.inputTokens as number) < 0 || (value.usage.outputTokens as number) < 0) {
      throw new ModelProviderError("invalid_usage");
    }
    usage = {
      inputTokens: value.usage.inputTokens as number,
      outputTokens: value.usage.outputTokens as number,
    };
  }
  if (value.kind === "final" && typeof value.text === "string") {
    return { kind: "final", text: value.text, ...(usage ? { usage } : {}) };
  }
  if (value.kind !== "tool-calls" || !Array.isArray(value.calls)
    || value.calls.length === 0 || value.calls.length > maxToolCalls) {
    throw new ModelProviderError("invalid_response");
  }
  const ids = new Set<string>();
  const calls: ToolCall[] = value.calls.map((call: unknown) => {
    if (!record(call) || !name(call.id) || !name(call.name) || !json(call.input) || ids.has(call.id)) {
      throw new ModelProviderError("invalid_tool_call");
    }
    ids.add(call.id);
    return { id: call.id, name: call.name, input: structuredClone(call.input) };
  });
  return { kind: "tool-calls", calls, ...(usage ? { usage } : {}) };
}

export class GitHubCopilotProvider implements ModelProvider {
  readonly id = "github-copilot";

  constructor(private readonly transport: CopilotTransport) {
    if (!transport || typeof transport.complete !== "function") {
      throw new ModelProviderError("missing_copilot_transport");
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    if (!name(request.model) || !Number.isSafeInteger(request.maxOutputTokens)
      || request.maxOutputTokens < 1 || request.maxOutputTokens > 131_072
      || !Array.isArray(request.messages) || request.messages.length === 0
      || !Array.isArray(request.tools) || request.tools.length > 128
      || new Set(request.tools.map((tool) => tool.name)).size !== request.tools.length) {
      throw new ModelProviderError("invalid_request");
    }
    const tools = request.tools.map((tool) => {
      if (!name(tool.name) || typeof tool.description !== "string"
        || !record(tool.inputSchema) || !json(tool.inputSchema)) {
        throw new ModelProviderError("invalid_tool_description");
      }
      return { name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) };
    });
    if (request.messages.length > 1_024 || !json(request.messages)
      || JSON.stringify(request.messages).length > 2_097_152) {
      throw new ModelProviderError("invalid_messages");
    }
    const messages: ModelMessage[] = request.messages.map((input: unknown): ModelMessage => {
      if (!record(input)) throw new ModelProviderError("invalid_messages");
      if (input.role === "assistant" && Array.isArray(input.calls)) {
        const parsed = parseModelResponse({ kind: "tool-calls", calls: input.calls });
        if (parsed.kind !== "tool-calls") throw new ModelProviderError("invalid_messages");
        return { role: "assistant", calls: parsed.calls };
      }
      if (input.role === "tool" && name(input.callId) && typeof input.content === "string") {
        return { role: "tool", callId: input.callId, content: input.content };
      }
      if (["system", "user", "assistant"].includes(input.role as string)
        && typeof input.content === "string") {
        return { role: input.role as "system" | "user" | "assistant", content: input.content };
      }
      throw new ModelProviderError("invalid_messages");
    });
    // Whitelisting fields prevents capabilities or tool executors reaching the provider.
    const response = await this.transport.complete({
      model: request.model,
      messages,
      tools,
      maxOutputTokens: request.maxOutputTokens,
      automaticToolExecution: false,
    }, request.signal);
    request.signal.throwIfAborted();
    return parseModelResponse(response);
  }
}
