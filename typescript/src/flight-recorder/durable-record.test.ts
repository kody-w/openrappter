import { describe, expect, it, vi } from "vitest";

import type { FlightRecorder } from "./recorder.js";
import { recordFlightEventDurably } from "./durable-record.js";
import type { FlightEvent } from "./types.js";

const EVENT = {
  id: "event-1",
  traceId: "trace-1",
} as FlightEvent;

describe("recordFlightEventDurably", () => {
  it("rejects an event when the recorder becomes unhealthy after append", async () => {
    const health = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        initialized: true,
        eventCount: 4,
        errorCount: 0,
      })
      .mockResolvedValueOnce({
        enabled: true,
        initialized: true,
        eventCount: 5,
        errorCount: 1,
        lastError: "injected ledger failure",
      });
    const recorder = {
      health,
      record: vi.fn().mockResolvedValue(EVENT),
    } as unknown as FlightRecorder;

    await expect(recordFlightEventDurably(recorder, {
      kind: "agent.import.started",
      source: "agent-import",
      status: "started",
    })).resolves.toBeNull();
  });

  it("rejects an acknowledged event that is not visible in the durable count", async () => {
    const health = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        initialized: true,
        eventCount: 4,
        errorCount: 0,
      })
      .mockResolvedValueOnce({
        enabled: true,
        initialized: true,
        eventCount: 4,
        errorCount: 0,
      });
    const recorder = {
      health,
      record: vi.fn().mockResolvedValue(EVENT),
    } as unknown as FlightRecorder;

    await expect(recordFlightEventDurably(recorder, {
      kind: "agent.import.started",
      source: "agent-import",
      status: "started",
    })).resolves.toBeNull();
  });
});
