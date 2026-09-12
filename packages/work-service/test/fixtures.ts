import { createHash } from "node:crypto";
import { WorkService } from "../src/index.js";
import type {
  CanonicalPort, Heads, JsonObject, JsonValue, VerifiedHistory,
  WorkAuthorizationPort, WorkCommand, WorkspaceHistoryPort, WorkspaceScope,
} from "../src/index.js";

export const scope: WorkspaceScope = { agentId: "agent-a", workspaceId: "workspace-a" };
export const otherScope: WorkspaceScope = { agentId: "agent-b", workspaceId: "workspace-b" };
export const emptyHeads = (): Heads => ({ body: null, memory: null, swarm: null });
export function digest(value: unknown): string {
  function ordered(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)]));
    }
    return input;
  }
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

interface Frame {
  owner: WorkspaceScope;
  stream: "body";
  previous: string | null;
  ref: string;
  value: JsonValue;
}

export class TestHistory implements WorkspaceHistoryPort, CanonicalPort {
  readonly entries = new Map<string, Frame[]>();
  readonly log: string[] = [];
  private readonly locks = new Map<string, Promise<void>>();
  appendCount = 0;
  scanCount = 0;
  readCount = 0;
  failBeforeAppend = 0;
  failAfterAppend = 0;
  dropAppend = 0;
  failScan = 0;
  failRead = 0;
  onAppend?: (count: number) => void;
  digest = digest;

  key(owner: WorkspaceScope): string {
    return `${owner.agentId}:${owner.workspaceId}`;
  }
  frames(owner = scope): Frame[] {
    return this.entries.get(this.key(owner)) ?? [];
  }
  appendEvent(owner: WorkspaceScope, value: JsonValue): void {
    const frames = this.frames(owner);
    const material = { owner, stream: "body" as const, previous: frames.at(-1)?.ref ?? null, value };
    frames.push({ ...structuredClone(material), ref: digest(material) });
    this.entries.set(this.key(owner), frames);
  }
  scan(raw: unknown, owner: WorkspaceScope): VerifiedHistory {
    this.log.push("scan");
    if (++this.scanCount === this.failScan) throw new Error("scan unavailable");
    if (!Array.isArray(raw)) throw new Error("not frames");
    let previous: string | null = null;
    for (const frame of raw as Frame[]) {
      const { ref, ...material } = frame;
      if (frame.owner.agentId !== owner.agentId || frame.owner.workspaceId !== owner.workspaceId
        || frame.previous !== previous || digest(material) !== ref) throw new Error("invalid chain");
      previous = ref;
    }
    return {
      scope: owner, heads: { ...emptyHeads(), body: previous },
      frames: (raw as Frame[]).map(({ ref, stream, value }) => ({ ref, stream, value })),
    };
  }
  async withExclusive<T>(
    _capability: object, owner: WorkspaceScope,
    action: Parameters<WorkspaceHistoryPort["withExclusive"]>[2],
  ): Promise<T> {
    const key = this.key(owner);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const queued = previous.then(() => held);
    this.locks.set(key, queued);
    await previous;
    try {
      return await action({
        readCommitted: async () => {
          this.log.push("read");
          if (++this.readCount === this.failRead) throw new Error("read unavailable");
          return structuredClone(this.frames(owner));
        },
        append: async (events, heads) => {
          this.log.push(`append:${String(events[0]?.type)}`);
          const count = ++this.appendCount;
          if (count === this.failBeforeAppend) throw new Error("write failed");
          const actual = { ...emptyHeads(), body: this.frames(owner).at(-1)?.ref ?? null };
          if (digest(heads) !== digest(actual)) throw new Error("head conflict");
          if (count !== this.dropAppend) for (const event of events) this.appendEvent(owner, event);
          this.onAppend?.(count);
          if (count === this.failAfterAppend) throw new Error("ack lost");
        },
      }) as T;
    } finally {
      unlock();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

export function fixture() {
  const store = new TestHistory();
  const capability = Object.freeze({});
  let denyCommand = false;
  let denyPermit = false;
  const authorization: WorkAuthorizationPort = {
    async authorizeRead(cap, owner) {
      store.log.push("authorize:read");
      if (cap !== capability || ![scope.workspaceId, otherScope.workspaceId, "computer-history"].includes(owner.workspaceId)) {
        throw new Error("unauthorized");
      }
    },
    async authorizeCommand(cap, request) {
      store.log.push("authorize:command");
      if (cap !== capability || denyCommand || !request.commandHash) throw new Error("unauthorized");
      return { principalId: "principal-a" };
    },
    async issuePermit(cap, request) {
      store.log.push("authorize:permit");
      if (cap !== capability || denyPermit) throw new Error("denied");
      return Object.freeze({ commandHash: request.commandHash, intentRef: request.intentRef, scope: request.command.scope });
    },
  };
  const createService = () => new WorkService({
    history: store, canonical: store, authorization, now: () => new Date("2026-09-12T00:00:00.000Z"),
  });
  return {
    store, capability, authorization, createService, service: createService(),
    denyCommand: () => { denyCommand = true; }, denyPermit: () => { denyPermit = true; },
  };
}

export function command(key = "command-1", payload: JsonValue = { title: "Report" }): WorkCommand {
  return {
    scope, operation: "task.execute", idempotencyKey: key, payload,
    resources: [{ kind: "workspace", id: scope.workspaceId }, { kind: "agent", id: scope.agentId }],
  };
}
export const success = (value: JsonValue = { answer: 42 }) => ({
  status: "succeeded" as const, value,
  receipts: [{ kind: "guest-ack", digest: "artifact-digest" }],
  events: [{ type: "task.finished", taskId: "task-1" }] satisfies JsonObject[],
});
