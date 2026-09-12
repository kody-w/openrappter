import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";
import { canonicalJson } from "@rapp-work/rapp1";
import type { ManagedCopilotTransport, ModelResponse } from "@rapp-work/model-provider";
import { createLocalServices } from "../src/local.js";
import { createHost } from "../src/server.js";
import type { RequestContext } from "../src/ports.js";
import { vmConfigurationHash, type CommandOptions, type CommandProcess, type FixedCommandTransport } from "../src/computer-drivers.js";
import { digestBytes } from "../src/local-work.js";

export const template = { OS: "linux", CPU: 4, Memory: 4096, Disk: 8, DiskFormat: "raw", Display: "1920x1080", Running: false, State: "stopped" };
const keyBytes = Buffer.alloc(51);
keyBytes.writeUInt32BE(11); keyBytes.write("ssh-ed25519", 4); keyBytes.writeUInt32BE(32, 15); keyBytes.fill(7, 19);
export const configuration = {
  version: 1 as const, distribution: "omarchy" as const, vmName: "work-omarchy", sourceVM: "omarchy-template",
  image: `ghcr.io/work-fixture/omarchy@sha256:${"a".repeat(64)}`,
  sourceConfigurationSha256: vmConfigurationHash(template), guestUser: "worker",
  sourceDiskSha256: digestBytes(Buffer.from("pinned local test disk")),
  hostKey: `ssh-ed25519 ${keyBytes.toString("base64")}`,
};
export class FakeCommands implements FixedCommandTransport {
  installed = true;
  sourceExists = true;
  vmExists = false;
  running = false;
  guestExecutions = 0;
  calls: { file: string; args: readonly string[]; options: CommandOptions }[] = [];
  executionScopes: string[] = [];
  private finishRun: (() => void) | undefined;
  async available() { return this.installed; }
  start(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh", args: readonly string[], options: CommandOptions): CommandProcess {
    this.calls.push({ file, args: [...args], options });
    if (file !== "/opt/homebrew/bin/tart" || args[0] !== "run") throw new Error("Unexpected fixed invocation.");
    this.running = true;
    const exited = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      this.finishRun = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    return { pid: 42, exited, stop: () => { this.running = false; this.finishRun?.(); } };
  }
  async run(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh", args: readonly string[], options: CommandOptions) {
    options.signal.throwIfAborted();
    this.calls.push({ file, args: [...args], options });
    const ok = (value: unknown) => ({ exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    if (file === "/usr/bin/ssh") {
      this.guestExecutions++;
      const input = JSON.parse(options.stdin!);
      this.executionScopes.push(input.workspace.workspaceId);
      return ok({ hostKey: input.hostKey, workspace: input.workspace, intentRef: input.intentRef,
        exitCode: 0, stdout: `private:${input.workspace.workspaceId}`, stderr: "" });
    }
    if (file !== "/opt/homebrew/bin/tart") throw new Error("No other host executable is permitted.");
    switch (args[0]) {
      case "list": return ok(this.vmExists ? [{ Source: "local", Name: configuration.vmName, Running: this.running, State: this.running ? "running" : "stopped" }] : []);
      case "get": {
        if (args[1] === configuration.sourceVM) return this.sourceExists ? ok(template) : { exitCode: 1, stdout: "", stderr: "missing template" };
        if (!this.vmExists) return { exitCode: 1, stdout: "", stderr: "missing VM" };
        return ok({ ...template, Running: this.running, State: this.running ? "running" : "stopped" });
      }
      case "clone":
        await mkdir(join(options.cwd, "tart", "vms", args[2]!), { recursive: true, mode: 0o700 });
        await copyFile(join(options.cwd, "tart", "vms", args[1]!, "disk.img"), join(options.cwd, "tart", "vms", args[2]!, "disk.img"));
        this.vmExists = true; return ok("");
      case "stop": this.running = false; this.finishRun?.(); return ok("");
      case "ip": return ok("192.0.2.40");
      default: throw new Error("Unexpected Tart operation.");
    }
  }
}
export function fakeCopilot(): ManagedCopilotTransport & { complete: ReturnType<typeof vi.fn> } {
  return {
    async status() { return { availability: "ready", authentication: "authenticated", models: ["test-model"], detail: "Injected model transport." }; },
    complete: vi.fn(async (request, signal: AbortSignal): Promise<ModelResponse> => {
      signal.throwIfAborted();
      if (request.tools.length > 0 && !request.messages.some((message: { role: string }) => message.role === "tool")) {
        return { kind: "tool-calls", calls: [{
          id: "call-1", name: request.tools.some((tool: { name: string }) => tool.name === "guest.execute") ? "guest.execute" : "guest.read",
          input: request.tools.some((tool: { name: string }) => tool.name === "guest.execute")
            ? { argv: ["/usr/bin/printf", "owned work"], cwd: ".", timeoutMs: 10_000 } : { path: "report.txt" },
        }] };
      }
      return { kind: "final", text: request.messages.map((message: { content?: string }) => message.content ?? "").join("\n") };
    }),
    async close() {},
  };
}
export const agentInput = (id: string, computerPolicy: "none" | "read-only" | "control" = "none") => ({
  id, name: id, role: "Worker", instructions: `Private instructions for ${id}.`, providerId: "github-copilot",
  model: "test-model", computerPolicy, approvalPolicy: "always" as const, enabled: true,
});
export async function productionFixture(options: { computer?: boolean; commands?: FakeCommands; directory?: string } = {}) {
  const directory = options.directory ?? join(process.cwd(), ".test-scratch", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (options.computer) {
    await mkdir(join(directory, "computer"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "computer.json"), canonicalJson(configuration), { mode: 0o600 });
    await writeFile(join(directory, "computer", "identity"), "test identity, never used with real SSH", { mode: 0o600 });
    await mkdir(join(directory, "computer", "tart", "vms", configuration.sourceVM), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "computer", "tart", "vms", configuration.sourceVM, "disk.img"), "pinned local test disk", { mode: 0o600 });
  }
  const commands = options.commands ?? new FakeCommands();
  const copilot = fakeCopilot();
  let fault = false;
  const token = randomBytes(48).toString("base64url");
  const services = createLocalServices({
    directory, token, commands, copilot,
    persistenceFault: (point) => { if (fault && point === "before-commit") throw new Error("Injected persistence unavailable."); },
  });
  const host = await createHost(services);
  const principal = (await services.security.authenticate(token))!;
  const context = (): RequestContext => ({ principal, requestId: randomUUID() });
  const rpc = async (method: string, params: unknown = {}, id = randomUUID()) => {
    const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return response.json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  };
  return {
    directory, services, host, commands, copilot, context, rpc,
    failPersistence(value = true) { fault = value; },
    async close(remove = true) { await host.close(); if (remove) await rm(directory, { recursive: true, force: true }); },
  };
}
export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await delay(30);
  }
  throw new Error(`Condition not reached: ${JSON.stringify(last)}`);
}
