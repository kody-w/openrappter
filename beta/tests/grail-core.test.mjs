import assert from "node:assert/strict";
import { describe, it } from "node:test";

await import("../ui/grail-core.js");

const {
  MAX_MEDIA_BYTES,
  LivingCompanyWeek,
  classifyMedia,
  createSemanticController,
  reviewImmutablePayload,
  truthfulUnavailable,
} = globalThis.OpenRappterGrailCore;

describe("Frontier Grail core", () => {
  it("runs deterministic Living Company Week with zero side effects", () => {
    const first = new LivingCompanyWeek();
    const completed = first.run();
    assert.equal(completed.status, "completed");
    assert.equal(completed.externalSideEffects, 0);
    assert.equal(completed.sends, 0);
    assert.equal(completed.publishes, 0);
    assert.equal(completed.submissions, 0);
    assert.equal(completed.ledger.length, 5);
    assert.ok(completed.ledger.every((entry) => entry.redacted === true));
    assert.ok(completed.drafts.every((draft) => draft.private === true));
    assert.ok(completed.drafts.some((draft) => draft.status === "review-ready"));

    first.reset();
    assert.deepEqual(first.run(), completed);
  });

  it("classifies exact 100MB and adjacent media states", () => {
    assert.equal(classifyMedia(null).state, "error");
    assert.equal(classifyMedia({
      name: "exact.mp4",
      size: MAX_MEDIA_BYTES,
      type: "video/mp4",
    }).state, "ingesting");
    assert.equal(classifyMedia({
      name: "large.mp4",
      size: MAX_MEDIA_BYTES + 1,
      type: "video/mp4",
    }).state, "too-large");
    assert.equal(classifyMedia({
      name: "archive.zip",
      size: 100,
      type: "application/zip",
    }).state, "unsupported");
  });

  it("binds immutable approval review to action, payload, and base", async () => {
    const reviewed = await reviewImmutablePayload(
      "config.set",
      { raw: "port: 18790\n" },
      "base-a",
    );
    assert.equal(Object.isFrozen(reviewed), true);
    assert.match(reviewed.payloadHash, /^[a-f0-9]{64}$/);
    assert.notEqual(
      (await reviewImmutablePayload(
        "config.set",
        { raw: "port: 1\n" },
        "base-a",
      )).payloadHash,
      reviewed.payloadHash,
    );
    assert.notEqual(
      (await reviewImmutablePayload(
        "config.set",
        { raw: "port: 18790\n" },
        "base-b",
      )).payloadHash,
      reviewed.payloadHash,
    );
  });

  it("exposes semantic snapshot/open but no authority actions", async () => {
    let activeSurface = null;
    const controller = createSemanticController(
      ["health", "living-company"],
      () => ({ activeSurface }),
      async (surface) => {
        activeSurface = surface;
      },
    );
    assert.deepEqual(Object.keys(controller).sort(), ["open", "snapshot"]);
    assert.deepEqual(await controller.open("health"), {
      activeSurface: "health",
    });
    await assert.rejects(() => controller.open("shell"), /Unknown Grail surface/);
    for (const forbidden of [
      "approve",
      "send",
      "publish",
      "submit",
      "shell",
      "import",
    ]) {
      assert.equal(controller[forbidden], undefined);
    }
  });

  it("returns explicit unavailable state rather than fake readiness", () => {
    assert.deepEqual(
      truthfulUnavailable("release ring", "adapter pending"),
      {
        status: "unavailable",
        name: "release ring",
        reason: "adapter pending",
      },
    );
  });
});
