#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [electron, home, runtime, python, resultFile] = process.argv.slice(2);
if (![electron, home, runtime, python, resultFile].every(Boolean)) {
  throw new Error("Package hatch proof requires electron, home, runtime, python, and result paths.");
}
const cli = path.join(import.meta.dirname, "openrappter-hatch.mjs");
const name = "package-neighbor";

function command(action) {
  const result = spawnSync(process.execPath, [
    cli,
    action,
    name,
    "--runtime",
    runtime,
    "--python",
    python,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRAPPTER_ELECTRON: electron,
      OPENRAPPTER_HOME: home,
    },
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${action} exited ${result.status}.`,
    );
  }
  return JSON.parse(result.stdout);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || ""}`);
}

let hatch;
try {
  hatch = command("hatch");
  const endpointFile = path.join(hatch.beta_home, "chat-endpoint.json");
  const endpoint = await waitFor(async () => {
    if (!existsSync(endpointFile)) return null;
    const value = JSON.parse(readFileSync(endpointFile, "utf8"));
    const response = await fetch(value.url.replace(/\/chat$/, "/health"), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health.status === "ready" ? value : null;
  }, "hatched neighborhood readiness");
  if (
    endpoint.neighborhood_id !== hatch.neighborhood_id
    || endpoint.dock_visible !== true
    || !endpoint.app_name.includes("Package Neighbor")
    || hatch.python === python
    || statSync(hatch.python).ino === statSync(python).ino
  ) {
    throw new Error("Packaged hatch identity or Python isolation is incomplete.");
  }
  const stopped = command("stop");
  if (!stopped.stopped) throw new Error("Packaged hatch capability stop failed.");
  await waitFor(() => !alive(hatch.pid), "hatched process exit", 20_000);
  const proof = {
    schema: "openrappter-package-hatch-proof/1.0",
    app_name: endpoint.app_name,
    dock_visible: endpoint.dock_visible,
    neighborhood_id: endpoint.neighborhood_id,
    parent_neighborhood_id: hatch.parent_neighborhood_id,
    generation: hatch.generation,
    rappid: hatch.instance_rappid,
    python_owned: true,
    capability_stop: true,
    process_exited: true,
  };
  writeFileSync(resultFile, `${JSON.stringify(proof, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
} catch (error) {
  if (hatch?.pid && alive(hatch.pid)) {
    try {
      command("stop");
    } catch {}
  }
  throw error;
}
