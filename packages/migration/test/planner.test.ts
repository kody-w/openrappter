import { describe, expect, it, vi } from "vitest";
import { LegacyMigration } from "../src/index.js";
import type { InertLegacyReaderPort, LegacySource } from "../src/index.js";

const source = (kind: LegacySource["kind"] = "agent", id = "source-a"): LegacySource => ({
  id, root: "/explicit-source", relativePath: `${kind}s.json`, format: "json", kind,
});
const target = { agentId: "agent-new", workspaceId: "workspace-new" };
function setup(input: unknown, descriptor = source()) {
  let bytes = new TextEncoder().encode(JSON.stringify(input));
  let modifiedAt = "2026-09-11T00:00:00.000Z";
  const discover = vi.fn(async () => [descriptor]);
  const read = vi.fn(async () => ({ bytes, modifiedAt }));
  const reader: InertLegacyReaderPort = { discover, read };
  const migration = new LegacyMigration(reader, { now: () => new Date("2026-09-12T00:00:00.000Z") });
  return {
    migration, discover, read, reader,
    change: (value: unknown) => { bytes = new TextEncoder().encode(JSON.stringify(value)); },
    changeTimestamp: () => { modifiedAt = "2026-09-11T01:00:00.000Z"; },
    raw: (value: string) => { bytes = new TextEncoder().encode(value); },
  };
}

