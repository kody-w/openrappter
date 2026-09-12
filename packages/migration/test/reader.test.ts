import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileInertLegacyReader, LegacyMigration } from "../src/index.js";

const created: string[] = [];
async function directory() {
  const root = resolve("test-data", randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  created.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit read-only inert file reader", () => {
  it("inventories only known JSON data and leaves every source byte and path unchanged", async () => {
    const root = await directory();
    const original = '[{"name":"Analyst","module":"not-loaded.mjs"}]';
    await writeFile(join(root, "agents.json"), original);
    await writeFile(join(root, "not-loaded.mjs"), "globalThis.DO_NOT_LOAD_THIS = true;");
    await writeFile(join(root, "unknown.json"), '{"other":"ignored"}');
    const before = (await readdir(root)).sort();
    const migration = new LegacyMigration(new FileInertLegacyReader());
    const inventory = await migration.inventory([root]);
    expect(inventory.files.map((file) => file.source.relativePath)).toEqual(["agents.json"]);
    await migration.plan(inventory, inventory.records.map((entry) => entry.id), { agentId: "agent", workspaceId: "workspace" });
    expect((await readdir(root)).sort()).toEqual(before);
    expect(await readFile(join(root, "agents.json"), "utf8")).toBe(original);
    expect((globalThis as Record<string, unknown>).DO_NOT_LOAD_THIS).toBeUndefined();
  });

  it("does not follow a source symlink during inventory or a symlink replacement during read", async () => {
    const root = await directory();
    const other = await directory();
    await writeFile(join(other, "data.json"), '[{"title":"outside"}]');
    await symlink(join(other, "data.json"), join(root, "tasks.json"));
    const reader = new FileInertLegacyReader();
    expect(await reader.discover([root])).toEqual([]);
    await writeFile(join(root, "agents.json"), '[{"name":"one"}]');
    const [source] = await reader.discover([root]);
    await rm(join(root, "agents.json"));
    await symlink(join(other, "data.json"), join(root, "agents.json"));
    await expect(reader.read(source!, 1024)).rejects.toThrow();
  });

  it("refuses executable files even when their names end in JSON", async () => {
    const root = await directory();
    await writeFile(join(root, "agents.json"), '[{"name":"do not load"}]');
    await chmod(join(root, "agents.json"), 0o700);
    expect(await new FileInertLegacyReader().discover([root])).toEqual([]);
  });

  it("rejects relative roots, root symlinks, and arbitrary file descriptors", async () => {
    const reader = new FileInertLegacyReader();
    await expect(reader.discover(["relative"])).rejects.toThrow("invalid_source_root");
    const root = await directory();
    const other = await directory();
    const alias = join(root, "alias");
    await symlink(other, alias);
    await expect(reader.discover([alias])).rejects.toThrow("unsafe_source_root");
    await expect(reader.read({
      id: "forged", root, relativePath: "../source.mjs", format: "json", kind: "agent",
    }, 1024)).rejects.toThrow("invalid_source");
  });

  it("bounds reads and rejects malformed encoding", async () => {
    const root = await directory();
    await writeFile(join(root, "agents.json"), '[{"name":"too much"}]');
    const reader = new FileInertLegacyReader();
    const [source] = await reader.discover([root]);
    await expect(reader.read(source!, 2)).rejects.toThrow("source_not_inert");
    await writeFile(join(root, "agents.json"), Buffer.from([0xff, 0xfe]));
    const inventory = await new LegacyMigration(reader).inventory([root]);
    expect(inventory.files[0]).toMatchObject({ status: "rejected", reason: "invalid_inert_json" });
  });
});
