import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { betaSourceFingerprint } from "./walkthrough-provenance.mjs";


const betaDir = path.resolve(import.meta.dirname, "..");
const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(
    process.env.BRAINSTEM_HOME || path.join(homedir(), ".brainstem"),
    "beta-launcher",
  );
const reportsDir = path.join(betaHome, "walkthroughs", "runs");
const validationsDir = path.join(betaHome, "walkthroughs", "validations");

function latestReportPath() {
  const filename = readdirSync(reportsDir)
    .filter((candidate) => (
      candidate.endsWith(".json") && !candidate.includes("-historical")
    ))
    .sort((left, right) => right.localeCompare(left))[0];
  if (!filename) throw new Error("No scored walkthrough report is available.");
  return path.join(reportsDir, filename);
}

function artifactDescriptor(filePath) {
  const stats = statSync(filePath);
  return {
    path: filePath,
    sha256: createHash("sha256")
      .update(readFileSync(filePath))
      .digest("hex"),
    size_bytes: stats.size,
    modified_at: stats.mtime.toISOString(),
  };
}

function runValidation(runDirectory, name, command, args, scorePattern) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: betaDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  const completedAt = new Date().toISOString();
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const outputPath = path.join(runDirectory, `${name}.log`);
  writeFileSync(outputPath, output, { mode: 0o600 });
  const score = scorePattern ? output.match(scorePattern) : null;
  return {
    name,
    command: [command, ...args].join(" "),
    exit_status: result.status,
    started_at: startedAt,
    completed_at: completedAt,
    output: artifactDescriptor(outputPath),
    score: score
      ? {
          passed: Number(score[1]),
          total: Number(score[2] || score[1]),
        }
      : null,
  };
}

function main() {
  if (!existsSync(reportsDir)) {
    throw new Error("The walkthrough report directory is missing.");
  }
  const reportPath = latestReportPath();
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const source = betaSourceFingerprint();
  if (report.provenance?.source_hash !== source.source_hash) {
    throw new Error("The latest walkthrough was not produced by the current source.");
  }
  const runDirectory = path.join(validationsDir, report.run_id);
  mkdirSync(runDirectory, { recursive: true });
  const commands = [
    runValidation(
      runDirectory,
      "syntax",
      "npm",
      ["run", "check", "--silent"],
      null,
    ),
    runValidation(
      runDirectory,
      "tests",
      "npm",
      ["test", "--silent"],
      /tests\s+(\d+)/,
    ),
    runValidation(
      runDirectory,
      "package-gate",
      "npm",
      ["run", "package:gate", "--silent"],
      /PACKAGE READY\s+—\s+(\d+)\/(\d+)\s+pass/,
    ),
    runValidation(
      runDirectory,
      "walkthrough-gate",
      process.execPath,
      [path.join(import.meta.dirname, "walkthrough-gate.mjs"), "--allow-uncertified"],
      /PERFECT\s+—\s+(\d+)\/(\d+)\s+pass/,
    ),
  ];
  report.validation = {
    run_id: report.run_id,
    certified_at: new Date().toISOString(),
    source_hash: source.source_hash,
    commands,
  };
  writeFileSync(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  const failed = commands.filter((command) => command.exit_status !== 0);
  process.stdout.write(`${JSON.stringify({
    report: reportPath,
    run_id: report.run_id,
    source_hash: source.source_hash,
    commands: commands.map((command) => ({
      name: command.name,
      exit_status: command.exit_status,
      score: command.score,
      output: command.output,
    })),
  }, null, 2)}\n`);
  process.exit(failed.length ? 1 : 0);
}

main();