describe("inert review-only migration", () => {
  it("never probes paths or loads data during normal construction", async () => {
    const test = setup([]);
    expect(test.discover).not.toHaveBeenCalled();
    expect(test.read).not.toHaveBeenCalled();
    expect((await test.migration.inventory([])).records).toHaveLength(0);
    expect(test.discover).not.toHaveBeenCalled();
    expect(test.read).not.toHaveBeenCalled();
  });

  it("produces an explicit review plan, excluding executable fields and all legacy authority", async () => {
    const marker = "globalThis.LEGACY_CODE_WAS_LOADED = true";
    const test = setup([{
      name: "Analyst", instructions: "Prepare reports", code: marker, module: "agent.mjs",
      tools: ["host.shell"], workspaceId: "/private", policy: { allowAll: true }, enabled: true,
    }]);
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect(test.discover).toHaveBeenCalledWith(["/explicit-source"]);
    expect(inventory).toMatchObject({ authoritative: false });
    const entry = inventory.records[0]!;
    expect(entry.data).toEqual({
      kind: "agent", name: "Analyst", instructions: "Prepare reports", enabled: false, policyReviewRequired: true,
    });
    expect(entry.warnings).toContain("executable_and_authority_fields_excluded");
    const plan = await test.migration.plan(inventory, [entry.id], target);
    expect(plan).toMatchObject({
      mode: "review-only", authoritative: false, requiresAuthorization: true,
      target, sourceDisposition: "leave-unchanged",
    });
    expect(plan.items[0]?.targetPath).toMatch(/^imports\/[a-f0-9]{64}-[a-f0-9]{64}-0\.json$/u);
    expect(plan.items[0]?.proposedEvent).toMatchObject({
      type: "migration.import.proposed", sourceHash: entry.sourceHash,
      sourceModifiedAt: entry.sourceModifiedAt, reviewRequired: true,
    });
    for (const excluded of [marker, "agent.mjs", "host.shell", "/private", "allowAll"]) {
      expect(JSON.stringify(plan)).not.toContain(excluded);
    }
    expect((globalThis as Record<string, unknown>).LEGACY_CODE_WAS_LOADED).toBeUndefined();
    expect(test.read).toHaveBeenCalledTimes(2);
    expect(Object.keys(test.reader).sort()).toEqual(["discover", "read"]);
  });

  it("does not convert legacy completion claims into trusted completed tasks", async () => {
    const test = setup([{ title: "Legacy report", status: "succeeded", receipt: "not-a-proof" }], source("task"));
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect(inventory.records[0]?.data).toEqual({
      kind: "task", title: "Legacy report", description: "", status: "draft", legacyStatus: "succeeded",
    });
    expect(inventory.records[0]?.warnings).toContain("not_evidence_of_completed_work");
  });

  it("imports memory only as untrusted inert text and bounded tags", async () => {
    const test = setup([{ content: "A note", tags: ["work", 42], command: "do-not-run" }], source("memory"));
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect(inventory.records[0]?.data).toEqual({ kind: "memory", content: "A note", tags: ["work"], trusted: false });
  });

  it("requires explicit selections from this planner's unmodified inventory", async () => {
    const test = setup([{ name: "Analyst" }]);
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect((await test.migration.plan(inventory, [], target)).items).toHaveLength(0);
    expect(test.read).toHaveBeenCalledOnce();
    await expect(test.migration.plan({ ...inventory }, [inventory.records[0]!.id], target))
      .rejects.toThrow("invalid_review_selection");
    await expect(test.migration.plan(inventory, ["unknown"], target)).rejects.toThrow("unknown_review_record");
    await expect(test.migration.plan(inventory, [inventory.records[0]!.id, inventory.records[0]!.id], target))
      .rejects.toThrow("invalid_review_selection");
    expect(() => { (inventory.records[0]!.data as Record<string, unknown>).enabled = true; }).toThrow();
  });

  it.each(["content", "timestamp"])("re-reads and rejects a changed source %s before planning", async (change) => {
    const test = setup([{ name: "Analyst" }]);
    const inventory = await test.migration.inventory(["/explicit-source"]);
    if (change === "content") test.change([{ name: "Changed" }]);
    else test.changeTimestamp();
    await expect(test.migration.plan(inventory, [inventory.records[0]!.id], target))
      .rejects.toThrow("review_source_changed");
  });

  it("rejects invalid JSON as data rather than evaluating it", async () => {
    const test = setup([]);
    test.raw("(() => { throw new Error('executed'); })()");
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect(inventory.records).toHaveLength(0);
    expect(inventory.files[0]).toMatchObject({ status: "rejected", reason: "invalid_inert_json" });
  });

  it("reads JSONL as bounded inert records with source hashes", async () => {
    const test = setup([], { ...source("memory"), format: "jsonl", relativePath: "history.jsonl" });
    test.raw('{"content":"one"}\n\n{"content":"two"}\n');
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect(inventory.records.map((record) => record.data.content)).toEqual(["one", "two"]);
    expect(inventory.records[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    const bounded = new LegacyMigration(test.reader, { maxRecords: 1 });
    await expect(bounded.inventory(["/explicit-source"])).rejects.toThrow("record_limit_exceeded");
  });

  it("bounds file sizes and record counts even with a faulty reader", async () => {
    const test = setup([{ name: "one" }, { name: "two" }]);
    await expect(new LegacyMigration(test.reader, { maxRecords: 1 }).inventory(["/explicit-source"]))
      .rejects.toThrow("record_limit_exceeded");
    await expect(new LegacyMigration(test.reader, { maxFileBytes: 1 }).inventory(["/explicit-source"]))
      .rejects.toThrow("invalid_source_read");
  });

  it("reports unreadable and manually reviewable records without leaking raw errors", async () => {
    const test = setup([{ name: "one" }, { module: "skip-code" }]);
    expect((await test.migration.inventory(["/explicit-source"])).files[0]).toMatchObject({
      status: "reviewable", reason: "some_records_require_manual_review",
    });
    test.read.mockRejectedValue(new Error("secret path and password"));
    const inventory = await test.migration.inventory(["/explicit-source"]);
    expect(inventory.files[0]).toMatchObject({ status: "unreadable", reason: "source_unreadable" });
    expect(JSON.stringify(inventory)).not.toContain("password");
  });

  it("keeps prototype-looking keys inert and generates non-colliding target paths", async () => {
    const test = setup([]);
    test.raw('[{"name":"Analyst","__proto__":{"polluted":true}}]');
    test.discover.mockResolvedValue([source("agent", "first"), source("agent", "second")]);
    const inventory = await test.migration.inventory(["/explicit-source"]);
    const plan = await test.migration.plan(inventory, inventory.records.map((entry) => entry.id), target);
    expect(new Set(plan.items.map((item) => item.targetPath)).size).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain("__proto__");
  });

  it("cannot create an executable plan or escape the imports destination", async () => {
    const test = setup([{ name: "Analyst" }]);
    const inventory = await test.migration.inventory(["/explicit-source"]);
    await expect(test.migration.plan(inventory, [inventory.records[0]!.id], {
      ...target, workspaceId: "../outside",
    })).rejects.toThrow("invalid_review_selection");
    expect("apply" in test.migration).toBe(false);
    expect("execute" in test.migration).toBe(false);
  });
});
