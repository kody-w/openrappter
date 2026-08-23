import type { FlightRecorder } from "./recorder.js";
import type { FlightEvent, FlightEventInput } from "./types.js";

/**
 * Append one event and require the recorder's exact committed-storage receipt.
 * Retention may prune older rows after append without invalidating this
 * acknowledgment; a missing or mismatched per-event receipt fails closed.
 */
export async function recordFlightEventDurably(
  recorder: FlightRecorder,
  input: FlightEventInput,
): Promise<FlightEvent | null> {
  const durable = await recorder.recordDurably(input);
  if (
    !durable ||
    durable.receipt.eventId !== durable.event.id ||
    durable.receipt.traceId !== durable.event.traceId ||
    durable.receipt.kind !== durable.event.kind ||
    durable.receipt.sequence !== durable.event.sequence ||
    durable.receipt.contentHash !== durable.event.contentHash ||
    durable.event.kind !== input.kind ||
    durable.event.source !== input.source ||
    (input.traceId !== undefined && durable.event.traceId !== input.traceId)
  ) {
    return null;
  }
  return durable.event;
}
