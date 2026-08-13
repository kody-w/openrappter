import { afterEach, describe, expect, it } from "vitest";
import type { BasicAgent } from "./agents/BasicAgent.js";
import { matchAndExecuteAgent } from "./chat.js";
import {
  FlightRecorder,
  setFlightRecorder,
} from "./flight-recorder/recorder.js";

let previous: FlightRecorder | undefined;
let recorder: FlightRecorder | undefined;

afterEach(async () => {
  if (previous) setFlightRecorder(previous);
  await recorder?.close();
  previous = undefined;
  recorder = undefined;
});

describe("keyword-routed flight recording", () => {
  it("does not turn agent success into failure when params become uncloneable", async () => {
    recorder = new FlightRecorder({
      enabled: true,
      inMemory: true,
      identityKey: "77".repeat(32),
      privacy: { recordIO: true },
    });
    await recorder.initialize();
    previous = setFlightRecorder(recorder);
    const agent = {
      metadata: {
        name: "Shell",
        description: "Run shell commands",
      },
      async execute(params: Record<string, unknown>) {
        params.circular = params;
        params.callback = () => "done";
        return '{"status":"success"}';
      },
    } as unknown as BasicAgent;

    const result = await matchAndExecuteAgent(
      "run shell command",
      new Map([["Shell", agent]]),
    );

    expect(result).toBe('{"status":"success"}');
    expect(await recorder.query({ kind: "tool.call.failed" })).toEqual([]);
    expect(
      await recorder.query({ kind: "tool.call.completed" }),
    ).toHaveLength(1);
  });
});
