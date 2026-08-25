#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  acquirePlanLock,
  SemanticTrace,
  SemanticUiPlanRunner,
  validateSemanticPlan,
} from "../electron/semantic-ui-plan.mjs";
import { scrubDiagnosticValue } from "../electron/log-redaction.mjs";

const require = createRequire(import.meta.url);
const BETA_ROOT = path.resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage: node scripts/frontier-ui.mjs --plan <plan.json> [launch options]",
    "",
    "Launch options:",
    "  --app <OpenRappter.app|executable>  Launch a packaged Frontier.",
    "  --source                           Launch this checkout with its locked Electron.",
    "  --brainstem-source <directory>     Grail source copied into the isolated home.",
    "  --metadata <ui-driver.json>        Connect to an already-running Frontier.",
    "  --home <directory>                 Isolated OpenRappter home (fresh by default).",
    "  --trace <trace.jsonl>              Redacted deterministic trace path.",
    "  --headless                         Hide the app window (use xvfb in CI instead when layout matters).",
    "  --keep-open                        Leave a launched app running after the plan.",
    "  --validate-only                    Validate without launching or connecting.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    app: null,
    brainstemSource: null,
    headless: false,
    home: null,
    keepOpen: false,
    metadata: null,
    plan: null,
    source: false,
    trace: null,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--source") options.source = true;
    else if (argument === "--headless") options.headless = true;
    else if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--validate-only") options.validateOnly = true;
    else if ([
      "--app",
      "--brainstem-source",
      "--home",
      "--metadata",
      "--plan",
      "--trace",
    ].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      options[argument.slice(2).replace("-source", "Source")] = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.plan) throw new Error("--plan is required.");
  const launchModes = [Boolean(options.app), options.source, Boolean(options.metadata)]
    .filter(Boolean).length;
  if (!options.validateOnly && launchModes !== 1) {
    throw new Error("Choose exactly one of --app, --source, or --metadata.");
  }
  return options;
}

function packagedExecutable(value) {
  const target = path.resolve(value);
  if (process.platform === "darwin" && target.endsWith(".app")) {
    const executable = path.join(target, "Contents", "MacOS", "OpenRappter");
    if (!existsSync(executable)) {
      throw new Error(`Packaged app executable is missing: ${executable}`);
    }
    return executable;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    throw new Error(`Packaged app executable is missing: ${target}`);
  }
  return target;
}

