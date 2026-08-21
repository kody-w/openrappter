import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Installing on a Node below the declared floor used to succeed and then produce
// a dozen unrelated test failures, because the code reaches for node:sqlite and
// npm does not enforce `engines` unless asked. The floor was right; nothing made
// it bite. These tests keep the declaration honest and enforced.

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npmrc = readFileSync(new URL("../.npmrc", import.meta.url), "utf8");

// node:sqlite landed in Node 22.5. Anything the floor allows must have it.
const REQUIRED_BY_CODE = { major: 22, minor: 5 };

function floorOf(range) {
  const match = String(range).match(/>=\s*(\d+)\.(\d+)/);
  assert.ok(match, `engines.node must declare a lower bound, saw ${range}`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

test("the declared Node floor is at least what the code actually needs", () => {
  const floor = floorOf(pkg.engines?.node);
  const ok = floor.major > REQUIRED_BY_CODE.major
    || (floor.major === REQUIRED_BY_CODE.major && floor.minor >= REQUIRED_BY_CODE.minor);
  assert.ok(
    ok,
    `engines.node is ${pkg.engines?.node}, but the ledger imports node:sqlite, which `
      + `requires >=${REQUIRED_BY_CODE.major}.${REQUIRED_BY_CODE.minor}. `
      + "Lowering the floor below what the code imports is how a machine installs "
      + "successfully and then fails in twelve unrelated places.",
  );
});

test("the floor is enforced at install rather than merely declared", () => {
  assert.match(
    npmrc,
    /^engine-strict\s*=\s*true\s*$/m,
    "beta/.npmrc must set engine-strict=true, or npm installs happily on a Node "
      + "the project does not support and the failure surfaces much later, "
      + "somewhere unrelated",
  );
});

test("the running Node satisfies the range this package declares", () => {
  // Enforcement without a correct bound is worse than no enforcement: turning on
  // engine-strict against a stale upper bound would have refused installation on
  // the one machine that ran the suite clean (Node 26.5.0, 510 of 518 passing)
  // while the bound still said <26. If this fails, either the range is stale or
  // the runtime is genuinely unsupported — and you want to know which, now.
  const range = String(pkg.engines?.node || "");
  const lower = range.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  const upper = range.match(/<\s*(\d+)/);
  assert.ok(lower, `engines.node needs a lower bound, saw ${range}`);
  const [maj, min, pat] = process.versions.node.split(".").map(Number);
  const atLeast = maj > +lower[1]
    || (maj === +lower[1] && (min > +lower[2] || (min === +lower[2] && pat >= +lower[3])));
  assert.ok(atLeast, `running Node ${process.version} is below engines.node ${range}`);
  if (upper) {
    assert.ok(
      maj < Number(upper[1]),
      `running Node ${process.version} is excluded by engines.node ${range}, yet it is `
        + "running this suite. Widen the bound or stop using this runtime — with "
        + "engine-strict enabled, this configuration refuses to install.",
    );
  }
});

test("lifecycle scripts stay disabled", () => {
  // This nearly went the other way: appending engine-strict with `>` instead of
  // `>>` silently removed ignore-scripts, which would re-enable a postinstall
  // that downloads and chmods a third-party binary with no checksum. A settings
  // file that carries a security decision needs a test, not a comment alone.
  assert.match(
    npmrc,
    /^ignore-scripts\s*=\s*true\s*$/m,
    "beta/.npmrc must keep ignore-scripts=true — ffmpeg-static's postinstall "
      + "fetches an executable from a third-party release with no checksum and "
      + "chmods it 0755",
  );
});

test("every module the code imports from node: is available on this runtime", async () => {
  // Catches the class of failure directly: an import the running Node lacks.
  const sources = ["../electron/ledger.mjs"];
  for (const rel of sources) {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8");
    for (const [, mod] of text.matchAll(/from\s+"(node:[a-z:]+)"/g)) {
      await assert.doesNotReject(
        () => import(mod),
        `${rel} imports ${mod}, which this runtime (${process.version}) does not provide`,
      );
    }
  }
});
