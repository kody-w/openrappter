import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../scripts/stage-transition-rollback.mjs", import.meta.url),
);
const posix = process.platform !== "win32";

function git(cwd, args) {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(extension = "sh") {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-transition-"));
  const brainstemRepo = path.join(root, "brainstem");
  mkdirSync(brainstemRepo);
  git(brainstemRepo, ["init", "-q"]);
  writeFileSync(path.join(brainstemRepo, "runtime.txt"), "old\n");
  git(brainstemRepo, ["add", "."]);
  git(brainstemRepo, ["commit", "-q", "-m", "old"]);
  const brainstemHead = git(brainstemRepo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(brainstemRepo, "runtime.txt"), "new\n");
  git(brainstemRepo, ["add", "."]);
  git(brainstemRepo, ["commit", "-q", "-m", "new"]);

  const rollbackCommit = "1".repeat(40);
  const requestPath = path.join(root, "update-request.json");
  const rollbackPath = path.join(root, `rollback.${extension}`);
  const targetPath = path.join(root, `target.${extension}`);
  const markerPath = path.join(root, "marker.txt");
  writeFileSync(
    requestPath,
    JSON.stringify({
      brainstemExpectedHead: brainstemHead,
      brainstemRepoRoot: brainstemRepo,
      currentVersion: "0.1.0-beta.8",
      gitExecutable: "git",
      remoteUrl: "https://github.com/kody-w/openrappter.git",
      rollbackCommit,
    }),
  );
  writeFileSync(rollbackPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(
    targetPath,
    `#!/bin/sh
printf '%s\n%s\n%s\n' "$BRAINSTEM_BETA_RELEASE_TAG" "$BRAINSTEM_BETA_PRESERVE_RUNTIME" "$BRAINSTEM_BETA_RUNTIME_COMMIT" > ${JSON.stringify(markerPath)}
`,
    { mode: 0o700 },
  );
  chmodSync(targetPath, 0o700);
  return {
    root,
    brainstemRepo,
    brainstemHead,
    requestPath,
    rollbackPath,
    targetPath,
    markerPath,
  };
}

test("legacy updater rollback is replaced by a verified transition shim", { skip: !posix }, () => {
  const value = fixture();
  try {
    const stage = spawnSync(
      process.execPath,
      [script, value.requestPath, value.rollbackPath, value.targetPath],
      { encoding: "utf8" },
    );
    assert.equal(stage.status, 0, stage.stderr);
    assert.match(readFileSync(value.rollbackPath, "utf8"), /BRAINSTEM_BETA_TRANSITION_ROLLBACK=1/);

    const run = spawnSync("/bin/bash", [value.rollbackPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        BRAINSTEM_BETA_BOOTSTRAP_URL: "https://example.invalid/wrong-installer",
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(git(value.brainstemRepo, ["rev-parse", "HEAD"]), value.brainstemHead);
    assert.deepEqual(readFileSync(value.markerPath, "utf8").trim().split("\n"), [
      "brainstem-beta-v0.1.0-beta.8",
      "1",
      value.brainstemHead,
    ]);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("new updater requests keep their staged rollback installer", { skip: !posix }, () => {
  const value = fixture();
  try {
    const request = JSON.parse(readFileSync(value.requestPath, "utf8"));
    request.releaseTag = "brainstem-beta-v0.1.0-beta.9";
    writeFileSync(value.requestPath, JSON.stringify(request));
    const before = readFileSync(value.rollbackPath, "utf8");
    const stage = spawnSync(
      process.execPath,
      [script, value.requestPath, value.rollbackPath, value.targetPath],
      { encoding: "utf8" },
    );
    assert.equal(stage.status, 0, stage.stderr);
    assert.equal(readFileSync(value.rollbackPath, "utf8"), before);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Windows transition shim carries an encoded preserve-runtime rollback", () => {
  const value = fixture("cmd");
  try {
    const stage = spawnSync(
      process.execPath,
      [script, value.requestPath, value.rollbackPath, value.targetPath],
      { encoding: "utf8" },
    );
    assert.equal(stage.status, 0, stage.stderr);
    const shim = readFileSync(value.rollbackPath, "utf8");
    const encoded = shim.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    assert.ok(encoded);
    const powershell = Buffer.from(encoded, "base64").toString("utf16le");
    assert.match(powershell, /BRAINSTEM_BETA_PRESERVE_RUNTIME = '1'/);
    assert.match(powershell, new RegExp(value.brainstemHead));
    assert.match(powershell, /BRAINSTEM_BETA_BOOTSTRAP_URL/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("transition staging refuses a symlink instead of following it", { skip: !posix }, () => {
  const value = fixture();
  const victim = path.join(value.root, "victim.sh");
  try {
    rmSync(value.rollbackPath);
    writeFileSync(victim, "preserve\n");
    symlinkSync(victim, value.rollbackPath);
    const stage = spawnSync(
      process.execPath,
      [script, value.requestPath, value.rollbackPath, value.targetPath],
      { encoding: "utf8" },
    );
    assert.notEqual(stage.status, 0);
    assert.equal(readFileSync(victim, "utf8"), "preserve\n");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
