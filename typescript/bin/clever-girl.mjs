import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command } from "commander";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function repeat(value, previous) {
  return [...previous, value];
}

function createHelp() {
  const command = new Command()
    .name("openrappter clever-girl")
    .description(
      "Observe recurring workflow friction in explicitly selected local exports",
    );

  const observe = command
    .command("observe")
    .description("Emit a local, read-only versioned Clever Girl JSON report")
    .option(
      "--input <path>",
      "Explicit coding-assistant history export (repeatable)",
      repeat,
      [],
    )
    .option(
      "--activity <path>",
      "Explicit repository-activity export (repeatable)",
      repeat,
      [],
    )
    .option("--estate-manifest <path>", "Explicit RAPP estate manifest")
    .option(
      "--capability-catalog <path>",
      "Explicit capability catalog (repeatable)",
      repeat,
      [],
    )
    .option(
      "--skills-root <path>",
      "Explicit local skills root (repeatable)",
      repeat,
      [],
    )
    .option(
      "--source <adapter>",
      "auto, claude, codex, copilot, openrappter, or normalized",
      "auto",
    )
    .option("--since <date-time>", "Inclusive RFC 3339 start time")
    .option("--until <date-time>", "Inclusive RFC 3339 end time")
    .option("--min-sessions <count>", "Selected recurrence session threshold")
    .option("--min-days <count>", "Selected recurrence active-day threshold")
    .option("--output <path>", "Also write to a new explicit path (POSIX only)")
    .option(
      "--facet-sidecar-output <path>",
      "Write complete opaque v3 repair assignments to a new POSIX path",
    )
    .option("--report-version <version>", "auto, 2, or 3", "auto")
    .option("--pretty", "Pretty-print the JSON report");

  return { command, observe };
}

function enginePath() {
  const packaged = path.join(
    packageRoot,
    "dist",
    "clever-girl",
    "rapter-clever-girl.mjs",
  );
  if (existsSync(packaged)) return packaged;
  return path.resolve(packageRoot, "..", "scripts", "rapter-clever-girl.mjs");
}

export async function runCleverGirlCli(argv) {
  const { command, observe } = createHelp();
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    command.outputHelp();
    return 0;
  }
  if (
    argv[0] === "help" ||
    (argv[0] === "observe" &&
      argv.some((argument) => argument === "--help" || argument === "-h"))
  ) {
    observe.outputHelp();
    return 0;
  }

  const engine = await import(pathToFileURL(enginePath()).href);
  return engine.main(argv);
}
