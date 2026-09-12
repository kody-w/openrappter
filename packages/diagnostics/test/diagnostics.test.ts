import { describe, expect, it, vi } from "vitest";
import { DiagnosticRedactor, Diagnostics, REDACTED } from "../src/index.js";

describe("non-authoritative redacted diagnostics", () => {
  it("redacts raw inputs, outputs, secrets, paths, and unknown strings recursively", () => {
    const diagnostics = new Diagnostics();
    diagnostics.record({
      component: "runtime", operation: "model.complete", level: "error",
      details: {
        status: "failed", count: 3, token: "ghp_secret", password: "private",
        nested: {
          input: { prompt: "business private" }, output: "customer report",
          path: "/Users/someone/private", error: new Error("secret stack"),
          unknown: "Bearer abc", code: "transport_unavailable",
        },
      },
    });
    const exported = diagnostics.exportSupport();
    for (const secret of ["ghp_secret", "business private", "customer report", "/Users/", "Bearer abc", "secret stack"]) {
      expect(exported).not.toContain(secret);
    }
    expect(exported).toContain("transport_unavailable");
    expect(JSON.parse(exported)).toMatchObject({ authoritative: false, redacted: true });
  });

  it("pseudonymizes resource identifiers consistently without retaining their plaintext", () => {
    const redactor = new DiagnosticRedactor();
    const value = redactor.redact({ workspaceId: "workspace-customer-sensitive", agentId: "agent" }) as Record<string, string>;
    expect(value.workspaceId).toMatch(/^id:[a-f0-9]{16}$/u);
    expect(redactor.redact({ workspaceId: "workspace-customer-sensitive" })).toEqual({ workspaceId: value.workspaceId });
    expect(new DiagnosticRedactor().redact({ workspaceId: "workspace-customer-sensitive" }))
      .not.toEqual({ workspaceId: value.workspaceId });
  });

  it("does not run getters, serializers, or error object methods", () => {
    const getter = vi.fn(() => "secret");
    const toJSON = vi.fn(() => ({ status: "secret" }));
    const input = Object.defineProperty({ toJSON }, "code", { get: getter, enumerable: true });
    const value = new DiagnosticRedactor().redact(input);
    expect(value).toEqual({ toJSON: REDACTED, code: REDACTED });
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("bounds recursive and cyclic values", () => {
    const cycle: Record<string, unknown> = { count: 1 };
    cycle.child = cycle;
    expect(new DiagnosticRedactor().redact(cycle)).toEqual({ count: 1, child: REDACTED });
  });

  it("redacts secrets even when disguised as safe status codes", () => {
    const redactor = new DiagnosticRedactor();
    expect(redactor.redact({
      code: `ghp_${"a".repeat(50)}`, status: "user@example.com", component: "/Users/private",
    })).toEqual({ code: REDACTED, status: REDACTED, component: REDACTED });
  });

  it("bounds retention and cannot be made authoritative or mutated through an export", () => {
    const diagnostics = new Diagnostics({ maxRecords: 2 });
    for (let index = 0; index < 3; index++) diagnostics.record({
      component: "work", operation: "commit", level: "info", details: { count: index, authoritative: true },
    });
    expect(diagnostics.snapshot().map((record) => record.sequence)).toEqual([2, 3]);
    expect(diagnostics.snapshot().every((record) => record.authoritative === false)).toBe(true);
    expect(() => (diagnostics.snapshot() as unknown[]).pop()).toThrow();
    const exported = JSON.parse(diagnostics.exportSupport());
    exported.records.length = 0;
    expect(diagnostics.snapshot()).toHaveLength(2);
  });

  it("cannot make application work fail because a diagnostic sink or clock fails", () => {
    expect(() => new Diagnostics({ sink: () => { throw new Error("sink"); } }).record({
      component: "work", operation: "commit", level: "error",
    })).not.toThrow();
    expect(() => new Diagnostics({ now: () => { throw new Error("clock"); } }).record({
      component: "work", operation: "commit", level: "error",
    })).not.toThrow();
  });

  it("does not probe anything during construction and bounds explicit health checks", async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(async () => new Promise<"healthy">(() => {}));
      const diagnostics = new Diagnostics();
      expect(check).not.toHaveBeenCalled();
      const pending = diagnostics.health([{ name: "provider", check }], 10);
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toEqual([{
        authoritative: false, name: { name: "provider" }, status: "unconfirmed",
      }]);
    } finally { vi.useRealTimers(); }
  });

  it("does not leak failing health-probe error messages", async () => {
    const diagnostics = new Diagnostics();
    const health = await diagnostics.health([{
      name: "transport", async check() { throw new Error("password=secret"); },
    }]);
    expect(health[0]?.status).toBe("unconfirmed");
    expect(JSON.stringify(health)).not.toContain("password");
    expect(diagnostics.exportSupport()).not.toContain("secret");
  });
});
