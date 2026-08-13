/**
 * Mutation probes for the Flight Recorder acceptance gate.
 *
 * These are not duplicate happy-path tests. Each probe deliberately mutates
 * one invariant and proves the corresponding assertion turns red.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeFlightEventHash, verifyFlightEventHash } from "./integrity.js";
import { SQLiteFlightLedger } from "./ledger.js";
import { sanitizeFlightPayload } from "./redaction.js";
import { FLIGHT_EVENT_SCHEMA, type FlightEvent } from "./types.js";

function event(): FlightEvent {
  const body: Omit<FlightEvent, "contentHash"> = {
    schema: FLIGHT_EVENT_SCHEMA,
    id: "mutation-event",
    sequence: 1,
    traceId: "trace-a",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    kind: "agent.execute.completed",
    source: "mutation-test",
    status: "success",
    metadata: { ordinary: true },
    payload: { value: 1 },
  };
  return { ...body, contentHash: computeFlightEventHash(body) };
}

describe("Flight Recorder mutation probes", () => {
  it("detects a trace-correlation mutation", () => {
    const original = event();
    const mutated = { ...original, traceId: "trace-b" };

    expect(verifyFlightEventHash(original)).toBe(true);
    expect(verifyFlightEventHash(mutated)).toBe(false);
  });

  it("detects a payload mutation", () => {
    const original = event();
    const mutated = { ...original, payload: { value: 2 } };

    expect(computeFlightEventHash(mutated)).not.toBe(original.contentHash);
    expect(verifyFlightEventHash(mutated)).toBe(false);
  });

  it("proves secret redaction is not a vacuous string check", () => {
    const secret = `ghp_${"z".repeat(32)}`;
    const insecureControl = { recentEdit: { patch: `const x = "${secret}"` } };
    const sanitized = sanitizeFlightPayload(insecureControl, {
      recordIO: true,
    });

    expect(JSON.stringify(insecureControl)).toContain(secret);
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(JSON.stringify(sanitized)).toContain("[redacted]");
  });

  it("proves secret-shaped metadata keys cannot bypass redaction", () => {
    const secret = `ghp_${"k".repeat(32)}`;
    const input = { [secret]: "ordinary value" };
    const sanitized = sanitizeFlightPayload(input, { recordIO: true });

    expect(JSON.stringify(input)).toContain(secret);
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(JSON.stringify(sanitized)).toContain("[redacted]");
  });

  it("proves raw IO is absent unless explicitly opted in", () => {
    const payload = { ordinary: "visible only with consent" };

    expect(sanitizeFlightPayload(payload)).toBeUndefined();
    expect(sanitizeFlightPayload(payload, { recordIO: true })).toEqual(payload);
  });

  it("imports the committed TypeScript/Python golden hash vector", async () => {
    const vector = JSON.parse(
      readFileSync(
        new URL(
          "../../../contracts/flight-recorder-vector.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as FlightEvent;

    expect(computeFlightEventHash(vector)).toBe(vector.contentHash);
    expect(verifyFlightEventHash(vector)).toBe(true);
    const ledger = new SQLiteFlightLedger({ inMemory: true });
    await ledger.initialize();
    try {
      expect(
        await ledger.import({
          schema: "openrappter-flight-export/1.0",
          exportedAt: "2026-08-11T12:35:00.000Z",
          events: [vector],
        }),
      ).toBe(1);
      expect(await ledger.query({ traceId: vector.traceId })).toEqual([vector]);
    } finally {
      await ledger.close();
    }
  });
});
