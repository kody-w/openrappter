import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";


const proof = readFileSync(
  new URL("../scripts/data-sloshing-proof.mjs", import.meta.url),
  "utf8",
);

test("data sloshing proof uses the real isolated kernel and Molter gate", () => {
  assert.match(proof, /cpSync\(pristineGrail, grailDirectory/);
  assert.match(proof, /new BetaRouteManager\(\{/);
  assert.doesNotMatch(proof, /moltVerifier\s*:/);
  assert.match(proof, /manager\.startDefault\(\)/);
  assert.match(proof, /fetch\(`\$\{route\.url\}\/chat`/);
  assert.match(proof, /ring\?\.meta\?\.verifiedBy === "molter\._verify"/);
  assert.match(proof, /endpoint: `\$\{fixtureOrigin\}\/model`/);
  assert.match(proof, /NO_PROXY: "127\.0\.0\.1,localhost"/);
  assert.match(proof, /HTTP_PROXY: ""/);
  assert.match(proof, /ignoredGrailEntries/);
});

test("data sloshing proof covers the three turns, CLI queries, and redaction", () => {
  assert.match(proof, /what's the weather here/);
  assert.match(proof, /drop a pin here for Kody/);
  assert.match(proof, /how did I build the weather agent\?/);
  assert.match(proof, /select event, tool_name from agents/);
  assert.match(proof, /spawnSync\(\s*"grep"/);
  assert.match(proof, /credential-shaped turn is redacted in SQLite and JSONL/);
  assert.match(proof, /SCRATCH_BETA_HOME=/);
  assert.match(proof, /DATA_SLOSHING_PROOF=/);
});
