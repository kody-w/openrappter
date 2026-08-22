import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The beta page at docs/beta/ claims to run "the code that ships". That claim is
// only worth making if it stays true, and a copied file drifts the moment
// someone edits the original — silently, because nothing would fail. So this
// fails the build instead.
//
// GitHub Pages serves only from /docs, which is why the modules are copied there
// rather than imported across the tree. The copy is a deployment mechanic; the
// identity is the thing being protected.

const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(betaRoot, "..");
const pageLib = path.join(repoRoot, "docs", "beta", "lib");

const COPIED = ["rapp-protocol.mjs", "qqdrill-deps.mjs", "qqdrill.mjs"];

// The installer sparse-checks-out `beta` and `tools/rapp1` only, so an INSTALLED
// Frontier has no docs/ at all — and it runs this suite as its install gate.
// Enforcing a repository-shaped invariant there turned every install red for a
// defect the user cannot have and cannot fix. The parity these tests protect is
// a property of the repository, so they only run where the repository is.
const inRepository = existsSync(path.join(repoRoot, "docs", "beta", "index.html"));
const only = inRepository ? test : test.skip;

only("the beta page runs the shipped modules, byte for byte", () => {
  const drifted = [];
  for (const name of COPIED) {
    const shipped = path.join(betaRoot, "electron", name);
    const served = path.join(pageLib, name);
    assert.ok(existsSync(served), `docs/beta/lib/${name} is missing — the page cannot load`);
    if (readFileSync(shipped).equals(readFileSync(served))) continue;
    drifted.push(name);
  }
  assert.deepEqual(
    drifted,
    [],
    "these files differ between beta/electron and docs/beta/lib, so the page is no longer "
      + "running what ships. Re-copy them in the same commit as the change:\n"
      + COPIED.map((n) => `  cp beta/electron/${n} docs/beta/lib/${n}`).join("\n"),
  );
});

only("only the crypto shim is reimplemented for the browser", () => {
  // The page is allowed to supply SHA-256, because the protocol hashes
  // synchronously and Web Crypto does not. It is not allowed to reimplement
  // anything above that, because that is where drift would actually hurt.
  const page = readFileSync(path.join(repoRoot, "docs", "beta", "index.html"), "utf8");
  for (const name of ["drill", "assimilate", "fixedPoints", "runsFrom", "alignment"]) {
    assert.ok(
      page.includes(name),
      `the page should USE ${name} from the shipped module`,
    );
    assert.equal(
      new RegExp(`function\\s+${name}\\s*\\(`).test(page),
      false,
      `the page must not define its own ${name} — a browser copy of the logic would drift`,
    );
  }
  assert.match(page, /"node:crypto":\s*"\.\/lib\/node-crypto\.mjs"/, "the import map wires the shim");
});
