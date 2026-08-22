import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GOOD_AI_NEIGHBOR_SCHEMA,
  createNeighborhoodIdentity,
  ensureNeighborhoodManifest,
} from "../electron/neighborhood-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("every top-level AI neighborhood has a distinct OS app identity", () => {
  const alpha = createNeighborhoodIdentity("alpha");
  const research = createNeighborhoodIdentity("research-twin");
  const finance = createNeighborhoodIdentity("finance-twin");

  assert.equal(alpha.schema, GOOD_AI_NEIGHBOR_SCHEMA);
  assert.equal(alpha.app_name, "OpenRappter");
  assert.equal(alpha.dock_badge, "");
  assert.equal(research.app_name, "OpenRappter · Research Twin");
  assert.equal(research.dock_badge, "RT");
  assert.equal(finance.dock_badge, "FT");
  assert.equal(new Set([
    alpha.neighborhood_id,
    research.neighborhood_id,
    finance.neighborhood_id,
  ]).size, 3);
  assert.equal(new Set([
    alpha.app_user_model_id,
    research.app_user_model_id,
    finance.app_user_model_id,
  ]).size, 3);
  assert.equal(createNeighborhoodIdentity("../escape").instance, "alpha");
  const recursive = createNeighborhoodIdentity("research-twin", {
    generation: 2,
    neighborhoodId: `openrappter:research-twin:${"a".repeat(64)}`,
    parentNeighborhoodId: "openrappter:parent",
  });
  assert.equal(recursive.generation, 2);
  assert.equal(recursive.parent_neighborhood_id, "openrappter:parent");
  assert.equal(recursive.dock_badge, "RTAA");
  assert.match(recursive.app_name, /Research Twin · aaaa/);
});

test("the Electron shell visibly binds one dock creature to one neighborhood", () => {
  const main = read("electron/main.mjs");
  const ui = read("ui/index.html");
  const renderer = read("ui/renderer.js");

  assert.match(main, /app\.setName\(neighborhood\.app_name\)/);
  assert.match(main, /app\.setAppUserModelId\(neighborhood\.app_user_model_id\)/);
  assert.match(main, /app\.dock\.setBadge\(neighborhood\.dock_badge\)/);
  assert.match(main, /const state = \{\s*neighborhood,/);
  assert.match(ui, /data-drive="shell\.neighborhood"/);
  assert.match(ui, /Good AI Estate/);
  assert.match(renderer, /state\.neighborhood\.neighborhood_id/);
  assert.match(renderer, /document\.title = state\.neighborhood\.app_name/);
  const hatchProof = read("scripts/package-hatch-proof.mjs");
  const packageGate = read("scripts/package-gate.mjs");
  assert.match(hatchProof, /openrappter-package-hatch-proof\/1\.0/);
  assert.match(hatchProof, /command\("hatch"\)/);
  assert.match(hatchProof, /command\("stop"\)/);
  assert.match(packageGate, /package-hatch-proof\.mjs/);
  assert.match(packageGate, /newestPackagedSourceMtime/);
  assert.match(packageGate, /manifest\.build\?\.files/);
  assert.match(packageGate, /entry\.startsWith\("node_modules\/"\)/);
});

test("the Electron container is a private durable data manifest", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "good-neighbor-data-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const identity = createNeighborhoodIdentity("data-neighbor", {
    neighborhoodId: `openrappter:data-neighbor:${"b".repeat(64)}`,
  });
  const first = ensureNeighborhoodManifest(home, identity, {
    now: () => new Date("2026-08-22T12:00:00.000Z"),
  });
  const second = ensureNeighborhoodManifest(home, identity, {
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  assert.equal(first.manifest.container, "electron-app");
  assert.equal(first.manifest.durability, "data-defined");
  assert.equal(second.manifest.created_at, first.manifest.created_at);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
});

test("one estate manifests multiple residents and rejects foreign neighborhoods", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "good-neighbor-estate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const identity = createNeighborhoodIdentity("estate-root");
  const residents = [
    {
      kind: "root",
      neighborhood_id: identity.root_neighborhood_id,
      name: identity.instance_name,
      rappid: null,
    },
    ...["rappid:@openrappter/research:aaa", "rappid:@openrappter/finance:bbb"]
      .map((rappid) => ({
        kind: "resident",
        neighborhood_id: `${identity.estate_id}:resident:${rappid}`,
        name: rappid.split("/").at(-1),
        rappid,
        status: "ready",
      })),
  ];
  const { manifest } = ensureNeighborhoodManifest(home, identity, {
    neighborhoods: residents,
  });
  assert.equal(manifest.neighborhoods.length, 3);
  assert.deepEqual(
    manifest.neighborhoods.map((entry) => entry.kind),
    ["root", "resident", "resident"],
  );

  const foreign = structuredClone(residents);
  foreign[1].neighborhood_id = "estate:openrappter:foreign:resident:stowaway";
  assert.throws(
    () => ensureNeighborhoodManifest(home, identity, { neighborhoods: foreign }),
    /foreign neighborhood/i,
  );
});

test("Good AI Neighbor is a normative protocol, not a branding slogan", () => {
  const protocol = read("docs/GOOD-AI-NEIGHBOR-PROTOCOL.md");
  const docs = read("docs/README.md");
  const golden = read("GOLDEN_PATH.md");
  const compliance = read("docs/twins/COMPLIANCE.md");

  assert.match(protocol, /openrappter-good-ai-neighbor\/1\.0/);
  assert.match(protocol, /one dock creature owns one isolated AI estate/i);
  assert.match(protocol, /MUST NOT.*share, hardlink, symlink, scan, mutate, stop/s);
  assert.match(protocol, /may herd any neighborhood or twin in its estate/i);
  assert.match(protocol, /exactly one\s+`estate_id`/i);
  assert.match(protocol, /POST \/chat/);
  assert.match(protocol, /verified OpenRappter tile/i);
  assert.match(protocol, /bounded recursive tree/i);
  assert.match(protocol, /32 detached\s+child estates/);
  assert.match(protocol, /eight generations/);
  assert.match(protocol, /one-estate-many-neighborhoods/);
  assert.match(docs, /GOOD-AI-NEIGHBOR-PROTOCOL\.md/);
  assert.match(golden, /Good AI Estate/);
  assert.match(compliance, /own Electron estate and Dock creature/i);
});
