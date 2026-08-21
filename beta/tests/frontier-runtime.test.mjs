import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";


const betaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(betaRoot, "..");

test("the Frontier runtime proof passes against real Grail workers", (t) => {
  // The proof copies the pristine Grail from the repository root. An installed
  // Frontier is a sparse checkout (beta/ + tools/rapp1) with no Grail beside it.
  if (!existsSync(path.join(repositoryRoot, "rapp_brainstem", "brainstem.py"))) {
    t.skip("no pristine Grail beside beta/ (installed sparse checkout, not a repository)");
    return;
  }
  const python = process.env.BRAINSTEM_BETA_PYTHON
    || path.join(homedir(), ".brainstem", "venv", "bin", "python");
  if (!existsSync(python)) {
    t.skip(`Brainstem Python is unavailable at ${python}`);
    return;
  }
  const result = spawnSync(
    process.execPath,
    [path.join(betaRoot, "scripts", "frontier-runtime-proof.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
      timeout: 180_000,
      killSignal: "SIGTERM",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    [
      "frontier-runtime-proof.mjs failed:",
      result.stdout,
      result.stderr,
    ].join("\n"),
  );
});
