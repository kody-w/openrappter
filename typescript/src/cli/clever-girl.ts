import type { Command } from "commander";

function repeat(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerCleverGirlCommand(program: Command): void {
  const cleverGirl = program
    .command("clever-girl")
    .description(
      "Observe recurring workflow friction in explicitly selected local exports",
    );

  cleverGirl
    .command("observe")
    .description(
      "Emit a local, read-only rapter-clever-girl.observe.v2 JSON report",
    )
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
    .option(
      "--output <path>",
      "Also write to a new explicit path (POSIX only)",
    )
    .option("--pretty", "Pretty-print the JSON report")
    .action(async () => {
      const commandIndex = process.argv.indexOf("clever-girl");
      const argv = process.argv.slice(commandIndex + 1);
      const wrapper = (await import(
        new URL("../../bin/clever-girl.mjs", import.meta.url).href
      )) as {
        runCleverGirlCli(args: string[]): Promise<number>;
      };
      process.exitCode = await wrapper.runCleverGirlCli(argv);
    });
}
