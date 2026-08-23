// The detached updater must leave a launcher that opens. When the pinned
// installer fails half way (checkout moved, dependencies half installed), the
// runner re-installs the previously installed commit with the rollback
// installer prepareUpdate staged BEFORE anything moved, and reports what it
// did in the result file the reopened app reads. Real git, real scripts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
  "update-runner.mjs",
);
const redactionSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
  "log-redaction.mjs",
);
const posix = process.platform !== "win32";

function git(cwd, args) {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function repoWithTwoCommits(root, name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  writeFileSync(path.join(dir, "file.txt"), `${name}-one\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "one"]);
  const first = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(dir, "file.txt"), `${name}-two\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "two"]);
  const second = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", first]);
  return { dir, first, second };
}

function script(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o700);
}

async function runUpdater({
  forward,
  rollback = null,
  expectedHead = null,
  relaunchWaitMs = 3_000,
  requestOverrides = {},
}) {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-update-runner-"));
  const beta = repoWithTwoCommits(root, "beta-src");
  const brainstem = repoWithTwoCommits(root, "brainstem-src");
  const markers = path.join(root, "markers.log");
  const installerPath = path.join(root, "forward.sh");
  const rollbackInstallerPath = path.join(root, "rollback.sh");
  const redactionPath = path.join(root, "log-redaction.mjs");
  const electronPath = path.join(root, "electron.sh");
  script(installerPath, forward({ beta, markers }));
  if (rollback) script(rollbackInstallerPath, rollback({ beta, markers }));
  script(electronPath, `echo electron >> "${markers}"; exit 0`);
  // The runner waits for the launcher process to exit. spawnSync below blocks
  // this event loop, so a live child would never be reaped and would look alive
  // for the whole run; use a pid that has already exited and been reaped.
  const parent = spawnSync("sh", ["-c", "exit 0"]);
  const request = {
    betaHome: root,
    betaExpectedHead: expectedHead || beta.first,
    betaRepoRoot: beta.dir,
    brainstemHome: root,
    brainstemExpectedHead: brainstem.first,
    brainstemRepoRoot: brainstem.dir,
    commit: beta.second,
    currentVersion: "0.1.0-beta.6",
    electronPath,
    gitExecutable: "git",
    installerPath,
    latestVersion: "0.1.0-beta.7",
    logPath: path.join(root, "update.log"),
    packageDir: path.join(root, "pkg"),
    parentPid: parent.pid,
    platform: process.platform,
    releaseTag: "brainstem-beta-v0.1.0-beta.7",
    remoteUrl: "https://github.com/microsoft/aibast-agents-library.git",
    redactionPath,
    requestPath: path.join(root, "request.json"),
    resultPath: path.join(root, "update-result.json"),
    runtimeVersionUrl:
      `https://raw.githubusercontent.com/microsoft/aibast-agents-library/${beta.second}/rapp_brainstem/VERSION`,
    runnerPath: path.join(root, "runner-copy.mjs"),
    updateRef: "main",
    ...(rollback
      ? {
          rollbackCommit: beta.first,
          rollbackInstallerPath,
          rollbackReleaseTag: "brainstem-beta-v0.1.0-beta.6",
          rollbackRuntimeVersionUrl:
            `https://raw.githubusercontent.com/microsoft/aibast-agents-library/${beta.first}/rapp_brainstem/VERSION`,
        }
      : {}),
    ...requestOverrides,
  };
  writeFileSync(request.requestPath, JSON.stringify(request));
  writeFileSync(request.runnerPath, readFileSync(runnerSource));
  writeFileSync(redactionPath, readFileSync(redactionSource));
  const run = spawnSync(
    process.execPath,
    [request.runnerPath, request.requestPath],
    { encoding: "utf8", timeout: 60_000 },
  );
  const result = JSON.parse(readFileSync(request.resultPath, "utf8"));
  const log = readFileSync(request.logPath, "utf8");
  // The relaunch is detached and unref'd, so the fake Electron may still be
  // writing its marker when the runner exits; give it a moment.
  const readMarkers = () => (existsSync(markers) ? readFileSync(markers, "utf8") : "");
  const deadline = Date.now() + relaunchWaitMs;
  while (!readMarkers().includes("electron") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const markerText = readMarkers();
  const head = git(beta.dir, ["rev-parse", "HEAD"]);
  const leftovers = [
    installerPath,
    rollbackInstallerPath,
    redactionPath,
    request.requestPath,
    request.runnerPath,
  ]
    .filter((file) => existsSync(file));
  rmSync(root, { recursive: true, force: true });
  return { run, result, log, markers: markerText, head, beta, brainstem, leftovers };
}

const failingForward = ({ beta, markers }) => (
  `git -C "${beta.dir}" checkout -q ${beta.second}\necho forward >> "${markers}"\nexit 7`
);
const restoringRollback = ({ beta, markers }) => (
  `git -C "${beta.dir}" checkout -q ${beta.first}\necho rollback >> "${markers}"\nexit 0`
);

test("a failed update rolls back to the previous commit and says so", { skip: !posix }, async () => {
  const { run, result, log, markers, head, beta, leftovers } = await runUpdater({
    forward: failingForward,
    rollback: restoringRollback,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(result.success, false);
  assert.match(result.error, /exited with code 7/);
  assert.deepEqual(
    { attempted: result.rollback.attempted, success: result.rollback.success, commit: result.rollback.commit },
    { attempted: true, success: true, commit: beta.first },
  );
  assert.equal(head, beta.first, "the launcher checkout is back on the previous commit");
  assert.equal(markers, "forward\nrollback\nelectron\n");
  assert.match(log, /Rolling back to/);
  assert.match(log, /\[OK\] Rolled back to/);
  assert.deepEqual(leftovers, [], "staged installers and the request are cleaned up");
});

test("forward and rollback installers receive their exact release context", { skip: !posix }, async () => {
  const { result, markers, beta, brainstem } = await runUpdater({
    forward: ({ markers }) => (
      `echo "forward:$BRAINSTEM_BETA_RELEASE_TAG:$BRAINSTEM_BETA_RUNTIME_VERSION_URL" >> "${markers}"\n`
      + "exit 7"
    ),
    rollback: ({ beta, markers }) => (
      `git -C "${beta.dir}" checkout -q ${beta.first}\n`
      + `echo "rollback:$BRAINSTEM_BETA_RELEASE_TAG:$BRAINSTEM_BETA_RUNTIME_VERSION_URL:$BRAINSTEM_BETA_PRESERVE_RUNTIME:$BRAINSTEM_BETA_RUNTIME_COMMIT" >> "${markers}"\n`
      + "exit 0"
    ),
  });

  assert.equal(result.rollback.success, true);
  assert.match(
    markers,
    new RegExp(`forward:brainstem-beta-v0\\.1\\.0-beta\\.7:.*${beta.second}`),
  );
  assert.match(
    markers,
    new RegExp(
      `rollback:brainstem-beta-v0\\.1\\.0-beta\\.6:.*${beta.first}.*:1:${brainstem.first}`,
    ),
  );
  assert.notEqual(beta.first, brainstem.first, "runtime rollback identity is independent");
});

test("a rollback that itself fails is reported as failed, never as restored", { skip: !posix }, async () => {
  const { result, head, beta } = await runUpdater({
    forward: failingForward,
    rollback: ({ markers }) => `echo rollback >> "${markers}"\nexit 1`,
  });
  assert.equal(result.success, false);
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.success, false);
  assert.match(result.rollback.error, /rollback installer exited with code 1/);
  assert.equal(head, beta.second, "nothing pretended to restore the checkout");
});

test("a rollback that exits 0 but leaves the checkout on the wrong commit is not a success", { skip: !posix }, async () => {
  const { result } = await runUpdater({
    forward: failingForward,
    rollback: ({ markers }) => `echo rollback >> "${markers}"\nexit 0`,
  });
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.success, false);
  assert.match(result.rollback.error, /after the rollback, not/);
});

test("a successful update never runs the rollback installer", { skip: !posix }, async () => {
  const { result, markers, head, beta } = await runUpdater({
    forward: ({ beta, markers }) => (
      `git -C "${beta.dir}" checkout -q ${beta.second}\necho forward >> "${markers}"\nexit 0`
    ),
    rollback: restoringRollback,
  });
  assert.equal(result.success, true);
  assert.equal(result.rollback, undefined);
  assert.equal(markers, "forward\nelectron\n");
  assert.equal(head, beta.second);
});

test("installer output is redacted before update.log persists it", { skip: !posix }, async () => {
  const secret = "ghp_updateRunnerSecret123456789";  // rapp-keyring: allow synthetic fixture — this value exists to prove it gets redacted
  const { result, log } = await runUpdater({
    forward: ({ beta }) => (
      `echo "Authorization: Bearer ${secret}"\n`
      + `git -C "${beta.dir}" checkout -q ${beta.second}\n`
      + "exit 0"
    ),
  });

  assert.equal(result.success, true);
  assert.doesNotMatch(log, new RegExp(secret));
  assert.match(log, /\[redacted:authorization\]/);
});

test("a pre-flight refusal changes nothing and does not roll back", { skip: !posix }, async () => {
  const { result, markers, head, beta } = await runUpdater({
    forward: failingForward,
    rollback: restoringRollback,
    expectedHead: "0".repeat(40),
  });
  assert.equal(result.success, false);
  assert.match(result.error, /changed after the update was approved/);
  assert.equal(result.rollback.attempted, false);
  assert.match(result.rollback.error, /did not run; nothing changed/);
  assert.doesNotMatch(markers, /forward/);
  assert.equal(head, beta.first);
});

test("an update request without a staged rollback reports that honestly", { skip: !posix }, async () => {
  const { result, head, beta } = await runUpdater({ forward: failingForward });
  assert.equal(result.success, false);
  assert.equal(result.rollback.attempted, false);
  assert.match(result.rollback.error, /No rollback installer was staged/);
  assert.equal(head, beta.second);
});

test("the updater does not relaunch while the parent app is still alive", { skip: !posix }, async () => {
  const keeper = spawn("sh", ["-c", "sleep 2 & echo $!; wait"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [pidChunk] = await once(keeper.stdout, "data");
  const livePid = Number(String(pidChunk).trim());
  assert.ok(Number.isInteger(livePid) && livePid > 0);
  const outcome = await runUpdater({
    forward: ({ beta }) => (
      `git -C "${beta.dir}" checkout -q ${beta.second}\nexit 0`
    ),
    relaunchWaitMs: 500,
    requestOverrides: {
      parentExitTimeoutMs: 25,
      parentPid: livePid,
    },
  });
  if (keeper.exitCode === null && keeper.signalCode === null) {
    await once(keeper, "close");
  }

  assert.equal(outcome.result.success, false);
  assert.match(outcome.result.error, /did not exit before the update timeout/);
  assert.doesNotMatch(outcome.markers, /electron/);
  assert.equal(outcome.head, outcome.beta.first);
});
