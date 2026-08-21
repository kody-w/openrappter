import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  formatProtectedHomes,
  launch,
  snapshotProtectedHomes,
} from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

function assertUnder(root, candidate) {
  const relative = path.relative(root, candidate);
  assert(
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`),
    `${candidate} must remain under ${root}`,
  );
}

frontierTest("boot owns an isolated kernel and leaves user homes unchanged", async () => {
  const before = snapshotProtectedHomes();
  let app = null;
  let routeUrl = null;
  try {
    app = await launch({
      occupyPort: 7071,
      scenario: "boot",
    });
    routeUrl = app.route.url;
    assert.equal(app.occupiedPort.port, 7071);
    assert.notEqual(new URL(routeUrl).port, "7071");
    assert.equal(app.health.status, "ok");
    assert.equal(app.health.model, "frontier-e2e-model");
    const healthGrail = realpathSync(app.health.brainstem_dir);
    assert.equal(
      process.platform === "win32" ? healthGrail.toLowerCase() : healthGrail,
      process.platform === "win32"
        ? app.realPaths.grail.toLowerCase()
        : app.realPaths.grail,
    );
    assert(app.health.agents.includes("ContextMemory"));

    for (const candidate of [
      app.paths.betaHome,
      app.paths.brainstemHome,
      app.paths.driverMetadata,
      app.paths.electronUserData,
      app.paths.grail,
      app.paths.lineageHome,
      app.paths.osHome,
      app.paths.stopFile,
      app.paths.trace,
    ]) {
      assertUnder(app.paths.root, candidate);
    }

    const telemetry = await app.driver.routeTelemetry();
    assert.equal(telemetry.active_route.url, routeUrl);
    assert(telemetry.events.some((event) => event.type === "worker-started"));
  } finally {
    await app?.stop();
  }

  await assert.rejects(
    fetch(`${routeUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
    }),
  );
  const after = snapshotProtectedHomes();
  assert.deepEqual(after, before);
  console.log(`PROTECTED_HOME_MTIMES_BEFORE=${formatProtectedHomes(before)}`);
  console.log(`PROTECTED_HOME_MTIMES_AFTER=${formatProtectedHomes(after)}`);
});
