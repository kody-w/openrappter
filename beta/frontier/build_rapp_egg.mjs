#!/usr/bin/env node
// Fledge a rapplication: pack a self-contained rapplication FOLDER (agents/*.py
// + optional index.html) into a fail-closed rapp/1-egg that re-hatches anywhere
// via drop-to-hatch. Clean source only — device exhaust (~/.rapp/<slug>/) never
// travels. Usage: node build_rapp_egg.mjs <rapplication-dir> [out.egg]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = process.env.RAPP_PROTOCOL || path.join(HERE, "..", "electron", "rapp-protocol.mjs");
const { packEgg, verifyEgg, readEgg, mintRappid } = await import(PROTO);

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error("usage: node build_rapp_egg.mjs <rapplication-dir> [out.egg]");
  process.exit(1);
}
const root = path.resolve(dir);
const name = path.basename(root);
const agentsDir = path.join(root, "agents");
if (!existsSync(agentsDir)) { console.error(`REFUSING: ${name} has no agents/ dir (not a fractal rapplication).`); process.exit(1); }

// files: agents/*.py -> agents/<file>; index.html -> ui.html (hatchEgg reads that as the custom UI)
const files = {};
let agentCount = 0;
for (const f of readdirSync(agentsDir)) {
  if (f.endsWith(".py") && statSync(path.join(agentsDir, f)).isFile()) {
    files[`agents/${f}`] = readFileSync(path.join(agentsDir, f));
    if (/_agent\.py$/.test(f)) agentCount++;
  }
}
if (!agentCount) { console.error(`REFUSING: ${name}/agents/ has no *_agent.py engine.`); process.exit(1); }
if (existsSync(path.join(root, "index.html"))) files["ui.html"] = readFileSync(path.join(root, "index.html"));
if (existsSync(path.join(root, "soul.md"))) files["soul.md"] = readFileSync(path.join(root, "soul.md"));

const { rappid } = mintRappid("frontier", name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
const egg = packEgg({
  variant: "rapplication", rappid, createdUtc: new Date().toISOString(),
  files, payload: { name, summary: `Fledged rapplication ${name}.` },
});
const [ok, law, reason] = verifyEgg(egg);
if (!ok) { console.error(`packed egg failed its own verifier (${law}: ${reason})`); process.exit(1); }
// self-check: it reads back as a rapplication with the agents + ui
const parsed = readEgg(egg);
const out = process.argv[3] || path.join(root, `${name}.egg`);
writeFileSync(out, egg, { mode: 0o600 });
console.log(JSON.stringify({
  egg: out, sha256: createHash("sha256").update(egg).digest("hex"), size_bytes: egg.length,
  rappid, agents: Object.keys(parsed.files).filter((k) => /_agent\.py$/.test(k)),
  ui: Object.keys(parsed.files).includes("ui.html"),
}, null, 2));