function sourceElectron() {
  let executable;
  try {
    executable = require("electron");
  } catch {
    throw new Error("Locked Electron is unavailable; run npm ci in beta/.");
  }
  if (typeof executable !== "string" || !existsSync(executable)) {
    throw new Error("Locked Electron executable is unavailable.");
  }
  return executable;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForMetadata(filePath, {
  launchedPid = null,
  timeoutMs = 120_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(readFileSync(filePath, "utf8"));
      if (
        metadata.host !== "127.0.0.1"
        || !Number.isInteger(metadata.port)
        || metadata.port < 1
        || metadata.port > 65535
        || typeof metadata.token !== "string"
        || metadata.token.length < 32
        || !Number.isInteger(metadata.pid)
        || !processAlive(metadata.pid)
        || metadata.semanticControl !== true
      ) {
        throw new Error("metadata is stale, malformed, or not in semantic-control mode");
      }
      if (launchedPid && metadata.pid !== launchedPid) {
        throw new Error("metadata belongs to a different app process");
      }
      return metadata;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for current UI driver metadata: ${String(last?.message || last)}.`,
  );
}

function createCommand(metadata) {
  const url = `http://127.0.0.1:${metadata.port}/v1/command`;
  return async (command) => {
    const response = await fetch(url, {
      body: JSON.stringify(command),
      headers: {
        authorization: ["Bearer", metadata.token].join(" "),
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(
        Math.max(5_000, Math.min(15 * 60_000, Number(command.timeoutMs) || 180_000)),
      ),
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `UI driver returned HTTP ${response.status}.`);
    }
    return payload.result;
  };
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function launch(options, home, metadataPath) {
  const source = options.source;
  const executable = source ? sourceElectron() : packagedExecutable(options.app);
  const stopFile = path.join(home, "control", "stop");
  const userData = path.join(home, "electron-user-data");
  mkdirSync(path.dirname(stopFile), { recursive: true, mode: 0o700 });
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  rmSync(stopFile, { force: true });
  const sourceGrail = options.brainstemSource
    || (source ? path.resolve(BETA_ROOT, "..", "rapp_brainstem") : null)
    || process.env.BRAINSTEM_BETA_SOURCE_DIR;
  if (!sourceGrail || !existsSync(path.join(sourceGrail, "brainstem.py"))) {
    throw new Error(
      "A packaged launch requires --brainstem-source pointing at a Grail runtime.",
    );
  }
  const isolatedGrail = path.join(home, "brainstem", "src", "rapp_brainstem");
  const excluded = new Set([
    ".brainstem_book.json",
    ".brainstem_data",
    ".brainstem_model",
    ".brainstem_secret",
    ".copilot_pending",
    ".copilot_session",
    ".copilot_token",
    ".env",
    ".pytest_cache",
    "__pycache__",
  ]);
  mkdirSync(path.dirname(isolatedGrail), { recursive: true, mode: 0o700 });
  cpSync(sourceGrail, isolatedGrail, {
    filter(candidate) {
      const relative = path.relative(sourceGrail, candidate);
      return !relative.split(path.sep).some((part) => (
        excluded.has(part) || part.endsWith(".pyc")
      ));
    },
    preserveTimestamps: true,
    recursive: true,
  });
  const args = [
    `--user-data-dir=${userData}`,
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...(source ? [BETA_ROOT] : []),
  ];
  const child = spawn(executable, args, {
    cwd: source ? BETA_ROOT : path.dirname(executable),
    env: {
      ...process.env,
      BRAINSTEM_BETA_E2E: "1",
      BRAINSTEM_BETA_E2E_STOP_FILE: stopFile,
      BRAINSTEM_BETA_HOME: path.join(home, "desktop"),
      BRAINSTEM_BETA_OWN_PORT: "1",
      BRAINSTEM_BETA_SOURCE_DIR: isolatedGrail,
      BRAINSTEM_BETA_UI_DRIVER_FILE: metadataPath,
      BRAINSTEM_HOME: path.join(home, "brainstem"),
      OPENRAPPTER_HOME: home,
      OPENRAPPTER_SEMANTIC_CONTROL: "1",
      ...(options.headless ? { BRAINSTEM_BETA_HEADLESS: "1" } : {}),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 64 * 1024) output = output.slice(-64 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return {
    child,
    output: () => output,
    async stop() {
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      if (await waitForExit(child)) return;
      child.kill("SIGTERM");
      if (await waitForExit(child, 5_000)) return;
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = validateSemanticPlan(JSON.parse(readFileSync(options.plan, "utf8")));
  if (options.validateOnly) {
    console.log(JSON.stringify({
      ok: true,
      actions: plan.actions.length,
      plan: plan.name,
      schema: plan.schema,
    }));
    return;
  }
  const runRoot = path.resolve(process.cwd(), ".openrappter-ui-runs");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const home = options.home || mkdtempSync(path.join(runRoot, "run-"));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const metadataPath = options.metadata
    || path.join(home, "desktop", "ui-driver.json");
  const tracePath = options.trace || path.join(home, "artifacts", "trace.jsonl");
  const releaseLock = acquirePlanLock(path.join(
    options.metadata ? path.dirname(metadataPath) : home,
    "semantic-plan.lock",
  ));
  const trace = new SemanticTrace({
    filePath: tracePath,
    roots: [home, process.cwd()],
  });
  let app = null;
  try {
    if (!options.metadata) app = launch(options, home, metadataPath);
    const metadata = await waitForMetadata(metadataPath, {
      launchedPid: app?.child.pid || null,
    });
    const runner = new SemanticUiPlanRunner({
      command: createCommand(metadata),
      record: (event) => trace.record(event),
    });
    const result = await runner.run(plan);
    const captures = result.results
      .filter((event) => event.action === "screenshot" && event.result?.path)
      .map((event) => event.result.path);
    console.log(JSON.stringify({
      ...scrubDiagnosticValue(result, { roots: [home, process.cwd()] }),
      artifacts: {
        captures,
        home,
        trace: tracePath,
      },
    }));
  } catch (error) {
    const details = scrubDiagnosticValue({
      error: String(error?.message || error),
      output: app?.output() || "",
      trace: tracePath,
    }, { roots: [home, process.cwd()] });
    console.error(JSON.stringify({ ok: false, ...details }));
    process.exitCode = 1;
  } finally {
    try {
      if (app && !options.keepOpen) await app.stop();
    } finally {
      releaseLock();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: scrubDiagnosticValue(
      String(error?.message || error),
      { roots: [process.cwd()] },
    ),
  }));
  process.exitCode = 1;
}
