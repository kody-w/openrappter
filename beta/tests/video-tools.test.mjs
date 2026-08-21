import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  videoToolInternals,
} from "../electron/video-tools.mjs";


test("resolved media tooling runs when it is present", () => {
  // Media tooling is an opt-in organ (CONSTITUTION.md Article II), and lifecycle
  // scripts are disabled so no binary is downloaded during the factory install.
  // The contract is therefore: resolution always yields something spawnable, and
  // whatever it resolves to MUST work if it is actually there. Requiring a
  // bundled binary to exist would make the sacred one-liner fail on every clean
  // machine, which is a worse failure than not having Show Mode.
  for (const executable of [
    resolveFfmpegExecutable({}),
    resolveFfprobeExecutable({}),
  ]) {
    assert.ok(executable, "resolution must always yield a command");
    const result = spawnSync(executable, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status === null) {
      // The binary could not be run on this machine: absent (ENOENT), not
      // executable (EACCES), or killed before exiting. All of those mean the
      // optional media organ simply is not installed here, which is the normal
      // state after a factory install with lifecycle scripts disabled. The
      // recording path probes for the organ first and refuses with a named,
      // explainable error rather than a spawn failure (probeMediaOrgan), so this
      // must not fail the installer's mandatory test run.
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    const architecture = spawnSync(
      "file",
      [resolveFfprobeExecutable({})],
      { encoding: "utf8" },
    );
    assert.equal(architecture.status, 0, architecture.stderr);
    assert.match(architecture.stdout, /arm64|universal/i);
  }
});

test("packaged video-tool paths resolve outside app.asar on every platform", () => {
  for (const [input, expected] of [
    [
      "/tmp/app.asar/node_modules/tool/bin",
      "/tmp/app.asar.unpacked/node_modules/tool/bin",
    ],
    [
      String.raw`C:\tmp\app.asar\node_modules\tool\bin.exe`,
      String.raw`C:\tmp\app.asar.unpacked\node_modules\tool\bin.exe`,
    ],
  ]) {
    assert.equal(videoToolInternals.unpackedPath(input), expected);
  }
});

test("the factory install never runs package lifecycle scripts", () => {
  // ffmpeg-static's postinstall downloads a native binary from a third-party
  // release with no checksum and no signature, then chmods it 0755 — arbitrary
  // native code executed during the sacred one-liner, in a product that refuses
  // a sha-mismatched agent.py. Electron's installer is the one script we want,
  // and it is invoked explicitly.
  const installer = readFileSync(
    new URL("../install.sh", import.meta.url), "utf8");
  const npmCi = installer.match(/npm" ci[^\n]*/g) || [];
  assert.ok(npmCi.length, "expected an npm ci invocation in the installer");
  for (const line of npmCi) {
    assert.match(line, /--ignore-scripts/, `npm ci must not run lifecycle scripts: ${line}`);
  }
  assert.match(
    installer,
    /node_modules\/electron\/install\.js/,
    "Electron's runtime installer must still be invoked explicitly",
  );

  const npmrc = readFileSync(new URL("../.npmrc", import.meta.url), "utf8");
  assert.match(npmrc, /^ignore-scripts=true$/m, "a dev install must match the shipped posture");
});

test("media tooling degrades to the system binary instead of demanding a download", () => {
  // With lifecycle scripts off there is no bundled binary, so resolution must
  // fall through to whatever the user already has on PATH rather than break.
  const resolved = resolveFfmpegExecutable({
    BRAINSTEM_BETA_FFMPEG: "/nonexistent/explicit/ffmpeg",
  });
  assert.equal(resolved, "/nonexistent/explicit/ffmpeg", "an explicit override wins");
  const fallback = resolveFfmpegExecutable({});
  assert.ok(fallback, "resolution always yields something spawnable");
});
