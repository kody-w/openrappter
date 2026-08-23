import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows package smoke cleanup", () => {
  it("loads better-sqlite3 only in a child process", () => {
    const source = readFileSync(
      new URL("../../../scripts/package-smoke.mjs", import.meta.url),
      "utf8",
    );
    const marker = source.indexOf("const windowsFlightDir");
    const windowsBranch = source.slice(
      source.lastIndexOf("} else {", marker),
      source.indexOf("console.log(", marker),
    );

    expect(windowsBranch).toContain(
      '["--input-type=module", "--eval", windowsFlightScript]',
    );
    expect(windowsBranch).not.toMatch(/\bimport\s*\(/);
  });
});

describe("Clever Girl package smoke contract", () => {
  it("checks exact installed assets, help, and v2 behavior", () => {
    const source = readFileSync(
      new URL("../../../scripts/package-smoke.mjs", import.meta.url),
      "utf8",
    );

    for (const packagedPath of [
      "bin/clever-girl.mjs",
      "dist/clever-girl/rapter-clever-girl.mjs",
      "dist/clever-girl/rapter-clever-girl-context.mjs",
      "dist/clever-girl/rapter-clever-girl-observe-v2.json",
      "dist/clever-girl/SKILL.md",
    ]) {
      expect(source).toContain(packagedPath);
    }
    expect(source).toContain('"clever-girl", "observe", "--help"');
    expect(source).toContain("rapter-clever-girl.observe.v2");
    expect(source).toContain("installedClever.stdout !== sourceClever.stdout");
  });
});
