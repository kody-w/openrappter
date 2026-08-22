#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OpenRappterHatchery } from "../electron/openrappter-hatchery.mjs";

const packageDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function executable() {
  if (process.env.OPENRAPPTER_ELECTRON) return process.env.OPENRAPPTER_ELECTRON;
  const root = path.join(packageDir, "node_modules", "electron", "dist");
  if (process.platform === "darwin") {
    return path.join(root, "Electron.app", "Contents", "MacOS", "Electron");
  }
  return path.join(root, process.platform === "win32" ? "electron.exe" : "electron");
}

function options(argv) {
  const args = [...argv];
  const openRappterHome = process.env.OPENRAPPTER_HOME
    || path.join(homedir(), ".openrappter");
  const brainstemHome = process.env.BRAINSTEM_HOME
    || path.join(openRappterHome, "brainstem");
  let runtime = process.env.BRAINSTEM_BETA_SOURCE_DIR
    || path.join(brainstemHome, "src", "rapp_brainstem");
  let python = process.env.BRAINSTEM_BETA_PYTHON
    || path.join(
      brainstemHome,
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  const rest = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--runtime") runtime = args.shift();
    else if (arg === "--python") python = args.shift();
    else rest.push(arg);
  }
  return {
    command: rest.shift(),
    name: rest.join(" "),
    openRappterHome,
    python,
    runtime,
  };
}

function usage() {
  process.stdout.write(`openrappter-hatch — hatch full OpenRappter twins

  openrappter-hatch hatch <name>
  openrappter-hatch list
  openrappter-hatch stop <name>
  openrappter-hatch recover <name>  # dead PID metadata only
`);
}

async function main() {
  const parsed = options(process.argv.slice(2));
  if (!parsed.command || ["help", "--help", "-h"].includes(parsed.command)) {
    usage();
    return 0;
  }
  const electronPath = executable();
  for (const [label, file] of [
    ["Electron", electronPath],
    ["Brainstem runtime", parsed.runtime],
    ["Python", parsed.python],
  ]) {
    if (!existsSync(file)) throw new Error(`${label} is missing at ${file}.`);
  }
  const hatchery = new OpenRappterHatchery({
    brainstemRuntimeDir: parsed.runtime,
    electronPath,
    openRappterHome: parsed.openRappterHome,
    packageDir,
    parentGeneration: Number.parseInt(
      process.env.OPENRAPPTER_NEIGHBORHOOD_GENERATION || "0",
      10,
    ),
    parentNeighborhoodId:
      process.env.OPENRAPPTER_NEIGHBORHOOD_ID || "openrappter:alpha",
    packConfigPath: process.env.RAPPTER_PACK_CONFIG
      || path.join(parsed.openRappterHome, "pack.json"),
    pythonPath: parsed.python,
  });
  let result;
  if (parsed.command === "hatch") result = await hatchery.hatch(parsed.name);
  else if (parsed.command === "list") result = { twins: await hatchery.list() };
  else if (parsed.command === "stop") result = await hatchery.stop(parsed.name);
  else if (parsed.command === "recover") result = hatchery.recover(parsed.name);
  else throw new Error(`unknown command ${parsed.command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`openrappter-hatch failed — ${error.message}\n`);
  process.exitCode = 1;
});
