/**
 * Flight Recorder runtime facade.
 *
 * The recorder is deliberately fail-open for the product and fail-loud in its
 * own health state: an unavailable audit database must never stop an agent
 * response, but it must also never masquerade as a healthy recorder.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  computeFlightEventHash,
  normalizeFlightModelId,
  normalizeFlightSessionId,
  normalizeFlightWorkspaceId,
} from "./integrity.js";
import { SQLiteFlightLedger } from "./ledger.js";
import {
  assertPrivateDirectory,
  hardenPrivatePath,
  syncParentDirectory,
} from "./permissions.js";
import {
  CURRENT_PROCESS_INCARNATION,
  registerRecorderOwner,
  unregisterRecorderOwner,
} from "./process-owner.js";
import {
  sanitizeFlightMetadata,
  sanitizeFlightPayload,
  sanitizeFlightValue,
  summarizeFlightError,
} from "./redaction.js";
import {
  FLIGHT_EVENT_SCHEMA,
  type FlightEvent,
  type FlightEventInput,
  type FlightExport,
  type FlightEventQuery,
  type FlightLedger,
  type FlightRecorderHealth,
  type FlightRecorderOptions,
  type FlightRecorderPrivacy,
  type FlightTraceContext,
} from "./types.js";

const DEFAULT_DB = path.join(
  os.homedir(),
  ".openrappter",
  "flight-recorder.db",
);
const DEFAULT_RETENTION = 10_000;
const RETENTION_BATCH_RATIO = 0.1;
let environmentRecorder: Promise<FlightRecorder> | null = null;
let recorderGeneration = 0;

function errorText(error: unknown): string {
  try {
    if (error instanceof Error) {
      return `${String(error.name)}: ${String(error.message)}`;
    }
    return String(error);
  } catch {
    return "UnknownError: [unavailable]";
  }
}

function safeErrorSummary(error: unknown): Record<string, unknown> {
  try {
    return summarizeFlightError(error);
  } catch {
    return { errorName: "UnknownError" };
  }
}

function privateIdentifier(
  value: string | undefined,
  privacy: FlightRecorderPrivacy,
  prefix: string,
  fieldKey: string = prefix,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${fieldKey} must be a string.`);
  }
  value = normalizeIdentifierUnicode(value);
  if (
    fieldKey === "kind" &&
    (
      value === "trace.started" ||
      value === "trace.completed" ||
      value === "trace.failed"
    )
  ) {
    return value;
  }

  function normalizeIdentifierUnicode(value: string): string {
    let normalized = "";
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          normalized += value[index] + value[index + 1];
          index += 1;
        } else {
          normalized += "\ufffd";
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        normalized += "\ufffd";
      } else {
        normalized += value[index];
      }
    }
    return normalized;
  }
  if (
    matchesExactRedactedValue(value, privacy.redactedValues)
  ) {
    return `${prefix}:${createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 24)}`;
  }
  if (isCanonicalPrivateIdentifier(value, prefix)) {
    return value;
  }
  if (
    sanitizeFlightValue(value, {
      redactedValues: privacy.redactedValues,
    }) !== value
  ) {
    return `${prefix}:${createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 24)}`;
  }

  if (fieldKey === "kind") {
    return sanitizeFlightValue(value, {
      redactedValues: privacy.redactedValues,
    }) === value
      ? value
      : `${prefix}:${createHash("sha256")
          .update(value)
          .digest("hex")
          .slice(0, 24)}`;
  }
  const policyKeys =
    fieldKey === "id" || fieldKey === "parentId"
      ? ["id", "parentId"]
      : [fieldKey];
  if (
    policyKeys.some(
      (key) =>
        sanitizeFlightMetadata({ [key]: value }, privacy)[key] !== value,
    )
  ) {
    return `${prefix}:${createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 24)}`;
  }

  const sanitized = sanitizeFlightValue(value, privacy);
  if (sanitized === value) return value;
  return `${prefix}:${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 24)}`;
}

function isCanonicalPrivateIdentifier(
  value: string,
  prefix: string,
): boolean {
  return new RegExp(`^${prefix}:[0-9a-f]{24}$`).test(value);
}

function matchesExactRedactedValue(
  value: string,
  redactedValues: readonly string[] | undefined,
): boolean {
  return (redactedValues ?? []).some(
    (candidate) =>
      candidate.length > 0 &&
      (/^[0-9a-f]{64}$/i.test(candidate)
        ? value.toLowerCase() === candidate.toLowerCase()
        : value === candidate),
  );
}

function isTraceSequenceConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    candidate?.code === "SQLITE_CONSTRAINT" ||
    (typeof candidate?.message === "string" &&
      /UNIQUE constraint failed:\s*flight_events\.trace_id,\s*flight_events\.sequence/i.test(
        candidate.message,
      ))
  );
}

function loadOrCreateIdentityKey(
  databasePath: string,
  explicitKey?: string,
  allowUnconfiguredCreate = true,
): string {
  const explicit = explicitKey?.trim();
  const environment =
    process.env.OPENRAPPTER_FLIGHT_ID_KEY?.trim();
  if (
    explicit &&
    environment &&
    explicit.toLowerCase() !== environment.toLowerCase()
  ) {
    throw new Error(
      "Configured Flight Recorder identity keys do not match.",
    );
  }

  const configured = explicit || environment;
  if (configured) {
    if (!/^[0-9a-f]{64}$/i.test(configured)) {
      throw new Error(
        "OPENRAPPTER_FLIGHT_ID_KEY must be 32-byte hexadecimal.",
      );
    }
  }

  const keyPath = `${databasePath}.identity-key`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const observed = lstatSync(keyPath);
      if (observed.isSymbolicLink() || !observed.isFile()) {
        throw new Error(
          "Flight Recorder identity key must be a regular file.",
        );
      }
      const descriptor = openSync(
        keyPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let existing: string;
      try {
        const opened = fstatSync(descriptor);
        const current = lstatSync(keyPath);
        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          opened.dev !== current.dev ||
          opened.ino !== current.ino
        ) {
          throw new Error(
            "Flight Recorder identity key changed during private open.",
          );
        }
        existing = readFileSync(descriptor, "utf8").trim();
      } finally {
        closeSync(descriptor);
      }
      if (/^[0-9a-f]{64}$/i.test(existing)) {
        if (
          configured &&
          existing.toLowerCase() !== configured.toLowerCase()
        ) {
          throw new Error(
            "Configured Flight Recorder identity key does not match the persisted key.",
          );
        }
        hardenPrivatePath(keyPath);
        return existing.toLowerCase();
      }
      if (existing.length > 0) {
        throw new Error("Flight Recorder identity key is invalid.");
      }
      const current = lstatSync(keyPath);
      if (
        current.dev !== observed.dev ||
        current.ino !== observed.ino ||
        current.mtimeMs !== observed.mtimeMs ||
        current.size !== observed.size
      ) {
        continue;
      }
      unlinkSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (!configured && !allowUnconfiguredCreate) {
      throw new Error(
        "Flight Recorder identity key is missing for a non-empty ledger.",
      );
    }
    const key =
      configured?.toLowerCase() ?? randomBytes(32).toString("hex");
    const temporary = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let published = false;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      hardenPrivatePath(temporary);
      writeFileSync(descriptor, `${key}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, keyPath);
        hardenPrivatePath(keyPath);
        syncParentDirectory(path.dirname(keyPath));
        published = true;
        return key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        // Another process may already have cleaned its temporary key.
      }
      if (published) syncParentDirectory(path.dirname(keyPath));
    }
  }
  throw new Error("Flight Recorder identity key could not be created.");
}

function prepareManagedDatabaseDirectory(directory: string): void {
  let existing = directory;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  assertPrivateDirectory(existing);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(directory);
  hardenPrivatePath(directory, true);
}

interface TraceGeneration {
  active: boolean;
}

interface StoredFlightTraceContext extends FlightTraceContext {
  generation?: TraceGeneration;
}

export class FlightRecorder {
  private readonly options: Required<
    Pick<FlightRecorderOptions, "enabled" | "retentionEvents">
  > &
    Omit<FlightRecorderOptions, "enabled" | "retentionEvents">;
  private readonly privacy: FlightRecorderPrivacy;
  private readonly managesDatabaseParent: boolean;
  private readonly ownsLedger: boolean;
  private readonly traceStorage =
    new AsyncLocalStorage<StoredFlightTraceContext>();
  private readonly sequenceByTrace = new Map<string, number>();
  private readonly sequenceLocks = new Map<string, Promise<void>>();
  private ledger: FlightLedger | null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private nextInitializationAttemptAt = 0;
  private closed = false;
  private closing = false;
  private clearing = false;
  private clearOperation: Promise<boolean> | null = null;
  private closeOperation: Promise<void> | null = null;
  private activeTraceOperations = 0;
  private readonly traceIdleWaiters = new Set<() => void>();
  private activeMutations = 0;
  private readonly mutationIdleWaiters = new Set<() => void>();
  private errorCount = 0;
  private lastError: string | undefined;
  private retainedEventCount = 0;
  private nextRetentionCheckCount = 0;
  private retentionMaintenance: Promise<void> | null = null;
  private identityKey: string | undefined;
  private readonly ownerId = randomUUID();
  private ownerPath: string | undefined;

  constructor(options: FlightRecorderOptions = {}, ledger?: FlightLedger) {
    this.options = {
      ...options,
      enabled: options.enabled ?? true,
      retentionEvents: options.retentionEvents ?? DEFAULT_RETENTION,
    };
    this.privacy = {
      ...options.privacy,
      redactedKeys: [...(options.privacy?.redactedKeys ?? [])],
      redactedValues: [...(options.privacy?.redactedValues ?? [])],
      excludedPathPatterns: [
        ...(options.privacy?.excludedPathPatterns ?? []),
      ],
    };
    this.identityKey = options.identityKey?.trim().toLowerCase();
    this.managesDatabaseParent = options.databasePath === undefined;
    this.ownsLedger = ledger === undefined;
    this.ledger = ledger ?? null;
  }

  async initialize(): Promise<void> {
    if (
      !this.options.enabled ||
      this.initialized ||
      this.closed ||
      this.closing ||
      performance.now() < this.nextInitializationAttemptAt
    ) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async initializeOnce(): Promise<void> {
    try {
      const databasePath = this.options.databasePath ?? DEFAULT_DB;
      const createsLedger = this.ledger === null;
      if (!this.options.inMemory && createsLedger) {
        const directory = path.dirname(databasePath);
        if (this.managesDatabaseParent) {
          prepareManagedDatabaseDirectory(directory);
        } else {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          assertPrivateDirectory(directory);
        }
        this.ownerPath = registerRecorderOwner(
          databasePath,
          this.ownerId,
        );
      }
      if (this.options.inMemory || !createsLedger) {
        this.identityKey ??= randomBytes(32).toString("hex");
      }
      this.ledger ??= new SQLiteFlightLedger({
        databasePath,
        inMemory: this.options.inMemory,
      });
      await this.ledger.initialize();
      if (this.closed || this.closing) {
        await this.ledger.close();
        return;
      }
      this.retainedEventCount = await this.ledger.count();
      if (!this.options.inMemory && createsLedger) {
        this.identityKey = loadOrCreateIdentityKey(
          databasePath,
          this.identityKey,
          this.retainedEventCount === 0,
        );
      }
      if (!this.identityKey || !/^[0-9a-f]{64}$/i.test(this.identityKey)) {
        throw new Error(
          "Flight Recorder identity key must be 32-byte hexadecimal.",
        );
      }
      await this.ledger.bindIdentityKey?.(this.identityKey);
      if (!this.privacy.redactedValues?.includes(this.identityKey)) {
        this.privacy.redactedValues = [
          ...(this.privacy.redactedValues ?? []),
          this.identityKey,
        ];
      }
      this.nextRetentionCheckCount = this.options.retentionEvents + 1;
      if (!this.options.inMemory && createsLedger) {
        hardenPrivatePath(databasePath);
      }
      this.initialized = true;
      this.nextInitializationAttemptAt = 0;
      this.lastError = undefined;
    } catch (error) {
      if (this.ownsLedger && this.ledger) {
        try {
          await this.ledger.close();
        } catch {
          // Preserve the original initialization error.
        }
        this.ledger = null;
      }
      unregisterRecorderOwner(this.ownerPath);
      this.ownerPath = undefined;
      this.noteError(error);
      this.nextInitializationAttemptAt = performance.now() + 1_000;
      // Fail open: callers can continue using OpenRappter and inspect health().
      this.initialized = false;
    }
  }

  async close(): Promise<void> {
    if (this.currentTrace()) {
      throw new Error(
        "Flight Recorder cannot close from inside an active trace.",
      );
    }
    if (this.closeOperation) return this.closeOperation;
    const operation = this.closeOnce();
    this.closeOperation = operation;
    try {
      await operation;
    } finally {
      if (this.closeOperation === operation) {
        this.closeOperation = null;
      }
    }
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) return;
    if (this.currentTrace()) {
      throw new Error(
        "Flight Recorder cannot close from inside an active trace.",
      );
    }
    this.closing = true;
    if (this.clearOperation) {
      try {
        await this.clearOperation;
      } catch {
        // Close must still release resources after a failed clear.
      }
    }
    if (this.initializing) {
      await this.initializing;
    }
    await this.waitForActiveTraces();
    await this.waitForMutations();
    this.closed = true;
    await Promise.all([...this.sequenceLocks.values()]);
    try {
      await this.ledger?.close();
    } catch (error) {
      this.noteError(error);
    } finally {
      this.initialized = false;
      this.sequenceByTrace.clear();
      this.sequenceLocks.clear();
      this.retainedEventCount = 0;
      this.nextRetentionCheckCount = 0;
      this.retentionMaintenance = null;
      this.closing = false;
      unregisterRecorderOwner(this.ownerPath);
      this.ownerPath = undefined;
    }
  }

  currentTrace(): FlightTraceContext | undefined {
    const context = this.currentTraceState();
    if (!context) return undefined;
    const { generation: _generation, ...publicContext } = context;
    return publicContext;
  }

  private currentTraceState(): StoredFlightTraceContext | undefined {
    const context = this.traceStorage.getStore();
    return context?.generation?.active === false ? undefined : context;
  }

  childProcessEnvironment(): NodeJS.ProcessEnv {
    const hasCustomPrivacy =
      (this.privacy.redactedKeys?.length ?? 0) > 0 ||
      (this.privacy.excludedPathPatterns?.length ?? 0) > 0 ||
      (this.privacy.redactedValues ?? []).some(
        (value) => value !== this.identityKey,
      );
    const shareable =
      this.options.enabled &&
      this.initialized &&
      !this.options.inMemory &&
      this.ownsLedger &&
      !hasCustomPrivacy;
    if (!shareable) {
      return { OPENRAPPTER_FLIGHT_RECORDER: "0" };
    }
    const trace = this.currentTrace();
    return {
      OPENRAPPTER_FLIGHT_RECORDER: "1",
      OPENRAPPTER_FLIGHT_DB: this.options.databasePath ?? DEFAULT_DB,
      OPENRAPPTER_FLIGHT_RETENTION: String(this.options.retentionEvents),
      OPENRAPPTER_FLIGHT_RECORD_IO:
        this.privacy.recordIO === true ? "1" : "0",
      ...(this.privacy.maxPayloadBytes === undefined
        ? {}
        : {
            OPENRAPPTER_FLIGHT_MAX_PAYLOAD: String(
              this.privacy.maxPayloadBytes,
            ),
          }),
      ...(trace
        ? {
            OPENRAPPTER_FLIGHT_TRACE_ID: trace.traceId,
            ...(trace.parentId
              ? { OPENRAPPTER_FLIGHT_PARENT_ID: trace.parentId }
              : {}),
            ...(trace.sessionId
              ? { OPENRAPPTER_FLIGHT_SESSION_ID: trace.sessionId }
              : {}),
            ...(trace.workspaceId
              ? { OPENRAPPTER_FLIGHT_WORKSPACE_ID: trace.workspaceId }
              : {}),
          }
        : {}),
    };
  }

  async withTraceContext<T>(
    context: FlightTraceContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const generation = { active: true };
    try {
      return await this.traceStorage.run(
        { ...context, generation },
        operation,
      );
    } finally {
      generation.active = false;
    }
  }

  async withParent<T>(
    parentId: string | null | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const current = this.currentTraceState();
    if (!current) return operation();
    return this.traceStorage.run(
      {
        ...current,
        parentId:
          parentId === undefined ? current.parentId ?? null : parentId,
      },
      operation,
    );
  }

  /**
   * Run work inside one correlated trace and record its terminal outcome.
   *
   * A nested call preserves the existing trace by default and uses the current
   * event as its parent only when the caller supplies one explicitly.
   */
  async runTrace<T>(
    context: Partial<FlightTraceContext>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const inherited = this.currentTrace();
    if (!inherited && (this.closed || this.closing || this.clearing)) {
      return operation();
    }
    this.activeTraceOperations += 1;
    try {
      if (
        this.options.enabled &&
        !this.initialized &&
        !this.closed &&
        !this.closing
      ) {
        await this.initialize();
      }
      const normalizedTraceId = privateIdentifier(
        inherited?.traceId ??
          context.traceId ??
          randomUUID(),
        inherited?.traceId
          ? { ...this.privacy, redactedValues: [] }
          : this.privacy,
        "trace",
        "traceId",
      )!;
      const trace: FlightTraceContext = {
        traceId: normalizedTraceId,
        sessionId: this.identityKey
          ? normalizeFlightSessionId(
              context.sessionId ?? inherited?.sessionId,
              this.identityKey,
              this.privacy.redactedValues,
            )
          : context.sessionId ?? inherited?.sessionId,
        workspaceId: normalizeFlightWorkspaceId(
          privateIdentifier(
            context.workspaceId ?? inherited?.workspaceId,
            this.privacy,
            "workspace",
            "workspaceId",
          ),
        ),
        parentId:
          context.parentId === undefined
            ? inherited?.parentId ?? null
            : context.parentId,
      };
      const generation = { active: true };
      try {
        return await this.traceStorage.run(
          { ...trace, generation },
          async () => {
            const started = performance.now();
            const root = await this.record({
              kind: "trace.started",
              source: "runtime",
              status: "started",
              metadata: { nested: Boolean(inherited) },
            });
            return this.withParent(root?.id ?? null, async () => {
              try {
                if (!root) return await operation();
                const result = await operation();
                const terminal = await this.record({
                  kind: "trace.completed",
                  source: "runtime",
                  status: "success",
                  durationMs: performance.now() - started,
                });
                if (!terminal && root) {
                  await this.releaseStartOwnership(root.id);
                }
                return result;
              } catch (error) {
                if (!root) throw error;
                let terminal: FlightEvent | null = null;
                try {
                  terminal = await this.record({
                    kind: "trace.failed",
                    source: "runtime",
                    status: "error",
                    durationMs: performance.now() - started,
                    metadata: safeErrorSummary(error),
                    payload: { error: errorText(error) },
                  });
                } finally {
                  if (!terminal && root) {
                    await this.releaseStartOwnership(root.id);
                  }
                }
                throw error;
              } finally {
                this.sequenceByTrace.delete(normalizedTraceId);
              }
            });
          },
        );
      } finally {
        generation.active = false;
      }
    } finally {
      this.activeTraceOperations -= 1;
      if (this.activeTraceOperations === 0) {
        for (const resolve of this.traceIdleWaiters) resolve();
        this.traceIdleWaiters.clear();
      }
    }
  }

  /**
   * Append one sanitized event.
   *
   * Returns null when disabled or unhealthy. It never throws into the product
   * execution path; health() carries the failure instead.
   */
  async record(input: FlightEventInput): Promise<FlightEvent | null> {
    if (
      !this.options.enabled ||
      this.closed ||
      (this.closing && !this.currentTrace())
    ) return null;
    if (!this.initialized || !this.ledger) {
      await this.initialize();
      if (this.closed || !this.initialized || !this.ledger) return null;
    }

    const context = this.currentTrace();
    if (this.clearing && !context) return null;
    const traceId = privateIdentifier(
      input.traceId ?? context?.traceId ?? randomUUID(),
      this.privacy,
      "trace",
      "traceId",
    )!;

    this.activeMutations += 1;
    try {
      let event: FlightEvent | undefined;
      let conflictAttempt = 0;
      while (!this.closed) {
        try {
          event = await this.withTraceSequence(traceId, async (sequence) => {
            const timestamp = input.timestamp ?? new Date().toISOString();
            const sanitizedPayload = sanitizeFlightPayload(
              input.payload,
              this.privacy,
            );
            const metadata = sanitizeFlightMetadata(
              input.metadata,
              this.privacy,
            );
            delete metadata.ownerPid;
            delete metadata.ownerId;
            delete metadata.ownerIncarnation;
            if (
              input.kind === "trace.started" &&
              input.source === "runtime"
            ) {
              metadata.ownerPid = process.pid;
              if (CURRENT_PROCESS_INCARNATION) {
                metadata.ownerIncarnation =
                  CURRENT_PROCESS_INCARNATION;
              }
            }
            const eventWithoutHash: Omit<FlightEvent, "contentHash"> = {
              schema: FLIGHT_EVENT_SCHEMA,
              id: privateIdentifier(
                randomUUID(),
                this.privacy,
                "event",
                "id",
              )!,
              sequence,
              traceId,
              parentId:
                input.parentId === null
                  ? null
                  : privateIdentifier(
                      input.parentId === undefined
                        ? context?.parentId ?? undefined
                        : input.parentId,
                      this.privacy,
                      "event",
                      "parentId",
                    ) ?? null,
              sessionId: normalizeFlightSessionId(
                input.sessionId ?? context?.sessionId,
                this.identityKey!,
                this.privacy.redactedValues,
              ),
              workspaceId: normalizeFlightWorkspaceId(
                privateIdentifier(
                  input.workspaceId ?? context?.workspaceId,
                  this.privacy,
                  "workspace",
                  "workspaceId",
                ),
              ),
              kind: privateIdentifier(
                input.kind,
                this.privacy,
                "kind",
                "kind",
              )!,
              source: privateIdentifier(
                input.source,
                this.privacy,
                "source",
                "source",
              )!,
              status: input.status ?? "info",
              timestamp,
              durationMs: input.durationMs,
              providerId: privateIdentifier(
                input.providerId,
                this.privacy,
                "provider",
                "providerId",
              ),
              model:
                sanitizeFlightMetadata(
                  { model: input.model },
                  this.privacy,
                ).model === input.model &&
                sanitizeFlightValue(input.model, this.privacy) === input.model
                  ? normalizeFlightModelId(input.model)
                  : undefined,
              agentName: privateIdentifier(
                input.agentName,
                this.privacy,
                "agent",
                "agentName",
              ),
              toolName: privateIdentifier(
                input.toolName,
                this.privacy,
                "tool",
                "toolName",
              ),
              metadata,
            };
            if (sanitizedPayload !== undefined)
              eventWithoutHash.payload = sanitizedPayload;
            const persisted: FlightEvent = {
              ...eventWithoutHash,
              contentHash: computeFlightEventHash(eventWithoutHash),
            };
            await this.ledger!.append(persisted);
            return persisted;
          });
          break;
        } catch (error) {
          if (isTraceSequenceConflict(error) && !this.closed) {
            this.sequenceByTrace.delete(traceId);
            conflictAttempt += 1;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(conflictAttempt, 10)),
            );
            continue;
          }
          throw error;
        }
      }
      if (!event) {
        throw new Error("Flight Recorder is closed.");
      }
      try {
        this.retainedEventCount = await this.ledger!.count();
        await this.enforceRetention(
          input.kind === "trace.completed" || input.kind === "trace.failed",
        );
      } catch (error) {
        // The event is already durable. Retention health must be surfaced, but
        // callers still need its ID for child causality and its true sequence.
        this.noteError(error);
      }
      return event;
    } catch (error) {
      this.noteError(error);
      return null;
    } finally {
      if (!context || context.traceId !== traceId) {
        this.sequenceByTrace.delete(traceId);
      }
      this.activeMutations -= 1;
      if (this.activeMutations === 0) {
        for (const resolve of this.mutationIdleWaiters) resolve();
        this.mutationIdleWaiters.clear();
      }
    }
  }

  async exportTrace(traceId: string): Promise<FlightExport | null> {
    return this.export({ traceId });
  }

  async query(query: FlightEventQuery = {}): Promise<FlightEvent[]> {
    const ledger = this.requireInspectionLedger();
    try {
        return await ledger.query(
          normalizeFlightQuery(query, this.identityKey!, this.privacy),
        );
    } catch (error) {
      this.noteError(error);
      throw error;
    }
  }

  async export(query: FlightEventQuery = {}): Promise<FlightExport | null> {
    const ledger = this.requireInspectionLedger();
    try {
      return await ledger.export(
        normalizeFlightQuery(query, this.identityKey!, this.privacy),
      );
    } catch (error) {
      this.noteError(error);
      throw error;
    }
  }

  async import(
    data: FlightExport,
    options: { replace?: boolean } = {},
  ): Promise<number> {
    if (this.closed || this.closing) {
      throw new Error("Flight Recorder close is in progress.");
    }
    const ledger = this.requireInspectionLedger();
    if (this.clearing && !this.currentTrace()) {
      throw new Error("Flight Recorder clear is in progress.");
    }
    this.activeMutations += 1;
    try {
      for (const event of data.events) {
        for (const [key, prefix] of [
          ["id", "event"],
          ["kind", "kind"],
          ["source", "source"],
          ["traceId", "trace"],
          ["parentId", "event"],
          ["providerId", "provider"],
          ["agentName", "agent"],
          ["toolName", "tool"],
        ] as const) {
          const value = event[key];
          if (
            typeof value === "string" &&
            privateIdentifier(value, this.privacy, prefix, key) !== value
          ) {
            throw new Error(
              `Flight Recorder import ${key} violates active privacy policy.`,
            );
          }
        }
        if (
          event.sessionId !== undefined &&
          normalizeFlightSessionId(
            event.sessionId,
            this.identityKey!,
            this.privacy.redactedValues,
          ) !== event.sessionId
        ) {
          throw new Error(
            "Flight Recorder import sessionId violates active privacy policy.",
          );
        }
        if (
          event.workspaceId !== undefined &&
          normalizeFlightWorkspaceId(
            privateIdentifier(
              event.workspaceId,
              this.privacy,
              "workspace",
              "workspaceId",
            ),
          ) !== event.workspaceId
        ) {
          throw new Error(
            "Flight Recorder import workspaceId violates active privacy policy.",
          );
        }
        if (
          event.model !== undefined &&
          (sanitizeFlightMetadata(
            { model: event.model },
            this.privacy,
          ).model !== event.model ||
            sanitizeFlightValue(event.model, this.privacy) !== event.model)
        ) {
          throw new Error(
            "Flight Recorder import model violates active privacy policy.",
          );
        }
        if (
          !isDeepStrictEqual(
            sanitizeFlightMetadata(event.metadata, this.privacy),
            event.metadata,
          )
        ) {
          throw new Error(
            "Flight Recorder import metadata violates active privacy policy.",
          );
        }
        if (Object.hasOwn(event, "payload")) {
          if (this.privacy.recordIO !== true) {
            throw new Error(
              "Flight Recorder import contains payload IO while recordIO is disabled.",
            );
          }
          if (
            !isDeepStrictEqual(
              sanitizeFlightPayload(event.payload, {
                ...this.privacy,
                recordIO: true,
              }),
              event.payload,
            )
          ) {
            throw new Error(
              "Flight Recorder import payload violates active privacy policy.",
            );
          }
        }
      }
      const imported = await ledger.import(data, options);
      for (const event of data.events)
        this.sequenceByTrace.delete(event.traceId);
      this.retainedEventCount = await ledger.count();
      this.nextRetentionCheckCount = this.options.retentionEvents + 1;
      return imported;
    } catch (error) {
      this.noteError(error);
      throw error;
    } finally {
      this.activeMutations -= 1;
      if (this.activeMutations === 0) {
        for (const resolve of this.mutationIdleWaiters) resolve();
        this.mutationIdleWaiters.clear();
      }
    }
  }

  async clear(): Promise<boolean> {
    if (this.currentTrace()) {
      throw new Error(
        "Flight Recorder cannot clear from inside an active trace.",
      );
    }
    if (this.clearOperation) return this.clearOperation;
    const operation = this.clearOnce();
    this.clearOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.clearOperation === operation) {
        this.clearOperation = null;
      }
    }
  }

  private async clearOnce(): Promise<boolean> {
    const ledger = this.requireInspectionLedger();
    if (this.closing) {
      throw new Error("Flight Recorder close is in progress.");
    }
    if (this.currentTrace()) {
      throw new Error(
        "Flight Recorder cannot clear from inside an active trace.",
      );
    }
    this.clearing = true;
    try {
      await this.waitForActiveTraces();
      await this.waitForMutations();
      await ledger.clear();
      this.sequenceByTrace.clear();
      this.retainedEventCount = 0;
      this.nextRetentionCheckCount = this.options.retentionEvents + 1;
      return true;
    } catch (error) {
      this.noteError(error);
      throw error;
    } finally {
      this.clearing = false;
    }
  }

  async health(): Promise<FlightRecorderHealth> {
    let eventCount = 0;
    if (this.initialized && this.ledger) {
      try {
        eventCount = await this.ledger.count();
      } catch (error) {
        this.noteError(error);
      }
    }
    return {
      enabled: this.options.enabled,
      initialized: this.initialized,
      eventCount,
      errorCount: this.errorCount,
      lastError: this.lastError,
      databasePath: this.options.inMemory
        ? ":memory:"
        : (this.options.databasePath ?? DEFAULT_DB),
    };
  }

  private noteError(error: unknown): void {
    this.errorCount += 1;
    this.lastError = errorText(error);
  }

  private async waitForActiveTraces(): Promise<void> {
    if (this.activeTraceOperations === 0) return;
    await new Promise<void>((resolve) => {
      this.traceIdleWaiters.add(resolve);
    });
  }

  private async waitForMutations(): Promise<void> {
    if (this.activeMutations === 0) return;
    await new Promise<void>((resolve) => {
      this.mutationIdleWaiters.add(resolve);
    });
  }

  private async releaseStartOwnership(eventId: string): Promise<void> {
    try {
      await this.ledger?.releaseEventOwnership?.(eventId);
    } catch (error) {
      this.noteError(error);
    }
  }

  private async enforceRetention(force = false): Promise<void> {
    const highWater = this.options.retentionEvents;
    if (
      highWater < 0 ||
      this.retainedEventCount <= highWater ||
      (!force && this.retainedEventCount < this.nextRetentionCheckCount)
    ) {
      return;
    }
    if (this.retentionMaintenance) {
      await this.retentionMaintenance;
      if (!force || this.retainedEventCount <= highWater) {
        return;
      }
    }

    const batch = Math.max(1, Math.ceil(highWater * RETENTION_BATCH_RATIO));
    const target = highWater > 100 ? Math.max(0, highWater - batch) : highWater;
    const maintenance = (async () => {
      const deleted = this.ledger!.pruneRuntime
        ? await this.ledger!.pruneRuntime(target)
        : await this.ledger!.prune(target);
      this.retainedEventCount = Math.max(
        0,
        this.retainedEventCount - deleted,
      );
      this.nextRetentionCheckCount =
        this.retainedEventCount > highWater
          ? this.retainedEventCount + batch
          : highWater + 1;
    })();
    this.retentionMaintenance = maintenance;
    try {
      await maintenance;
    } finally {
      if (this.retentionMaintenance === maintenance) {
        this.retentionMaintenance = null;
      }
    }
  }

  private requireInspectionLedger(): FlightLedger {
    if (!this.options.enabled) {
      throw new Error("Flight Recorder is disabled.");
    }
    if (!this.initialized || !this.ledger) {
      throw new Error(
        `Flight Recorder is unavailable${this.lastError ? `: ${this.lastError}` : "."}`,
      );
    }
    return this.ledger;
  }

  /**
   * Serialize sequence assignment per trace without blocking unrelated traces.
   */
  private async withTraceSequence<T>(
    traceId: string,
    operation: (sequence: number) => Promise<T>,
  ): Promise<T> {
    const previous = this.sequenceLocks.get(traceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.sequenceLocks.set(traceId, tail);

    await previous;
    try {
      let sequence = this.sequenceByTrace.get(traceId);
      if (sequence === undefined) {
        sequence = await this.loadLastSequence(traceId);
      }
      const next = sequence + 1;
      const result = await operation(next);
      this.sequenceByTrace.set(traceId, next);
      return result;
    } finally {
      release();
      if (this.sequenceLocks.get(traceId) === tail) {
        this.sequenceLocks.delete(traceId);
      }
    }
  }

  private async loadLastSequence(traceId: string): Promise<number> {
    if (this.ledger?.lastSequence) {
      return this.ledger.lastSequence(traceId);
    }
    const latest = await this.ledger!.query({
      traceId,
      order: "desc",
      limit: 1,
    });
    return latest[0]?.sequence ?? 0;
  }
}

