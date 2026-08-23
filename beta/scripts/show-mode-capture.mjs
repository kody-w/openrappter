// Drive the Show Mode click-through inside the running OpenRappter
// window through the token-authenticated UI driver bridge, and save one
// screenshot per step. This is how an AI (or CI) exercises the click-through
// exactly as a person clicking Next would see it, and how the README images
// are produced.
//
//   node scripts/show-mode-capture.mjs [--out docs/show-mode] [--pace 900]
//                                      [--force] [--keep-open] [--from <step>]
//
// Requires OpenRappter to be open (it will launch it through the beta launcher if
// not). Copilot sign-in is NOT required: the bridge drives the shell directly.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const betaRoot = path.resolve(here, "..");
const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(process.env.BRAINSTEM_HOME || path.join(homedir(), ".brainstem"), "beta-launcher");
const metadataPath = process.env.BRAINSTEM_BETA_UI_DRIVER_FILE || path.join(betaHome, "ui-driver.json");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const outDir = path.resolve(betaRoot, flag("--out", "docs/show-mode"));
const paceMs = Math.max(200, Number(flag("--pace", 900)) || 900);
const fromStep = flag("--from", "");
const withForce = args.includes("--force");
const keepOpen = args.includes("--keep-open");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bridge(metadata, command) {
  const response = await fetch(`http://${metadata.host}:${metadata.port}/v1/command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${metadata.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `UI bridge HTTP ${response.status}`);
  return payload.result;
}

async function waitForBridge(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      await bridge(metadata, { action: "inspect", target: "shell", limit: 1 });
      return metadata;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`OpenRappter is not ready: ${lastError?.message || "timeout"}`);
}

function launchBeta() {
  const launcher = process.env.BRAINSTEM_BETA_LAUNCHER
    || path.join(betaHome, process.platform === "win32" ? "launch.cmd" : "launch.sh");
  if (!existsSync(launcher)) throw new Error(`OpenRappter is closed and its launcher is missing at ${launcher}.`);
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/c", launcher], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(launcher, [], { detached: true, stdio: "ignore" });
  child.unref();
}

async function main() {
  let metadata;
  try {
    metadata = await waitForBridge(1500);
  } catch {
    launchBeta();
    metadata = await waitForBridge();
  }
  const status = await bridge(metadata, { action: "tour", value: "status" });
  if (!status?.available) throw new Error(status?.error || "Show Mode click-through is not loaded in the OpenRappter window.");
  const steps = status.steps;
  const startIndex = fromStep ? Math.max(0, steps.indexOf(fromStep)) : 0;
  mkdirSync(outDir, { recursive: true });
  // README/training screenshots are for people following along who are NOT in
  // force mode, so the banner must be off unless this capture explicitly opts in
  // with --force. Clear any leftover force state from a previous run first.
  await bridge(metadata, { action: "force_mode", value: withForce ? "on" : "off",
    ...(withForce ? { label: "AI force mode · walking the Show Mode click-through" } : {}) });
  const shots = [];
  try {
    for (let index = startIndex; index < steps.length; index += 1) {
      const state = await bridge(metadata, {
        action: "tour", value: "goto", step: index, settleMs: 850,
        ...(withForce ? { forceMode: true } : {}),
      });
      if (!state?.running) throw new Error(`Tour did not reach step ${steps[index]}.`);
      await sleep(paceMs);
      const shot = await bridge(metadata, { action: "screenshot" });
      const screenshot = shot.screenshot || shot;
      const name = `step-${String(index + 1).padStart(2, "0")}-${steps[index]}.png`;
      const target = path.join(outDir, name);
      copyFileSync(screenshot.path, target);
      shots.push({ index, id: steps[index], file: name, source: screenshot.path });
      process.stdout.write(`captured ${index + 1}/${steps.length} ${steps[index]} → ${path.relative(betaRoot, target)}\n`);
    }
  } finally {
    if (!keepOpen) await bridge(metadata, { action: "tour", value: "stop" }).catch(() => {});
    if (withForce) await bridge(metadata, { action: "force_mode", value: "off" }).catch(() => {});
  }
  const index = {
    version: 1,
    generated_utc: new Date().toISOString(),
    pace_ms: paceMs,
    force_mode: withForce,
    steps: shots,
    note: "Preview only: ghost content over the real panes; nothing recorded, analyzed, hotloaded, or sent.",
  };
  writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(betaRoot, path.join(outDir, "index.json"))} (${shots.length} steps)\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
