import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FlightRecorder,
  type FlightDurableAppend,
} from "./recorder.js";
import { recordFlightEventDurably } from "./durable-record.js";
import type { FlightEventInput } from "./types.js";

const recorders: FlightRecorder[] = [];

async function recorder(retentionEvents: number): Promise<FlightRecorder> {
  const instance = new FlightRecorder({
    enabled: true,
    inMemory: true,
    retentionEvents,
  });
  await instance.initialize();
  recorders.push(instance);
  return instance;
}

function requiredInput(index: number): FlightEventInput {
  return {
    kind: "agent.import.started",
    source: "agent-import",
    status: "started",
    traceId: `required-trace-${index}`,
    metadata: { index },
  };
}

afterEach(async () => {
  await Promise.all(recorders.splice(0).map((instance) => instance.close()));
});

describe("recordFlightEventDurably", () => {
  it("returns normal durable success from an exact committed append receipt", async () => {
    const instance = await recorder(-1);
    const event = await recordFlightEventDurably(instance, requiredInput(1));

    expect(event).toMatchObject({
      traceId: "required-trace-1",
      kind: "agent.import.started",
      source: "agent-import",
    });
    expect(await instance.query({ traceId: "required-trace-1" })).toEqual([
      event,
    ]);
  });

  it("stays successful when crossing retention prunes an older event", async () => {
    const instance = await recorder(1);
    await instance.record({
      kind: "older.atomic",
      source: "retention-test",
      traceId: "older-trace",
    });

    const event = await recordFlightEventDurably(instance, requiredInput(2));
    const health = await instance.health();

    expect(event?.traceId).toBe("required-trace-2");
    expect(health.eventCount).toBe(1);
    expect(await instance.query({ traceId: "older-trace" })).toEqual([]);
    expect(await instance.query({ traceId: "required-trace-2" })).toEqual([
      event,
    ]);
  });

  it("isolates exact receipts across concurrent writes and retention", async () => {
    const instance = await recorder(2);
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        recordFlightEventDurably(instance, requiredInput(index + 10)),
      ),
    );

    expect(results.every((event) => event !== null)).toBe(true);
    expect(new Set(results.map((event) => event!.id)).size).toBe(24);
    expect((await instance.health()).eventCount).toBeLessThanOrEqual(2);
  });

  it("pins required import trace barriers until the active transaction terminates", async () => {
    const instance = await recorder(0);

    await instance.runTrace({ traceId: "pinned-import-trace" }, async () => {
      const root = (await instance.query({
        traceId: "pinned-import-trace",
        kind: "trace.started",
      }))[0]!;
      const started = await recordFlightEventDurably(instance, {
        kind: "agent.import.started",
        source: "agent-import",
        status: "started",
        traceId: root.traceId,
        parentId: root.id,
      });
      const commit = await recordFlightEventDurably(instance, {
        kind: "agent.import.commit.started",
        source: "agent-import",
        status: "started",
        traceId: root.traceId,
        parentId: started!.id,
      });

      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          instance.record({
            kind: "retention.noise",
            source: "retention-test",
            traceId: `noise-${index}`,
            parentId: null,
          }),
        ),
      );

      const active = await instance.query({ traceId: root.traceId });
      expect(active.map((event) => event.id)).toEqual(
        expect.arrayContaining([root.id, started!.id, commit!.id]),
      );
    });
  });

  it("fails closed when the exact immutable event ID receipt is missing", async () => {
    const input = requiredInput(40);
    const event = {
      schema: "openrappter-event/1.0" as const,
      id: "event-exact",
      traceId: input.traceId!,
      parentId: null,
      kind: input.kind,
      source: input.source,
      status: "started" as const,
      timestamp: "2026-08-23T21:00:00.000Z",
      sequence: 1,
      metadata: {},
      contentHash: "a".repeat(64),
    };
    const recorderWithoutExactId = {
      recordDurably: vi.fn().mockResolvedValue({
        event,
        receipt: {
          eventId: "event-other",
          traceId: event.traceId,
          kind: event.kind,
          sequence: event.sequence,
          contentHash: event.contentHash,
        },
      } satisfies FlightDurableAppend),
    } as unknown as FlightRecorder;

    await expect(
      recordFlightEventDurably(recorderWithoutExactId, input),
    ).resolves.toBeNull();
  });

  it("fails closed when storage returns no durable append receipt", async () => {
    const recorderWithoutReceipt = {
      recordDurably: vi.fn().mockResolvedValue(null),
    } as unknown as FlightRecorder;

    await expect(
      recordFlightEventDurably(recorderWithoutReceipt, requiredInput(41)),
    ).resolves.toBeNull();
  });
});
