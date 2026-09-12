import { describe, expect, it, vi } from "vitest";
import { WorkService } from "../src/index.js";
import type { EffectOutcome, WorkCommand } from "../src/index.js";
import { command, fixture, scope, success } from "./fixtures.js";

describe("WorkService canonical orchestration", () => {
  it("authorizes, reads back intent, executes, links evidence, and publishes only after scanning", async () => {
    const { service, capability, store } = fixture();
    const result = await service.commit(capability, command(), async (context) => {
      store.log.push("effect");
      expect(context.intentRef).toBe(store.frames()[0]?.ref);
      expect(context.permit).toMatchObject({ commandHash: context.commandHash, intentRef: context.intentRef });
      expect((await store.scan(structuredClone(store.frames()), scope)).frames).toHaveLength(1);
      return success();
    });
    expect(result.state).toBe("committed");
    expect(store.log).toEqual([
      "authorize:read", "read", "scan", "authorize:command",
      "append:work.intent", "read", "scan", "authorize:permit", "effect", "scan",
      "append:work.outcome", "read", "scan", "append:work.evidence", "read", "scan",
    ]);
    if (result.state !== "committed") throw new Error("not committed");
    expect(result.proof.intentRef).toBe(store.frames()[0]?.ref);
    expect(result.proof.outcomeRef).toBe(store.frames()[1]?.ref);
    expect(result.proof.evidenceRef).toBe(store.frames()[2]?.ref);
    expect(result.proof.heads.body).toBe(result.proof.evidenceRef);
  });

  it("rebuilds idempotency from committed history after service restart", async () => {
    const { service, createService, capability } = fixture();
    const effect = vi.fn(async () => success());
    const first = await service.commit(capability, command(), effect);
    const second = await createService().commit(capability, command(), effect);
    expect(first.state).toBe("committed");
    expect(second).toMatchObject({ state: "committed", replayed: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent service instances on the workspace lock", async () => {
    const { service, createService, capability } = fixture();
    const effect = vi.fn(async () => { await Promise.resolve(); return success(); });
    const results = await Promise.all([
      service.commit(capability, command(), effect),
      createService().commit(capability, command(), effect),
      createService().commit(capability, command(), effect),
    ]);
    expect(results.map((entry) => entry.replayed).sort()).toEqual([false, true, true]);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("rejects same-key different-command replays, including altered resources", async () => {
    const { service, capability } = fixture();
    const effect = vi.fn(async () => success());
    await service.commit(capability, command(), effect);
    await expect(service.commit(capability, command("command-1", { title: "Other" }), effect))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.commit(capability, { ...command(), resources: [] }, effect))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("does not use caller IDs or old proofs as authorization", async () => {
    const { service, capability, store } = fixture();
    const effect = vi.fn(async () => success());
    await service.commit(capability, command(), effect);
    const size = store.frames().length;
    await expect(service.commit({}, command(), effect)).rejects.toThrow("unauthorized");
    await expect(service.read({}, scope)).rejects.toThrow("unauthorized");
    expect(store.frames()).toHaveLength(size);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("denies exact commands before any intent or effect", async () => {
    const test = fixture();
    test.denyCommand();
    const effect = vi.fn();
    await expect(test.service.commit(test.capability, command(), effect)).rejects.toThrow("unauthorized");
    expect(test.store.frames()).toHaveLength(0);
    expect(effect).not.toHaveBeenCalled();
  });

  it("records an acknowledged no-effect denial if permit issuance fails", async () => {
    const test = fixture();
    test.denyPermit();
    const effect = vi.fn();
    const result = await test.service.commit(test.capability, command(), effect);
    expect(result).toMatchObject({ state: "committed", status: "denied" });
    expect(effect).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("never claims success if append %i fails before durability", async (append) => {
    const { service, capability, store, createService } = fixture();
    store.failBeforeAppend = append;
    const effect = vi.fn(async () => success());
    expect(await service.commit(capability, command(), effect)).toMatchObject({ state: "unresolved" });
    expect(effect).toHaveBeenCalledTimes(append === 1 ? 0 : 1);
    if (append > 1) {
      expect(await createService().commit(capability, command(), effect)).toMatchObject({
        state: "unresolved", replayed: true,
      });
      expect(effect).toHaveBeenCalledTimes(1);
    }
  });

  it.each([1, 2])("recovered append %i acknowledgement loss is unresolved, never rerun", async (append) => {
    const { service, capability, store, createService } = fixture();
    store.failAfterAppend = append;
    const effect = vi.fn(async () => success());
    expect(await service.commit(capability, command(), effect)).toMatchObject({ state: "unresolved" });
    expect(await createService().commit(capability, command(), effect)).toMatchObject({
      state: "unresolved", replayed: true,
    });
    expect(effect).toHaveBeenCalledTimes(append === 1 ? 0 : 1);
  });

  it("can recognize a fully persisted triple after its final acknowledgement was lost", async () => {
    const { service, capability, store, createService } = fixture();
    store.failAfterAppend = 3;
    const effect = vi.fn(async () => success());
    expect(await service.commit(capability, command(), effect)).toMatchObject({ state: "unresolved" });
    expect(await createService().commit(capability, command(), effect)).toMatchObject({
      state: "committed", replayed: true,
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("keeps thrown effects unresolved even if the external side effect happened", async () => {
    const { service, capability, createService } = fixture();
    let externalWrites = 0;
    const effect = vi.fn(async () => { externalWrites++; throw new Error("lost guest acknowledgement"); });
    expect(await service.commit(capability, command(), effect)).toMatchObject({
      state: "unresolved", reason: "effect-uncertain",
    });
    expect(await createService().commit(capability, command(), effect)).toMatchObject({
      state: "unresolved", replayed: true, reason: "intent-only",
    });
    expect(externalWrites).toBe(1);
  });

  it("does not mistake missing evidence for a completed projection", async () => {
    const { service, capability, store } = fixture();
    store.failBeforeAppend = 3;
    await service.commit(capability, command(), async () => success());
    const apply = vi.fn((count: number) => count + 1);
    const projection = await service.project(capability, scope, { initial: () => 0, apply });
    expect(projection.value).toBe(0);
    expect(projection.proofs).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
    expect((await service.read(capability, scope)).commands[0]).toMatchObject({
      state: "unresolved", reason: "outcome-unproven",
    });
  });

  it("rejects a tampered chain before projecting or appending", async () => {
    const { service, capability, store } = fixture();
    await service.commit(capability, command(), async () => success());
    store.frames()[1]!.value = { type: "work.outcome", value: "forged" };
    const apply = vi.fn();
    await expect(service.project(capability, scope, { initial: () => 0, apply })).rejects.toThrow("invalid chain");
    await expect(service.commit(capability, command("next"), vi.fn())).rejects.toThrow("invalid chain");
    expect(apply).not.toHaveBeenCalled();
    expect(store.appendCount).toBe(3);
  });

  it.each([2, 3, 4])("does not publish if read-back scan %i fails", async (scan) => {
    const { service, capability, store } = fixture();
    store.failScan = scan;
    const effect = vi.fn(async () => success());
    expect(await service.commit(capability, command(), effect)).toMatchObject({ state: "unresolved" });
    expect(effect).toHaveBeenCalledTimes(scan === 2 ? 0 : 1);
  });

  it("does not execute when an append acknowledgement lacks its read-back intent", async () => {
    const { service, capability, store } = fixture();
    store.dropAppend = 1;
    const effect = vi.fn(async () => success());
    expect(await service.commit(capability, command(), effect)).toMatchObject({ state: "unresolved" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("rejects authenticated but unlinked, duplicated, or wrong-receipt events", async () => {
    for (const change of ["unlinked", "duplicate", "receipts"] as const) {
      const { service, capability, store } = fixture();
      await service.commit(capability, command(), async () => success());
      const evidence = structuredClone(store.frames()[2]!.value) as Record<string, never>;
      if (change === "duplicate") store.appendEvent(scope, evidence);
      else {
        store.frames().pop();
        if (change === "unlinked") (evidence as Record<string, unknown>).outcomeRef = "missing";
        else (evidence as Record<string, unknown>).receipts = [{ kind: "forged" }];
        store.appendEvent(scope, evidence);
      }
      await expect(service.read(capability, scope)).rejects.toMatchObject({
        code: change === "duplicate" ? "unlinked_work_event" : "invalid_evidence",
      });
    }
  });

  it("cancels before the effect without manufacturing a guest failure", async () => {
    const { service, capability, store } = fixture();
    const controller = new AbortController();
    store.onAppend = () => controller.abort();
    const effect = vi.fn();
    const result = await service.commit(capability, command(), effect, { signal: controller.signal });
    expect(result).toMatchObject({ state: "committed", status: "cancelled" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("pre-aborted commands do not create intents", async () => {
    const { service, capability, store } = fixture();
    await expect(service.commit(capability, command(), vi.fn(), { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(store.frames()).toHaveLength(0);
  });

  it("never accepts a malformed effect result as terminal", async () => {
    const { service, capability } = fixture();
    const effect = vi.fn(async () => ({ ...success(), receipts: [] }) as EffectOutcome);
    expect(await service.commit(capability, command(), effect)).toMatchObject({
      state: "unresolved", reason: "effect-uncertain",
    });
  });

  it("snapshots command input and protects scanned command data against mutation", async () => {
    const { service, capability } = fixture();
    const input = command();
    const promise = service.commit(capability, input, async ({ command: captured }) => {
      expect(captured.payload).toEqual({ title: "Report" });
      return success();
    });
    (input.payload as { title: string }).title = "mutated";
    const result = await promise;
    expect(result.command.payload).toEqual({ title: "Report" });
    expect(() => { (result.command.payload as { title: string }).title = "forged"; }).toThrow();
  });

  it("rejects getters and cyclic or non-JSON payloads without invoking them", async () => {
    const { service, capability } = fixture();
    const getter = vi.fn(() => "secret");
    const payload = Object.defineProperty({}, "secret", { get: getter, enumerable: true });
    await expect(service.commit(capability, command("getter", payload), vi.fn())).rejects.toMatchObject({ code: "invalid_json" });
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(service.commit(capability, command("cycle", cycle as never), vi.fn()))
      .rejects.toMatchObject({ code: "invalid_json" });
    await expect(service.commit(capability, command("nan", NaN), vi.fn()))
      .rejects.toMatchObject({ code: "invalid_json" });
  });

  it("requires every mandatory production boundary", () => {
    expect(() => new WorkService({} as never)).toThrow("missing_mandatory_port");
  });

  it("rejects wrong-owner verified scanner output even if the scanner is miswired", async () => {
    const { service, capability, store } = fixture();
    const original = store.scan.bind(store);
    store.scan = (raw, owner) => ({ ...original(raw, owner), scope: { ...owner, workspaceId: "elsewhere" } });
    await expect(service.read(capability, scope)).rejects.toMatchObject({ code: "wrong_history_owner" });
  });
});
