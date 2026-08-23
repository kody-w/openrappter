import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const betaRoot = path.resolve(import.meta.dirname, "..");

test("Frontier selects the semantic maximum from out-of-order API releases", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "frontier-resolution-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const curl = path.join(bin, "curl");
  const git = path.join(bin, "git");
  writeFileSync(curl, `#!/bin/bash
url="\${!#}"
case "$url" in
  *"/releases?per_page=30")
    cat <<'JSON'
[
  {
    "tag_name": "brainstem-beta-v0.1.0-beta.9"
  },
  {
    "tag_name": "brainstem-beta-v0.1.0-beta.7"
  },
  {
    "tag_name": "brainstem-beta-v0.1.0-beta.10"
  }
]
JSON
    ;;
  *"/commits/brainstem-beta-v0.1.0-beta.10")
    printf '%s\n' '  "sha": "200bda66f3e2ca319aa10a4d55a9bd03548961cf"'
    ;;
  *) exit 97 ;;
esac
`);
  writeFileSync(git, "#!/bin/sh\nexit 98\n");
  chmodSync(curl, 0o700);
  chmodSync(git, 0o700);

  try {
    const result = spawnSync(
      "bash",
      [path.join(betaRoot, "frontier.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH || ""}`,
          RAPP_FRONTIER_REPO: "kody-w/openrappter",
          RAPP_FRONTIER_RESOLVE_ONLY: "1",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "kody-w/openrappter brainstem-beta-v0.1.0-beta.10 "
        + "200bda66f3e2ca319aa10a4d55a9bd03548961cf",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PowerShell Frontier uses the same natural tag ordering", () => {
  const source = readFileSync(path.join(betaRoot, "frontier.ps1"), "utf8");
  assert.match(source, /function Get-NaturalTagKey/);
  assert.ok(
    (source.match(/Sort-Object \{ Get-NaturalTagKey \$_ \}/g) || []).length >= 2,
    "API and git fallback paths must share natural ordering",
  );
  assert.doesNotMatch(source, /\$release = @\(/);
});
