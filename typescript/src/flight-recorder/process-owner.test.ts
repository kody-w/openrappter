import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRecorderResetBarrier,
  CURRENT_PROCESS_INCARNATION,
  listLiveRecorderOwners,
  recorderOwnerDirectory,
  recorderResetLockPath,
  processMatchesIncarnation,
  registerRecorderOwner,
  unregisterRecorderOwner,
} from "./process-owner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "flight-owner-"));
  roots.push(root);
  return path.join(root, "flight.db");
}

describe("Flight Recorder process ownership", () => {
  it("reclaims a reset barrier owned by a dead process", () => {
    const database = databasePath();
    writeFileSync(recorderResetLockPath(database), "2147483647\n");

    const owner = registerRecorderOwner(database, "owner-a");
    expect(owner).toContain("owner-a.json");
    unregisterRecorderOwner(owner);
  });

  it("fails closed when the owner directory cannot be inspected", () => {
    const database = databasePath();
    writeFileSync(recorderOwnerDirectory(database), "not-a-directory");

    expect(() => listLiveRecorderOwners(database)).toThrow();
  });

  it("fails closed on a malformed owner entry", () => {
    const database = databasePath();
    const directory = recorderOwnerDirectory(database);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "partial.json"), "");

    expect(() => listLiveRecorderOwners(database)).toThrow(
      /cannot be inspected/i,
    );
  });

  it("reclaims an owner file after PID reuse with a different incarnation", () => {
    const database = databasePath();
    const directory = recorderOwnerDirectory(database);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "reused.json"),
      `${JSON.stringify({
        pid: process.pid,
        incarnation: "different-process-start",
      })}\n`,
    );

    expect(listLiveRecorderOwners(database)).toEqual([]);
  });

  it("uses a timezone-invariant current process incarnation", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(
        processMatchesIncarnation(
          process.pid,
          CURRENT_PROCESS_INCARNATION,
        ),
      ).toBe(true);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("treats a live PID with unavailable incarnation as active", () => {
    expect(processMatchesIncarnation(process.pid, undefined)).toBe(true);
  });

  it("fails closed when a recorded incarnation cannot be read for a live PID", () => {
    expect(
      processMatchesIncarnation(
        process.pid,
        "different-process-start",
        () => null,
      ),
    ).toBe(false);
  });

  it("does not reclaim a reset barrier owned by this live process", () => {
    const database = databasePath();
    mkdirSync(path.dirname(database), { recursive: true });
    writeFileSync(recorderResetLockPath(database), `${process.pid}\n`);

    expect(() => acquireRecorderResetBarrier(database)).toThrow(
      /reset is in progress/i,
    );
  });

  it("releases only the barrier nonce it acquired", () => {
    const database = databasePath();
    const release = acquireRecorderResetBarrier(database);
    writeFileSync(
      recorderResetLockPath(database),
      `${JSON.stringify({ pid: process.pid, nonce: "replacement" })}\n`,
    );

    release();
    expect(existsSync(recorderResetLockPath(database))).toBe(true);
  });
});
