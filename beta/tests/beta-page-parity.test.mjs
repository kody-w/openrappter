import assert from "node:assert/strict";
import { createHash as createNodeHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

only("the browser crypto shim is SHA-256 at every padding boundary", async () => {
  const shim = await import(pathToFileURL(path.join(pageLib, "node-crypto.mjs")).href);
  const digestStrings = (createHash, ...parts) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part, "utf8");
    return hash.digest("hex");
  };
  const digest = (createHash, input, splitAt = null) => {
    const hash = createHash("sha256");
    if (splitAt === null) hash.update(input);
    else {
      hash.update(input.subarray(0, splitAt));
      hash.update(input.subarray(splitAt));
    }
    return hash.digest("hex");
  };

  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(
      digestStrings(shim.createHash, input),
      expected,
      `standard string vector ${JSON.stringify(input)}`,
    );
  }

  for (let length = 0; length <= 200; length += 1) {
    const input = Buffer.alloc(length, 0x61);
    const expected = digest(createNodeHash, input);
    assert.equal(
      digest(shim.createHash, input),
      expected,
      `browser SHA-256 differs from node:crypto at byte length ${length}`,
    );
    assert.equal(
      digest(shim.createHash, input, Math.floor(length / 2)),
      expected,
      `split update differs at byte length ${length}`,
    );
  }

  const protocolParts = ["rapp/1:particle", "\n", "{\"asserts\":{\"note\":\"xx\"},\"requires\":{}}"];
  assert.equal(
    digestStrings(shim.createHash, ...protocolParts),
    digestStrings(createNodeHash, ...protocolParts),
    "chained protocol strings hash identically",
  );
  const utf8 = "\u2603\u{1f680}";
  assert.equal(
    digestStrings(shim.createHash, utf8),
    digestStrings(createNodeHash, utf8),
    "UTF-8 strings hash identically",
  );
});
