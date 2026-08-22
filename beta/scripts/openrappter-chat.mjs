#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const openRappterHome = process.env.OPENRAPPTER_HOME
  || path.join(homedir(), ".openrappter");
const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(openRappterHome, "desktop");
const metadataPath = process.env.OPENRAPPTER_CHAT_ENDPOINT_FILE
  || path.join(betaHome, "chat-endpoint.json");
const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  process.stderr.write("Usage: openrappter-chat <message>\n");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchOpenRappter() {
  const launcher = process.env.BRAINSTEM_BETA_LAUNCHER || path.join(
    betaHome,
    process.platform === "win32" ? "launch.cmd" : "launch.sh",
  );
  if (!existsSync(launcher)) {
    throw new Error(`OpenRappter launcher is missing at ${launcher}.`);
  }
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/c", launcher], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    : spawn(launcher, [], { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (
        metadata.schema !== "openrappter-chat-endpoint/1.0"
        || !/^http:\/\/127\.0\.0\.1:\d+\/chat$/.test(metadata.url)
      ) {
        throw new Error("invalid endpoint metadata");
      }
      const probe = await fetch(metadata.url, {
        signal: AbortSignal.timeout(1_500),
      });
      if (probe.status === 405) return metadata;
      lastError = new Error(`OpenRappter /chat probe HTTP ${probe.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`OpenRappter /chat is not ready: ${lastError?.message || "timeout"}`);
}

async function main() {
  let metadata;
  try {
    metadata = await waitForEndpoint(1_000);
  } catch {
    launchOpenRappter();
    metadata = await waitForEndpoint(60_000);
  }
  const response = await fetch(metadata.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_input: prompt,
      conversation_history: [],
    }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const body = await response.text();
  process.stdout.write(`${body}\n`);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
