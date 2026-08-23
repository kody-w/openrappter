import type { FlightRecorder } from "./recorder.js";
import type { FlightEvent, FlightEventInput } from "./types.js";

/**
 * Append one event and prove the backing ledger can immediately count it.
 * A returned event is therefore durable for this recorder generation, not
 * merely accepted by the in-memory API.
 */
export async function recordFlightEventDurably(
  recorder: FlightRecorder,
  input: FlightEventInput,
): Promise<FlightEvent | null> {
  const before = await recorder.health();
  if (!before.enabled || !before.initialized) return null;

  const event = await recorder.record(input);
  if (!event) return null;

  const after = await recorder.health();
  if (
    !after.enabled ||
    !after.initialized ||
    after.errorCount !== before.errorCount ||
    after.eventCount < before.eventCount + 1
  ) {
    return null;
  }
  return event;
}