function normalizeFlightQuery(
  query: FlightEventQuery,
  identityKey: string,
  privacy: FlightRecorderPrivacy,
): FlightEventQuery {
  return {
    ...query,
    ...(query.traceId === undefined
      ? {}
      : {
          traceId: isCanonicalPrivateIdentifier(query.traceId, "trace")
            ? query.traceId
            : privateIdentifier(
                query.traceId,
                privacy,
                "trace",
                "traceId",
              ),
        }),
    ...(query.sessionId === undefined
      ? {}
      : {
          sessionId: normalizeFlightSessionId(
            query.sessionId,
            identityKey,
            privacy.redactedValues,
          ),
        }),
    ...(query.workspaceId === undefined
      ? {}
      : {
          workspaceId: normalizeFlightWorkspaceId(
            privateIdentifier(
              query.workspaceId,
              privacy,
              "workspace",
              "workspaceId",
            ),
          ),
        }),
    ...(query.source === undefined
      ? {}
      : {
          source: privateIdentifier(
            query.source,
            privacy,
            "source",
            "source",
          ),
        }),
    ...(query.providerId === undefined
      ? {}
      : {
          providerId: privateIdentifier(
            query.providerId,
            privacy,
            "provider",
            "providerId",
          ),
        }),
    ...(query.agentName === undefined
      ? {}
      : {
          agentName: privateIdentifier(
            query.agentName,
            privacy,
            "agent",
            "agentName",
          ),
        }),
    ...(query.toolName === undefined
      ? {}
      : {
          toolName: privateIdentifier(
            query.toolName,
            privacy,
            "tool",
            "toolName",
          ),
        }),
  };
}

