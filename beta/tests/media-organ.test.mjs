import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MEDIA_ORGAN, probeMediaOrgan } from "../electron/video-tools.mjs";

// Article II: an organ is installed only on first enable, after a prompt naming
// what will be installed. The recording path used to reach straight for ffmpeg
// and let a raw spawn error stand in for that conversation.

test("a present organ probes clean", () => {
  const result = probeMediaOrgan({}, { run: () => ({ status: 0 }) });
  assert.equal(result.ok, true);
  assert.equal(result.organ, MEDIA_ORGAN.organ);
  assert.ok(result.executable, "the resolved executable is reported");
});

test("an absent organ reports what is missing, not a spawn failure", () => {
  const missing = probeMediaOrgan({}, {
    run: () => ({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.organ, "showtime-media");
  assert.equal(missing.name, MEDIA_ORGAN.name);
  assert.match(missing.detail, /ffmpeg/);
  assert.equal(missing.prefix, "organs/showtime-media");
  assert.equal(missing.reason, "ENOENT");
  // No organ catalog is published, so a size cannot be claimed honestly.
  assert.equal(missing.sizeBytes, null);
});

test("a present-but-unrunnable organ is also treated as absent", () => {
  // Present on disk and not executable is the same outcome for the person.
  const blocked = probeMediaOrgan({}, { run: () => ({ status: 126 }) });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /126/);
  const killed = probeMediaOrgan({}, { run: () => ({ status: null }) });
  assert.equal(killed.ok, false);
  assert.match(killed.reason, /signal/);
});

test("a throwing runner does not escape the probe", () => {
  const thrown = probeMediaOrgan({}, {
    run: () => { throw Object.assign(new Error("boom"), { code: "EPERM" }); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, "EPERM");
});

test("recording refuses before spawning when the organ is absent", () => {
  const driver = readFileSync(
    new URL("../electron/ui-driver-server.mjs", import.meta.url),
    "utf8",
  );
  const probeAt = driver.indexOf("probeMediaOrgan(env)");
  const spawnAt = driver.indexOf("const child = spawn(");
  assert.ok(probeAt > 0 && spawnAt > 0, "both the probe and the spawn must exist");
  assert.ok(
    probeAt < spawnAt,
    "the probe must run before the spawn, or the failure is a spawn error again",
  );
  assert.match(driver, /MediaOrganUnavailableError/);
});
