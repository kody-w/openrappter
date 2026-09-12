import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { MigrationError } from "./types.js";
import type { InertLegacyReaderPort, LegacyKind, LegacySource } from "./types.js";

const candidates: readonly { file: string; kind: LegacyKind; format: "json" | "jsonl" }[] = [
  { file: "agents.json", kind: "agent", format: "json" },
  { file: "tasks.json", kind: "task", format: "json" },
  { file: "memories.json", kind: "memory", format: "json" },
  { file: "history.jsonl", kind: "memory", format: "jsonl" },
];

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceId(root: string, relativePath: string): string {
  return sha256(JSON.stringify([root, relativePath]));
}

async function validateRoot(root: string): Promise<void> {
  if (!isAbsolute(root) || resolve(root) !== root) throw new MigrationError("invalid_source_root");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) {
    throw new MigrationError("unsafe_source_root");
  }
}

/** Read-only JSON/JSONL access. No home lookup, recursion, modules, or executable loaders. */
export class FileInertLegacyReader implements InertLegacyReaderPort {
  async discover(roots: readonly string[]): Promise<readonly LegacySource[]> {
    if (roots.length > 32 || new Set(roots).size !== roots.length) throw new MigrationError("invalid_source_roots");
    const sources: LegacySource[] = [];
    for (const root of roots) {
      await validateRoot(root);
      for (const candidate of candidates) {
        try {
          const stat = await lstat(join(root, candidate.file));
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) continue;
          sources.push(Object.freeze({
            id: sourceId(root, candidate.file), root, relativePath: candidate.file,
            format: candidate.format, kind: candidate.kind,
          }));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return Object.freeze(sources);
  }

  async read(source: LegacySource, maxBytes: number): Promise<{ bytes: Uint8Array; modifiedAt: string }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67_108_864
      || !candidates.some((candidate) => candidate.file === source.relativePath
        && candidate.kind === source.kind && candidate.format === source.format)
      || source.id !== sourceId(source.root, source.relativePath)) throw new MigrationError("invalid_source");
    await validateRoot(source.root);
    const handle = await open(join(source.root, source.relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || (before.mode & 0o111) !== 0 || before.size > maxBytes) throw new MigrationError("source_not_inert");
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length > maxBytes || length !== before.size || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new MigrationError("source_changed_during_read");
      }
      return { bytes: Uint8Array.from(buffer.subarray(0, length)), modifiedAt: before.mtime.toISOString() };
    } finally { await handle.close(); }
  }
}
