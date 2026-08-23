import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openAmbient } from "../electron/ambient.mjs";
import {
  readAmbientSettings,
  writeAmbientSettings,
} from "../electron/chat-look-settings.mjs";
import {
  openLedger,
  recordCompletedTurn,
} from "../electron/ledger.mjs";
import { RappStoreClient, STORE_SCHEMA } from "../electron/rapp-store.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";


const betaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(betaRoot, "..");
const pristineGrail = path.join(repositoryRoot, "rapp_brainstem");
const fixturesRoot = path.join(betaRoot, "tests", "fixtures", "agents");
const scratchRoot = mkdtempSync(
  path.join(tmpdir(), "rapp-data-sloshing-proof-"),
);
const scratchHome = path.join(scratchRoot, "home");
const betaHome = path.join(scratchRoot, "beta-home");
const lineageRoot = path.join(scratchRoot, "lineage");
const grailDirectory = path.join(scratchRoot, "rapp_brainstem");
const fakeGithubToken = "frontier-data-sloshing-proof";
const proofLocation = {
  accuracy_m: 0,
  label: "proof location",
  lat: 47.6062,
  lon: -122.3321,
};
const credentialProbe = "ghp_DataSloshingProofToken1234567890";  // rapp-keyring: allow synthetic fixture — this value exists to prove it gets redacted
const rows = [];
const previousEnvironment = new Map();
const modelState = {
  errors: [],
  ledgerSystem: null,
  pinArgs: null,
  requests: [],
  weatherArgs: null,
  weatherSystem: null,
};
const ignoredGrailEntries = new Set([
  ".brainstem_book.json",
  ".brainstem_data",
  ".brainstem_model",
  ".brainstem_secret",
  ".copilot_pending",
  ".copilot_session",
  ".copilot_token",
  ".env",
  ".pytest_cache",
  ".remote_agents",
  ".repos.json",
  "__pycache__",
  "voice.zip",
]);
let failed = false;
let fixtureServer = null;
let manager = null;
let ledger = null;

function printable(value) {
  return String(value ?? "")
    .replaceAll("|", "/")
    .replaceAll("\n", " ");
}

async function step(name, run) {
  try {
    const outcome = await run();
    const pass = outcome === true || outcome?.pass === true;
    rows.push({
      name,
      result: pass ? "PASS" : "FAIL",
      detail: outcome && typeof outcome === "object" ? outcome.detail : "",
    });
    if (!pass) failed = true;
    return outcome?.value;
  } catch (error) {
    failed = true;
    rows.push({
      name,
      result: "FAIL",
      detail: String(error?.stack || error?.message || error),
    });
    return undefined;
  }
}

function printTable() {
  console.log("| Check | Result | Detail |");
  console.log("|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${printable(row.name)} | ${row.result} | ${printable(row.detail)} |`,
    );
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolvePython() {
  const candidates = [
    process.env.BRAINSTEM_BETA_PYTHON,
    path.join(homedir(), ".brainstem", "venv", "bin", "python"),
    path.join(homedir(), ".brainstem", "venv", "Scripts", "python.exe"),
    process.env.PYTHON,
    process.platform === "win32" ? "python" : "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const probe = spawnSync(
      candidate,
      ["-c", "import flask, requests, sys; print(sys.executable)"],
      { encoding: "utf8", windowsHide: true },
    );
    if (probe.status === 0) {
      return String(probe.stdout || "").trim() || candidate;
    }
  }
  throw new Error("A Python environment with Flask and requests is required.");
}

