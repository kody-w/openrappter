#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";

import { OpenRappterTileStore } from "../electron/openrappter-tile.mjs";

function parse(argv) {
  const args = [...argv];
  const openRappterHome = process.env.OPENRAPPTER_HOME
    || path.join(homedir(), ".openrappter");
  const home = process.env.BRAINSTEM_HOME
    || path.join(openRappterHome, "brainstem");
  let betaHome = process.env.BRAINSTEM_BETA_HOME
    || path.join(openRappterHome, "desktop");
  let brainstemDir = process.env.BRAINSTEM_BETA_SOURCE_DIR
    || path.join(home, "src", "rapp_brainstem");
  const rest = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--beta-home") betaHome = args.shift();
    else if (arg === "--brainstem-dir") brainstemDir = args.shift();
    else rest.push(arg);
  }
  return { betaHome, brainstemDir, command: rest.shift(), rest };
}

function usage() {
  process.stdout.write(`openrappter-tile — export, import, and back up this local OpenRappter

  describe
  export <path.openrappter.tile>
  import <path.openrappter.tile>
  adopt <path.openrappter.tile>   # verified reinstall recovery
  backup
  list

  --beta-home <dir>
  --brainstem-dir <dir>
`);
}

function main() {
  const { betaHome, brainstemDir, command, rest } = parse(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  const store = new OpenRappterTileStore({ betaHome, brainstemDir });
  let result;
  if (command === "describe") result = store.describe();
  else if (command === "export") result = store.exportTile(rest[0]);
  else if (command === "import") result = store.importTile(rest[0]);
  else if (command === "adopt") {
    result = store.importTile(rest[0], { adoptIdentity: true });
  }
  else if (command === "backup") result = { file: store.backup() };
  else if (command === "list") result = { backups: store.listBackups() };
  else {
    process.stderr.write(`unknown command ${command}\n`);
    usage();
    return 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`openrappter-tile failed — ${error.message}\n`);
  process.exit(1);
}
