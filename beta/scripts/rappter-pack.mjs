#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dispatchPackNode,
  packNodeReady,
  readEstateInventory,
  runContinuousPackMatrix,
  runPackMatrix,
  validatePackConfig,
  writePackReport,
} from "../electron/rappter-pack.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function options(argv) {
  const args = [...argv];
  const openRappterHome = process.env.OPENRAPPTER_HOME
    || path.join(homedir(), ".openrappter");
  let config = path.join(openRappterHome, "pack.json");
  let home = process.env.BRAINSTEM_BETA_HOME
    || path.join(openRappterHome, "desktop");
  let matrix = path.join(
    packageRoot,
    "resources",
    "rappter-pack",
    "default-matrix.json",
  );
  let estate = "";
  let intervalMs = 60_000;
  let iterations = Infinity;
  const rest = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--config") config = args.shift();
    else if (arg === "--home") home = args.shift();
    else if (arg === "--matrix") matrix = args.shift();
    else if (arg === "--estate") estate = args.shift();
    else if (arg === "--interval") intervalMs = Number(args.shift()) * 1000;
    else if (arg === "--iterations") iterations = Number(args.shift());
    else rest.push(arg);
  }
  return { command: rest.shift(), config, estate, home, intervalMs, iterations, matrix };
}

function json(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"));
}

function usage() {
  process.stdout.write(`rappter-pack — mixed Brainstem/OpenRappter matrix controller

  status
  run
  loop [--interval seconds] [--iterations count]
  inventory --estate /path/to/rapp-monorepo/MANIFEST.json

  --config ~/.openrappter/pack.json
  --matrix path/to/matrix.json
  --home ~/.openrappter/desktop
`);
}

async function main() {
  const parsed = options(process.argv.slice(2));
  if (!parsed.command || ["help", "--help", "-h"].includes(parsed.command)) {
    usage();
    return 0;
  }
  if (parsed.command === "inventory") {
    if (!parsed.estate) throw new Error("inventory requires --estate MANIFEST.json");
    process.stdout.write(`${JSON.stringify(readEstateInventory(parsed.estate), null, 2)}\n`);
    return 0;
  }
  const config = validatePackConfig(json(parsed.config));
  if (parsed.command === "status") {
    const results = await Promise.all(config.nodes.map(async (node) => {
      try {
        const result = await dispatchPackNode(
          node,
          { action: "health", case_id: "status" },
        );
        return {
          node: node.id,
          ...result,
          ready: packNodeReady(result),
        };
      } catch (error) {
        return { node: node.id, ok: false, error: error.message };
      }
    }));
    process.stdout.write(`${JSON.stringify({ pack_id: config.pack_id, results }, null, 2)}\n`);
    return results.every((result) => result.ready === true) ? 0 : 1;
  }
  const matrix = json(parsed.matrix);
  if (parsed.command === "run") {
    const report = await runPackMatrix({ config, matrix });
    const file = writePackReport(parsed.home, report);
    process.stdout.write(`${JSON.stringify({ file, report }, null, 2)}\n`);
    return report.summary.fail ? 1 : 0;
  }
  if (parsed.command === "loop") {
    const reports = await runContinuousPackMatrix({
      config,
      intervalMs: parsed.intervalMs,
      iterations: parsed.iterations,
      matrix,
      onIteration: (report) => {
        const file = writePackReport(parsed.home, report);
        process.stdout.write(`${JSON.stringify({
          at: report.created_at,
          expected_cases: report.summary.total,
          observed_pass: report.summary.pass,
          observed_fail: report.summary.fail,
          file,
        })}\n`);
      },
    });
    return reports.some((report) => report.summary.fail) ? 1 : 0;
  }
  throw new Error(`unknown command ${parsed.command}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`rappter-pack failed — ${error.message}\n`);
    process.exitCode = 1;
  });
