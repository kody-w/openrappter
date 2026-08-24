#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const betaRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.dirname(betaRoot);
const packagedRoot = path.resolve(process.argv[2] || betaRoot);
const provenance = JSON.parse(readFileSync(
  path.join(repositoryRoot, "contracts", "frontier-ui-provenance-v1.json"),
  "utf8",
));

assert.equal(provenance.schema, "openrappter-frontier-provenance/1.0");
for (const [sourcePath, expectedDigest] of Object.entries(provenance.files)) {
  assert.ok(sourcePath.startsWith("beta/"), `Non-Frontier source in manifest: ${sourcePath}`);
  const relative = sourcePath.slice("beta/".length);
  const packagedPath = path.join(packagedRoot, relative);
  assert.ok(existsSync(packagedPath), `Packaged Frontier is missing ${relative}`);
  if (relative === "package.json") continue;
  const observed = createHash("sha256")
    .update(readFileSync(packagedPath))
    .digest("hex");
  assert.equal(observed, expectedDigest, `Packaged ${relative} drifted from source`);
}

const packagedMetadata = JSON.parse(
  readFileSync(path.join(packagedRoot, "package.json"), "utf8"),
);
assert.equal(packagedMetadata.main, "electron/bootstrap.mjs");
for (const forbidden of [
  "ui/frontier-host-adapter.js",
  "ui/frontier-chat-bridge.js",
]) {
  assert.equal(existsSync(path.join(packagedRoot, forbidden)), false);
}

process.stdout.write(
  `Frontier provenance verified: ${Object.keys(provenance.files).length} authoritative files\n`,
);
