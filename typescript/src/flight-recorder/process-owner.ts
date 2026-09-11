import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertPrivateDirectory,
  hardenPrivatePath,
  syncParentDirectory,
} from "./permissions.js";

const processOwnedPaths = new Set<string>();
let exitHandlerInstalled = false;

function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once("exit", () => {
    for (const ownerPath of processOwnedPaths) {
      try {
        unlinkSync(ownerPath);
      } catch {
        // Process exit cleanup is best effort.
      }
    }
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readProcessIncarnation(pid: number): string | null {
    try {
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/);
        const startTicks = fields[19];
        return startTicks ? `linux:${startTicks}` : null;
      }
      if (process.platform === "win32") {
        return `win:${execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`,
          ],
          { encoding: "utf8", windowsHide: true },
        ).trim()}`;
      }
      const started = execFileSync(
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        },
      ).trim();
      return started ? `ps-c-utc:${started}` : null;
    } catch {
      return null;
    }
}

export const CURRENT_PROCESS_INCARNATION =
  readProcessIncarnation(process.pid) ?? undefined;

export function processMatchesIncarnation(
  pid: number,
  incarnation: string | undefined,
): boolean {
  if (!processAlive(pid)) return false;
  if (!incarnation) return true;
  const current =
    pid === process.pid
      ? CURRENT_PROCESS_INCARNATION
      : readProcessIncarnation(pid);
  return current === null || current === incarnation;
}

export function recorderOwnerDirectory(databasePath: string): string {
  return `${databasePath}.owners`;
}

export function recorderResetLockPath(databasePath: string): string {
  return `${databasePath}.reset-lock`;
}

function resetBarrierIsActive(lockPath: string): boolean {
  try {
    const observed = lstatSync(lockPath);
    const raw = readFileSync(lockPath, "utf8").trim();
    let pid: number;
    try {
      const parsed = JSON.parse(raw) as unknown;
      pid =
        typeof parsed === "object" && parsed !== null
          ? Number((parsed as { pid?: unknown }).pid)
          : Number(parsed);
    } catch {
      pid = Number.parseInt(raw, 10);
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Flight Recorder reset barrier is invalid.");
    }
    const parsed = (() => {
      try {
        return JSON.parse(raw) as { incarnation?: unknown };
      } catch {
        return {};
      }
    })();
    const incarnation =
      typeof parsed.incarnation === "string"
        ? parsed.incarnation
        : undefined;
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      processMatchesIncarnation(pid, incarnation)
    ) {
      return true;
    }
    const current = lstatSync(lockPath);
    if (
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.mtimeMs !== observed.mtimeMs ||
      current.size !== observed.size
    ) {
      return true;
    }
    unlinkSync(lockPath);
    syncParentDirectory(path.dirname(lockPath));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function registerRecorderOwner(
  databasePath: string,
  ownerId: string,
): string {
  const resetLock = recorderResetLockPath(databasePath);
  if (resetBarrierIsActive(resetLock)) {
    throw new Error("Flight Recorder reset is in progress.");
  }
  const directory = recorderOwnerDirectory(databasePath);
  prepareRecorderOwnerDirectory(directory);
  hardenPrivatePath(directory, true);
  const ownerPath = path.join(directory, `${ownerId}.json`);
  const temporary = `${ownerPath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    hardenPrivatePath(temporary);
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        ownerId,
        pid: process.pid,
        ...(CURRENT_PROCESS_INCARNATION
          ? { incarnation: CURRENT_PROCESS_INCARNATION }
          : {}),
      })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, ownerPath);
    syncParentDirectory(directory);
  } finally {
    unlinkSync(temporary);
    syncParentDirectory(directory);
  }
  if (resetBarrierIsActive(resetLock)) {
    unlinkSync(ownerPath);
    syncParentDirectory(directory);
    throw new Error("Flight Recorder reset is in progress.");
  }
  processOwnedPaths.add(ownerPath);
  installExitHandler();
  return ownerPath;
}

export function unregisterRecorderOwner(ownerPath: string | undefined): void {
  if (!ownerPath) return;
  processOwnedPaths.delete(ownerPath);
  try {
    unlinkSync(ownerPath);
    syncParentDirectory(path.dirname(ownerPath));
  } catch {
    // A reset may already have removed the owner directory.
  }
}

