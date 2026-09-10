import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

frontierTest("Teams controls use the real isolated shell and reject unrelated destinations before joining", async () => {
  const app = await launch({ scenario: "boot" });
  try {
    // Other live applications may append logs while this test runs.
    // Check the owned paths instead of requiring the host filesystem to freeze.
    for (const candidate of [
      app.paths.betaHome, app.paths.brainstemHome, app.paths.driverMetadata,
      app.paths.electronUserData, app.paths.grail, app.paths.stopFile,
    ]) {
      const relative = path.relative(app.paths.root, candidate);
      assert(relative && !path.isAbsolute(relative) && relative !== ".."
        && !relative.startsWith(`..${path.sep}`));
    }
    await app.driver.run([{
      action: "click",
      selector: "#teams-settings-open",
      settleMs: 50,
    }], { target: "shell" });
    await app.driver.expect({
      selector: "#teams-title",
      text: "Meet now in Teams",
      target: "shell",
    });
    await app.driver.run([{
      action: "type",
      selector: "#teams-url",
      value: "https://example.invalid/meet/123",
      typingDelayMs: 1,
    }, {
      action: "click",
      selector: "#teams-join",
      settleMs: 50,
    }], { target: "shell" });
    await app.driver.expect({
      selector: "#teams-error",
      text: "Use a teams.microsoft.com or teams.live.com meeting invitation.",
      target: "shell",
    });
    assert.equal(app.model.requests.length, 0, "invalid invitations must not invoke the model");
    await app.driver.run([{
      action: "click",
      selector: "#teams-close",
    }, {
      action: "click",
      selector: "#enter",
    }], { target: "shell" });
    await app.driver.run([{
      action: "click",
      selector: "#surgeon-close",
    }], { target: "shell" });
    await app.driver.expect({
      selector: "#surgeon-tab",
      text: "GitHub Copilot",
      target: "shell",
    });
  } finally {
    await app.stop();
  }
});
