import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { idSchema, snapshotSchema, type Check, type Snapshot } from "./contracts.js";
import type { StoragePort } from "./ports.js";

export function emptyWorkspace(workspaceId: string): Snapshot {
  return {
    workspaceId: idSchema.parse(workspaceId), revision: 0,
    agents: [], tasks: [], runs: [], approvals: [], artifacts: [], automations: [],
    settings: {
      workspaceName: "My workspace",
      appearance: { theme: "system", density: "comfortable" },
      work: { defaultPriority: "normal", approvalPolicy: "always" },
      notifications: { approvals: true, completedRuns: true },
    },
  };
}
const diskSchema = z.strictObject({ version: z.literal(1), snapshot: snapshotSchema });

export class FileStorage implements StoragePort {
  private readonly directory: string;
  private initialized = false;
  private closing = false;
  private queues = new Map<string, Promise<unknown>>();

  constructor(directory: string) { this.directory = resolve(directory); }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("Storage directory must be private and must not be a symbolic link.");
    }
    this.initialized = true;
  }
  async check(): Promise<Check> {
    return this.initialized && !this.closing
      ? { state: "ready", detail: "Private local workspace storage." }
      : { state: "unavailable", detail: "Workspace storage is not open." };
  }
  private path(workspaceId: string): string {
    if (!this.initialized) throw new Error("Storage is not open.");
    return join(this.directory, `${idSchema.parse(workspaceId)}.json`);
  }
  private async load(workspaceId: string): Promise<Snapshot> {
    const path = this.path(workspaceId);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || (stat.mode & 0o077) !== 0) {
          throw new Error("Invalid workspace storage file.");
        }
        const envelope = diskSchema.parse(JSON.parse(await readFile(handle, "utf8")));
        if (envelope.snapshot.workspaceId !== workspaceId) throw new Error("Workspace identity mismatch.");
        return envelope.snapshot;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWorkspace(workspaceId);
      throw error;
    }
  }
  async read(workspaceId: string): Promise<Snapshot> {
    if (this.closing) throw new Error("Storage is closing.");
    await this.queues.get(workspaceId);
    return this.load(workspaceId);
  }
  transact<T>(workspaceId: string, update: (draft: Snapshot) => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Storage is closing."));
    this.path(workspaceId);
    const operation = (this.queues.get(workspaceId) ?? Promise.resolve()).then(async () => {
      const draft = await this.load(workspaceId);
      const result = await update(draft);
      draft.revision += 1;
      const validated = snapshotSchema.parse(draft);
      if (validated.workspaceId !== workspaceId) throw new Error("Workspace identity cannot be changed.");
      const serialized = JSON.stringify({ version: 1, snapshot: validated });
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error("Workspace storage capacity reached.");
      const path = this.path(workspaceId);
      const staging = `${path}.${randomUUID()}.next`;
      try {
        const handle = await open(staging, "wx", 0o600);
        try {
          await handle.writeFile(serialized);
          await handle.sync();
        } finally { await handle.close(); }
        await rename(staging, path);
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        await unlink(staging).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return structuredClone(result);
    });
    const settled = operation.then(() => undefined, () => undefined);
    this.queues.set(workspaceId, settled);
    void settled.then(() => {
      if (this.queues.get(workspaceId) === settled) this.queues.delete(workspaceId);
    });
    return operation;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.queues.values());
    this.initialized = false;
  }
}