export function listLiveRecorderOwners(
  databasePath: string,
  excludedPid = process.pid,
): number[] {
  const directory = recorderOwnerDirectory(databasePath);
  const live: number[] = [];
  try {
    validateRecorderOwnerDirectory(directory);
    for (const entry of readdirSync(directory)) {
      const ownerPath = path.join(directory, entry);
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as {
          pid?: unknown;
          incarnation?: unknown;
        };
        const pid = Number(owner.pid);
        if (
          Number.isSafeInteger(pid) &&
          pid > 0 &&
          processMatchesIncarnation(
            pid,
            typeof owner.incarnation === "string"
              ? owner.incarnation
              : undefined,
          )
        ) {
          if (pid !== excludedPid) live.push(pid);
        } else {
          unlinkSync(ownerPath);
        }
      } catch (error) {
        throw new Error(
          `Flight Recorder owner record cannot be inspected: ${
            (error as Error).message
          }`,
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return [...new Set(live)];
}

export function acquireRecorderResetBarrier(
  databasePath: string,
): () => void {
  const lockPath = recorderResetLockPath(databasePath);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path.dirname(lockPath));
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (resetBarrierIsActive(lockPath)) {
      throw new Error("Another Flight Recorder reset is in progress.");
    }
    const temporary = `${lockPath}.${process.pid}.${nonce}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      hardenPrivatePath(temporary);
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          pid: process.pid,
          nonce,
          ...(CURRENT_PROCESS_INCARNATION
            ? { incarnation: CURRENT_PROCESS_INCARNATION }
            : {}),
        })}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, lockPath);
        syncParentDirectory(path.dirname(lockPath));
        return () => {
          try {
            const owner = JSON.parse(
              readFileSync(lockPath, "utf8"),
            ) as { nonce?: unknown };
            if (owner.nonce === nonce) {
              unlinkSync(lockPath);
              syncParentDirectory(path.dirname(lockPath));
            }
          } catch {
            // Never unlink a barrier whose ownership cannot be verified.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary publication may already be gone.
      }
    }
  }
  throw new Error("Flight Recorder reset barrier could not be acquired.");
}

export function removeRecorderOwnerDirectory(databasePath: string): void {
  const directory = recorderOwnerDirectory(databasePath);
  try {
    validateRecorderOwnerDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(directory, {
    recursive: true,
    force: true,
  });
}

function prepareRecorderOwnerDirectory(directory: string): void {
  try {
    validateRecorderOwnerDirectory(directory);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertPrivateDirectory(path.dirname(directory));
  mkdirSync(directory, { mode: 0o700 });
  validateRecorderOwnerDirectory(directory);
}

function validateRecorderOwnerDirectory(directory: string): void {
  const before = lstatSync(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(
      `Flight Recorder owner storage must be a regular directory: ${directory}`,
    );
  }
  assertPrivateDirectory(directory);
  const after = lstatSync(directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error(
      `Flight Recorder owner storage identity changed: ${directory}`,
    );
  }
}

export function removeRecorderIdentityArtifacts(
  databasePath: string,
): number {
  const keyPath = `${databasePath}.identity-key`;
  const directory = path.dirname(keyPath);
  const keyName = path.basename(keyPath);
  const escapedKeyName = keyName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const temporaryPattern = new RegExp(
    `^${escapedKeyName}\\.\\d+\\.[0-9a-f-]+\\.tmp$`,
  );
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let caseAliasVerified = false;
  let canonicalStat: ReturnType<typeof lstatSync> | undefined;
  try {
    canonicalStat = lstatSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (canonicalStat) {
    for (const entry of entries) {
      if (
        entry.name === keyName ||
        entry.name.toLowerCase() !== keyName.toLowerCase()
      ) {
        continue;
      }
      try {
        const entryStat = lstatSync(path.join(directory, entry.name));
        if (
          entryStat.dev === canonicalStat.dev &&
          entryStat.ino === canonicalStat.ino
        ) {
          caseAliasVerified = true;
          break;
        }
      } catch {
        // A concurrent deletion is handled by the final remnant scan.
      }
    }
  }
  const foldedTemporaryPattern = new RegExp(
    `^${escapedKeyName.toLowerCase()}\\.\\d+\\.[0-9a-f-]+\\.tmp$`,
  );
  const matchesIdentityArtifact = (name: string): boolean =>
    name === keyName ||
    temporaryPattern.test(name) ||
    (
      caseAliasVerified &&
      (
        name.toLowerCase() === keyName.toLowerCase() ||
        foldedTemporaryPattern.test(name.toLowerCase())
      )
    );

  const candidates = entries
    .filter((entry) => matchesIdentityArtifact(entry.name))
    .map((entry) => path.join(directory, entry.name));
  for (const candidate of candidates) unlinkSync(candidate);
  if (candidates.length > 0) syncParentDirectory(directory);

  const remnants = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => matchesIdentityArtifact(entry.name))
    .map((entry) => path.join(directory, entry.name));
  if (remnants.length > 0) {
    throw new Error(
      `Reset could not remove Flight Recorder identity artifacts: ${remnants.join(", ")}`,
    );
  }
  return candidates.length;
}
