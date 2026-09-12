import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isVerifiedChain } from "@rapp-work/rapp1";
import { agentInput, productionFixture, workspaceInput } from "./production-fixture.js";

type Fixture = Awaited<ReturnType<typeof productionFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup() { const f = await productionFixture({ computer: true }); fixtures.push(f); return f; }

describe("workspace-scoped shared agent computer", () => {
  it("reports a verified start lease and headless display honestly, then starts a second workspace without cloning a second VM", async () => {
    const f = await setup(), a = f.workspace!;
    const b = await f.services.work.createWorkspace(f.catalogContext(), workspaceInput("Second workspace", "second-lead"));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cloning = new Promise<void>((resolve) => { entered = resolve; });
    const original = f.commands.run.bind(f.commands);
    f.commands.run = async (file, args, options) => {
      if (file === "/opt/homebrew/bin/tart" && args[0] === "clone") { entered(); await gate; }
      return original(file, args, options);
    };
    const starting = f.services.computer.start(f.context(a.id));
    await cloning;
    try {
      const own = await f.services.computer.inspect(f.context(a.id));
      expect(own).toMatchObject({ state: "starting", verified: false,
        workspace: { id: a.id, enabled: false, approvalPolicy: "always" },
        lease: { state: "held", workspaceId: a.id, agentId: a.catalogScope.agentId, operation: "starting" },
        display: { state: "unavailable" } });
      const other = await f.services.computer.inspect(f.context(b.id));
      expect(other).toMatchObject({ state: "starting", workspace: { id: b.id, enabled: false },
        lease: { state: "other-workspace", id: null, workspaceId: null, agentId: null } });
    } finally { release(); }
    expect(await starting).toMatchObject({ state: "running", workspace: { id: a.id, enabled: true }, lease: { state: "idle" } });
    expect(await f.services.computer.inspect(f.context(b.id))).toMatchObject({ state: "running", workspace: { id: b.id, enabled: false } });
    expect(await f.services.computer.start(f.context(b.id))).toMatchObject({ state: "running", workspace: { id: b.id, enabled: true } });
    expect(f.commands.calls.filter((call) => call.args[0] === "clone")).toHaveLength(1);
    expect(f.commands.calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
    const p = f.services.persistence;
    const history = await p.read(p.owner.computer);
    const acquisitions = history.commands.filter((command) => command.command.operation === "computer.lease.acquire");
    expect(acquisitions.map((command) => (command.command.payload as { owner: unknown }).owner)).toEqual([a.catalogScope, b.catalogScope]);
    const scanned = await (await p.workspace(p.owner.computer)).scan();
    expect(isVerifiedChain(scanned.streams.body)).toBe(true);
    expect(scanned.streams.body.frames.length).toBeGreaterThan(0);
    await f.services.computer.stop(f.context(b.id));
    expect(await f.services.computer.inspect(f.context(a.id))).toMatchObject({ state: "stopped", workspace: { enabled: false } });
  }, 90_000);

  it("does not let an agent reuse another business's computer activation or guest scope", async () => {
    const f = await setup();
    const b = await f.services.work.createWorkspace(f.catalogContext(), workspaceInput("Isolated work", "isolated-lead"));
    await f.services.computer.start(f.context());
    const settings = (await f.services.work.snapshot(f.context(b.id))).settings;
    await f.services.work.updateSettings(f.context(b.id), { ...settings, work: { ...settings.work, approvalPolicy: "on-risk" } });
    const agent = await f.services.work.saveAgent(f.context(b.id), { ...agentInput(b.leadAgentId, "read-only"), approvalPolicy: "on-risk" });
    const task = await f.services.work.createTask(f.context(b.id), {
      requestId: randomUUID(), title: "Read scoped evidence", instructions: "Read the approved report.",
      agentId: agent.id, priority: "normal",
    });
    await expect(f.services.work.startRun(f.context(b.id), task.id, f.services.runtime, f.services.provider)).rejects.toMatchObject({ code: -32011 });
    expect(f.copilot.complete).not.toHaveBeenCalled();
    await f.services.computer.start(f.context(b.id));
    await f.services.work.startRun(f.context(b.id), task.id, f.services.runtime, f.services.provider);
    await f.services.runtime.drain();
    expect(f.commands.executionScopes).toEqual([agent.workspaceId]);
    expect((await f.services.work.snapshot(f.context())).tasks).toEqual([]);
    expect((await f.services.work.snapshot(f.context(b.id))).runs[0]!.state).toBe("completed");
  }, 90_000);

  it("exposes unresolved operations without starting or stealing a lease", async () => {
    const f = await setup();
    await f.services.persistence.commit(f.services.persistence.owner.computer, "uncertain-start", "computer.start", {}, async () => {
      throw new Error("Unknown computer outcome.");
    });
    expect(await f.services.computer.inspect(f.context())).toMatchObject({
      state: "unresolved", verified: false, lease: { state: "unresolved" }, display: { state: "unavailable" },
    });
    await expect(f.services.computer.start(f.context())).rejects.toMatchObject({ code: -32011 });
    expect(f.commands.calls).toEqual([]);
  }, 25_000);
});
