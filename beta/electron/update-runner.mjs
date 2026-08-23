import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  openPrivateAppendFile,
  redactCredentialText,
} from "./log-redaction.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const RELEASE_TAG_PATTERN = /^brainstem-beta-v[0-9A-Za-z._-]+$/;
const INSTALLER_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLog(logFd, value) {
  const text = String(value || "");
  if (text) writeSync(logFd, redactCredentialText(text));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForParent(pid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(250);
  }
  throw new Error("The beta application did not exit before the update timeout.");
}

function requireString(request, key) {
  const value = request[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Update request is missing ${key}.`);
  }
  return value;
}

function loadRequest(requestPath) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  for (const key of [
    "betaHome",
    "betaExpectedHead",
    "betaRepoRoot",
    "brainstemHome",
    "brainstemExpectedHead",
    "brainstemRepoRoot",
    "electronPath",
    "gitExecutable",
    "installerPath",
    "logPath",
    "packageDir",
    "redactionPath",
    "releaseTag",
    "remoteUrl",
    "requestPath",
    "resultPath",
    "runtimeVersionUrl",
    "runnerPath",
    "updateRef",
  ]) {
    requireString(request, key);
  }
  request.openRappterHome = typeof request.openRappterHome === "string"
    && request.openRappterHome
    ? request.openRappterHome
    : path.dirname(request.betaHome);
  request.openRappterBrainstemHome =
    typeof request.openRappterBrainstemHome === "string"
    && request.openRappterBrainstemHome
      ? request.openRappterBrainstemHome
      : request.brainstemHome;
  if (!Number.isInteger(request.parentPid) || request.parentPid < 1) {
    throw new Error("Update request has an invalid parent process.");
  }
  if (
    request.parentExitTimeoutMs !== undefined
    && (
      !Number.isInteger(request.parentExitTimeoutMs)
      || request.parentExitTimeoutMs < 1
      || request.parentExitTimeoutMs > 120_000
    )
  ) {
    throw new Error("Update request has an invalid parent exit timeout.");
  }
  if (!COMMIT_PATTERN.test(request.commit || "")) {
    throw new Error("Update request has an invalid commit.");
  }
  for (const key of ["betaExpectedHead", "brainstemExpectedHead"]) {
    if (!COMMIT_PATTERN.test(request[key])) {
      throw new Error(`Update request has an invalid ${key}.`);
    }
  }
  if (!RELEASE_TAG_PATTERN.test(request.releaseTag)) {
    throw new Error("Update request has an invalid release tag.");
  }
  // Rollback staging is optional on the wire (older requests), but when it is
  // present it must be coherent: a pinned previous commit and its installer.
  if (request.rollbackInstallerPath !== undefined || request.rollbackCommit !== undefined) {
    requireString(request, "rollbackInstallerPath");
    requireString(request, "rollbackReleaseTag");
    requireString(request, "rollbackRuntimeVersionUrl");
    if (!COMMIT_PATTERN.test(request.rollbackCommit || "")) {
      throw new Error("Update request has an invalid rollback commit.");
    }
    if (!RELEASE_TAG_PATTERN.test(request.rollbackReleaseTag)) {
      throw new Error("Update request has an invalid rollback release tag.");
    }
  }
  return request;
}

// Re-install the previously installed commit with ITS OWN installer, staged
// by prepareUpdate before anything moved. Reports, never throws: the outcome
// rides along in the result file so the reopened app can say what happened.
function rollbackUpdate(request, logFd, failure) {
  const outcome = {
    attempted: false,
    success: false,
    commit: request.rollbackCommit || request.betaExpectedHead,
    error: null,
  };
  if (!request.rollbackInstallerPath) {
    outcome.error = "No rollback installer was staged with this update.";
    return outcome;
  }
  if (!existsSync(request.rollbackInstallerPath)) {
    outcome.error = `The staged rollback installer is missing at ${request.rollbackInstallerPath}.`;
    return outcome;
  }
  outcome.attempted = true;
  writeLog(
    logFd,
    `[..] Rolling back to ${outcome.commit} because: ${failure}\n`,
  );
  try {
    gitOutput(
      request,
      request.brainstemRepoRoot,
      ["checkout", "--detach", request.brainstemExpectedHead],
    );
    const result = installUpdate(
      {
        ...request,
        commit: outcome.commit,
        installerPath: request.rollbackInstallerPath,
        preserveRuntime: true,
        releaseTag: request.rollbackReleaseTag,
        runtimeCommit: request.brainstemExpectedHead,
        runtimeVersionUrl: request.rollbackRuntimeVersionUrl,
      },
      logFd,
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `The rollback installer exited with code ${result.status ?? "unknown"}.`,
      );
    }
    const head = gitOutput(request, request.betaRepoRoot, ["rev-parse", "HEAD"])
      .toLowerCase();
    if (head !== outcome.commit) {
      throw new Error(
        `The launcher checkout is at ${head.slice(0, 8)} after the rollback, not ${
          outcome.commit.slice(0, 8)
        }.`,
      );
    }
    outcome.success = true;
    writeLog(logFd, `[OK] Rolled back to ${outcome.commit}\n`);
  } catch (error) {
    outcome.error = redactCredentialText(String(error?.message || error));
    writeLog(logFd, `[X] Rollback failed: ${outcome.error}\n`);
  }
  return outcome;
}

function gitOutput(request, cwd, args) {
  const result = spawnSync(request.gitExecutable, ["-C", cwd, ...args], {
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Git verification failed in ${cwd}: ${(result.stderr || "").trim()}`,
    );
  }
  return (result.stdout || "").trim();
}

