import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { hardenPrivatePath } from "../flight-recorder/permissions.js";
import {
  ensureFlightRecorderFromEnv,
  type FlightEventKind,
} from "../flight-recorder/index.js";

async function resolvePotentialPath(target: string): Promise<string> {
  const suffix: string[] = [];
  let current = target;
  while (true) {
    try {
      return path.resolve(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

function integer(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got "${value}".`);
  }
  return parsed;
}

function eventSummary(
  event: import("../flight-recorder/index.js").FlightEvent,
): Record<string, unknown> {
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    traceId: event.traceId,
    kind: event.kind,
    status: event.status,
    source: event.source,
    providerId: event.providerId,
    model: event.model,
    agentName: event.agentName,
    toolName: event.toolName,
    durationMs: event.durationMs,
    metadata: event.metadata,
    contentHash: event.contentHash,
  };
}

async function assertSafeExportDestination(
  destination: string,
  databasePath: string | undefined,
): Promise<void> {
  if (!databasePath || databasePath === ":memory:") return;
  const database = path.resolve(databasePath);
  const artifacts = [
    database,
    `${database}-wal`,
    `${database}-shm`,
    `${database}.identity-key`,
    `${database}.reset-lock`,
    `${database}.owners`,
  ];
  const identityTemporaryPrefix = `${database}.identity-key.`;
  const foldPath = (value: string): string =>
    process.platform === "win32" || process.platform === "darwin"
      ? value.toLowerCase()
      : value;
  const foldedDestination = foldPath(destination);
  const foldedArtifacts = artifacts.map(foldPath);
  const foldedOwnerDirectory = foldPath(`${database}.owners`);
  const foldedIdentityTemporaryPrefix = foldPath(
    identityTemporaryPrefix,
  );
  if (
    foldedArtifacts.includes(foldedDestination) ||
    foldedDestination.startsWith(
      `${foldedOwnerDirectory}${path.sep}`,
    ) ||
    (
      foldedDestination.startsWith(foldedIdentityTemporaryPrefix) &&
      foldedDestination.endsWith(".tmp")
    )
  ) {
    throw new Error(
      "Flight export output must not target Flight Recorder storage.",
    );
  }

  const canonicalDatabase = await resolvePotentialPath(database);
  const canonicalDestination = await resolvePotentialPath(destination);
  const canonicalArtifacts = [
    canonicalDatabase,
    `${canonicalDatabase}-wal`,
    `${canonicalDatabase}-shm`,
    `${canonicalDatabase}.identity-key`,
    `${canonicalDatabase}.reset-lock`,
    `${canonicalDatabase}.owners`,
  ];
  const foldedCanonicalDestination = foldPath(canonicalDestination);
  const foldedCanonicalArtifacts = canonicalArtifacts.map(foldPath);
  const foldedCanonicalOwnerDirectory = foldPath(
    `${canonicalDatabase}.owners`,
  );
  const foldedCanonicalIdentityTemporaryPrefix = foldPath(
    `${canonicalDatabase}.identity-key.`,
  );
  if (
    foldedCanonicalArtifacts.includes(foldedCanonicalDestination) ||
    foldedCanonicalDestination.startsWith(
      `${foldedCanonicalOwnerDirectory}${path.sep}`,
    ) ||
    (
      foldedCanonicalDestination.startsWith(
        foldedCanonicalIdentityTemporaryPrefix,
      ) &&
      foldedCanonicalDestination.endsWith(".tmp")
    )
  ) {
    throw new Error(
      "Flight export output must not target Flight Recorder storage.",
    );
  }

  const ownerDirectory = `${database}.owners`;
  let ownerDirectoryStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    ownerDirectoryStat = await stat(ownerDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (ownerDirectoryStat) {
    let current = destination;
    while (true) {
      try {
        const currentStat = await stat(current);
        if (
          currentStat.dev === ownerDirectoryStat.dev &&
          currentStat.ino === ownerDirectoryStat.ino
        ) {
          throw new Error(
            "Flight export output must not target Flight Recorder owner storage.",
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  let destinationStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    destinationStat = await stat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!destinationStat) return;
  for (const artifact of artifacts) {
    try {
      const artifactStat = await stat(artifact);
      if (
        artifactStat.dev === destinationStat.dev &&
        artifactStat.ino === destinationStat.ino
      ) {
        throw new Error(
          "Flight export output aliases Flight Recorder storage.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function writePrivateExport(
  file: string,
  content: string,
  databasePath?: string,
): Promise<void> {
  const destination = path.resolve(file);
  await assertSafeExportDestination(destination, databasePath);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    hardenPrivatePath(temporary);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await assertSafeExportDestination(destination, databasePath);
    await rename(temporary, destination);
    hardenPrivatePath(destination);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export function registerFlightRecorderCommand(program: Command): void {
  const flight = program
    .command("flight")
    .description("Inspect the local privacy-aware Flight Recorder");

  flight
    .command("status")
    .description("Show recorder health, event count, and local database path")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const recorder = await ensureFlightRecorderFromEnv();
      const health = await recorder.health();
      if (options.json) {
        console.log(JSON.stringify(health, null, 2));
        return;
      }
      console.log(
        `Flight Recorder: ${health.enabled ? "enabled" : "disabled"}`,
      );
      console.log(`  initialized : ${health.initialized}`);
      console.log(`  events      : ${health.eventCount}`);
      console.log(`  errors      : ${health.errorCount}`);
      console.log(`  database    : ${health.databasePath ?? "(none)"}`);
      if (health.lastError) console.log(`  last error  : ${health.lastError}`);
    });

  flight
    .command("events")
    .description("List privacy-safe event summaries")
    .option("--trace <id>", "Filter by trace ID")
    .option("--session <id>", "Filter by session ID")
    .option("--kind <kind>", "Filter by event kind")
    .option("--agent <name>", "Filter by agent name")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum events", "50")
    .option("--json", "Print one JSON array instead of JSON lines")
    .action(
      async (options: {
        trace?: string;
        session?: string;
        kind?: string;
        agent?: string;
        provider?: string;
        limit: string;
        json?: boolean;
      }) => {
        const recorder = await ensureFlightRecorderFromEnv();
        const events = await recorder.query({
          traceId: options.trace,
          sessionId: options.session,
          kind: options.kind as FlightEventKind | undefined,
          agentName: options.agent,
          providerId: options.provider,
          order: "desc",
          limit: integer(options.limit),
        });
        if (options.json) {
          console.log(JSON.stringify(events.map(eventSummary), null, 2));
          return;
        }
        for (const event of events) {
          console.log(JSON.stringify(eventSummary(event)));
        }
      },
    );

  flight
    .command("export")
    .description(
      "Export a versioned trace/session/event bundle for replay or evals",
    )
    .option("--trace <id>", "Filter by trace ID")
    .option("--session <id>", "Filter by session ID")
    .option("--kind <kind>", "Filter by event kind")
    .option("--output <path>", "Write to a file (mode 0600) instead of stdout")
    .action(
      async (options: {
        trace?: string;
        session?: string;
        kind?: string;
        output?: string;
      }) => {
        const recorder = await ensureFlightRecorderFromEnv();
        const bundle = await recorder.export({
          traceId: options.trace,
          sessionId: options.session,
          kind: options.kind as FlightEventKind | undefined,
        });
        if (!bundle) throw new Error("Flight Recorder is not initialized.");
        const json = `${JSON.stringify(bundle, null, 2)}\n`;
        if (!options.output) {
          process.stdout.write(json);
          return;
        }
        const health = await recorder.health();
        await writePrivateExport(
          options.output,
          json,
          health.databasePath,
        );
        console.log(
          `Exported ${bundle.events.length} event(s) to ${options.output}`,
        );
      },
    );

  flight
    .command("import <path>")
    .description("Import an integrity-checked replay/eval bundle")
    .option("--replace", "Replace existing events with matching event IDs")
    .action(async (file: string, options: { replace?: boolean }) => {
      const recorder = await ensureFlightRecorderFromEnv();
      let data: unknown;
      try {
        data = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        throw new Error(
          `Cannot read Flight Recorder export: ${(error as Error).message}`,
        );
      }
      const imported = await recorder.import(
        data as import("../flight-recorder/index.js").FlightExport,
        { replace: options.replace },
      );
      console.log(`Imported ${imported} event(s) from ${file}`);
    });

  flight
    .command("clear")
    .description("Delete every locally recorded event")
    .option("--yes", "Confirm destructive deletion")
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes) {
        throw new Error("Refusing to clear without --yes.");
      }
      const recorder = await ensureFlightRecorderFromEnv();
      if (!(await recorder.clear())) {
        throw new Error(
          "Flight Recorder could not clear its database. Check flight status.",
        );
      }
      console.log("Flight Recorder cleared.");
    });
}
