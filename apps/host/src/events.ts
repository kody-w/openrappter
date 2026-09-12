import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eventSchema, scopeSchema, type EventPage, type EventScope, type WorkEvent } from "./contracts.js";
import type { Principal } from "./ports.js";
import { HostError } from "./errors.js";

const cursorSchema = z.strictObject({
  version: z.literal(1), instance: z.string(), principal: z.string(), workspace: z.string(),
  scope: scopeSchema, after: z.number().int().nonnegative().safe(),
});
type Journal = { sequence: number; entries: { sequence: number; event: WorkEvent }[] };
const matches = (event: WorkEvent, scope: EventScope) =>
  event.area === scope.area && (!scope.entityId || event.entityId === scope.entityId);
const scopeKey = (scope: EventScope) => `${scope.area}:${scope.entityId ?? ""}`;

export class EventJournal {
  readonly instanceId = randomUUID();
  private readonly secret = randomBytes(32);
  private readonly journals = new Map<string, Journal>();
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid event retention capacity.");
  }
  private journal(workspaceId: string): Journal {
    let journal = this.journals.get(workspaceId);
    if (!journal) {
      journal = { sequence: 0, entries: [] };
      this.journals.set(workspaceId, journal);
    }
    return journal;
  }
  private signature(body: string): Buffer { return createHmac("sha256", this.secret).update(body).digest(); }
  private encode(principal: Principal, scope: EventScope, after: number): string {
    const body = Buffer.from(JSON.stringify({
      version: 1, instance: this.instanceId, principal: principal.id,
      workspace: principal.workspaceId, scope, after,
    })).toString("base64url");
    return `${body}.${this.signature(body).toString("base64url")}`;
  }
  private decode(principal: Principal, scope: EventScope, cursor: string): number {
    const invalid = () => new HostError(-32010, "Cursor is invalid for this identity, workspace, or scope.");
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
      const signature = Buffer.from(parts[1], "base64url");
      if (signature.length !== 32 || !timingSafeEqual(signature, this.signature(parts[0]))) throw invalid();
      const data = cursorSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
      if (data.instance !== this.instanceId || data.principal !== principal.id ||
          data.workspace !== principal.workspaceId || scopeKey(data.scope) !== scopeKey(scope)) throw invalid();
      return data.after;
    } catch { throw invalid(); }
  }
  read(principal: Principal, scope: EventScope, cursor?: string, limit = 100): EventPage {
    const journal = this.journal(principal.workspaceId);
    const after = cursor ? this.decode(principal, scope, cursor) : 0;
    if (after > journal.sequence) throw new HostError(-32010, "Cursor is ahead of this event journal.");
    const earliest = journal.entries[0]?.sequence ?? 1;
    if (cursor && after < earliest - 1) {
      throw new HostError(-32012, "Cursor expired. Refresh the workspace and subscribe without a cursor.");
    }
    const matching = journal.entries.filter((entry) => entry.sequence > after && matches(entry.event, scope));
    const page = matching.slice(0, limit);
    const position = matching.length > limit ? page.at(-1)!.sequence : journal.sequence;
    return { events: structuredClone(page.map((entry) => entry.event)), cursor: this.encode(principal, scope, position) };
  }
  publish(workspaceId: string, event: WorkEvent): void {
    const journal = this.journal(workspaceId);
    journal.entries.push({ sequence: ++journal.sequence, event: eventSchema.parse(event) });
    journal.entries.splice(0, Math.max(0, journal.entries.length - this.capacity));
    for (const listener of this.listeners.get(workspaceId) ?? []) listener();
  }
  listen(workspaceId: string, callback: () => void): () => void {
    const listeners = this.listeners.get(workspaceId) ?? new Set();
    listeners.add(callback);
    this.listeners.set(workspaceId, listeners);
    return () => {
      listeners.delete(callback);
      if (!listeners.size) this.listeners.delete(workspaceId);
    };
  }
}
