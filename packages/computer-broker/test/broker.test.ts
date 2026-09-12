import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ComputerBroker, computerToolOutcome } from "../src/index.js";
import type {
  BrokerRequest, ComputerConfiguration, ComputerLease, ComputerLeaseStorePort,
  GuestSession, ScopedGuestPort, TartControlPort, VMInspection, WorkspaceArtifactsPort,
} from "../src/index.js";
import { command, fixture, scope } from "../../work-service/test/fixtures.js";

const publicKey = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1),
]);
const configuration: ComputerConfiguration = {
  id: "computer", historyScope: { agentId: "computer-owner", workspaceId: "computer-history" },
  vmName: "rapp-work-omarchy", image: `registry.example/omarchy@sha256:${"a".repeat(64)}`,
  hostKey: `ssh-ed25519 ${publicKey.toString("base64")}`, guestUser: "rapp",
  maxExecutionMs: 10_000, maxLeaseMs: 60_000, maxOutputBytes: 4096, maxArtifactBytes: 4096,
};
const request = (key: string): BrokerRequest => ({
  idempotencyKey: key, parentIntentRef: "agent-intent-ref", taskId: "task-a", runId: "run-a",
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ack = (session: GuestSession) => ({
  hostKey: session.expectedHostKey, workspace: session.workspace, intentRef: session.intentRef,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let count = 0; count < 30; count++) await Promise.resolve(); }

async function setup() {
  const test = fixture();
  let held = false;
  let sequence = 0;
  const acquire = vi.fn(async () => {
    if (held) throw new Error("busy");
    held = true;
    const id = `lease-${++sequence}`;
    return {
      id,
      assertHeld: async () => { if (!held) throw new Error("lost"); },
      release: async () => { if (!held) throw new Error("lost"); held = false; },
    };
  });
  const leases: ComputerLeaseStorePort = { acquire };
  let state: VMInspection | undefined = {
    name: configuration.vmName, sourceImage: configuration.image,
    operatingSystem: "omarchy", state: "running", hostMounts: [],
  };
  const tart: TartControlPort = {
    inspect: vi.fn(async () => state ? structuredClone(state) : undefined),
    clone: vi.fn(async (sourceImage, name) => {
      state = { sourceImage, name, operatingSystem: "omarchy", state: "stopped", hostMounts: [] };
    }),
    start: vi.fn(async () => { if (state) state = { ...state, state: "running" }; }),
    stop: vi.fn(async () => { if (state) state = { ...state, state: "stopped" }; }),
    address: vi.fn(async () => "192.168.64.2"),
  };
  const bytes = new TextEncoder().encode("report");
  const guest: ScopedGuestPort = {
    execute: vi.fn(async (session) => ({ ...ack(session), exitCode: 0, stdout: "done", stderr: "" })),
    upload: vi.fn(async (session, input) => ({
      ...ack(session), path: input.path, sha256: input.sha256, bytesWritten: input.bytes.byteLength,
    })),
    download: vi.fn(async (session, input) => ({
      ...ack(session), path: input.path, sha256: hash(bytes), bytes,
    })),
  };
  const artifacts: WorkspaceArtifactsPort = {
    read: vi.fn(async () => ({ bytes, sha256: hash(bytes) })),
    write: vi.fn(async (_cap, _scope, _bytes, sha256) => ({ artifactId: "artifact-download", sha256 })),
  };
  let now = 0;
  const dependencies = { work: test.service, leases, tart, guest, artifacts, configuration, now: () => now };
  const broker = new ComputerBroker(dependencies);
  const result = await broker.acquire(test.capability, scope, request("acquire-1"));
  if (result.state !== "acquired") throw new Error("lease not acquired");
  return {
    ...test, broker, lease: result.lease, leaseReceipt: result.receipt, dependencies, acquire,
    guest, tart, artifacts, bytes,
    setVM: (vm: VMInspection | undefined) => { state = vm; },
    setNow: (value: number) => { now = value; },
  };
}
const executeRequest = (key = "execute-1") => ({ ...request(key), argv: ["date"], cwd: ".", timeoutMs: 1000 });

describe("single pinned ComputerBroker", () => {
  it("records lease acquisition and guest effects on the computer's own verified history", async () => {
    const test = await setup();
    const receipt = await test.broker.execute(test.capability, test.lease, executeRequest());
    expect(receipt).toMatchObject({ state: "committed", computerId: "computer", commit: { status: "succeeded" } });
    const [session, call] = vi.mocked(test.guest.execute).mock.calls[0]!;
    expect(session).toMatchObject({
      address: "192.168.64.2", expectedHostKey: configuration.hostKey, strictHostKeyChecking: true,
      workspace: scope, root: "/workspaces/workspace-a",
    });
    expect(session.permit).toMatchObject({ intentRef: session.intentRef });
    expect(call).toEqual({ argv: ["date"], cwd: "/workspaces/workspace-a", timeoutMs: 1000, maxOutputBytes: 4096 });
    expect((await test.service.read(test.capability, configuration.historyScope)).commands.map(
      (entry) => entry.command.operation,
    )).toEqual(["computer.lease.acquire", "computer.execute"]);
  });

  it("links the computer receipt into an agent tool commit without nested workspace-lock deadlock", async () => {
    const test = await setup();
    const outer = await test.service.commit(test.capability, { ...command("tool-call"), operation: "tool.execute" },
      async (context) => computerToolOutcome(await test.broker.execute(test.capability, test.lease, {
        ...executeRequest(), parentIntentRef: context.intentRef,
      })));
    expect(outer.state).toBe("committed");
    if (outer.state !== "committed") throw new Error("missing commit");
    expect(outer.receipts[0]).toMatchObject({ kind: "computer-receipt", computerId: "computer" });
    expect(outer.receipts[0]?.evidenceRef).not.toBe(outer.proof.evidenceRef);
  });

  it("does not accept copied IDs as a lease", async () => {
    const test = await setup();
    const forged = { id: test.lease.id, computerId: "computer" } as ComputerLease;
    await expect(test.broker.execute(test.capability, forged, executeRequest())).rejects.toThrow("invalid_lease");
    expect(test.guest.execute).not.toHaveBeenCalled();
  });

  it("holds an exclusive host lease across broker instances and does not retry a failed acquisition key", async () => {
    const test = await setup();
    const second = new ComputerBroker(test.dependencies);
    expect(await second.acquire(test.capability, scope, request("acquire-2"))).toMatchObject({ state: "unresolved" });
    expect(test.acquire).toHaveBeenCalledTimes(2);
    await test.broker.release(test.capability, test.lease, request("release-1"));
    expect(await second.acquire(test.capability, scope, request("acquire-2"))).toMatchObject({ state: "unresolved" });
    expect(test.acquire).toHaveBeenCalledTimes(2);
    expect(await second.acquire(test.capability, scope, request("acquire-3"))).toMatchObject({ state: "acquired" });
  });

  it("uses only the fixed pinned Tart identity for provision/start/stop", async () => {
    const test = await setup();
    test.setVM(undefined);
    expect(await test.broker.provision(test.capability, test.lease, request("provision"))).toMatchObject({ state: "committed" });
    expect(test.tart.clone).toHaveBeenCalledWith(configuration.image, configuration.vmName, expect.any(AbortSignal));
    expect(await test.broker.start(test.capability, test.lease, request("start"))).toMatchObject({ state: "committed" });
    expect(test.tart.start).toHaveBeenCalledWith(configuration.vmName, expect.any(AbortSignal));
    expect(await test.broker.stop(test.capability, test.lease, request("stop"))).toMatchObject({ state: "committed" });
    expect(test.tart.stop).toHaveBeenCalledWith(configuration.vmName, expect.any(AbortSignal));
    expect(test.guest.execute).not.toHaveBeenCalled();
  });

  it.each([
    { image: "registry.example/omarchy:latest" }, { image: "omarchy" },
    { hostKey: "" }, { hostKey: "ssh-ed25519 invalid" }, { maxExecutionMs: Infinity },
  ])("rejects missing or mutable pins and unbounded configuration", async (override) => {
    const test = await setup();
    expect(() => new ComputerBroker({
      ...test.dependencies, configuration: { ...configuration, ...override },
    })).toThrow();
  });

  it("snapshots host configuration and performs no discovery or transport during construction", async () => {
    const test = await setup();
    const input = { ...configuration };
    vi.mocked(test.tart.inspect).mockClear();
    new ComputerBroker({ ...test.dependencies, configuration: input });
    input.vmName = "other-computer";
    expect(test.tart.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { sourceImage: "registry.example/omarchy:latest" },
    { hostMounts: ["/Users"] }, { name: "other-vm" }, { operatingSystem: "other" },
    { state: "stopped" },
  ])("never falls back to host execution for an untrusted or stopped VM", async (override) => {
    const test = await setup();
    test.setVM({
      name: configuration.vmName, sourceImage: configuration.image, operatingSystem: "omarchy",
      state: "running", hostMounts: [], ...override,
    } as VMInspection);
    expect(await test.broker.execute(test.capability, test.lease, executeRequest())).toMatchObject({ state: "unresolved" });
    expect(test.guest.execute).not.toHaveBeenCalled();
    expect(test.tart.start).not.toHaveBeenCalled();
    expect(test.tart.clone).not.toHaveBeenCalled();
  });

  it.each(["/etc", "../private", "a/../../private", "a//b", "a/./b", "a\\b", "a/%2e%2e", "a\0b"])(
    "rejects guest paths outside the mediated workspace: %s", async (cwd) => {
      const test = await setup();
      await expect(test.broker.execute(test.capability, test.lease, { ...executeRequest(), cwd }))
        .rejects.toThrow("guest_path_outside_workspace");
      expect(test.guest.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects host-key or scope mismatches and quarantines the lease", async () => {
    const test = await setup();
    vi.mocked(test.guest.execute).mockImplementation(async (session) => ({
      ...ack(session), hostKey: "other-key", exitCode: 0, stdout: "untrusted", stderr: "",
    }));
    expect(await test.broker.execute(test.capability, test.lease, executeRequest())).toMatchObject({ state: "unresolved" });
    await expect(test.broker.execute(test.capability, test.lease, executeRequest("retry"))).rejects.toThrow("lease_unresolved");
    expect(await test.broker.reconcile(test.capability, test.lease)).toMatchObject({ state: "unresolved" });
    expect(test.guest.execute).toHaveBeenCalledOnce();
  });

  it("never executes without a verified intent or an exact authorized capability", async () => {
    const test = await setup();
    test.store.failBeforeAppend = test.store.appendCount + 1;
    expect(await test.broker.execute(test.capability, test.lease, executeRequest())).toMatchObject({ state: "unresolved" });
    expect(test.guest.execute).not.toHaveBeenCalled();
    const other = await setup();
    expect(await other.broker.execute({}, other.lease, executeRequest())).toMatchObject({ state: "unresolved" });
    expect(other.guest.execute).not.toHaveBeenCalled();
  });

  it("replays committed execution receipts without issuing another guest effect", async () => {
    const test = await setup();
    await test.broker.execute(test.capability, test.lease, executeRequest());
    expect(await test.broker.execute(test.capability, test.lease, executeRequest())).toMatchObject({
      state: "committed", commit: { replayed: true },
    });
    expect(test.guest.execute).toHaveBeenCalledOnce();
  });

  it("requires explicit proof reconciliation after an acknowledgement loss, never effect replay", async () => {
    const test = await setup();
    test.store.failAfterAppend = test.store.appendCount + 3;
    expect(await test.broker.execute(test.capability, test.lease, executeRequest())).toMatchObject({ state: "unresolved" });
    expect(await test.broker.reconcile(test.capability, test.lease)).toMatchObject({ state: "committed" });
    expect(await test.broker.execute(test.capability, test.lease, executeRequest())).toMatchObject({
      state: "committed", commit: { replayed: true },
    });
    expect(test.guest.execute).toHaveBeenCalledOnce();
  });

  it("cancels promptly while retaining a busy, quarantined lease until a late guest settles", async () => {
    const test = await setup();
    const entered = deferred<GuestSession>();
    const finish = deferred<void>();
    vi.mocked(test.guest.execute).mockImplementation(async (session) => {
      entered.resolve(session);
      await finish.promise;
      return { ...ack(session), exitCode: 0, stdout: "done", stderr: "" };
    });
    const controller = new AbortController();
    const running = test.broker.execute(test.capability, test.lease, { ...executeRequest(), signal: controller.signal });
    await entered.promise;
    controller.abort();
    expect(await running).toMatchObject({ state: "unresolved" });
    await expect(test.broker.release(test.capability, test.lease, request("release"))).rejects.toThrow("computer_operation_busy");
    finish.resolve();
    await flush();
    await expect(test.broker.release(test.capability, test.lease, request("release"))).rejects.toThrow("lease_unresolved");
    expect(await test.broker.reconcile(test.capability, test.lease)).toMatchObject({ state: "committed" });
    expect(await test.broker.release(test.capability, test.lease, request("release"))).toMatchObject({ state: "committed" });
  });

  it("rejects new work after lease expiry but allows an orderly release", async () => {
    const test = await setup();
    test.setNow(configuration.maxLeaseMs + 1);
    await expect(test.broker.execute(test.capability, test.lease, executeRequest())).rejects.toThrow("lease_expired");
    expect(await test.broker.release(test.capability, test.lease, request("release"))).toMatchObject({ state: "committed" });
    await expect(test.broker.execute(test.capability, test.lease, executeRequest())).rejects.toThrow("lease_released");
  });

  it("uploads and downloads only scoped artifact references with verified bytes and receipts", async () => {
    const test = await setup();
    const upload = await test.broker.upload(test.capability, test.lease, {
      ...request("upload"), artifactId: "artifact-source", guestPath: "inputs/report.txt",
    });
    expect(upload).toMatchObject({ state: "committed" });
    expect(test.artifacts.read).toHaveBeenCalledWith(test.capability, scope, "artifact-source", 4096);
    expect(vi.mocked(test.guest.upload).mock.calls[0]?.[1]).toMatchObject({
      path: "/workspaces/workspace-a/inputs/report.txt", sha256: hash(test.bytes),
    });
    const download = await test.broker.download(test.capability, test.lease, {
      ...request("download"), guestPath: "outputs/report.txt",
    });
    expect(download).toMatchObject({
      state: "committed", commit: { value: { artifactId: "artifact-download", sha256: hash(test.bytes) } },
    });
    expect(test.artifacts.write).toHaveBeenCalledWith(test.capability, scope, test.bytes, hash(test.bytes));
  });

  it("does not transfer a corrupt artifact or persist an out-of-scope download", async () => {
    const test = await setup();
    vi.mocked(test.artifacts.read).mockResolvedValue({ bytes: test.bytes, sha256: "wrong" });
    expect(await test.broker.upload(test.capability, test.lease, {
      ...request("upload"), artifactId: "artifact-source", guestPath: "report",
    })).toMatchObject({ state: "unresolved" });
    expect(test.guest.upload).not.toHaveBeenCalled();
    const other = await setup();
    vi.mocked(other.guest.download).mockImplementation(async (session) => ({
      ...ack(session), path: "/etc/passwd", bytes: other.bytes, sha256: hash(other.bytes),
    }));
    expect(await other.broker.download(other.capability, other.lease, {
      ...request("download"), guestPath: "report",
    })).toMatchObject({ state: "unresolved" });
    expect(other.artifacts.write).not.toHaveBeenCalled();
  });

  it("requires every production port and cannot turn an unresolved receipt into agent evidence", async () => {
    expect(() => new ComputerBroker({} as never)).toThrow("missing_mandatory_port");
    expect(() => computerToolOutcome({ state: "unresolved", computerId: "computer", reason: "unknown" }))
      .toThrow("computer_outcome_unresolved");
  });
});
