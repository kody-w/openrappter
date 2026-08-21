import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The store index records each bundled rapplication's sha256 and byte count, and
// a published index whose hash no longer matches the bytes breaks verification for
// anyone summoning that rapplication — the one check between a public fetch and
// running someone else's code. CI enforces this, which means it is caught after a
// push; twice now that has been me. Catch it here instead, before the push.

const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(
  readFileSync(path.join(betaRoot, "frontier", "store", "index.json"), "utf8"),
);

function entries(node, out = []) {
  if (Array.isArray(node)) { for (const v of node) entries(v, out); return out; }
  if (node && typeof node === "object") {
    if (node.singleton_filename && node.singleton_sha256) out.push(node);
    for (const v of Object.values(node)) entries(v, out);
  }
  return out;
}

test("the store index matches the rapplication bytes it describes", () => {
  const found = entries(index);
  assert.ok(found.length > 0, "expected the store index to describe rapplications");
  const stale = [];
  for (const entry of found) {
    const dir = String(entry.manifest_name || "").split("/").pop();
    const file = path.join(
      betaRoot, "frontier", "rapplications", dir, "agents", entry.singleton_filename,
    );
    let bytes;
    try { bytes = readFileSync(file); } catch { stale.push(`${dir}: ${file} is missing`); continue; }
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== entry.singleton_sha256) {
      stale.push(`${dir}: sha256 is ${sha.slice(0, 12)}…, index says ${String(entry.singleton_sha256).slice(0, 12)}…`);
    }
    const size = statSync(file).size;
    if (entry.singleton_bytes !== undefined && size !== entry.singleton_bytes) {
      stale.push(`${dir}: ${size} bytes on disk, index says ${entry.singleton_bytes}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    "The store index is out of date with the rapplication bytes.\n"
      + "Run: python3 beta/frontier/build_store.py  and commit the result.\n"
      + stale.join("\n"),
  );
});
