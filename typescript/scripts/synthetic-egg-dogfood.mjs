import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = path.resolve(process.argv[2] || ".synthetic-organism-eggs");
if (!target.includes(`${path.sep}.synthetic-organism-eggs`)) {
  throw new Error("Synthetic dogfood output must stay in a .synthetic-organism-eggs directory.");
}
fs.rmSync(target, { recursive: true, force: true });
const home = path.join(target, "home");
fs.mkdirSync(path.join(home, "agents"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(home, "skills", "fixture"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(home, "sounds"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(home, "rappid.tail"), `${"5".repeat(64)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(home, "SOUL.md"), "# Synthetic organism\n", { mode: 0o600 });
fs.writeFileSync(path.join(home, "agents", "fixture_agent.js"), "export const synthetic = true;\n", { mode: 0o600 });
fs.writeFileSync(path.join(home, "agents", "lineage.jsonl"), '{"generation":1,"synthetic":true}\n', { mode: 0o600 });
fs.writeFileSync(path.join(home, "skills", "fixture", "SKILL.md"), "# Synthetic\n", { mode: 0o600 });
fs.writeFileSync(path.join(home, "memory.json"), '{"facts":["synthetic only"]}\n', { mode: 0o600 });
fs.writeFileSync(path.join(home, "cron.json"), '{"jobs":[{"id":"synthetic"}]}\n', { mode: 0o600 });
fs.writeFileSync(path.join(home, "sounds", "chirp.wav"), "RIFFsynthetic-only", { mode: 0o600 });
fs.writeFileSync(path.join(home, "sounds", "chirp.wav.license.json"), JSON.stringify({
  origin: "generated synthetic fixture",
  license: "CC0-1.0",
  owned: true,
}), { mode: 0o600 });

const root = path.resolve(import.meta.dirname, "..");
const { LocalOrganismAdapter, OrganismEggService } = await import(
  pathToFileURL(path.join(root, "dist", "egg", "index.js")).href
);
const service = new OrganismEggService(
  new LocalOrganismAdapter(home),
  path.join(target, "runtime"),
);
const common = {
  includeHistory: true,
  includeMedia: true,
  createdUtc: "2026-08-23T20:00:00.000Z",
  sourceVersion: "synthetic-dogfood",
  sourceCommit: "synthetic-fixture",
  sourceRing: "beta.11",
};
const portable = await service.export({
  ...common,
  mode: "portable",
  output: path.join(target, "synthetic-portable.egg"),
});
const sealed = await service.export({
  ...common,
  mode: "sealed-backup",
  output: path.join(target, "synthetic-sealed.egg"),
  passphrase: "synthetic-dogfood-passphrase",
});
const opaque = service.inspect(sealed.output);
const decrypted = service.inspect(sealed.output, "synthetic-dogfood-passphrase");
if (opaque.decrypted || !decrypted.decrypted) throw new Error("Sealed inspection contract failed.");
fs.writeFileSync(path.join(target, "REPORT.json"), JSON.stringify({
  synthetic: true,
  portable: { file: portable.output, digest: portable.digest, dimensions: portable.manifest.dimensions },
  sealed: { file: sealed.output, digest: sealed.digest, dimensions: sealed.manifest.dimensions },
}, null, 2));
console.log(path.join(target, "REPORT.json"));