function assertCheckoutUnchanged(request, cwd, expectedHead, label) {
  const head = gitOutput(request, cwd, ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== expectedHead) {
    throw new Error(`${label} changed after the update was approved.`);
  }
  const dirty = gitOutput(
    request,
    cwd,
    ["status", "--porcelain", "--untracked-files=no"],
  );
  if (dirty) {
    throw new Error(`${label} gained tracked local changes after approval.`);
  }
}

function writeResult(request, result) {
  const temporaryPath = `${request.resultPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      ...result,
      commit: request.commit,
      currentVersion: request.currentVersion,
      latestVersion: request.latestVersion,
      logPath: request.logPath,
    }, null, 2)}\n`,
  );
  renameSync(temporaryPath, request.resultPath);
}

function installUpdate(request, logFd) {
  const env = {
    ...process.env,
    OPENRAPPTER_HOME: request.openRappterHome,
    OPENRAPPTER_BRAINSTEM_HOME: request.openRappterBrainstemHome,
    BRAINSTEM_HOME: request.brainstemHome,
    BRAINSTEM_BETA_COMMIT: request.commit,
    BRAINSTEM_BETA_HOME: request.betaHome,
    BRAINSTEM_BETA_NO_LAUNCH: "1",
    BRAINSTEM_BETA_RELEASE_TAG: request.releaseTag,
    BRAINSTEM_BETA_REPO_URL: request.remoteUrl,
    BRAINSTEM_BETA_RUNTIME_VERSION_URL: request.runtimeVersionUrl,
    BRAINSTEM_BETA_UPDATE_REF: request.updateRef,
  };
  if (request.preserveRuntime) {
    env.BRAINSTEM_BETA_PRESERVE_RUNTIME = "1";
    env.BRAINSTEM_BETA_RUNTIME_COMMIT = request.runtimeCommit;
  }

  let result;
  if (request.platform === "win32") {
    env.BRAINSTEM_BETA_INSTALLER_PATH = request.installerPath;
    result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "& $env:BRAINSTEM_BETA_INSTALLER_PATH",
      ],
      {
        encoding: "utf8",
        env,
        maxBuffer: INSTALLER_OUTPUT_MAX_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } else {
    result = spawnSync("/bin/bash", [request.installerPath], {
      encoding: "utf8",
      env,
      maxBuffer: INSTALLER_OUTPUT_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  writeLog(logFd, result.stdout);
  writeLog(logFd, result.stderr);
  return result;
}

function relaunch(request) {
  if (!existsSync(request.electronPath)) {
    throw new Error(`Electron is missing after the update: ${request.electronPath}`);
  }
  const child = spawn(request.electronPath, [request.packageDir], {
    detached: true,
    env: {
      ...process.env,
      BRAINSTEM_HOME: request.brainstemHome,
      BRAINSTEM_BETA_HOME: request.betaHome,
      BRAINSTEM_BETA_REPO_URL: request.remoteUrl,
      BRAINSTEM_BETA_UPDATE_REF: request.updateRef,
    },
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("Update request path is required.");
  const request = loadRequest(requestPath);
  const logFd = openPrivateAppendFile(request.logPath);
  let result;
  let installStarted = false;
  let parentExited = false;

  try {
    writeLog(
      logFd,
      `\n[${new Date().toISOString()}] Updating OpenRappter to ${request.commit}\n`,
    );
    await waitForParent(
      request.parentPid,
      request.parentExitTimeoutMs ?? 120_000,
    );
    parentExited = true;
    assertCheckoutUnchanged(
      request,
      request.betaRepoRoot,
      request.betaExpectedHead,
      "The beta launcher source",
    );
    assertCheckoutUnchanged(
      request,
      request.brainstemRepoRoot,
      request.brainstemExpectedHead,
      "The shared Brainstem source",
    );
    installStarted = true;
    const install = installUpdate(request, logFd);
    if (install.error) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        `The beta installer exited with code ${install.status ?? "unknown"}.`,
      );
    }
    result = { success: true };
  } catch (error) {
    result = {
      success: false,
      error: redactCredentialText(String(error?.message || error)),
    };
    writeLog(logFd, `[X] ${result.error}\n`);
    // Only an installer that actually ran can have left the install half
    // moved; a pre-flight refusal changed nothing and needs no rollback.
    result.rollback = installStarted
      ? rollbackUpdate(request, logFd, result.error)
      : {
          attempted: false,
          success: false,
          commit: request.rollbackCommit || request.betaExpectedHead,
          error: "The installer did not run; nothing changed.",
        };
  } finally {
    closeSync(logFd);
    writeResult(request, result);
    for (const temporaryPath of [
      request.installerPath,
      request.rollbackInstallerPath,
      request.requestPath,
      request.redactionPath,
      request.runnerPath,
    ].filter(Boolean)) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Windows cannot remove the running copy of this script. It is harmless
        // in the private cache and a later updater can replace it.
      }
    }
  }

  if (!parentExited) return;
  try {
    relaunch(request);
  } catch (error) {
    writeResult(request, {
      success: false,
      error: `${result.error ? `${result.error} ` : ""}Could not reopen the app: ${
        String(error?.message || error)
      }`,
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
