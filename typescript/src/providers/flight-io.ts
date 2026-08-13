import { sanitizeFlightValue } from "../flight-recorder/redaction.js";
import type {
  Message,
  ProviderResponse,
  ToolCall,
} from "./types.js";

export function flightStructuredValue(value: unknown): unknown {
  return sanitizeFlightValue(value);
}

export function flightLogResult(value: string): string {
  const sanitized = flightStructuredValue(value);
  if (typeof sanitized === "string") return sanitized;
  try {
    return JSON.stringify(sanitized) ?? "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}

export function formatFlightAgentLog(
  agent: string,
  result: string,
  failed = false,
): string {
  return `[${agent}] ${failed ? "ERROR: " : ""}${flightLogResult(result)}`;
}

export function sanitizeFlightAgentLog(value: string): string {
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(value);
  if (!match) return flightLogResult(value);
  const failed = match[2].startsWith("ERROR: ");
  return formatFlightAgentLog(
    match[1],
    failed ? match[2].slice("ERROR: ".length) : match[2],
    failed,
  );
}

export function flightToolCalls(
  calls: ToolCall[] | null | undefined,
): unknown {
  return calls;
}

export function flightMessages(messages: Message[]): unknown[] {
  return messages;
}

export function flightProviderResponse(
  response: ProviderResponse,
): Record<string, unknown> {
  return { ...response };
}
