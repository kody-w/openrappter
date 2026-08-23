import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const packageRoot = path.join(repositoryRoot, "typescript");
const binary = path.join(packageRoot, "bin", "openrappter.mjs");
const engine = path.join(repositoryRoot, "scripts", "rapter-clever-girl.mjs");
const fixture = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "rapter-clever-girl",
  "normalized.jsonl",
);
const capabilityCatalog = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "rapter-clever-girl",
  "capability-contract-catalog.json",
);
const environment = {
  ...process.env,
  HOME: path.join(repositoryRoot, ".clever-girl-test-home-not-created"),
  USERPROFILE: path.join(repositoryRoot, ".clever-girl-test-home-not-created"),
  OPENRAPPTER_HOME: path.join(
    repositoryRoot,
    ".clever-girl-test-home-not-created",
  ),
};

function run(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  });
}

describe("Clever Girl installed CLI contract", () => {
  it("documents the exact observe interface", () => {
    const result = run([binary, "clever-girl", "observe", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: openrappter clever-girl observe [options]",
    );
    for (const option of [
      "--input <path>",
      "--activity <path>",
      "--estate-manifest <path>",
      "--capability-catalog <path>",
      "--skills-root <path>",
      "--source <adapter>",
      "--since <date-time>",
      "--until <date-time>",
      "--min-sessions <count>",
      "--min-days <count>",
      "--output <path>",
      "--facet-sidecar-output <path>",
      "--report-version <version>",
      "--pretty",
    ]) {
      expect(result.stdout).toContain(option);
    }
  });

  it("emits byte-identical Observe Mode v2 JSON", () => {
    const observeArgs = [
      "observe",
      "--input",
      fixture,
      "--source",
      "normalized",
      "--report-version",
      "2",
    ];
    const direct = run([engine, ...observeArgs]);
    const packagedInterface = run([binary, "clever-girl", ...observeArgs]);

    expect(packagedInterface.status).toBe(direct.status);
    expect(packagedInterface.stdout).toBe(direct.stdout);
    expect(packagedInterface.stderr).toBe(direct.stderr);
    expect(JSON.parse(packagedInterface.stdout)).toMatchObject({
      schemaVersion: "rapter-clever-girl.observe.v2",
      mode: "observe",
      status: "ok",
    });
  });

  it("emits byte-identical Observe Mode v3 JSON with behavioral contracts", () => {
    const observeArgs = [
      "observe",
      "--input",
      fixture,
      "--source",
      "normalized",
      "--capability-catalog",
      capabilityCatalog,
      "--report-version",
      "3",
    ];
    const direct = run([engine, ...observeArgs]);
    const packagedInterface = run([binary, "clever-girl", ...observeArgs]);

    expect(packagedInterface.status).toBe(direct.status);
    expect(packagedInterface.stdout).toBe(direct.stdout);
    expect(packagedInterface.stderr).toBe(direct.stderr);
    expect(JSON.parse(packagedInterface.stdout)).toMatchObject({
      schemaVersion: "rapter-clever-girl.observe.v3",
      mode: "observe",
      status: "ok",
      detector: {
        unassignedRepairOccurrences: 0,
      },
    });
  });

  it("preserves configuration-error stdout, stderr, and exit semantics", () => {
    const direct = run([engine, "observe"]);
    const packagedInterface = run([binary, "clever-girl", "observe"]);

    expect(packagedInterface.status).toBe(2);
    expect(packagedInterface.status).toBe(direct.status);
    expect(packagedInterface.stdout).toBe("");
    expect(packagedInterface.stdout).toBe(direct.stdout);
    expect(packagedInterface.stderr).toBe(direct.stderr);
  });

  it("keeps the Observe Mode route free of generic CLI initialization", () => {
    const launcher = readFileSync(binary, "utf8");
    const observeRoute = launcher.slice(0, launcher.indexOf("} else {"));
    const wrapper = readFileSync(
      path.join(packageRoot, "bin", "clever-girl.mjs"),
      "utf8",
    );

    expect(observeRoute).not.toMatch(/child_process|src\/index|dist\/index/);
    expect(wrapper).not.toMatch(
      /node:(?:child_process|http|https|net|tls|dns|dgram)|\bfetch\s*\(/,
    );
    expect(wrapper).toContain("return engine.main(argv)");
  });
});
