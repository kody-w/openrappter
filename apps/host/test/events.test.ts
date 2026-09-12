import { describe, expect, it } from "vitest";
import { EventJournal } from "../src/events.js";
import { owner } from "./fixture.js";

describe("signed, scoped event cursors", () => {
  const scope = { area: "work" as const, entityId: "task-one" };
  const event = (id: string) => ({
    id, area: "work" as const, entityId: "task-one", kind: "updated" as const, at: new Date().toISOString(),
  });
  it("binds cursor to principal, workspace, area, entity, and host instance", () => {
    const journal = new EventJournal();
    const cursor = journal.read(owner, scope).cursor;
    expect(() => journal.read({ ...owner, id: "other" }, scope, cursor)).toThrow("Cursor is invalid");
    expect(() => journal.read({ ...owner, workspaceId: "other" }, scope, cursor)).toThrow("Cursor is invalid");
    expect(() => journal.read(owner, { area: "agents" }, cursor)).toThrow("Cursor is invalid");
    expect(() => journal.read(owner, { area: "work" }, cursor)).toThrow("Cursor is invalid");
    expect(() => new EventJournal().read(owner, scope, cursor)).toThrow("Cursor is invalid");
  });
  it("rejects tampering and expired retained cursors explicitly", () => {
    const journal = new EventJournal(2);
    const cursor = journal.read(owner, scope).cursor;
    expect(() => journal.read(owner, scope, `${cursor}x`)).toThrow("Cursor is invalid");
    for (const id of ["one", "two", "three"]) journal.publish(owner.workspaceId, event(id));
    expect(() => journal.read(owner, scope, cursor)).toThrow("Cursor expired");
    expect(journal.read(owner, scope).events.map((item) => item.id)).toEqual(["two", "three"]);
  });
  it("paginates without missing matching events or leaking another workspace", () => {
    const journal = new EventJournal();
    journal.publish(owner.workspaceId, event("one"));
    journal.publish("other", event("hidden"));
    journal.publish(owner.workspaceId, { ...event("unrelated"), entityId: "task-two" });
    journal.publish(owner.workspaceId, event("two"));
    const first = journal.read(owner, scope, undefined, 1);
    const second = journal.read(owner, scope, first.cursor, 1);
    expect([...first.events, ...second.events].map((item) => item.id)).toEqual(["one", "two"]);
    expect(journal.read(owner, scope, second.cursor).events).toEqual([]);
  });
});
