import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CopilotStudioAuthManager,
  readDeploymentDefaults,
  resolvePacExecutable,
} from "../electron/copilot-studio-auth.mjs";


test("deployment defaults return no client secret", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-copilot-settings-"));
  try {
    const settings = path.join(root, "local.settings.json");
    writeFileSync(settings, JSON.stringify({
      Values: {
        ASSISTANT_NAME: "RAPP Agent",
        DYNAMICS_365_CLIENT_ID: "client",
        DYNAMICS_365_CLIENT_SECRET: "do-not-return",
        DYNAMICS_365_RESOURCE: "https://example.crm.dynamics.com",
        DYNAMICS_365_TENANT_ID: "tenant",
      },
    }));
    const result = readDeploymentDefaults(settings);
    assert.equal(result.environment_url, "https://example.crm.dynamics.com");
    assert.equal(result.secret_present, true);
    assert.equal(JSON.stringify(result).includes("do-not-return"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth status reports PAC profiles and active environment", async () => {
  const manager = new CopilotStudioAuthManager({
    pacExecutable: "/tmp/pac",
  });
  manager.runPac = async (args) => (
    args[1] === "list" ? "profiles" : "active environment"
  );
  assert.deepEqual(await manager.status(), {
    pac: "/tmp/pac",
    profiles: "profiles",
    active: "active environment",
  });
});

test("explicit PAC executable wins", () => {
  assert.equal(
    resolvePacExecutable({ BRAINSTEM_BETA_PAC: process.execPath }),
    process.execPath,
  );
});
