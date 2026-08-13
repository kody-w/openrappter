import {
  getFlightRecorder,
  summarizeFlightError,
} from "../flight-recorder/index.js";
import type { FlightTraceContext } from "../flight-recorder/types.js";
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ProviderResponse,
} from "./types.js";
import {
  flightMessages,
  flightProviderResponse,
} from "./flight-io.js";

export interface RecordedChatRequest {
  provider: LLMProvider;
  messages: Message[];
  options?: ChatOptions;
  source: string;
  scope?: Partial<FlightTraceContext>;
  attributes?: Record<string, unknown>;
}

export async function chatWithFlightRecorder(
  request: RecordedChatRequest,
): Promise<ProviderResponse> {
  const recorder = getFlightRecorder();
  const attempt = async (): Promise<ProviderResponse> => {
    const startedAt = performance.now();
    const modelPolicy = request.options?.model;
    const started = await recorder.record({
      kind: "provider.attempt.started",
      source: request.source,
      status: "started",
      providerId: request.provider.id,
      metadata: {
        ...request.attributes,
        messageCount: request.messages.length,
        toolCount: request.options?.tools?.length ?? 0,
        streaming: false,
        ...(modelPolicy === undefined ? {} : { modelPolicy }),
      },
      payload: () => ({ messages: flightMessages(request.messages) }),
    });

    return recorder.withParent(started?.id ?? null, async () => {
      try {
        const response = await request.provider.chat(
          request.messages,
          request.options,
        );
        await recorder.record({
          kind: "provider.attempt.completed",
          source: request.source,
          status: "success",
          providerId: request.provider.id,
          model: response.model,
          durationMs: performance.now() - startedAt,
          metadata: {
            ...request.attributes,
            messageCount: request.messages.length,
            toolCount: request.options?.tools?.length ?? 0,
            streaming: false,
            ...(modelPolicy === undefined ? {} : { modelPolicy }),
            toolCallsOccurred: Boolean(response.tool_calls?.length),
            ...(response.usage ? { usage: response.usage } : {}),
          },
          payload: () => ({
            messages: flightMessages(request.messages),
            response: flightProviderResponse(response),
          }),
        });
        return response;
      } catch (error) {
        await recorder.record({
          kind: "provider.attempt.failed",
          source: request.source,
          status: "error",
          providerId: request.provider.id,
          durationMs: performance.now() - startedAt,
          metadata: {
            ...request.attributes,
            messageCount: request.messages.length,
            toolCount: request.options?.tools?.length ?? 0,
            streaming: false,
            ...(modelPolicy === undefined ? {} : { modelPolicy }),
            ...summarizeFlightError(error),
          },
          payload: () => ({
            messages: flightMessages(request.messages),
            error,
          }),
        });
        throw error;
      }
    });
  };

  if (recorder.currentTrace()) {
    if (!request.scope || Object.keys(request.scope).length === 0) {
      return attempt();
    }
    const current = recorder.currentTrace()!;
    return recorder.runTrace(
      {
        ...request.scope,
        traceId: request.scope.traceId ?? current.traceId,
        parentId:
          request.scope.parentId === undefined
            ? current.parentId ?? null
            : request.scope.parentId,
      },
      attempt,
    );
  }
  return recorder.runTrace(request.scope ?? {}, attempt);
}
