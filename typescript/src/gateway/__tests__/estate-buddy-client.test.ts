import { describe, expect, it, vi } from "vitest";
import {
  createEstateCommandRunner,
  EstateBuddyClient,
  type EstateCommandRunner,
} from "../estate-buddy-client.js";

function receipt(value: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...value });
}

describe("EstateBuddyClient", () => {
  it("lists buddies through the central manifest without stdin", async () => {
    const runner = vi.fn<EstateCommandRunner>().mockResolvedValue(
      receipt({
        estate: "Test Estate",
        devices: ["local"],
        buddies: [
          {
            id: "barry",
            name: "Barry",
            device: "local",
            rappid: null,
            presence: "online",
            status: "ready",
            transport: "local",
            via_probe: false,
          },
        ],
      }),
    );
    const client = new EstateBuddyClient({
      manifest: "/private/estate.json",
      runner,
    });

    const result = await client.list();

    expect(result.buddies[0].name).toBe("Barry");
    expect(runner).toHaveBeenCalledWith(
      ["estate", "buddy", "list", "/private/estate.json"],
      undefined,
      10 * 60_000,
    );
  });

  it("streams chat text through stdin instead of process arguments", async () => {
    const runner = vi.fn<EstateCommandRunner>().mockResolvedValue(
      receipt({
        buddy: {
          id: "barry",
          name: "Barry",
          device: "local",
          rappid: null,
          presence: "online",
          status: "ready",
          transport: "local",
          via_probe: false,
        },
        response: "Barry READY",
        session_id: "session-1",
      }),
    );
    const client = new EstateBuddyClient({
      manifest: "/private/estate.json",
      runner,
    });

    const result = await client.chat({
      buddyId: "barry",
      message: "private estate message",
    });

    expect(result.response).toBe("Barry READY");
    const [args, input] = runner.mock.calls[0];
    expect(args).toEqual([
      "estate",
      "buddy",
      "chat",
      "/private/estate.json",
      "--stdin",
    ]);
    expect(args.join(" ")).not.toContain("private estate message");
    expect(JSON.parse(input!)).toEqual({
      buddy_id: "barry",
      message: "private estate message",
    });
  });

  it("reports a create only after Herdr verifies online presence", async () => {
    const runner = vi
      .fn<EstateCommandRunner>()
      .mockResolvedValueOnce(
        receipt({
          device: "rappter-two",
          presence: "online",
          created: {
            name: "Map Maker",
            rappid: "rappid:@test/map-maker:" + "a".repeat(64),
            ui: "rapplication",
          },
          handshake: {
            ready: true,
            response: "Map Maker READY",
          },
        }),
      )
      .mockResolvedValueOnce(
        receipt({
          device: "rappter-two",
          presence: "offline",
        }),
      );
    const client = new EstateBuddyClient({ runner });

    await expect(
      client.create({
        deviceId: "rappter-two",
        name: "Map Maker",
        role: "Build a visual estate map.",
        ui: "rapplication",
      }),
    ).resolves.toMatchObject({
      presence: "online",
      created: { name: "Map Maker" },
    });
    await expect(
      client.create({
        deviceId: "rappter-two",
        name: "Ghost",
        role: "Never answers.",
      }),
    ).rejects.toThrow("did not verify");
  });

  it("surfaces failed and malformed receipts instead of shaping success", async () => {
    const failed = new EstateBuddyClient({
      runner: vi
        .fn<EstateCommandRunner>()
        .mockResolvedValue(
          JSON.stringify({ ok: false, error: "target did not answer" }),
        ),
    });
    await expect(failed.list()).rejects.toThrow("target did not answer");

    const malformed = new EstateBuddyClient({
      runner: vi.fn<EstateCommandRunner>().mockResolvedValue("{}"),
    });
    await expect(malformed.list()).rejects.toThrow(
      "invalid buddy list receipt",
    );
  });

  it("handles a child closing before stdin is consumed", async () => {
    const run = createEstateCommandRunner(process.execPath);

    await expect(
      run(
        ["-e", "process.exit(1)"],
        "private request".repeat(10_000),
        5_000,
      ),
    ).rejects.toThrow(/RAPP-Herdr|send request/);
  });
});