let globalRecorder = new FlightRecorder({ enabled: false });

export function getFlightRecorder(): FlightRecorder {
  return globalRecorder;
}

export function setFlightRecorder(recorder: FlightRecorder): FlightRecorder {
  const previous = globalRecorder;
  recorderGeneration += 1;
  globalRecorder = recorder;
  environmentRecorder = Promise.resolve(recorder);
  return previous;
}

export async function withFlightTrace<T>(
  context: Partial<FlightTraceContext>,
  operation: () => Promise<T>,
): Promise<T> {
  return globalRecorder.runTrace(context, operation);
}

/**
 * Configure the process-global recorder once from environment variables.
 *
 * Summary events are enabled by default for the actual product. Vitest and
 * other test processes remain disabled unless explicitly opted in, preventing
 * imports from writing into a developer's real ~/.openrappter directory.
 *
 * Raw IO remains opt-in even when the recorder itself is enabled.
 */
export function ensureFlightRecorderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FlightRecorder> {
  if (environmentRecorder) return environmentRecorder;

  const generation = recorderGeneration;
  environmentRecorder = (async () => {
    const enabled =
      env.OPENRAPPTER_FLIGHT_RECORDER === "1" ||
      (env.OPENRAPPTER_FLIGHT_RECORDER !== "0" && env.NODE_ENV !== "test");
    const retention = Number.parseInt(
      env.OPENRAPPTER_FLIGHT_RETENTION ?? String(DEFAULT_RETENTION),
      10,
    );
    const recorder = new FlightRecorder({
      enabled,
      ...(env.OPENRAPPTER_FLIGHT_DB?.trim()
        ? { databasePath: env.OPENRAPPTER_FLIGHT_DB }
        : {}),
      retentionEvents:
        Number.isSafeInteger(retention) && retention >= 0
          ? retention
          : DEFAULT_RETENTION,
      privacy: {
        recordIO: env.OPENRAPPTER_FLIGHT_RECORD_IO === "1",
        maxPayloadBytes: env.OPENRAPPTER_FLIGHT_MAX_PAYLOAD
          ? Number.parseInt(env.OPENRAPPTER_FLIGHT_MAX_PAYLOAD, 10)
          : undefined,
      },
    });
    await recorder.initialize();
    if (generation === recorderGeneration) {
      globalRecorder = recorder;
      return recorder;
    }
    await recorder.close();
    return globalRecorder;
  })();

  return environmentRecorder;
}

/** Test-only reset for processes that need to exercise env bootstrap twice. */
export function resetFlightRecorderEnvironmentForTests(): void {
  environmentRecorder = null;
}
