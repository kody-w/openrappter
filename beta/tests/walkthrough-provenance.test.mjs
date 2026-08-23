import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runtimeDirectoryFingerprint,
} from "../scripts/walkthrough-provenance.mjs";


test("runtime fingerprint detects code changes and excludes secrets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-runtime-fingerprint-"));
  try {
    mkdirSync(path.join(root, "agents"));
    writeFileSync(path.join(root, "brainstem.py"), "print('one')\n");
    writeFileSync(path.join(root, "agents", "demo_agent.py"), "VALUE = 1\n");
    writeFileSync(path.join(root, ".env"), "SECRET=one\n");
    const first = runtimeDirectoryFingerprint(root);
    writeFileSync(path.join(root, ".env"), "SECRET=two\n");
    assert.equal(runtimeDirectoryFingerprint(root).source_hash, first.source_hash);
    writeFileSync(path.join(root, "brainstem.py"), "print('two')\n");
    assert.notEqual(runtimeDirectoryFingerprint(root).source_hash, first.source_hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
