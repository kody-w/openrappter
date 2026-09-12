import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceScope } from "@rapp-work/work-service";
import { ComputerBrokerError } from "./types.js";
import type { ComputerLeaseStorePort, HostComputerLease } from "./types.js";
import { id, validateOwner } from "./validation.js";

export class FileComputerLeaseStore implements ComputerLeaseStorePort {
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new ComputerBrokerError("invalid_lease_directory");
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async acquire(computerId: string, owner: WorkspaceScope): Promise<HostComputerLease> {
    if (!id(computerId)) throw new ComputerBrokerError("invalid_computer_id");
    validateOwner(owner);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
      || await realpath(this.root) !== this.root) throw new ComputerBrokerError("unsafe_lease_directory");
    const path = join(this.root, `${computerId}.lease`);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ComputerBrokerError("computer_busy");
      throw error;
    }
    const leaseId = randomUUID();
    let identity: { ino: number; dev: number };
    try {
      await handle.writeFile(JSON.stringify({ version: 1, id: leaseId, computerId, owner }), "utf8");
      await handle.sync();
      const info = await handle.stat();
      identity = { ino: info.ino, dev: info.dev };
    } finally {
      await handle.close();
    }
    await this.syncDirectory();
    let released = false;
    const assertHeld = async () => {
      if (released) throw new ComputerBrokerError("lease_released");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 4096 || info.ino !== identity.ino || info.dev !== identity.dev) {
          throw new ComputerBrokerError("lease_lost");
        }
        const value = JSON.parse(await file.readFile("utf8")) as { id?: unknown; computerId?: unknown };
        if (value.id !== leaseId || value.computerId !== computerId) throw new ComputerBrokerError("lease_lost");
      } finally { await file.close(); }
    };
    return Object.freeze({
      id: leaseId,
      assertHeld,
      release: async () => {
        await assertHeld();
        await unlink(path);
        released = true;
        await this.syncDirectory();
      },
    });
  }
}
