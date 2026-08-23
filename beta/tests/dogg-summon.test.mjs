import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DOGG_SUMMON_SCHEMA,
  summonDoggNeighborhood,
  validateDoggRawUrl,
} from "../electron/dogg-summon.mjs";

const commit = "c".repeat(40);
const catalogUrl =
  `https://raw.githubusercontent.com/example/estate/${commit}/index.json`;
const agentUrl =
  `https://raw.githubusercontent.com/example/estate/${commit}/agents/proof_agent.py`;
const agent = "class ProofAgent: pass\n";
const sha256 = createHash("sha256").update(agent).digest("hex");

test("DOGG summons full resolves verified GitHub raw user data locally", async () => {
  const catalog = {
    schema: "rapp-store/1.0",
    rapplications: [{
      id: "proof-neighborhood",
      name: "Proof Neighborhood",
      singleton_filename: "proof_agent.py",
      singleton_url: agentUrl,
      singleton_sha256: sha256,
      singleton_bytes: Buffer.byteLength(agent),
      shipped_in_commit: commit,
      license: "Apache-2.0",
    }],
  };
  const calls = [];
  const twinManager = {
    async hatchFromStore(store, id, options) {
      const cartridge = await store.download(id);
      calls.push({ cartridge, id, options });
      return {
        id: "twin-proof",
        name: cartridge.entry.name,
        rappid: `rappid:@example/proof:${"d".repeat(64)}`,
        status: "ready",
      };
    },
  };
  const result = await summonDoggNeighborhood({
    fetchImpl: async (url) => {
      if (url === catalogUrl) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      if (url === agentUrl) return new Response(agent, { status: 200 });
      return new Response("not found", { status: 404 });
    },
    instruction: "start locally",
    storeId: "proof-neighborhood",
    summonsFull: catalogUrl,
    twinManager,
  });
  assert.equal(result.dogg.schema, DOGG_SUMMON_SCHEMA);
  assert.equal(result.dogg.authority, "local-estate-decides");
  assert.equal(result.dogg.source, "github-raw-user-data");
  assert.equal(calls[0].cartridge.sha256, sha256);
  assert.equal(calls[0].options.instruction, "start locally");
});

test("DOGG refuses mutable or non-raw summons and payloads", async () => {
  for (const url of [
    "https://raw.githubusercontent.com/example/estate/main/index.json",
    `https://github.com/example/estate/${commit}/index.json`,
    "https://example.com/index.json",
  ]) {
    assert.throws(() => validateDoggRawUrl(url), /immutable GitHub raw/);
  }
  await assert.rejects(
    summonDoggNeighborhood({
      fetchImpl: async () => new Response(JSON.stringify({
        schema: "rapp-store/1.0",
        rapplications: [{
          id: "unsafe",
          singleton_filename: "unsafe_agent.py",
          singleton_url: "https://example.com/unsafe_agent.py",
          singleton_sha256: "a".repeat(64),
        }],
      })),
      storeId: "unsafe",
      summonsFull: catalogUrl,
      twinManager: { hatchFromStore() {} },
    }),
    /not immutable GitHub raw user data/,
  );
});

test("Rappter Surgeon exposes DOGG summon as a local-decision tool", () => {
  const surgeon = readFileSync(
    path.join(import.meta.dirname, "..", "electron", "rappter-surgeon.mjs"),
    "utf8",
  );
  const main = readFileSync(
    path.join(import.meta.dirname, "..", "electron", "main.mjs"),
    "utf8",
  );
  assert.match(surgeon, /name: "summon_dogg_neighborhood"/);
  assert.match(surgeon, /summons_full/);
  assert.match(surgeon, /Global data is only a candidate|local estate decides/i);
  assert.match(main, /summonDoggNeighborhood/);
  assert.match(main, /summon_dogg:/);
  const compliance = JSON.parse(readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "resources",
      "good-ai-estate-rapp1-compliance.json",
    ),
    "utf8",
  ));
  assert.equal(compliance.status, "aligned-not-certified");
  assert.equal(
    compliance.authority.sha256,
    "6d06daba65d7c045716f3d6e95db8401ab58e727820e4114466d847f62cae49b",
  );
  assert.equal(compliance.public_spine.completion, false);
  assert.equal(compliance.public_spine.blocking_gaps, 41);
  assert.equal(compliance.dogg_summon.rapp1_core, false);
});
