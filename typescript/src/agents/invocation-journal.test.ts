import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  invocationsSince,
  recordInvocation,
  trimJournal,
} from "./invocation-journal.js";

const originalHome = process.env.OPENRAPPTER_HOME;
let temporaryHome: string | undefined;

afterEach(() => {
  delete process.env.OPENRAPPTER_INVOCATION_REQUEST_ID;
  if (originalHome === undefined) {
    delete process.env.OPENRAPPTER_HOME;
  } else {
    process.env.OPENRAPPTER_HOME = originalHome;
  }
  if (temporaryHome) {
    rmSync(temporaryHome, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

describe("agent invocation journal", () => {
  it("sanitizes structured results before prefixing and truncating", () => {
    temporaryHome = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-invocations-"),
    );
    process.env.OPENRAPPTER_HOME = temporaryHome;
    process.env.OPENRAPPTER_INVOCATION_REQUEST_ID = "request-sanitize";
    const secret = "ordinary-secret-value".repeat(20);

    recordInvocation(
      "Shell",
      JSON.stringify({ password: secret, output: "ok" }),
      true,
    );

    delete process.env.OPENRAPPTER_INVOCATION_REQUEST_ID;
    const [line] = invocationsSince(0, "request-sanitize");
    expect(line).toContain("[Shell] ERROR:");
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("ordinary-secret-value");
  });

  it("does not persist uncorrelated standalone invocations", () => {
    temporaryHome = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-invocations-"),
    );
    process.env.OPENRAPPTER_HOME = temporaryHome;
    delete process.env.OPENRAPPTER_INVOCATION_REQUEST_ID;

    recordInvocation("Shell", "standalone-result");

    expect(
      existsSync(
        path.join(temporaryHome, "agent-invocations.jsonl"),
      ),
    ).toBe(false);
  });

  it("isolates overlapping request journals by correlation ID", () => {
    temporaryHome = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-invocations-"),
    );
    process.env.OPENRAPPTER_HOME = temporaryHome;
    process.env.OPENRAPPTER_INVOCATION_REQUEST_ID = "request-a";
    recordInvocation("Shell", "result-a");
    process.env.OPENRAPPTER_INVOCATION_REQUEST_ID = "request-b";
    recordInvocation("Memory", "result-b");
    delete process.env.OPENRAPPTER_INVOCATION_REQUEST_ID;

    expect(invocationsSince(0, "request-a")).toEqual([
      "[Shell] result-a",
    ]);
    expect(invocationsSince(0, "request-b")).toEqual([
      "[Memory] result-b",
    ]);
  });

  it("finds correlated entries beyond the legacy tail window", () => {
    temporaryHome = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-invocations-"),
    );
    process.env.OPENRAPPTER_HOME = temporaryHome;
    process.env.OPENRAPPTER_INVOCATION_REQUEST_ID = "request-target";
    recordInvocation("Shell", "target-result");
    process.env.OPENRAPPTER_INVOCATION_REQUEST_ID = "request-noise";
    for (let index = 0; index < 300; index += 1) {
      recordInvocation("Noise", `noise-${index}`);
    }
    delete process.env.OPENRAPPTER_INVOCATION_REQUEST_ID;

    expect(
      invocationsSince(Number.MAX_SAFE_INTEGER, "request-target"),
    ).toEqual(["[Shell] target-result"]);
  });

  it("always cleans stale request files even when the legacy journal is short", () => {
    temporaryHome = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-invocations-"),
    );
    process.env.OPENRAPPTER_HOME = temporaryHome;
    writeFileSync(
      path.join(temporaryHome, "agent-invocations.jsonl"),
      '{"at":1,"line":"legacy"}\n',
    );
    const stale = path.join(
      temporaryHome,
      "agent-invocations.stale-request.jsonl",
    );
    writeFileSync(stale, '{"at":1,"line":"stale"}\n');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(stale, old, old);

    trimJournal();
    expect(existsSync(stale)).toBe(false);
    expect(
      existsSync(
        path.join(temporaryHome, "agent-invocations.jsonl"),
      ),
    ).toBe(false);
  });

  it("refuses a symlinked journal home without touching its target", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(
      path.join(os.tmpdir(), "openrappter-invocations-"),
    );
    temporaryHome = root;
    const target = path.join(root, "target");
    const alias = path.join(root, "alias");
    mkdirSync(target, { mode: 0o755 });
    const before = statSync(target).mode & 0o777;
    symlinkSync(target, alias, "dir");
    process.env.OPENRAPPTER_HOME = alias;
    process.env.OPENRAPPTER_INVOCATION_REQUEST_ID = "request-link";

    recordInvocation("Shell", "must-not-write");

    expect(readdirSync(target)).toEqual([]);
    expect(statSync(target).mode & 0o777).toBe(before);
  });
});
