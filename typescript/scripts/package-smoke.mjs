import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const scratch = mkdtempSync(path.join(packageRoot, ".package-smoke-"));

function runUnchecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return result;
}

function run(command, args, options = {}) {
  const result = runUnchecked(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with status ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run(npm, args, {
    shell: process.platform === "win32",
    ...options,
  });
}

function parsePackResult(output) {
  for (
    let start = output.indexOf("[");
    start >= 0;
    start = output.indexOf("[", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index++) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === "[") depth++;
      else if (char === "]" && --depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(start, index + 1));
          if (Array.isArray(parsed) && parsed[0]?.filename) return parsed;
        } catch {
          break;
        }
        break;
      }
    }
  }
  throw new Error(`npm pack did not emit its artifact JSON:\n${output}`);
}

function parseJsonValue(output, opening, closing) {
  const start = output.indexOf(opening);
  const end = output.lastIndexOf(closing);
  if (start < 0 || end < start) {
    throw new Error(`CLI output did not contain JSON:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

try {
  const packed = run(process.execPath, [
    path.join(packageRoot, "scripts", "pack-locked.mjs"),
    "--json",
    "--pack-destination",
    scratch,
  ]);
  const packResult = parsePackResult(packed.stdout);
  const artifact = packResult[0];
  if (!artifact?.filename) throw new Error("npm pack did not report a tarball");

  const packedFiles = new Set(
    (artifact.files ?? []).map((entry) => entry.path),
  );
  if (!packedFiles.has("ui/dist/index.html")) {
    throw new Error("Tarball does not contain ui/dist/index.html");
  }
  if (!packedFiles.has("ui/dist/xpedition-landscape.svg")) {
    throw new Error("Tarball does not contain the original XPedition landscape");
  }
  if (!packedFiles.has("npm-shrinkwrap.json")) {
    throw new Error("Tarball does not contain the reviewed dependency lock");
  }
  for (const required of [
    "bin/clever-girl.mjs",
    "dist/agents/ShowAndTellAgent.js",
    "dist/agents/DesktopControlAgent.js",
    "dist/clever-girl/rapter-clever-girl.mjs",
    "dist/clever-girl/rapter-clever-girl-context.mjs",
    "dist/clever-girl/rapter-clever-girl-reader.mjs",
    "dist/clever-girl/rapter-clever-girl-schema-validator.mjs",
    "dist/clever-girl/rapter-clever-girl-observe-v2.json",
    "dist/clever-girl/rapter-clever-girl-observe-v3.json",
    "dist/clever-girl/rapter-clever-girl-capability-catalog-v2.json",
    "dist/clever-girl/rapter-clever-girl-repair-assignments-v1.json",
    "dist/clever-girl/SKILL.md",
    "dist/cli/clever-girl.js",
    "dist/desktop-control/queue.js",
    "dist/show-and-tell/store.js",
    "dist/show-and-tell/worker.js",
    "dist/cli/show-and-tell.js",
  ]) {
    if (!packedFiles.has(required)) {
      throw new Error(`Tarball does not contain ${required}`);
    }
  }

  const tarball = path.join(scratch, artifact.filename);
  if (!existsSync(tarball)) throw new Error(`Missing tarball: ${tarball}`);

  const installRoot = path.join(scratch, "install");
  const home = path.join(scratch, "home");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(installRoot, "package.json"),
    JSON.stringify({ name: "openrappter-package-smoke", private: true }),
  );

  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: installRoot,
  });

  const installedRoot = path.join(installRoot, "node_modules", "openrappter");
  const installedIndex = path.join(installedRoot, "ui", "dist", "index.html");
  if (
    !existsSync(installedIndex) ||
    readFileSync(installedIndex, "utf8").length === 0
  ) {
    throw new Error("Installed package is missing ui/dist/index.html");
  }
  const installedLandscape = path.join(
    installedRoot,
    "ui",
    "dist",
    "xpedition-landscape.svg",
  );
  const sourceLandscape = path.join(
    packageRoot,
    "ui",
    "public",
    "xpedition-landscape.svg",
  );
  if (
    !existsSync(installedLandscape) ||
    readFileSync(installedLandscape, "utf8") !==
      readFileSync(sourceLandscape, "utf8")
  ) {
    throw new Error(
      "Installed package does not contain the exact original XPedition landscape",
    );
  }
  const installedUiAssets = path.join(installedRoot, "ui", "dist", "assets");
  const installedUiJavaScript = readdirSync(installedUiAssets)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(path.join(installedUiAssets, name), "utf8"))
    .join("\n");
  if (!installedUiJavaScript.includes("Living Company Week")) {
    throw new Error(
      "Installed package does not contain the Living Company Desktop runtime",
    );
  }
  if (
    !installedUiJavaScript.includes("OpenRappter Personal") ||
    !installedUiJavaScript.includes("xpedition-extension-v1.json") ||
    !installedUiJavaScript.includes("needs-sign-in") ||
    !installedUiJavaScript.includes("no-entitlement")
  ) {
    throw new Error(
      "Installed package does not contain personal branding, data-only descriptors, and Copilot readiness",
    );
  }

  const cleverGirlAssets = [
    [
      path.join("scripts", "rapter-clever-girl.mjs"),
      path.join("dist", "clever-girl", "rapter-clever-girl.mjs"),
    ],
    [
      path.join("scripts", "rapter-clever-girl-context.mjs"),
      path.join("dist", "clever-girl", "rapter-clever-girl-context.mjs"),
    ],
    [
      path.join("scripts", "rapter-clever-girl-reader.mjs"),
      path.join("dist", "clever-girl", "rapter-clever-girl-reader.mjs"),
    ],
    [
      path.join("scripts", "rapter-clever-girl-schema-validator.mjs"),
      path.join(
        "dist",
        "clever-girl",
        "rapter-clever-girl-schema-validator.mjs",
      ),
    ],
    [
      path.join("contracts", "rapter-clever-girl-observe-v2.json"),
      path.join("dist", "clever-girl", "rapter-clever-girl-observe-v2.json"),
    ],
    [
      path.join("contracts", "rapter-clever-girl-observe-v3.json"),
      path.join("dist", "clever-girl", "rapter-clever-girl-observe-v3.json"),
    ],
    [
      path.join("contracts", "rapter-clever-girl-capability-catalog-v2.json"),
      path.join(
        "dist",
        "clever-girl",
        "rapter-clever-girl-capability-catalog-v2.json",
      ),
    ],
    [
      path.join("contracts", "rapter-clever-girl-repair-assignments-v1.json"),
      path.join(
        "dist",
        "clever-girl",
        "rapter-clever-girl-repair-assignments-v1.json",
      ),
    ],
    [
      path.join(".claude", "skills", "rapter-clever-girl-observe", "SKILL.md"),
      path.join("dist", "clever-girl", "SKILL.md"),
    ],
  ];
  for (const [repositoryRelative, packageRelative] of cleverGirlAssets) {
    const repositoryFile = path.resolve(packageRoot, "..", repositoryRelative);
    const installedFile = path.join(installedRoot, packageRelative);
    if (
      !existsSync(installedFile) ||
      readFileSync(installedFile, "utf8") !==
        readFileSync(repositoryFile, "utf8")
    ) {
      throw new Error(
        `Installed package does not contain the exact ${packageRelative} asset`,
      );
    }
  }

  const binary = path.join(installedRoot, "bin", "openrappter.mjs");
  const cleverHelp = run(
    process.execPath,
    [binary, "clever-girl", "observe", "--help"],
    { cwd: installRoot },
  );
  if (
    !cleverHelp.stdout.includes("openrappter clever-girl observe") ||
    !cleverHelp.stdout.includes("--input <path>")
  ) {
    throw new Error("Installed package does not expose Clever Girl help");
  }

  const cleverInput = path.join(scratch, "clever-girl-input.jsonl");
  writeFileSync(
    cleverInput,
    readFileSync(
      path.resolve(
        packageRoot,
        "..",
        "scripts",
        "fixtures",
        "rapter-clever-girl",
        "normalized.jsonl",
      ),
      "utf8",
    ),
    { mode: 0o600 },
  );
  const sourceEngine = path.resolve(
    packageRoot,
    "..",
    "scripts",
    "rapter-clever-girl.mjs",
  );
  const capabilityCatalog = path.resolve(
    packageRoot,
    "..",
    "scripts",
    "fixtures",
    "rapter-clever-girl",
    "capability-contract-catalog.json",
  );
  const cleverArgs = [
    "observe",
    "--input",
    cleverInput,
    "--source",
    "normalized",
  ];
  const installedClever = run(
    process.execPath,
    [binary, "clever-girl", ...cleverArgs],
    { cwd: installRoot },
  );
  const sourceClever = run(
    process.execPath,
    [sourceEngine, ...cleverArgs],
    { cwd: installRoot },
  );
  const installedExplicitV2 = run(
    process.execPath,
    [binary, "clever-girl", ...cleverArgs, "--report-version", "2"],
    { cwd: installRoot },
  );
  const sourceExplicitV2 = run(
    process.execPath,
    [sourceEngine, ...cleverArgs, "--report-version", "2"],
    { cwd: installRoot },
  );
  const installedReport = JSON.parse(installedClever.stdout);
  if (
    installedReport.schemaVersion !== "rapter-clever-girl.observe.v2" ||
    installedClever.stdout !== sourceClever.stdout ||
    installedClever.stderr !== sourceClever.stderr ||
    installedClever.stdout !== installedExplicitV2.stdout ||
    installedClever.stderr !== installedExplicitV2.stderr ||
    installedClever.stdout !== sourceExplicitV2.stdout ||
    installedClever.stderr !== sourceExplicitV2.stderr
  ) {
    throw new Error(
      "Installed Clever Girl CLI does not preserve the Observe Mode v2 result",
    );
  }

  const autoArgs = [
    ...cleverArgs,
    "--capability-catalog",
    capabilityCatalog,
    "--report-version",
    "auto",
  ];
  const installedAuto = run(
    process.execPath,
    [binary, "clever-girl", ...autoArgs],
    { cwd: installRoot },
  );
  if (
    JSON.parse(installedAuto.stdout).schemaVersion !==
    "rapter-clever-girl.observe.v3"
  ) {
    throw new Error("Installed Clever Girl explicit auto did not select v3");
  }

  const v3Args = [
    ...cleverArgs,
    "--capability-catalog",
    capabilityCatalog,
    "--report-version",
    "3",
  ];
  const installedV3 = run(
    process.execPath,
    [binary, "clever-girl", ...v3Args],
    { cwd: installRoot },
  );
  const sourceV3 = run(
    process.execPath,
    [sourceEngine, ...v3Args],
    { cwd: installRoot },
  );
  const installedV3Report = JSON.parse(installedV3.stdout);
  if (
    installedV3Report.schemaVersion !== "rapter-clever-girl.observe.v3" ||
    installedV3.stdout !== sourceV3.stdout ||
    installedV3.stderr !== sourceV3.stderr
  ) {
    throw new Error(
      "Installed Clever Girl CLI does not preserve the Observe Mode v3 result",
    );
  }

  const installedCleverRoot = path.join(installedRoot, "dist", "clever-girl");
  if (process.platform !== "win32") {
    const sidecarContract = path.join(
      installedCleverRoot,
      "rapter-clever-girl-repair-assignments-v1.json",
    );
    const hiddenSidecarContract = `${sidecarContract}.missing`;
    const forbiddenSidecar = path.join(scratch, "must-not-exist-sidecar.json");
    renameSync(sidecarContract, hiddenSidecarContract);
    const absentSidecar = runUnchecked(
      process.execPath,
      [
        binary,
        "clever-girl",
        ...v3Args,
        "--facet-sidecar-output",
        forbiddenSidecar,
      ],
      { cwd: installRoot },
    );
    if (
      absentSidecar.error ||
      absentSidecar.status !== 2 ||
      absentSidecar.stdout !== "" ||
      existsSync(forbiddenSidecar)
    ) {
      throw new Error(
        "Installed explicit v3 did not fail closed without its sidecar contract",
      );
    }
    renameSync(hiddenSidecarContract, sidecarContract);
  }

  const v3Contract = path.join(
    installedCleverRoot,
    "rapter-clever-girl-observe-v3.json",
  );
  const hiddenV3Contract = `${v3Contract}.missing`;
  renameSync(v3Contract, hiddenV3Contract);
  const unflaggedWithoutV3Assets = run(
    process.execPath,
    [binary, "clever-girl", ...cleverArgs],
    { cwd: installRoot },
  );
  if (unflaggedWithoutV3Assets.stdout !== installedClever.stdout) {
    throw new Error(
      "Installed unflagged v2 changed when optional v3 assets were absent",
    );
  }
  const absentV3Contract = runUnchecked(
    process.execPath,
    [binary, "clever-girl", ...v3Args],
    { cwd: installRoot },
  );
  if (
    absentV3Contract.error ||
    absentV3Contract.status !== 2 ||
    absentV3Contract.stdout !== ""
  ) {
    throw new Error(
      "Installed explicit v3 did not fail closed without its report contract",
    );
  }
  renameSync(hiddenV3Contract, v3Contract);

  const cli = run(
    process.execPath,
    [path.join(installedRoot, "bin", "openrappter.mjs"), "--web"],
    {
      cwd: installRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OPENRAPPTER_WEB_CHECK: "1",
      },
    },
  );
  if (!cli.stdout.includes("Web UI assets available:")) {
    throw new Error(
      `Installed --web did not locate packaged UI assets:\n${cli.stdout}`,
    );
  }

  // The historical Web UI smoke intentionally installs with --ignore-scripts.
  // Flight Recorder uses better-sqlite3, whose native binding is prepared by
  // its install script. Rebuild only that reviewed dependency before testing
  // the runtime path an ordinary npm install provides.
  runNpm(["rebuild", "better-sqlite3"], { cwd: installRoot });

  const showHelp = run(process.execPath, [binary, "show", "--help"], {
    cwd: installRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENRAPPTER_FLIGHT_RECORDER: "0",
      OPENRAPPTER_SHOW_TEST_MODE: "1",
    },
  });
  if (!/show-and-tell/i.test(showHelp.stdout)) {
    throw new Error("Installed package does not expose the Show-and-Tell CLI");
  }

  const installedStore = pathToFileURL(
    path.join(installedRoot, "dist", "show-and-tell", "store.js"),
  ).href;
  const installedAgent = pathToFileURL(
    path.join(installedRoot, "dist", "agents", "ShowAndTellAgent.js"),
  ).href;
  const showRoot = path.join(scratch, "installed-show-and-tell");
  const showScript = `
    import { createHash, randomBytes } from "node:crypto";
    import { ShowAndTellStore } from ${JSON.stringify(installedStore)};
    import { ShowAndTellAgent } from ${JSON.stringify(installedAgent)};
    const store = new ShowAndTellStore(${JSON.stringify(showRoot)});
    await store.initialize();
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    store.database()
      .prepare("INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), "start", now, now + 60000);
    const agent = new ShowAndTellAgent({ store, localSurface: true });
    const started = JSON.parse(await agent.perform({
      action: "start",
      intent: "Package smoke",
      poll_interval_ms: 60000,
      max_duration_ms: 60000,
      consent_token: token,
    }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const live = JSON.parse(await agent.perform({
      action: "status",
      session_id: started.session.id,
    }));
    const stopped = JSON.parse(await agent.perform({
      action: "stop",
      session_id: started.session.id,
    }));
    const events = await store.events(started.session.id);
    const activation = events.find((event) => event.type === "app.activate");
    const browser = events.find((event) => event.type === "browser.url");
    process.stdout.write(JSON.stringify({
      started: started.status,
      healthy: live.collector_healthy,
      stopped: stopped.session.state,
      activation,
      browser,
    }));
    store.close();
  `;
  const showSmoke = run(
    process.execPath,
    ["--input-type=module", "--eval", showScript],
    {
      cwd: installRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OPENRAPPTER_FLIGHT_RECORDER: "0",
        OPENRAPPTER_SHOW_TEST_MODE: "1",
      },
    },
  );
  const showStatus = parseJsonValue(showSmoke.stdout, "{", "}");
  if (
    showStatus.started !== "success" ||
    showStatus.healthy !== true ||
    showStatus.stopped !== "stopped" ||
    showStatus.activation?.source !== "context-collector" ||
    showStatus.activation?.data?.app !== "ShowAndTellTestApp" ||
    showStatus.activation?.data?.window !== "Synthetic collector window" ||
    !Number.isInteger(showStatus.activation?.sequence) ||
    showStatus.browser?.data?.url !== "https://example.test/workflow" ||
    showStatus.browser?.sequence !== showStatus.activation.sequence + 1
  ) {
    throw new Error(
      `Installed Show-and-Tell worker failed:\n${showSmoke.stdout}`,
    );
  }

  if (process.platform !== "win32") {
    const flightDb = path.join(home, "flight.db");
    const flightEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: "production",
      OPENRAPPTER_FLIGHT_RECORDER: "1",
      OPENRAPPTER_FLIGHT_DB: flightDb,
    };
    const managedHome = path.join(scratch, "managed-home");
    mkdirSync(managedHome, { recursive: true, mode: 0o755 });
    chmodSync(managedHome, 0o755);
    const {
      OPENRAPPTER_FLIGHT_DB: _ignoredFlightDb,
      ...environmentWithoutFlightDb
    } = process.env;
    run(process.execPath, [binary, "flight", "status", "--json"], {
      cwd: installRoot,
      env: {
        ...environmentWithoutFlightDb,
        HOME: managedHome,
        USERPROFILE: managedHome,
        NODE_ENV: "production",
        OPENRAPPTER_FLIGHT_RECORDER: "1",
      },
    });
    const managedDirectory = path.join(managedHome, ".openrappter");
    const managedDatabase = path.join(managedDirectory, "flight-recorder.db");
    if (process.platform !== "win32") {
      if ((statSync(managedDirectory).mode & 0o777) !== 0o700) {
        throw new Error(
          "Packaged default Flight Recorder directory is not 0700",
        );
      }
      if ((statSync(managedDatabase).mode & 0o777) !== 0o600) {
        throw new Error(
          "Packaged default Flight Recorder database is not 0600",
        );
      }
      if (
        (statSync(`${managedDatabase}.identity-key`).mode & 0o777) !==
        0o600
      ) {
        throw new Error("Packaged Flight Recorder identity key is not 0600");
      }
    }

    // ShellAgent is deterministic and needs no provider credential.
    run(process.execPath, [binary, "ls"], {
      cwd: installRoot,
      env: flightEnv,
    });
    const beforeExec = run(
      process.execPath,
      [binary, "flight", "status", "--json"],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const beforeExecStatus = parseJsonValue(beforeExec.stdout, "{", "}");
    run(process.execPath, [binary, "list directory", "--exec", "Shell"], {
      cwd: installRoot,
      env: flightEnv,
    });

    const status = run(
      process.execPath,
      [binary, "flight", "status", "--json"],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const statusJson = parseJsonValue(status.stdout, "{", "}");
    if (
      !statusJson.initialized ||
      statusJson.eventCount <= beforeExecStatus.eventCount
    ) {
      throw new Error(
        `Packaged --exec did not append a Flight Recorder trace:\n${status.stdout}`,
      );
    }
    const mcpBinary = path.join(installedRoot, "dist", "mcp", "stdio.js");
    const mcpRequest = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "Shell",
        arguments: { query: "list directory" },
      },
    })}\n`;
    const standaloneMcp = spawnSync(process.execPath, [mcpBinary], {
      cwd: installRoot,
      encoding: "utf8",
      input: mcpRequest,
      env: flightEnv,
    });
    if (
      standaloneMcp.status !== 0 ||
      !standaloneMcp.stdout.includes('"result"')
    ) {
      throw new Error(
        `Packaged standalone MCP failed:\n${standaloneMcp.stdout}\n${standaloneMcp.stderr}`,
      );
    }
    const standaloneExportResult = run(
      process.execPath,
      [binary, "flight", "export"],
      { cwd: installRoot, env: flightEnv },
    );
    const standaloneExport = parseJsonValue(
      standaloneExportResult.stdout,
      "{",
      "}",
    );
    const standaloneTool = [...standaloneExport.events]
      .reverse()
      .find((event) => event.kind === "tool.call.started");
    const standaloneAgent = standaloneTool
      ? standaloneExport.events.find(
          (event) =>
            event.traceId === standaloneTool.traceId &&
            event.kind === "agent.execute.started",
        )
      : undefined;
    if (
      !standaloneTool ||
      !standaloneAgent ||
      standaloneAgent.parentId !== standaloneTool.id
    ) {
      throw new Error(
        "Standalone MCP call omitted the tool-to-agent lifecycle",
      );
    }
    const afterStandalone = run(
      process.execPath,
      [binary, "flight", "status", "--json"],
      { cwd: installRoot, env: flightEnv },
    );
    const afterStandaloneStatus = parseJsonValue(
      afterStandalone.stdout,
      "{",
      "}",
    );
    const mcpTraceId = "package-mcp-trace";
    const mcpParentId = "package-provider-attempt";
    const mcpResult = spawnSync(process.execPath, [mcpBinary], {
      cwd: installRoot,
      encoding: "utf8",
      input: mcpRequest,
      env: {
        ...flightEnv,
        OPENRAPPTER_FLIGHT_TRACE_ID: mcpTraceId,
        OPENRAPPTER_FLIGHT_PARENT_ID: mcpParentId,
        OPENRAPPTER_FLIGHT_SESSION_ID: "package-mcp-session",
      },
    });
    if (mcpResult.status !== 0 || !mcpResult.stdout.includes('"result"')) {
      throw new Error(
        `Packaged MCP child failed to execute Shell:\n${mcpResult.stdout}\n${mcpResult.stderr}`,
      );
    }
    const afterMcp = run(
      process.execPath,
      [binary, "flight", "status", "--json"],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const afterMcpStatus = parseJsonValue(afterMcp.stdout, "{", "}");
    if (afterMcpStatus.eventCount <= afterStandaloneStatus.eventCount) {
      throw new Error("Packaged MCP child did not persist agent events");
    }
    const ownerDirectory = `${flightDb}.owners`;
    if (existsSync(ownerDirectory) && readdirSync(ownerDirectory).length > 0) {
      throw new Error("Packaged MCP child leaked recorder owner markers");
    }
    const mcpExportResult = run(
      process.execPath,
      [binary, "flight", "export", "--trace", mcpTraceId],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const mcpExport = parseJsonValue(mcpExportResult.stdout, "{", "}");
    const mcpToolStarted = mcpExport.events.find(
      (event) => event.kind === "tool.call.started",
    );
    const mcpAgentStarted = mcpExport.events.find(
      (event) => event.kind === "agent.execute.started",
    );
    const mcpChildStarted = mcpExport.events.find(
      (event) =>
        event.kind === "trace.started" && event.parentId === mcpParentId,
    );
    if (
      !mcpToolStarted ||
      !mcpAgentStarted ||
      !mcpChildStarted ||
      mcpToolStarted.parentId !== mcpChildStarted.id ||
      mcpAgentStarted.parentId !== mcpToolStarted.id ||
      mcpExport.events.some((event) => event.traceId !== mcpTraceId)
    ) {
      throw new Error(
        "Packaged MCP child did not preserve parent trace causality",
      );
    }

    const eventsResult = run(
      process.execPath,
      [binary, "flight", "events", "--json"],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const events = parseJsonValue(eventsResult.stdout, "[", "]");
    if (!Array.isArray(events) || events.length < 5) {
      throw new Error("Packaged flight events returned no trace");
    }
    if (events.some((event) => Object.hasOwn(event, "payload"))) {
      throw new Error(
        "Packaged default Flight Recorder persisted raw payload IO",
      );
    }

    const exportPath = path.join(scratch, "flight-export.json");
    writeFileSync(exportPath, "public placeholder", { mode: 0o644 });
    chmodSync(exportPath, 0o644);
    run(
      process.execPath,
      [binary, "flight", "export", "--output", exportPath],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const exported = JSON.parse(readFileSync(exportPath, "utf8"));
    if (exported.schema !== "openrappter-flight-export/1.0") {
      throw new Error("Packaged flight export has the wrong schema");
    }
    if (
      process.platform !== "win32" &&
      (statSync(exportPath).mode & 0o777) !== 0o600
    ) {
      throw new Error("Packaged flight export overwrite is not mode 0600");
    }

    run(process.execPath, [binary, "flight", "clear", "--yes"], {
      cwd: installRoot,
      env: flightEnv,
    });
    run(process.execPath, [binary, "flight", "import", exportPath], {
      cwd: installRoot,
      env: flightEnv,
    });
    const restored = run(
      process.execPath,
      [binary, "flight", "status", "--json"],
      {
        cwd: installRoot,
        env: flightEnv,
      },
    );
    const restoredStatus = parseJsonValue(restored.stdout, "{", "}");
    if (restoredStatus.eventCount !== exported.events.length) {
      throw new Error(
        "Packaged flight export/import did not round-trip exactly",
      );
    }
    const identityTemporaryArtifacts = [
      `${flightDb}.identity-key.123.01234567-89ab-cdef-0123-456789abcdef.tmp`,
      `${flightDb}.identity-key.456.0123456789abcdef0123456789abcdef.tmp`,
    ];
    const identityKeyContents = readFileSync(
      `${flightDb}.identity-key`,
      "utf8",
    );
    for (const artifact of identityTemporaryArtifacts) {
      writeFileSync(artifact, identityKeyContents, { mode: 0o600 });
    }
    run(process.execPath, [binary, "reset", "--yes"], {
      cwd: installRoot,
      env: flightEnv,
    });
    for (const resetPath of [
      flightDb,
      `${flightDb}-wal`,
      `${flightDb}-shm`,
      `${flightDb}.identity-key`,
      ...identityTemporaryArtifacts,
    ]) {
      if (existsSync(resetPath)) {
        throw new Error(
          `Packaged reset left Flight Recorder state: ${resetPath}`,
        );
      }
    }
  } else {
    const windowsFlightDir = path.join(scratch, "windows-flight-recorder");
    mkdirSync(windowsFlightDir, { recursive: true });
    const recorderModule = pathToFileURL(
      path.join(installedRoot, "dist", "flight-recorder", "recorder.js"),
    ).href;
    const permissionsModule = pathToFileURL(
      path.join(installedRoot, "dist", "flight-recorder", "permissions.js"),
    ).href;
    const windowsFlightScript = `
      import path from "node:path";
      import { FlightRecorder } from ${JSON.stringify(recorderModule)};
      import { hardenPrivatePath } from ${JSON.stringify(permissionsModule)};
      const directory = ${JSON.stringify(windowsFlightDir)};
      hardenPrivatePath(directory, true);
      const recorder = new FlightRecorder({
        enabled: true,
        databasePath: path.join(directory, "flight.db"),
        retentionEvents: -1,
      });
      try {
        await recorder.initialize();
        await recorder.runTrace(
          { traceId: "windows-package-smoke" },
          async () => {},
        );
        const health = await recorder.health();
        if (!health.initialized || health.eventCount < 2) {
          throw new Error(
            \`Packaged Windows Flight Recorder did not persist a trace: \${JSON.stringify(health)}\`,
          );
        }
      } finally {
        await recorder.close();
      }
    `;
    run(
      process.execPath,
      ["--input-type=module", "--eval", windowsFlightScript],
      { cwd: installRoot },
    );
  }

  console.log(
    `Package smoke passed: ${artifact.filename} includes OpenRappter Personal, Copilot readiness, data-only XPedition descriptors, Living Company Desktop, its original landscape, Flight Recorder, Show-and-Tell, and Clever Girl Observe Mode v2/v3`,
  );
} finally {
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
