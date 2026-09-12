import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileComputerLeaseStore } from "../src/index.js";

const created: string[] = [];
async function directory() {
  const root = resolve("test-data", randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  created.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const owner = { agentId: "agent-a", workspaceId: "workspace-a" };

describe("durable host computer lease", () => {
  it("is exclusive across store instances and releases only its own durable token", async () => {
    const root = await directory();
    const first = await new FileComputerLeaseStore(root).acquire("computer", owner);
    expect((await stat(join(root, "computer.lease"))).mode & 0o777).toBe(0o600);
    const value = JSON.parse(await readFile(join(root, "computer.lease"), "utf8"));
    expect(value.id).toBe(first.id);
    await expect(new FileComputerLeaseStore(root).acquire("computer", owner)).rejects.toThrow("computer_busy");
    await first.assertHeld();
    await first.release();
    await expect(first.assertHeld()).rejects.toThrow("lease_released");
    const next = await new FileComputerLeaseStore(root).acquire("computer", owner);
    expect(next.id).not.toBe(first.id);
    await next.release();
  });

  it("never steals an orphaned or expired-looking lease", async () => {
    const root = await directory();
    await writeFile(join(root, "computer.lease"), JSON.stringify({ id: "orphan", expiresAt: 0 }), { mode: 0o600 });
    await expect(new FileComputerLeaseStore(root).acquire("computer", owner)).rejects.toThrow("computer_busy");
    expect(JSON.parse(await readFile(join(root, "computer.lease"), "utf8")).id).toBe("orphan");
  });

  it("rejects symlink lock files and unsafe root directories without modifying targets", async () => {
    const root = await directory();
    const target = join(root, "target");
    await writeFile(target, "unchanged");
    await symlink(target, join(root, "computer.lease"));
    await expect(new FileComputerLeaseStore(root).acquire("computer", owner)).rejects.toThrow("computer_busy");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    const alias = join(root, "alias");
    const other = await directory();
    await symlink(other, alias);
    await expect(new FileComputerLeaseStore(alias).acquire("computer", owner)).rejects.toThrow("unsafe_lease_directory");
  });

  it("detects a replaced lease and refuses to delete the replacement", async () => {
    const root = await directory();
    const lease = await new FileComputerLeaseStore(root).acquire("computer", owner);
    await writeFile(join(root, "computer.lease"), JSON.stringify({ id: "replacement", computerId: "computer" }));
    await expect(lease.release()).rejects.toThrow("lease_lost");
    expect(JSON.parse(await readFile(join(root, "computer.lease"), "utf8")).id).toBe("replacement");
  });
});
