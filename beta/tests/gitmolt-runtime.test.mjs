import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";


const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(betaRoot, "..");
const proofScript = path.join(betaRoot, "scripts", "gitmolt-runtime-proof.sh");
const corpusAgent = path.join(
  "cat-agent-skills",
  "rapp-agent-converter",
  "assets",
  "hello_rapp_agent.py",
);

function probe(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    ...options,
  });
}

test("git-molt keeps two live Brainstem runtimes healthy", {
  timeout: 190_000,
}, (t) => {
  if (process.platform === "win32") {
    t.skip("the proof targets Bash 3.2-compatible macOS and Linux hosts");
    return;
  }
  // The proof copies the pristine Grail and runs the vendored git-molt from the
  // repository root; an installed Frontier is a sparse checkout without either.
  const repositoryRoot = path.resolve(betaRoot, "..");
  for (const [label, required] of [
    ["pristine Grail", path.join(repositoryRoot, "rapp_brainstem", "brainstem.py")],
    ["vendored git-molt", process.env.GIT_MOLT || path.join(betaRoot, "tools", "git-molt", "bin", "git-molt")],
  ]) {
    if (!existsSync(required)) {
      t.skip(`${label} is not beside beta/ (installed sparse checkout, not a repository): ${required}`);
      return;
    }
  }

  const python = process.env.BRAINSTEM_PYTHON
    || path.join(homedir(), ".brainstem", "venv", "bin", "python");
  if (!existsSync(python)) {
    t.skip(`Brainstem venv Python is unavailable: ${python}`);
    return;
  }
  const pythonProbe = probe(python, ["-c", "import flask"]);
  if (pythonProbe.status !== 0) {
    t.skip(`Brainstem venv Python cannot import Flask: ${python}`);
    return;
  }

  const gitProbe = probe("git", ["--version"]);
  if (gitProbe.status !== 0) {
    t.skip("git is unavailable");
    return;
  }

  const corpus = process.env.RAPP_SKILLS_DIR;
  if (corpus) {
    assert.ok(
      existsSync(path.join(corpus, corpusAgent)),
      `RAPP_SKILLS_DIR has no ${corpusAgent}`,
    );
  } else {
    const networkProbe = probe("git", [
      "ls-remote",
      "--exit-code",
      "https://github.com/kody-w/rapp-skills",
      "HEAD",
    ]);
    if (networkProbe.status !== 0) {
      t.skip("network access to github.com/kody-w/rapp-skills is unavailable");
      return;
    }
  }

  const result = spawnSync("bash", [proofScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      BRAINSTEM_PYTHON: python,
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    [
      `proof exit: ${result.status}`,
      result.error?.message || "",
      result.stdout || "",
      result.stderr || "",
    ].filter(Boolean).join("\n"),
  );
  assert.match(result.stdout, /## PASS\/FAIL table/);
  assert.match(result.stdout, /valid collision exposes gate\/kernel disagreement \| PASS/);
  assert.match(result.stdout, /a foreign verified trailer does not transfer authority \| PASS/);
  assert.match(result.stdout, /unverified transfer tip is parked and the frame carried its path \| PASS/);
  assert.match(result.stdout, /Summary: \d+ claim\(s\), 0 failure\(s\)/);
});

test("git-molt composition refuses an escaping agent path", (t) => {
  if (process.platform === "win32") {
    t.skip("the vendored command is a Bash script");
    return;
  }
  if (!existsSync(path.join(betaRoot, "tools", "git-molt", "bin", "git-molt"))) {
    t.skip("vendored git-molt is not beside beta/ (installed sparse checkout, not a repository)");
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "git-molt-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moltDir = path.join(root, "lineage.git");
  const source = path.join(root, "demo_agent.py");
  const output = path.join(root, "composition");
  const escaped = path.join(root, "escaped_agent.py");
  const command = path.join(betaRoot, "tools", "git-molt", "bin", "git-molt");
  writeFileSync(source, "VALUE = 'safe'\n");
  const env = { ...process.env, GIT_MOLT_DIR: moltDir, HOME: root };
  assert.equal(spawnSync("bash", [command, "init"], {
    cwd: root,
    encoding: "utf8",
    env,
  }).status, 0);
  assert.equal(spawnSync("bash", [
    command,
    "baseline",
    "demo_agent.py",
    source,
  ], {
    cwd: root,
    encoding: "utf8",
    env,
  }).status, 0);
  assert.equal(spawnSync("git", [
    `--git-dir=${moltDir}`,
    "config",
    "molt.locus.demo_agent.py.path",
    "../escaped_agent.py",
  ], {
    cwd: root,
    encoding: "utf8",
    env,
  }).status, 0);

  const composed = spawnSync("bash", [command, "compose", output], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.notEqual(composed.status, 0);
  assert.match(composed.stderr, /unsafe agent path/);
  assert.equal(existsSync(escaped), false);
  assert.equal(
    readFileSync(source, "utf8"),
    "VALUE = 'safe'\n",
    "the source remains untouched",
  );
});
