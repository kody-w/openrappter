import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

/**
 * Write credential-adjacent JSON without ever truncating the last good copy.
 *
 * The temporary file lives beside the destination so rename remains atomic.
 * Both the file and containing directory are permission-repaired on every
 * write, not only when first created.
 */
export function writeCopilotSecretJsonAtomically(
  filePath: string,
  value: unknown,
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  const temporaryPath =
    `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best effort while preserving the original error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename may already have completed, or the temp file may not exist.
    }
    throw error;
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms do not permit fsync on directories. The file rename is
    // still atomic; directory sync is the additional crash-durability step.
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Nothing else can improve durability after this point.
      }
    }
  }
}
