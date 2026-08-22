import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const VERSION_PATTERN = /^[0-9A-Za-z._-]+$/;
const [requestPath, rollbackPath, targetInstaller] = process.argv.slice(2);

function requireRegularFile(file, label) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

for (const [value, label] of [
  [requestPath, "update request"],
  [rollbackPath, "rollback installer"],
  [targetInstaller, "target installer"],
]) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} path must be absolute.`);
  }
}
requireRegularFile(requestPath, "Update request");
requireRegularFile(rollbackPath, "Rollback installer");
requireRegularFile(targetInstaller, "Target installer");

const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (typeof request.releaseTag === "string" && request.releaseTag) {
  process.exit(0);
}
for (const key of [
  "brainstemExpectedHead",
  "brainstemRepoRoot",
  "currentVersion",
  "gitExecutable",
  "remoteUrl",
  "rollbackCommit",
]) {
  if (typeof request[key] !== "string" || !request[key]) {
    throw new Error(`Legacy update request is missing ${key}.`);
  }
}
if (
  !COMMIT_PATTERN.test(request.brainstemExpectedHead)
  || !COMMIT_PATTERN.test(request.rollbackCommit)
) {
  throw new Error("Legacy update request has an invalid commit.");
}
if (!VERSION_PATTERN.test(request.currentVersion)) {
  throw new Error("Legacy update request has an invalid current version.");
}
const remote = new URL(request.remoteUrl);
const match = remote.href.match(
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
);
if (!match) {
  throw new Error("Legacy update request has an unsupported repository URL.");
}

const runtimeVersionUrl = [
  "https://raw.githubusercontent.com",
  match[1],
  match[2],
  request.brainstemExpectedHead,
  "rapp_brainstem/VERSION",
].join("/");
const posixScript = `#!/bin/bash
set -euo pipefail
export BRAINSTEM_BETA_TRANSITION_ROLLBACK=1
export BRAINSTEM_BETA_RELEASE_TAG=${shellQuote(`brainstem-beta-v${request.currentVersion}`)}
export BRAINSTEM_BETA_RUNTIME_VERSION_URL=${shellQuote(runtimeVersionUrl)}
export BRAINSTEM_BETA_PRESERVE_RUNTIME=1
export BRAINSTEM_BETA_RUNTIME_COMMIT=${shellQuote(request.brainstemExpectedHead)}
unset BRAINSTEM_BETA_BOOTSTRAP_URL BRAINSTEM_BETA_BOOTSTRAP_SHA256
${shellQuote(request.gitExecutable)} -C ${shellQuote(request.brainstemRepoRoot)} checkout --detach ${shellQuote(request.brainstemExpectedHead)}
exec /bin/bash ${shellQuote(targetInstaller)}
`;
const powershellScript = `$ErrorActionPreference = 'Stop'
$env:BRAINSTEM_BETA_TRANSITION_ROLLBACK = '1'
$env:BRAINSTEM_BETA_RELEASE_TAG = ${powershellQuote(`brainstem-beta-v${request.currentVersion}`)}
$env:BRAINSTEM_BETA_RUNTIME_VERSION_URL = ${powershellQuote(runtimeVersionUrl)}
$env:BRAINSTEM_BETA_PRESERVE_RUNTIME = '1'
$env:BRAINSTEM_BETA_RUNTIME_COMMIT = ${powershellQuote(request.brainstemExpectedHead)}
Remove-Item Env:BRAINSTEM_BETA_BOOTSTRAP_URL -ErrorAction SilentlyContinue
Remove-Item Env:BRAINSTEM_BETA_BOOTSTRAP_SHA256 -ErrorAction SilentlyContinue
& ${powershellQuote(request.gitExecutable)} -C ${powershellQuote(request.brainstemRepoRoot)} checkout --detach ${powershellQuote(request.brainstemExpectedHead)}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ${powershellQuote(targetInstaller)}
exit $LASTEXITCODE
`;
const script = rollbackPath.toLowerCase().endsWith(".cmd")
  ? `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${
      Buffer.from(powershellScript, "utf16le").toString("base64")
    }\r\n`
  : posixScript;

const temporaryPath = `${rollbackPath}.${process.pid}.tmp`;
try {
  writeFileSync(temporaryPath, script, { encoding: "utf8", flag: "wx", mode: 0o700 });
  renameSync(temporaryPath, rollbackPath);
  chmodSync(rollbackPath, 0o700);
} finally {
  rmSync(temporaryPath, { force: true });
}
