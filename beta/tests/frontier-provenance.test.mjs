import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const provenancePath = path.join(root, "contracts/frontier-ui-provenance-v1.json");
const provenance = existsSync(provenancePath)
  ? JSON.parse(readFileSync(provenancePath, "utf8"))
  : null;

test("records the application and Brainstem authorities selected by deployment", () => {
  assert.equal(provenance?.schema, "openrappter-frontier-provenance/1.0");
  assert.deepEqual(provenance?.application, {
    repository: "kody-w/openrappter",
    root: "beta",
    entrypoint: "beta/electron/bootstrap.mjs",
    renderer: "beta/ui",
    packageWorkflow: ".github/workflows/frontier-desktop.yml",
  });
  assert.equal(
    provenance?.brainstem?.taggedReleaseRoot,
    "rapp_brainstem",
  );
  assert.equal(
    provenance?.brainstem?.installedRuntime,
    "~/.openrappter/brainstem/src/rapp_brainstem",
  );
});

test("the deployed beta is an installer landing for the maintained application", () => {
  const landing = read("docs/beta/index.html");
  assert.match(
    landing,
    /raw\.githubusercontent\.com\/kody-w\/openrappter\/main\/beta\/install\.sh/,
  );
  const installer = read("beta/install.sh");
  assert.match(installer, /REPO_URL=.*kody-w\/openrappter/);
  assert.match(installer, /BETA_SOURCE\/beta/);
  assert.match(installer, /src\/rapp_brainstem/);
});

test("desktop release packages beta directly and never the TypeScript patient host", () => {
  const frontierWorkflow = read(".github/workflows/frontier-desktop.yml");
  const releaseWorkflow = read(".github/workflows/release.yml");
  assert.match(
    frontierWorkflow,
    /name: Package[\s\S]*working-directory: beta[\s\S]*npm run/,
  );
  assert.match(releaseWorkflow, /working-directory: beta/);
  assert.doesNotMatch(releaseWorkflow, /working-directory: typescript\/desktop/);
});

test("the maintained application owns its renderer and IPC modules", () => {
  const metadata = JSON.parse(read("beta/package.json"));
  assert.equal(metadata.main, "electron/bootstrap.mjs");
  assert.ok(metadata.build.files.includes("ui/**"));
  assert.ok(metadata.build.files.includes("electron/**"));
  const html = read("beta/ui/index.html");
  const features = read("beta/ui/frontier-features.js");
  assert.match(html, /src="renderer\.js"/);
  assert.doesNotMatch(html, /frontier-host-adapter\.js/);
  assert.doesNotMatch(html, /frontier-chat-bridge\.js/);
  assert.match(features, /global\.brainstemBeta/);
  assert.match(features, /nativeCall\("getState"\)/);
  assert.doesNotMatch(features, /OpenRappterFrontierHost|rpc\(/);
});

test("the legacy TypeScript build cannot mirror or rewrite Frontier", () => {
  const build = read("typescript/scripts/build-ui.mjs");
  assert.doesNotMatch(build, /beta.*ui|frontierRoot|rapp_brainstem|frontier-chat/);
  const packageSmoke = read("typescript/scripts/package-smoke.mjs");
  assert.doesNotMatch(packageSmoke, /Frontier primary interface|frontier-features/);
});

test("every authoritative renderer byte matches its reviewed provenance digest", () => {
  assert.ok(provenance);
  const reviewed = new Set(Object.keys(provenance.files));
  for (const [file, expected] of Object.entries(provenance.files)) {
    const bytes = readFileSync(path.join(root, file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      `${file} drifted from the reviewed Frontier source`,
    );
  }
  for (const required of [
    "beta/ui/index.html",
    "beta/ui/renderer.js",
    "beta/electron/bootstrap.mjs",
    "beta/electron/main.mjs",
    "beta/electron/preload.cjs",
  ]) {
    assert.ok(reviewed.has(required), `${required} is missing provenance`);
  }
});

test("a one-byte source mutation and a reintroduced mirror fail provenance", () => {
  const sourcePath = "beta/ui/index.html";
  const source = readFileSync(path.join(root, sourcePath));
  const mutated = Buffer.concat([source, Buffer.from("\n")]);
  assert.notEqual(
    createHash("sha256").update(mutated).digest("hex"),
    provenance.files[sourcePath],
  );

  const forbiddenMirrorBuild = `${read("typescript/scripts/build-ui.mjs")}
const frontierRoot = path.resolve(packageRoot, "..", "beta", "ui");`;
  assert.match(forbiddenMirrorBuild, /frontierRoot[\s\S]*beta.*ui/);
  assert.doesNotMatch(
    read("typescript/scripts/build-ui.mjs"),
    /frontierRoot[\s\S]*beta.*ui/,
  );
});
