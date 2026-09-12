import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ScopedGuestPort, TartControlPort, VMInspection } from "@rapp-work/computer-broker";
import { ComputerBrokerError } from "@rapp-work/computer-broker";
import { canonicalJson, parseCanonicalJson } from "@rapp-work/rapp1";
import { PrivateRoot } from "@rapp-work/workspace-store";
import { digest } from "./persistence.js";

const label = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);
export const computerConfigSchema = z.strictObject({
  version: z.literal(1), distribution: z.literal("omarchy"),
  vmName: label, sourceVM: label,
  image: z.string().regex(/^[a-z0-9][a-z0-9._/-]+@sha256:[a-f0-9]{64}$/),
  sourceConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDiskSha256: z.string().regex(/^[a-f0-9]{64}$/),
  guestUser: label, hostKey: z.string().max(128),
});
export type LocalComputerConfig = z.infer<typeof computerConfigSchema>;
export interface CommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly stdin?: string;
}
export interface CommandProcess {
  readonly pid: number;
  readonly exited: Promise<{ exitCode: number; stdout: string; stderr: string }>;
  stop(): void;
}
export interface FixedCommandTransport {
  available(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh"): Promise<boolean>;
  start(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh", args: readonly string[], options: CommandOptions): CommandProcess;
  run(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh", args: readonly string[], options: CommandOptions): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class NodeFixedCommands implements FixedCommandTransport {
  async available(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh"): Promise<boolean> {
    try { await access(file, constants.X_OK); return true; } catch { return false; }
  }
  start(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh", args: readonly string[], options: CommandOptions): CommandProcess {
    options.signal.throwIfAborted();
    if (!["/opt/homebrew/bin/tart", "/usr/bin/ssh"].includes(file)) throw new Error("Unrecognized application binary.");
    const child = spawn(file, [...args], {
      cwd: options.cwd, env: { ...options.env }, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let failure: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      hardStop ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = () => { failure = "command_cancelled"; stop(); };
    options.signal.addEventListener("abort", abort, { once: true });
    const exited = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let size = 0;
      const collect = (buffers: Buffer[], bytes: Buffer) => {
        size += bytes.length;
        if (size > options.maxBytes) { failure = "command_output_limit"; stop(); return; }
        buffers.push(bytes);
      };
      child.stdout.on("data", (data: Buffer) => collect(stdout, data));
      child.stderr.on("data", (data: Buffer) => collect(stderr, data));
      child.once("error", () => { failure = "command_unavailable"; });
      child.once("close", (code) => {
        clearTimeout(timer); clearTimeout(hardStop); options.signal.removeEventListener("abort", abort);
        if (failure) reject(new ComputerBrokerError(failure));
        else resolve({ exitCode: code ?? 255, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      child.stdin.on("error", () => { /* A closed stdin is confirmed by process exit, not retried. */ });
      child.stdin.end(options.stdin);
      if (options.timeoutMs > 0) timer = setTimeout(() => { failure = "command_timeout"; stop(); }, options.timeoutMs);
      if (options.signal.aborted) abort();
    });
    return { pid: child.pid ?? 0, exited, stop };
  }
  run(file: "/opt/homebrew/bin/tart" | "/usr/bin/ssh", args: readonly string[], options: CommandOptions) {
    return this.start(file, args, options).exited;
  }
}

const listSchema = z.array(z.object({ Source: z.string(), Name: z.string(), Running: z.boolean(), State: z.string() }));
const vmSchema = z.object({
  OS: z.literal("linux"), CPU: z.number().int().positive(), Memory: z.number().positive(),
  Disk: z.union([z.string(), z.number()]), DiskFormat: z.string(), Display: z.string(),
  Running: z.boolean(), State: z.string(),
});
export function vmConfigurationHash(value: unknown): string {
  const vm = vmSchema.parse(value);
  return digest({ OS: vm.OS, CPU: vm.CPU, Memory: vm.Memory, Disk: vm.Disk, DiskFormat: vm.DiskFormat, Display: vm.Display });
}
const provenanceSchema = z.strictObject({
  image: z.string(), vmName: z.string(), configurationHash: z.string(), sourceConfigurationSha256: z.string(),
  sourceDiskSha256: z.string(),
});

/** No caller supplies a command, mount, executable, SSH option, or source image path. */
export class TartSshDrivers {
  readonly tart: TartControlPort;
  readonly guest: ScopedGuestPort;
  private root!: PrivateRoot;
  private running: CommandProcess | undefined;
  private initialized: Promise<void> | undefined;
  private readonly env: Readonly<Record<string, string>>;
  constructor(
    readonly directory: string, readonly config: LocalComputerConfig,
    readonly commands: FixedCommandTransport,
    private readonly authorizeGuest: (session: Parameters<ScopedGuestPort["execute"]>[0], request: Parameters<ScopedGuestPort["execute"]>[1]) => void,
  ) {
    computerConfigSchema.parse(config);
    if (config.vmName === config.sourceVM) throw new ComputerBrokerError("template_is_not_work_computer");
    this.env = { HOME: directory, PATH: "/usr/bin:/bin", TART_HOME: join(directory, "tart"), TART_NO_AUTO_PRUNE: "true", TMPDIR: directory };
    this.tart = {
      inspect: (name, signal) => this.inspect(name, signal),
      clone: (image, name, signal) => this.clone(image, name, signal),
      start: (name, signal) => this.start(name, signal),
      stop: (name, signal) => this.stop(name, signal),
      address: async (name, signal) => {
        this.name(name);
        return (await this.command(["ip", name, "--wait", "15"], signal)).stdout.trim();
      },
    };
    this.guest = {
      execute: async (session, request) => {
        this.authorizeGuest(session, request);
        return this.ssh(session, { action: "execute", request }) as ReturnType<ScopedGuestPort["execute"]>;
      },
      // No transfer tool is exposed until a separate transfer capability is authorized.
      upload: async () => { throw new ComputerBrokerError("guest_transfer_not_authorized"); },
      download: async () => { throw new ComputerBrokerError("guest_transfer_not_authorized"); },
    };
  }
  private async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      this.root = await PrivateRoot.open(this.directory, true);
      await this.root.mkdir("tart");
      if (!await this.commands.available("/opt/homebrew/bin/tart") || !await this.commands.available("/usr/bin/ssh")) {
        throw new ComputerBrokerError("computer_binary_unavailable");
      }
      const identity = join(this.directory, "identity");
      const stat = await lstat(identity);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || await realpath(identity) !== identity) throw new ComputerBrokerError("unsafe_ssh_identity");
      const known = `${this.config.vmName} ${this.config.hostKey}\n`;
      if (await this.root.stat("known-hosts") === null) await this.root.writeAtomic("known-hosts", known);
      else if ((await this.root.read("known-hosts")).toString("utf8") !== known) throw new ComputerBrokerError("host_key_pin_changed");
    })();
    return this.initialized;
  }
  async check(): Promise<void> {
    await this.initialize();
    const source = await this.info(this.config.sourceVM, AbortSignal.timeout(3000));
    if (source.Running || vmConfigurationHash(source) !== this.config.sourceConfigurationSha256) {
      throw new ComputerBrokerError("untrusted_local_template");
    }
  }
  private name(name: string): void {
    if (name !== this.config.vmName) throw new ComputerBrokerError("unconfigured_vm");
  }
  private async command(args: readonly string[], signal: AbortSignal) {
    await this.initialize();
    const result = await this.commands.run("/opt/homebrew/bin/tart", args, {
      cwd: this.directory, env: this.env, signal, timeoutMs: 30_000, maxBytes: 1_048_576,
    });
    if (result.exitCode !== 0) throw new ComputerBrokerError("tart_command_failed");
    return result;
  }
  private async info(name: string, signal: AbortSignal) {
    return vmSchema.parse(JSON.parse((await this.command(["get", name, "--format", "json"], signal)).stdout));
  }
  async inspect(name: string, signal: AbortSignal): Promise<VMInspection | undefined> {
    this.name(name);
    const machines = listSchema.parse(JSON.parse((await this.command(["list", "--source", "local", "--format", "json"], signal)).stdout));
    const matching = machines.filter((item) => item.Name === name);
    if (!matching.length) return undefined;
    if (matching.length !== 1 || matching[0]!.Source !== "local") throw new ComputerBrokerError("ambiguous_vm");
    const receipt = provenanceSchema.parse(parseCanonicalJson(await this.root.read("clone.json")));
    const vm = await this.info(name, signal);
    if (receipt.image !== this.config.image || receipt.vmName !== name
      || receipt.sourceConfigurationSha256 !== this.config.sourceConfigurationSha256
      || receipt.sourceDiskSha256 !== this.config.sourceDiskSha256
      || receipt.configurationHash !== vmConfigurationHash(vm)
      || (vm.Running && !this.running) || !["running", "stopped"].includes(vm.State)) {
      throw new ComputerBrokerError("untrusted_vm");
    }
    return { name, sourceImage: receipt.image, operatingSystem: "omarchy", state: vm.Running ? "running" : "stopped", hostMounts: [] };
  }
  private async clone(image: string, name: string, signal: AbortSignal): Promise<void> {
    this.name(name);
    if (image !== this.config.image) throw new ComputerBrokerError("unpinned_image");
    await this.check();
    if (await this.inspect(name, signal)) throw new ComputerBrokerError("vm_already_exists");
    if (await this.root.stat("clone.json") !== null) throw new ComputerBrokerError("orphaned_clone_provenance");
    if (await this.diskHash(this.config.sourceVM, signal) !== this.config.sourceDiskSha256) throw new ComputerBrokerError("template_disk_pin_mismatch");
    // sourceVM is a local label in the application-owned Tart home; clone cannot pull an image.
    await this.command(["clone", this.config.sourceVM, name], signal);
    const vm = await this.info(name, signal);
    if (vmConfigurationHash(vm) !== this.config.sourceConfigurationSha256 || vm.Running) throw new ComputerBrokerError("clone_unconfirmed");
    if (await this.diskHash(name, signal) !== this.config.sourceDiskSha256) throw new ComputerBrokerError("clone_disk_pin_mismatch");
    await this.root.writeAtomic("clone.json", canonicalJson({
      image, vmName: name, configurationHash: vmConfigurationHash(vm),
      sourceConfigurationSha256: this.config.sourceConfigurationSha256,
      sourceDiskSha256: this.config.sourceDiskSha256,
    }));
    await this.inspect(name, signal);
  }
  private async diskHash(name: string, signal: AbortSignal): Promise<string> {
    const path = join(this.directory, "tart", "vms", name, "disk.img");
    if (await realpath(path) !== path) throw new ComputerBrokerError("unsafe_template_disk");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) !== 0
        || before.uid !== process.getuid?.()) throw new ComputerBrokerError("unsafe_template_disk");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) { signal.throwIfAborted(); hash.update(chunk); }
      const after = await file.stat();
      const linked = await lstat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== linked.ino
        || before.dev !== linked.dev || linked.isSymbolicLink()) throw new ComputerBrokerError("template_disk_changed");
      return hash.digest("hex");
    } finally { await file.close(); }
  }
  private async start(name: string, signal: AbortSignal): Promise<void> {
    this.name(name);
    const vm = await this.inspect(name, signal);
    if (!vm) throw new ComputerBrokerError("vm_missing");
    if (vm.state === "running") return;
    const lifetime = new AbortController();
    const process = this.commands.start("/opt/homebrew/bin/tart", [
      "run", "--no-graphics", "--no-audio", "--no-clipboard", name,
    ], { cwd: this.directory, env: this.env, signal: lifetime.signal, timeoutMs: 0, maxBytes: 65_536 });
    this.running = process;
    let exited = false;
    void process.exited.then(() => { exited = true; if (this.running === process) this.running = undefined; },
      () => { exited = true; if (this.running === process) this.running = undefined; });
    try {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (exited) throw new ComputerBrokerError("vm_start_failed");
        if ((await this.inspect(name, signal))?.state === "running") return;
        await delay(100, undefined, { signal });
      }
      throw new ComputerBrokerError("vm_start_unconfirmed");
    } catch (error) { process.stop(); throw error; }
  }
  private async stop(name: string, signal: AbortSignal): Promise<void> {
    this.name(name);
    await this.command(["stop", name], signal);
    const stopped = await this.info(name, signal);
    if (stopped.Running || stopped.State !== "stopped") throw new ComputerBrokerError("vm_stop_unconfirmed");
    this.running?.stop(); this.running = undefined;
  }
  private async ssh(session: Parameters<ScopedGuestPort["execute"]>[0], body: object): Promise<unknown> {
    await this.initialize();
    if (session.expectedHostKey !== this.config.hostKey || session.user !== this.config.guestUser
      || session.root !== `/workspaces/${session.workspace.workspaceId}` || session.strictHostKeyChecking !== true) {
      throw new ComputerBrokerError("untrusted_guest_session");
    }
    const result = await this.commands.run("/usr/bin/ssh", [
      "-F", "/dev/null", "-T", "-i", join(this.directory, "identity"),
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
      "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
      "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=${this.config.vmName}`,
      "-o", `UserKnownHostsFile=${join(this.directory, "known-hosts")}`, "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no",
      "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ConnectTimeout=10",
      "--", `${session.user}@${session.address}`, "/usr/bin/node /usr/local/lib/rapp-work/guest-helper.js",
    ], {
      cwd: this.directory, env: { HOME: this.directory, PATH: "/usr/bin:/bin" }, signal: session.signal,
      timeoutMs: 35_000, maxBytes: 1_048_576,
      stdin: JSON.stringify({ version: 1, ...body, root: session.root, workspace: session.workspace,
        intentRef: session.intentRef, hostKey: session.expectedHostKey }),
    });
    if (result.exitCode !== 0) throw new ComputerBrokerError("guest_execution_unconfirmed");
    return JSON.parse(result.stdout);
  }
  close(): void { this.running?.stop(); this.running = undefined; }
}
