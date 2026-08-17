import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  statSync,
} from "node:fs";
import path from "node:path";

/**
 * PowerShell is spawned fresh for every hardened path, and a cold start pays
 * for the shell plus the .NET types the ACL script uses. 15s was enough on an
 * idle machine and not on a loaded one: CI failed with
 * `spawnSync powershell.exe ETIMEDOUT` while hardening a Show-and-Tell
 * directory, which aborts the operation that asked for the private path.
 */
const ACL_TIMEOUT_MS = 60_000;
const ACL_ATTEMPTS = 2;

/**
 * Whether a failure is the spawn never getting off the ground, rather than the
 * ACL work itself failing.
 *
 * The distinction is the whole safety argument for retrying. A refused or
 * unverifiable ACL exits 1 from the script, which surfaces as a non-zero
 * `status` and no `code`, so it is never retried and never softened — the
 * caller still fails closed. Only a transient inability to start or run the
 * process is tried again.
 */
export function isTransientSpawnFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ETIMEDOUT" || code === "EAGAIN" || code === "EBUSY";
}

/**
 * Run an idempotent operation, retrying only transient spawn failures.
 *
 * Exported so the retry policy can be tested on any platform; the ACL script
 * itself only runs on Windows.
 */
export function withTransientRetry<T>(
  operation: () => T,
  attempts = ACL_ATTEMPTS,
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientSpawnFailure(error)) throw error;
    }
  }
}

export function hardenPrivatePath(
  target: string,
  directory = false,
): void {
  if (process.platform !== "win32") {
    chmodSync(target, directory ? 0o700 : 0o600);
    return;
  }

  const user = process.env.USERNAME;
  if (!user) {
    throw new Error("USERNAME is required to harden Flight Recorder ACLs.");
  }
  const securityType = directory
    ? "System.Security.AccessControl.DirectorySecurity"
    : "System.Security.AccessControl.FileSecurity";
  const ioType = directory
    ? "System.IO.DirectoryInfo"
    : "System.IO.FileInfo";
  const inheritance = directory
    ? "[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'"
    : "[System.Security.AccessControl.InheritanceFlags]::None";
  const command = `
$ErrorActionPreference = 'Stop'
try {
  $identity = New-Object System.Security.Principal.NTAccount($env:HF_USER)
  $sid = $identity.Translate([System.Security.Principal.SecurityIdentifier])
  $acl = New-Object ${securityType}
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', ${inheritance}, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $item = New-Object ${ioType}($env:HF_TARGET)
  $item.SetAccessControl($acl)

  $actual = $item.GetAccessControl()
  $ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier])
  $rules = @($actual.Access)
  $allowedOwners = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $actual.AreAccessRulesProtected -or $allowedOwners -notcontains $ownerSid.Value -or $rules.Count -ne 1) {
    throw 'Flight Recorder ACL verification failed.'
  }
  $ruleSid = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
  if ($ruleSid.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band $fullControl) -ne $fullControl)) {
    throw 'Flight Recorder ACL rule verification failed.'
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;
  withTransientRetry(() =>
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: ACL_TIMEOUT_MS,
        env: { ...process.env, HF_TARGET: target, HF_USER: user },
      },
    ),
  );
}

export function assertPrivateDirectory(target: string): void {
  let current = path.resolve(target);
  while (true) {
    const linked = lstatSync(current);
    if (
      linked.isSymbolicLink() &&
      (
        process.platform === "win32" ||
        typeof process.getuid !== "function" ||
        linked.uid !== 0
      )
    ) {
      throw new Error(
        `Flight Recorder storage parent must not use a user-controlled symlink: ${current}`,
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (process.platform === "win32") {
    const command = `
$ErrorActionPreference = 'Stop'
try {
  $identity = New-Object System.Security.Principal.NTAccount($env:HF_USER)
  $sid = $identity.Translate([System.Security.Principal.SecurityIdentifier])
  $allowed = @($sid.Value, 'S-1-3-4', 'S-1-5-18', 'S-1-5-32-544')
  $writeRights = (
    [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl -bor
    [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
    [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $item = New-Object System.IO.DirectoryInfo($env:HF_TARGET)
  $acl = $item.GetAccessControl()
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($allowed -notcontains $ownerSid.Value) {
    throw "Flight Recorder storage parent has untrusted owner $($ownerSid.Value)."
  }
  foreach ($rule in @($acl.Access)) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
    if ($allowed -contains $ruleSid.Value) { continue }
    if (($rule.FileSystemRights -band $writeRights) -ne 0) {
      throw "Flight Recorder storage parent grants write access to $($ruleSid.Value)."
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;
    const user = process.env.USERNAME;
    if (!user) {
      throw new Error(
        "USERNAME is required to validate Flight Recorder ACLs.",
      );
    }
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, HF_TARGET: target, HF_USER: user },
      },
    );
    return;
  }
  const status = statSync(target);
  if (!status.isDirectory()) {
    throw new Error(
      `Flight Recorder storage parent must be a directory: ${target}`,
    );
  }
  if (
    typeof process.getuid === "function" &&
    status.uid !== process.getuid()
  ) {
    throw new Error(
      `Flight Recorder storage parent must be owned by the current user: ${target}`,
    );
  }
  if ((status.mode & 0o022) !== 0) {
    throw new Error(
      `Flight Recorder storage parent must not be group/world writable: ${target}`,
    );
  }
}

export function syncParentDirectory(target: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(target, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
