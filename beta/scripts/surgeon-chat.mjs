import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(
    process.env.BRAINSTEM_HOME || path.join(homedir(), ".brainstem"),
    "beta-launcher",
  );
const metadataPath = process.env.BRAINSTEM_BETA_UI_DRIVER_FILE
  || path.join(betaHome, "ui-driver.json");
const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  process.stderr.write("Usage: brainstem-surgeon <task>\n");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBridge(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      const response = await fetch(
        `http://${metadata.host}:${metadata.port}/v1/command`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${metadata.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "inspect",
            target: "shell",
            limit: 1,
          }),
        },
      );
      if (response.ok) return metadata;
      lastError = new Error(`UI bridge HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`RAPP Brainstem Frontier is not ready: ${lastError?.message || "timeout"}`);
}

function launchBeta() {
  const configured = process.env.BRAINSTEM_BETA_LAUNCHER;
  const launcher = configured || path.join(
    betaHome,
    process.platform === "win32" ? "launch.cmd" : "launch.sh",
  );
  if (!existsSync(launcher)) {
    throw new Error(
      `RAPP Brainstem Frontier is closed and its launcher is missing at ${launcher}.`,
    );
  }
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/c", launcher], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    : spawn(launcher, [], {
        detached: true,
        stdio: "ignore",
      });
  child.unref();
}

async function main() {
  let metadata;
  try {
    metadata = await waitForBridge(1000);
  } catch {
    launchBeta();
    metadata = await waitForBridge();
  }
  const response = await fetch(
    `http://${metadata.host}:${metadata.port}/v1/command`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${metadata.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "surgeon_chat",
        target: "shell",
        value: prompt,
        timeoutMs: 60 * 60 * 1000,
      }),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Brain Surgeon HTTP ${response.status}`);
  }
  process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
