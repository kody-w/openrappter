import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FlightRecorder } from "./recorder.js";
import { hardenPrivatePath } from "./permissions.js";

interface AclSummary {
  Protected: boolean;
  Owner: string;
  Access: Array<{
    Identity: string;
    Rights: string;
    Inherited: boolean;
  }>;
}

function readAcl(target: string): AclSummary {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$item = if ([System.IO.Directory]::Exists($env:HF_TARGET)) { New-Object System.IO.DirectoryInfo($env:HF_TARGET) } else { New-Object System.IO.FileInfo($env:HF_TARGET) }",
        "$acl = $item.GetAccessControl()",
        "[pscustomobject]@{ Protected = $acl.AreAccessRulesProtected; Owner = $acl.Owner; Access = @($acl.Access | ForEach-Object { [pscustomobject]@{ Identity = $_.IdentityReference.Value; Rights = $_.FileSystemRights.ToString(); Inherited = $_.IsInherited } }) } | ConvertTo-Json -Depth 4 -Compress",
      ].join("; "),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HF_TARGET: target },
    },
  );
  return JSON.parse(output) as AclSummary;
}

describe.skipIf(process.platform !== "win32")(
  "Flight Recorder Windows storage",
  () => {
    it("initializes private database, sidecars, owner, and identity files", async () => {
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "openrappter-flight-win-"),
      );
      hardenPrivatePath(directory, true);
      const databasePath = path.join(directory, "flight.db");
      const recorder = new FlightRecorder({ enabled: true, databasePath });
      try {
        await recorder.initialize();
        await recorder.runTrace({ traceId: "windows-storage" }, async () => {});

        expect(existsSync(databasePath)).toBe(true);
        expect(existsSync(`${databasePath}.identity-key`)).toBe(true);
        expect(existsSync(`${databasePath}.owners`)).toBe(true);
        expect((await recorder.health()).initialized).toBe(true);
        for (const target of [
          databasePath,
          `${databasePath}-wal`,
          `${databasePath}-shm`,
          `${databasePath}.identity-key`,
        ]) {
          const acl = readAcl(target);
          expect(acl.Protected).toBe(true);
          expect(acl.Owner).toContain("\\");
          expect(acl.Access).toHaveLength(1);
          expect(acl.Access[0]).toMatchObject({
            Identity: expect.stringContaining("\\"),
            Rights: expect.stringContaining("FullControl"),
            Inherited: false,
          });
        }
      } finally {
        await recorder.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("materializes private WAL sidecars before a reopened ledger is ready", async () => {
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "openrappter-flight-win-reopen-"),
      );
      hardenPrivatePath(directory, true);
      const databasePath = path.join(directory, "flight.db");
      const first = new FlightRecorder({ enabled: true, databasePath });
      await first.initialize();
      await first.close();
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });

      const second = new FlightRecorder({ enabled: true, databasePath });
      try {
        await second.initialize();
        for (const target of [
          `${databasePath}-wal`,
          `${databasePath}-shm`,
        ]) {
          expect(existsSync(target)).toBe(true);
          const acl = readAcl(target);
          expect(acl.Protected).toBe(true);
          expect(acl.Access).toHaveLength(1);
          expect(acl.Access[0]).toMatchObject({
            Rights: expect.stringContaining("FullControl"),
            Inherited: false,
          });
        }
      } finally {
        await second.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
