import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";


const dirname = path.dirname(fileURLToPath(import.meta.url));
const brainstemHome = process.env.BRAINSTEM_HOME
  || path.join(homedir(), ".brainstem");
const driverFile = process.env.BRAINSTEM_BETA_UI_DRIVER_FILE
  || path.join(brainstemHome, "beta-launcher", "ui-driver.json");
const agentPath = path.join(dirname, "brainstem_ui_driver_agent.py");
const agentToolName = `BrainstemUiDriverE2E${process.pid}`;
const agentSource = readFileSync(agentPath, "utf8")
  .replaceAll("BrainstemUiDriver", agentToolName);
const marker = "BETA_UI_E2E_COMPLETE";
const timeoutMs = Number.parseInt(
  process.env.BRAINSTEM_BETA_E2E_TIMEOUT_MS || "300000",
  10,
);
const customTask = process.argv.slice(2).join(" ").trim();
const prompt = [
  "Run the OpenRappter update-control demonstration end to end.",
  "Use delegate_to_brainstem exactly once with the complete one-turn agent",
  "below as ephemeral_agent. Do not install it into a persistent stack.",
  "",
  `ephemeral_agent.filename: brainstem_ui_driver_e2e_agent.py`,
  "ephemeral_agent.source:",
  "```python",
  agentSource,
  "```",
  "",
  `In the Brainstem prompt, tell ${agentToolName} to:`,
  "1. start_recording;",
  "2. click #beta-app-btn and then #beta-check-updates;",
  "3. wait up to 60 seconds for #beta-update-status to leave idle/checking;",
  "4. read #beta-app-panel;",
  "5. stop_recording so the playable video and final screenshot are attached.",
  "Do not click Update and Restart.",
  customTask ? `Also satisfy this additional instruction: ${customTask}` : "",
  `When the visible result is verified, reply with ${marker} followed by the exact update status.`,
].filter(Boolean).join("\n");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function driverMetadata() {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(readFileSync(driverFile, "utf8"));
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
  throw new Error(
    `The beta UI driver did not become ready: ${
      lastError?.message || "timeout"
    }`,
  );
}

async function driverCommand(metadata, command) {
  const response = await fetch(
    `http://${metadata.host}:${metadata.port}/v1/command`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${metadata.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `UI driver HTTP ${response.status}`);
  }
  return payload.result;
}

async function main() {
  const metadata = await driverMetadata();
  await driverCommand(metadata, {
    action: "click",
    target: "shell",
    selector: "#enter",
    optional: true,
    label: "Entering the teaching workspace",
  });
  const result = await driverCommand(metadata, {
    action: "surgeon_chat",
    target: "shell",
    value: prompt,
    label: "Asking GitHub Copilot to drive the visible Brainstem",
    timeoutMs,
  });
  const screenshot = await driverCommand(metadata, {
    action: "screenshot",
    target: "shell",
  });
  const response = String(result?.response || "");
  const markerIndex = response.indexOf(marker);
  process.stdout.write(`${JSON.stringify({
    ok: markerIndex >= 0,
    result: markerIndex >= 0
      ? response.slice(markerIndex, markerIndex + 2000)
      : response.slice(-2000),
    screenshot: screenshot.path,
  }, null, 2)}\n`);
  if (markerIndex < 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
