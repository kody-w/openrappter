import type {
  CanonicalPort, CommittedCommand, Heads, JsonObject, JsonValue,
  TerminalStatus, VerifiedHistory, WorkCommand, WorkSnapshot, WorkspaceScope,
} from "./ports.js";

export class WorkServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkServiceError";
  }
}

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function sameScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return a.agentId === b.agentId && a.workspaceId === b.workspaceId;
}

export function validateScope(scope: WorkspaceScope): void {
  if (!scope || !text(scope.agentId) || !text(scope.workspaceId)) {
    throw new WorkServiceError("invalid_scope");
  }
}

export function validateCommand(command: WorkCommand): void {
  validateScope(command.scope);
  if (!text(command.idempotencyKey) || !text(command.operation)
    || !/^[a-z][a-z0-9_.-]*$/u.test(command.operation)
    || !Array.isArray(command.resources)
    || command.resources.some((resource) => !resource || !text(resource.id)
      || !["agent", "workspace", "task", "run", "computer", "artifact"].includes(resource.kind))) {
    throw new WorkServiceError("invalid_command");
  }
}

export function jsonCopy<T>(value: T): T {
  const active = new Set<object>();
  function copy(input: unknown, depth = 0): JsonValue {
    if (depth > 64) throw new WorkServiceError("invalid_json");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null || active.has(input)) {
      throw new WorkServiceError("invalid_json");
    }
    if (!Array.isArray(input) && !object(input)) throw new WorkServiceError("invalid_json");
    active.add(input);
    let result: JsonValue;
    if (Array.isArray(input)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (!descriptor || !("value" in descriptor)) throw new WorkServiceError("invalid_json");
        output.push(copy(descriptor.value, depth + 1));
      }
      result = output;
    } else {
      const output: JsonObject = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw new WorkServiceError("invalid_json");
        Object.defineProperty(output, key, {
          value: copy(descriptor.value, depth + 1), enumerable: true, writable: false, configurable: false,
        });
      }
      result = output;
    }
    active.delete(input);
    return Object.freeze(result) as JsonValue;
  }
  return copy(value) as T;
}

function validHeads(heads: Heads): boolean {
  return object(heads) && ["body", "memory", "swarm"].every((stream) =>
    heads[stream as keyof Heads] === null || text(heads[stream as keyof Heads]));
}

export function assertExtension(before: VerifiedHistory, after: VerifiedHistory): void {
  if (!sameScope(before.scope, after.scope) || after.frames.length < before.frames.length) {
    throw new WorkServiceError("history_rollback");
  }
  for (const stream of ["body", "memory", "swarm"]) {
    const prefix = before.frames.filter((frame) => frame.stream === stream);
    const extended = after.frames.filter((frame) => frame.stream === stream);
    if (prefix.some((frame, index) => frame.ref !== extended[index]?.ref)) {
      throw new WorkServiceError("history_rollback");
    }
  }
}

interface Pending {
  command: WorkCommand;
  hash: string;
  principalId: string;
  intentRef: string;
  outcome?: { ref: string; value: JsonObject };
  committed?: CommittedCommand;
}

const terminal = new Set<string>(["succeeded", "failed", "cancelled", "denied"]);

/** Domain reducers see only complete intent/outcome/evidence triples. */
export function reduceHistory(history: VerifiedHistory, canonical: CanonicalPort): WorkSnapshot {
  validateScope(history.scope);
  if (!validHeads(history.heads) || !Array.isArray(history.frames)) {
    throw new WorkServiceError("invalid_verified_history");
  }
  const refs = new Set<string>();
  const pending = new Map<string, Pending>();
  const keys = new Set<string>();
  const last: Record<string, string | null> = { body: null, memory: null, swarm: null };
  for (const frame of history.frames) {
    if (!text(frame.ref) || refs.has(frame.ref) || !Object.hasOwn(last, frame.stream)) {
      throw new WorkServiceError("invalid_verified_history");
    }
    refs.add(frame.ref);
    last[frame.stream] = frame.ref;
    const event = frame.value;
    if (!object(event) || typeof event.type !== "string" || !event.type.startsWith("work.")) continue;
    if (frame.stream !== "body" || event.version !== 1 || !text(event.commandHash)) {
      throw new WorkServiceError("invalid_work_event");
    }
    if (event.type === "work.intent") {
      if (!object(event.command) || !text(event.principalId)) {
        throw new WorkServiceError("invalid_intent");
      }
      const command = event.command as unknown as WorkCommand;
      validateCommand(command);
      if (!sameScope(command.scope, history.scope)
        || canonical.digest(event.command) !== event.commandHash
        || pending.has(event.commandHash) || keys.has(command.idempotencyKey)) {
        throw new WorkServiceError("invalid_intent");
      }
      keys.add(command.idempotencyKey);
      pending.set(event.commandHash, {
        command, hash: event.commandHash, principalId: event.principalId, intentRef: frame.ref,
      });
      continue;
    }
    const entry = pending.get(event.commandHash);
    if (!entry || event.intentRef !== entry.intentRef || entry.committed) {
      throw new WorkServiceError("unlinked_work_event");
    }
    if (event.type === "work.outcome") {
      if (entry.outcome || typeof event.status !== "string" || !terminal.has(event.status)
        || !Object.hasOwn(event, "value") || !text(event.receiptsHash)
        || !Array.isArray(event.events) || !event.events.every(object)) {
        throw new WorkServiceError("invalid_outcome");
      }
      entry.outcome = { ref: frame.ref, value: event };
    } else if (event.type === "work.evidence") {
      if (!entry.outcome || entry.outcome.ref !== event.outcomeRef
        || !Array.isArray(event.receipts) || event.receipts.length === 0 || !event.receipts.every(object)
        || canonical.digest(event.receipts) !== entry.outcome.value.receiptsHash) {
        throw new WorkServiceError("invalid_evidence");
      }
      entry.committed = {
        state: "committed", command: entry.command, commandHash: entry.hash,
        principalId: entry.principalId, status: entry.outcome.value.status as TerminalStatus,
        value: entry.outcome.value.value!, events: entry.outcome.value.events as JsonObject[],
        receipts: event.receipts,
        proof: {
          intentRef: entry.intentRef, outcomeRef: entry.outcome.ref,
          evidenceRef: frame.ref, heads: history.heads,
        },
      };
    } else {
      throw new WorkServiceError("unsupported_work_event");
    }
  }
  if (Object.entries(last).some(([stream, ref]) => history.heads[stream as keyof Heads] !== ref)) {
    throw new WorkServiceError("invalid_verified_heads");
  }
  return jsonCopy({
    scope: history.scope,
    heads: history.heads,
    commands: [...pending.values()].map((entry) => entry.committed ?? {
      state: "unresolved" as const, command: entry.command, commandHash: entry.hash,
      principalId: entry.principalId, intentRef: entry.intentRef,
      reason: entry.outcome ? "outcome-unproven" as const : "intent-only" as const,
    }),
  });
}