function setProofEnvironment(values) {
  for (const [key, value] of Object.entries(values)) {
    previousEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
}

function restoreEnvironment() {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

}

function copyPristineGrail() {
  cpSync(pristineGrail, grailDirectory, {
    recursive: true,
    filter(source) {
      const relative = path.relative(pristineGrail, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      return !parts.some((part) => (
        ignoredGrailEntries.has(part)
        || part.endsWith(".pyc")
      ));
    },
  });
}

function latestMessage(messages, role) {
  return [...messages].reverse().find((message) => message.role === role) || null;
}

function sloshedCoordinates(systemContent) {
  const match = String(systemContent || "").match(
    /lat (-?\d+(?:\.\d+)?), lon (-?\d+(?:\.\d+)?)/,
  );
  if (!match) {
    throw new Error("Scripted model did not receive sloshed coordinates.");
  }
  return {
    lat: Number(match[1]),
    lon: Number(match[2]),
  };
}

function completion(message, finishReason = "stop") {
  return {
    id: `proof-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4o",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
  };
}

function toolCompletion(name, args, id) {
  return completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    }],
  }, "tool_calls");
}

async function readRequestJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new Error("Replay request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
  });
  response.end(bytes);
}

function scriptedCompletion(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = latestMessage(messages, "system")?.content || "";
  const user = latestMessage(messages, "user")?.content || "";
  const last = messages.at(-1) || {};
  const tools = new Set(
    (body.tools || []).map((tool) => tool?.function?.name).filter(Boolean),
  );
  modelState.requests.push({
    lastRole: last.role,
    tools: [...tools],
    user,
  });

  if (/what's the weather here/i.test(user)) {
    if (last.role === "tool" && last.name === "WeatherAgent") {
      return completion({
        role: "assistant",
        content: `WeatherAgent reported ${last.content}. No clarification was needed.`,
      });
    }
    if (!tools.has("WeatherAgent")) {
      throw new Error("WeatherAgent was not offered to the scripted model.");
    }
    modelState.weatherSystem = system;
    modelState.weatherArgs = sloshedCoordinates(system);
    return toolCompletion(
      "WeatherAgent",
      modelState.weatherArgs,
      "proof-weather-call",
    );
  }

  if (/drop a pin here for Kody/i.test(user)) {
    if (last.role === "tool" && last.name === "PinDropAgent") {
      return completion({
        role: "assistant",
        content: `PinDropAgent confirmed ${last.content}.`,
      });
    }
    if (!tools.has("PinDropAgent")) {
      throw new Error("PinDropAgent was not offered to the scripted model.");
    }
    modelState.pinArgs = {
      to: "Kody",
      ...sloshedCoordinates(system),
    };
    return toolCompletion(
      "PinDropAgent",
      modelState.pinArgs,
      "proof-pin-call",
    );
  }

  if (/how did I build the weather agent/i.test(user)) {
    modelState.ledgerSystem = system;
    if (
      !system.includes("<ledger>")
      || !system.includes("installed WeatherAgent")
      || !system.includes("from store")
    ) {
      throw new Error("Scripted model did not receive the weather install ledger row.");
    }
    return completion({
      role: "assistant",
      content: (
        "The ledger row says installed WeatherAgent from store. "
        + "Use its sqlite3 agents query to inspect the cached source path."
      ),
    });
  }

  if (/credential redaction probe/i.test(user)) {
    return completion({
      role: "assistant",
      content: "Credential redaction probe completed.",
    });
  }

  throw new Error(`Unexpected scripted-model prompt: ${user}`);
}

async function startFixtureServer(weatherSource, pinSource) {
  const singleton = new Map([
    ["/agents/weather_agent.py", Buffer.from(weatherSource)],
    ["/agents/pin_drop_agent.py", Buffer.from(pinSource)],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/model/models") {
        sendJson(response, 200, {
          data: [{
            id: "gpt-4o",
            name: "Scripted GPT-4o",
            capabilities: { type: "chat" },
            supported_endpoints: ["/chat/completions"],
          }],
        });
        return;
      }
      if (
        request.method === "POST"
        && url.pathname === "/model/chat/completions"
      ) {
        const body = await readRequestJson(request);
        sendJson(response, 200, scriptedCompletion(body));
        return;
      }
      if (request.method === "GET" && url.pathname === "/catalog/index.json") {
        const origin = `http://127.0.0.1:${server.address().port}`;
        sendJson(response, 200, {
          schema: STORE_SCHEMA,
          generated_at: new Date().toISOString(),
          rapplications: [
            {
              id: "weather",
              name: "Weather fixture",
              version: "1.0.0",
              singleton_filename: "weather_agent.py",
              singleton_url: `${origin}/agents/weather_agent.py`,
              singleton_sha256: sha256(singleton.get("/agents/weather_agent.py")),
              singleton_bytes: singleton.get("/agents/weather_agent.py").length,
              license: "test-only",
            },
            {
              id: "pin-drop",
              name: "Pin drop fixture",
              version: "1.0.0",
              singleton_filename: "pin_drop_agent.py",
              singleton_url: `${origin}/agents/pin_drop_agent.py`,
              singleton_sha256: sha256(singleton.get("/agents/pin_drop_agent.py")),
              singleton_bytes: singleton.get("/agents/pin_drop_agent.py").length,
              license: "test-only",
            },
          ],
        });
        return;
      }
      if (request.method === "GET" && singleton.has(url.pathname)) {
        const bytes = singleton.get(url.pathname);
        response.writeHead(200, {
          "Content-Type": "text/x-python",
          "Content-Length": bytes.length,
        });
        response.end(bytes);
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      modelState.errors.push(String(error?.stack || error));
      sendJson(response, 500, { error: String(error?.message || error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function stopServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function postChat(route, prompt, history, sessionId) {
  const response = await fetch(`${route.url}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_input: prompt,
      conversation_history: history,
      session_id: sessionId,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Brainstem returned HTTP ${response.status}.`);
  }
  recordCompletedTurn(ledger, {
    agentLogs: data.agent_logs,
    model: data.model,
    requestId: randomUUID(),
    response: data.response,
    sessionId: data.session_id || sessionId,
    surface: "brainstem",
    userInput: prompt,
  });
  history.push(
    { role: "user", content: prompt },
    { role: "assistant", content: data.response },
  );
  return data;
}

let sqliteOutput = "";
let grepOutput = "";
try {
  const python = resolvePython();
  await step("preflight: real Grail, Python, sqlite3, and grep", () => {
    const sqlite = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
    const grep = spawnSync("grep", ["--version"], { encoding: "utf8" });
    return {
      pass: existsSync(path.join(pristineGrail, "brainstem.py"))
        && existsSync(path.join(fixturesRoot, "weather_agent.py"))
        && existsSync(path.join(fixturesRoot, "pin_drop_agent.py"))
        && sqlite.status === 0
        && grep.status === 0,
      detail: `python=${python}; sqlite3=${sqlite.status}; grep=${grep.status}`,
    };
  });

  mkdirSync(scratchHome, { recursive: true });
  copyPristineGrail();
  const weatherSource = readFileSync(
    path.join(fixturesRoot, "weather_agent.py"),
    "utf8",
  );
  const pinSource = readFileSync(
    path.join(fixturesRoot, "pin_drop_agent.py"),
    "utf8",
  );
  fixtureServer = await startFixtureServer(weatherSource, pinSource);
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  writeFileSync(
    path.join(grailDirectory, ".copilot_session"),
    JSON.stringify({
      token: "proof-copilot-token",
      endpoint: `${fixtureOrigin}/model`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      github_token_fingerprint: sha256(Buffer.from(fakeGithubToken)),
    }),
    { mode: 0o600 },
  );
  setProofEnvironment({
    BRAINSTEM_HOME: path.join(scratchHome, ".brainstem"),
    BRAINSTEM_LAN_MODE: "0",
    GH_CONFIG_DIR: path.join(scratchHome, ".config", "gh"),
    GITHUB_MODEL: "gpt-4o",
    GITHUB_TOKEN: fakeGithubToken,
    HOME: scratchHome,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    PIP_CACHE_DIR: path.join(scratchHome, ".cache", "pip"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INDEX: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    RAPP_AMBIENT_DEVICE: "1",
    RAPP_AMBIENT_DIR: path.join(betaHome, "ambient"),
    RAPP_LINEAGE_ENV: "default",
    RAPP_MOLT_LINEAGE: "1",
    SOUL_PATH: path.join(grailDirectory, "soul.md"),
    VOICE_MODE: "0",
    XDG_CONFIG_HOME: path.join(scratchHome, ".config"),
  });

  ledger = openLedger(betaHome);
  const ambient = openAmbient(betaHome);
  writeAmbientSettings({
    approximateFallback: false,
    betaHome,
    granularity: "precise",
    userLocation: proofLocation,
  });
  const refreshAmbient = () => ambient.refreshDevice({
    settings: readAmbientSettings({ betaHome }),
  });
  ledger.setOnWrite((_row, currentLedger) => {
    ambient.refreshLedger(currentLedger.describe());
  });
  ambient.refreshLedger(ledger.describe());
  refreshAmbient();

  manager = new BetaRouteManager({
    betaHome,
    brainstemConfig: {
      brainstemDir: grailDirectory,
      python,
    },
    ledger,
    lineageRoot,
    lineageEnv: "default",
  });

  await step("fresh copy: real Molter gate seeds verified ring 2", () => {
    const baseline = manager.baselineAncestor("context_memory_agent.py");
    const head = manager.lineageStore.getHead(baseline.ancestorRappid);
    const ring = manager.lineageStore.listRings(baseline.ancestorRappid)
      .find((candidate) => candidate.ringRappid === head);
    return {
      pass: ring?.verified === true
        && ring?.meta?.ring === 2
        && ring?.meta?.verifiedBy === "molter._verify",
      detail: `head=${head}; ring=${ring?.meta?.ring}; verified=${ring?.verified}`,
    };
  });

  const store = new RappStoreClient({
    url: `${fixtureOrigin}/catalog/index.json`,
  });
  const weatherInstallStarted = Date.now();
  const weather = await store.download("weather");
  const installedWeather = await manager.installScopedAgent({
    filename: weather.filename,
    origin: "store",
    source: weather.source,
  });
  const weatherRow = ledger.database.prepare(`
    SELECT at, event, filename, tool_name, sha256, source_path, origin
    FROM agents
    WHERE filename = 'weather_agent.py' AND event = 'installed'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  const installLatencyMs = Date.parse(weatherRow?.at || 0) - weatherInstallStarted;
  await step("weather install reaches ledger within one second", () => ({
    pass: weatherRow?.tool_name === "WeatherAgent"
      && weatherRow?.origin === "store"
      && installLatencyMs >= -100
      && installLatencyMs <= 1000
      && existsSync(weatherRow?.source_path || ""),
    detail: `latency_ms=${installLatencyMs}; source=${weatherRow?.source_path}`,
  }));

  const pin = await store.download("pin-drop");
  await manager.installScopedAgent({
    filename: pin.filename,
    origin: "store",
    source: pin.source,
  });
  await step("local fixture catalog installs two sha-pinned agents", () => {
    const stack = manager.loadStack(installedWeather.stack_rappid);
    const names = stack.agents.map((agent) => agent.filename).sort();
    return {
      pass: names.includes("weather_agent.py")
        && names.includes("pin_drop_agent.py")
        && weather.verified
        && pin.verified,
      detail: names.join(", "),
    };
  });

  refreshAmbient();
  const route = await manager.startDefault();
  const healthResponse = await fetch(`${route.url}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  const health = await healthResponse.json();
  const worker = manager.workers.get(route.compositionHash);
  await step("real routed worker loads ring 2 and fixture tools", () => ({
    pass: healthResponse.ok
      && ["ok", "unauthenticated"].includes(health.status)
      && health.agents.includes("ContextMemory")
      && health.agents.includes("WeatherAgent")
      && health.agents.includes("PinDropAgent")
      && /CONTEXT_MEMORY_RING = 2/.test(
        manager.readActiveAgent("context_memory_agent.py"),
      )
      && Number.isInteger(worker?.process?.child?.pid),
    detail: `pid=${worker?.process?.child?.pid}; agents=${health.agents.join(",")}`,
  }));

  const history = [];
  const sessionId = "data-sloshing-proof";
  refreshAmbient();
  const weatherReply = await postChat(
    route,
    "what's the weather here",
    history,
    sessionId,
  );
  await step("turn 1: weather uses sloshed coordinates without clarification", () => ({
    pass: modelState.weatherArgs?.lat === proofLocation.lat
      && modelState.weatherArgs?.lon === proofLocation.lon
      && /DETERMINISTIC_FORECAST/.test(weatherReply.agent_logs || "")
      && !/where are you|what(?:'s| is) your location|\?$/.test(
        String(weatherReply.response || "").trim().toLowerCase(),
      ),
    detail: `args=${JSON.stringify(modelState.weatherArgs)}; reply=${weatherReply.response}`,
  }));

  refreshAmbient();
  const pinReply = await postChat(
    route,
    "drop a pin here for Kody",
    history,
    sessionId,
  );
  const pinFiles = readdirSync(worker.agentDirectory)
    .filter((name) => /^pin-[a-f0-9]{16}\.json$/.test(name));
  const pinPayload = pinFiles.length === 1
    ? JSON.parse(readFileSync(path.join(worker.agentDirectory, pinFiles[0]), "utf8"))
    : null;
  await step("turn 2: pin agent receives and writes the sloshed location", () => ({
    pass: modelState.pinArgs?.to === "Kody"
      && modelState.pinArgs?.lat === proofLocation.lat
      && modelState.pinArgs?.lon === proofLocation.lon
      && pinPayload?.to === "Kody"
      && pinPayload?.lat === proofLocation.lat
      && pinPayload?.lon === proofLocation.lon
      && /PIN_DROPPED/.test(pinReply.agent_logs || ""),
    detail: `args=${JSON.stringify(modelState.pinArgs)}; file=${pinFiles[0] || "missing"}`,
  }));

  refreshAmbient();
  const ledgerReply = await postChat(
    route,
    "how did I build the weather agent?",
    history,
    sessionId,
  );
  await step("turn 3: reply cites the weather install ledger row", () => ({
    pass: /ledger row says installed WeatherAgent from store/i.test(
      ledgerReply.response || "",
    )
      && /<ledger>/.test(modelState.ledgerSystem || "")
      && /installed WeatherAgent from store/.test(modelState.ledgerSystem || ""),
    detail: ledgerReply.response,
  }));

  const shownSqlite = String(modelState.ledgerSystem || "")
    .match(/^sqlite3 .+$/m)?.[0] || "";
  const cleanShellEnvironment = { ...process.env };
  delete cleanShellEnvironment.RAPP_AMBIENT_DIR;
  const shownQuery = process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", shownSqlite],
        { encoding: "utf8", env: cleanShellEnvironment },
      )
    : spawnSync(
        "/bin/sh",
        ["-c", shownSqlite],
        { encoding: "utf8", env: cleanShellEnvironment },
      );
  await step("the exact sloshed sqlite3 command runs in a clean terminal", () => ({
    pass: Boolean(shownSqlite)
      && shownQuery.status === 0
      && /WeatherAgent/.test(shownQuery.stdout || ""),
    detail: shownSqlite,
  }));

  const credentialReply = await postChat(
    route,
    `credential redaction probe token=${credentialProbe}`,
    history,
    "data-sloshing-redaction",
  );
  const sqliteCredential = ledger.database.prepare(`
    SELECT content
    FROM turns
    WHERE session_id = 'data-sloshing-redaction' AND role = 'user'
    ORDER BY id DESC
    LIMIT 1
  `).get()?.content || "";
  const mirrorText = readFileSync(ledger.mirrorPath, "utf8");
  await step("credential-shaped turn is redacted in SQLite and JSONL", () => ({
    pass: /redacted:/.test(sqliteCredential)
      && /redacted:/.test(mirrorText)
      && !sqliteCredential.includes(credentialProbe)
      && !mirrorText.includes(credentialProbe)
      && /completed/i.test(credentialReply.response || ""),
    detail: sqliteCredential,
  }));

  const sqlite = spawnSync(
    "sqlite3",
    [ledger.databasePath, "select event, tool_name from agents"],
    { encoding: "utf8" },
  );
  sqliteOutput = String(sqlite.stdout || "").trim();
  await step("sqlite3 CLI returns agent lifecycle rows", () => ({
    pass: sqlite.status === 0
      && /installed\|WeatherAgent/.test(sqliteOutput)
      && /installed\|PinDropAgent/.test(sqliteOutput),
    detail: sqliteOutput,
  }));

  const grep = spawnSync(
    "grep",
    ["-i", "WeatherAgent", ledger.mirrorPath],
    { encoding: "utf8" },
  );
  grepOutput = String(grep.stdout || "").trim();
  await step("grep returns the JSONL weather row", () => ({
    pass: grep.status === 0
      && /"table":"agents"/.test(grepOutput)
      && /WeatherAgent/.test(grepOutput),
    detail: grepOutput.slice(0, 240),
  }));

  await step("scripted model stayed local and matched every expected turn", () => ({
    pass: modelState.errors.length === 0
      && modelState.requests.length === 6
      && modelState.weatherSystem?.includes("<device_context>"),
    detail: `model_requests=${modelState.requests.length}; errors=${modelState.errors.length}`,
  }));

  if (process.platform !== "win32") {
    await step("ledger and ambient artifacts are private", () => ({
      pass: (statSync(ledger.databasePath).mode & 0o777) === 0o600
        && (statSync(ledger.mirrorPath).mode & 0o777) === 0o600
        && (statSync(path.join(betaHome, "ambient", "device.json")).mode & 0o777) === 0o600,
      detail: "ledger.sqlite=0600; ledger.jsonl=0600; device.json=0600",
    }));
  }
} catch (error) {
  failed = true;
  rows.push({
    name: "proof execution",
    result: "FAIL",
    detail: String(error?.stack || error?.message || error),
  });
} finally {
  if (manager) await manager.stop().catch(() => {});
  ledger?.close();
  await stopServer(fixtureServer);
  rmSync(grailDirectory, { recursive: true, force: true });
  rmSync(scratchHome, { recursive: true, force: true });
  restoreEnvironment();
}

printTable();
console.log(`SCRATCH_BETA_HOME=${betaHome}`);
console.log("SQLITE_OUTPUT_BEGIN");
console.log(sqliteOutput);
console.log("SQLITE_OUTPUT_END");
console.log("GREP_OUTPUT_BEGIN");
console.log(grepOutput);
console.log("GREP_OUTPUT_END");
console.log(`DATA_SLOSHING_PROOF=${failed ? "FAIL" : "PASS"}`);
process.exitCode = failed ? 1 : 0;
