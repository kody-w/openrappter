import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStorage } from "../src/storage.js";
import { createLocalServices } from "../src/local.js";
import { createHost, type RunningHost } from "../src/server.js";
import { agent, token } from "./fixture.js";

let directory: string;
let storage: FileStorage;
let host: RunningHost | undefined;
beforeEach(async () => {
  directory = join(process.cwd(), ".test-scratch", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  storage = new FileStorage(join(directory, "data"));
  await storage.initialize();
});
afterEach(async () => {
  await host?.close(); host = undefined;
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});
describe("durable local composition", () => {
  it("has empty canonical production state, a real runtime and an explicitly unavailable computer", async () => {
    const services = createLocalServices({ directory: join(directory, "local"), token });
    host = await createHost(services);
    const context = { principal: (await services.security.authenticate(token))!, requestId: "test" };
    expect((await services.work.snapshot(context)).agents).toEqual([]);
    expect((await services.runtime.check()).state).toBe("ready");
    expect(await services.computer.inspect(context)).toMatchObject({ state: "unavailable", verified: false, evidenceIds: [] });
    await services.work.saveAgent(context, { ...agent, providerId: "github-copilot" });
    const automation = await services.work.saveAutomation(context, {
      id: "schedule", name: "Review", taskTitle: "Review", instructions: "Review actual inputs",
      agentId: agent.id, cadence: { kind: "daily", at: "09:00", timezone: "UTC" }, enabled: true,
    }, services.runtime);
    expect(automation.nextRunAt).not.toBeNull();
    expect((await services.work.snapshot(context)).automations).toHaveLength(1);
  }, 15000);
  it("persists across storage reconstruction and uses private file permissions", async () => {
    await storage.transact("local", (snapshot) => { snapshot.settings.workspaceName = "Operations"; });
    const reopened = new FileStorage(join(directory, "data"));
    await reopened.initialize();
    expect((await reopened.read("local")).settings.workspaceName).toBe("Operations");
    expect((await stat(join(directory, "data", "local.json"))).mode & 0o777).toBe(0o600);
    await reopened.close();
  });
  it("serializes concurrent transactions and rolls back failed mutations", async () => {
    await Promise.all(Array.from({ length: 10 }, () => storage.transact("local", (snapshot) => {
      snapshot.settings.workspaceName += "x";
    })));
    expect((await storage.read("local")).revision).toBe(10);
    await expect(storage.transact("local", (snapshot) => {
      snapshot.settings.workspaceName = "not committed";
      throw new Error("failed");
    })).rejects.toThrow("failed");
    expect((await storage.read("local")).settings.workspaceName).not.toBe("not committed");
  });
  it("rejects corrupt, cross-workspace, traversal, and linked data without silently resetting", async () => {
    const path = join(directory, "data", "local.json");
    await writeFile(path, "{broken", { mode: 0o600 });
    await expect(storage.read("local")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
    await expect(storage.read("../elsewhere")).rejects.toThrow();
    const linked = join(directory, "data", "linked.json");
    await symlink(path, linked);
    await expect(storage.read("linked")).rejects.toThrow();
  });
  it("refuses a shared-permission data directory", async () => {
    const shared = join(directory, "shared");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    await expect(new FileStorage(shared).initialize()).rejects.toThrow("private");
  });
  it("drains an accepted transaction on close and refuses new writes", async () => {
    const accepted = storage.transact("local", (snapshot) => { snapshot.settings.workspaceName = "Saved before close"; });
    const closing = storage.close();
    await expect(storage.transact("local", () => {})).rejects.toThrow("closing");
    await accepted; await closing;
    const persisted = JSON.parse(await readFile(join(directory, "data", "local.json"), "utf8"));
    expect(persisted.snapshot.settings.workspaceName).toBe("Saved before close");
  });
});
