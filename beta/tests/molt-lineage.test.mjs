// Pins the molt-lineage/1.0 store contract (beta/docs/MOLT-LINEAGE-PROTOCOL.md):
// deterministic content-addressed rappids, env-scoped HEADs over one shared ring
// store, fail-safe passthrough resolution, gated fast-forward-only promotion with
// named conflicts, drift detection, and the tamper-evident promotion journal.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LineageStore,
  MAX_PROMOTION_JOURNAL_BYTES,
  lineageStoreInternals,
} from "../electron/lineage-store.mjs";

const {
  ancestorRappidFor,
  filesystemSegment,
  ringRappidFor,
} = lineageStoreInternals;

const BASELINE = "from agents.basic_agent import BasicAgent\n\nclass EchoAgent(BasicAgent):\n    def perform(self, **kwargs):\n        return 'baseline'\n";
const MOLT_1 = BASELINE.replace("'baseline'", "'ring one'");
const MOLT_2 = BASELINE.replace("'baseline'", "'ring two'");
const MOLT_PROD_ONLY = BASELINE.replace("'baseline'", "'prod hotfix'");

function freshStore(opts = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "molt-lineage-test-"));
  const brainstemDir = path.join(root, "brainstem");
  const agentsDirectory = path.join(brainstemDir, "agents");
  mkdirSync(agentsDirectory, { recursive: true });
  writeFileSync(path.join(agentsDirectory, "echo_agent.py"), BASELINE);
  const store = new LineageStore({
    brainstemDir,
    root: path.join(root, "lineage"),
    ...opts,
  });
  return { store, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function ancestor(store) {
  return store.baselineAncestors().find(
    (entry) => entry.filename === "echo_agent.py",
  ).ancestorRappid;
}

function ringFile(store, ancestorRappid, ringRappid) {
  return path.join(
    store.root,
    filesystemSegment(ancestorRappid),
    "rings",
    filesystemSegment(ringRappid),
    "meta.json",
  );
}

test("rappids are deterministic: same molt has the same identity everywhere", () => {
  const a1 = ancestorRappidFor("echo_agent.py", BASELINE);
  const a2 = ancestorRappidFor("echo_agent.py", BASELINE);
  assert.equal(a1, a2);
  const r1 = ringRappidFor(a1, a1, MOLT_1, "echo_agent.py");
  const r2 = ringRappidFor(a1, a1, MOLT_1, "echo_agent.py");
  assert.equal(r1, r2);
  // Different bytes, different parent, or different ancestor => different ring rappid.
  assert.notEqual(r1, ringRappidFor(a1, a1, MOLT_2, "echo_agent.py"));
  assert.notEqual(r1, ringRappidFor(a1, r1, MOLT_1, "echo_agent.py"));
});

test("identity is unified: the one live store mints every environment's rings", () => {
  const ancestor = ancestorRappidFor("echo_agent.py", BASELINE);
  const ring = ringRappidFor(ancestor, ancestor, MOLT_1, "echo_agent.py");
  const { store, cleanup } = freshStore();
  try {
    const registered = store.baselineAncestors()[0].ancestorRappid;
    assert.equal(registered, ancestor);
    assert.equal(store.appendRing(ancestor, { source: MOLT_1, verified: true }), ring);
  } finally {
    cleanup();
  }
});

test("passthrough by default: unknown agent, no HEAD, and kill-switch all resolve to baseline", () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.resolveLive("rappid:@grail/missing:" + "a".repeat(64)), null);
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    assert.ok(ancestor);
    // Registered but no live molt -> still baseline.
    assert.equal(store.resolveLive(ancestor).isBaseline, true);
    const ring = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    assert.ok(store.setHead(ancestor, ring));
    assert.equal(store.resolveLive(ancestor).source, MOLT_1);
    // Kill-switch forces pure Grail passthrough even with a live verified molt.
    const killed = new LineageStore({
      brainstemDir: store.brainstemDir,
      root: store.root,
      enabled: false,
    });
    assert.equal(killed.resolveLive(ancestor).isBaseline, true);
  } finally {
    cleanup();
  }
});

test("an unverified ring can never go live, and a tampered ring resolves to baseline", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const unverified = store.appendRing(ancestor, { source: MOLT_1, verified: false });
    assert.throws(
      () => store.setHead(ancestor, unverified),
      /invalid or unverified/,
    );
    assert.equal(store.resolveLive(ancestor).isBaseline, true);

    const ring = store.appendRing(ancestor, { source: MOLT_2, verified: true });
    assert.ok(store.setHead(ancestor, ring));
    // Tamper with the stored digest: the ring fails re-verification and
    // composition falls safely to the Grail baseline.
    const file = ringFile(store, ancestor, ring);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.sha256 = "0".repeat(64);
    writeFileSync(file, JSON.stringify(rec));
    assert.equal(store.resolveRing(ancestor, ring).isBaseline, true);
    assert.equal(store.resolveLive(ancestor).isBaseline, true);
  } finally {
    cleanup();
  }
});

test("HEAD walks back to any ring or to baseline non-destructively", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const r1 = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    const r2 = store.appendRing(ancestor, { source: MOLT_2, parentRappid: r1, verified: true });
    assert.ok(store.setHead(ancestor, r2));
    assert.deepEqual(store.walk(ancestor, r2), [ancestor, r1, r2]);
    // Back one ring, then to the baseline; every ring is retained throughout.
    assert.ok(store.setHead(ancestor, r1));
    assert.equal(store.resolveLive(ancestor).source, MOLT_1);
    assert.deepEqual(store.rollbackToBaseline(ancestor).changed, [ancestor]);
    assert.equal(store.resolveLive(ancestor).isBaseline, true);
    assert.equal(store.listRings(ancestor).length, 3);
    // Grow up again: HEAD forward to the retained later ring.
    assert.ok(store.setHead(ancestor, r2));
    assert.equal(store.resolveLive(ancestor).source, MOLT_2);
  } finally {
    cleanup();
  }
});

test("environments are HEADs, not copies: dev and prod pin into one shared ring store", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const r1 = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    assert.ok(store.setHead(ancestor, r1, { env: "DEV" }));
    assert.equal(store.resolveLive(ancestor, { env: "dev" }).ringRappid, r1);
    // prod is untouched by dev's HEAD move — same store, independent pointer.
    assert.equal(store.resolveLive(ancestor, { env: "prod" }).isBaseline, true);
    assert.equal(store.getHead(ancestor, { env: "prod" }), ancestor);
    assert.ok(store.setHead(ancestor, ancestor, { env: "prod" }));
    writeFileSync(
      path.join(
        store.root,
        filesystemSegment(ancestor),
        "HEAD.47732.1787264941456.tmp",
      ),
      `${ancestor}\n`,
    );
    assert.deepEqual(store.environments(ancestor), [
      { env: "default", head: ancestor, isBaseline: true },
      { env: "dev", head: r1, isBaseline: false },
      { env: "prod", head: ancestor, isBaseline: true },
    ]);
    assert.equal(
      store.listRings(ancestor).filter((ring) => ring.ringRappid === r1).length,
      1,
      "environment pointers share one physical ring",
    );
  } finally {
    cleanup();
  }
});

test("promotion fast-forwards when the target has not diverged", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const r1 = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    const r2 = store.appendRing(ancestor, { source: MOLT_2, parentRappid: r1, verified: true });
    store.setHead(ancestor, r2, { env: "dev" });
    // prod at baseline -> trivial fast-forward.
    let res = store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "alice" });
    assert.equal(res.ok, true);
    assert.equal(res.reason, "fast-forward");
    assert.equal(store.getHead(ancestor, { env: "prod" }), r2);
    // Re-promoting in-sync envs is a recorded no-op, not an error.
    res = store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "alice" });
    assert.equal(res.ok, true);
    assert.equal(res.noop, true);
    // prod behind on the same path (at r1) also fast-forwards.
    store.setHead(ancestor, r1, { env: "prod" });
    res = store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "alice" });
    assert.equal(res.ok, true);
    assert.equal(store.getHead(ancestor, { env: "prod" }), r2);
  } finally {
    cleanup();
  }
});

test("the ALM scenario: a prod-only molt makes promotion a named CONFLICT, never a silent overwrite", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const r1 = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    // Someone molts directly in prod off r1...
    const prodOnly = store.appendRing(ancestor, { source: MOLT_PROD_ONLY, parentRappid: r1, verified: true });
    store.setHead(ancestor, prodOnly, { env: "prod" });
    // ...while dev builds a different layer off the same base.
    const devRing = store.appendRing(ancestor, { source: MOLT_2, parentRappid: r1, verified: true });
    store.setHead(ancestor, devRing, { env: "dev" });
    const res = store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "bob" });
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    // The refusal names both diverging rappids and their common ancestor.
    assert.equal(res.target_head, prodOnly);
    assert.equal(res.source_head, devRing);
    assert.equal(res.common_ancestor, r1);
    // Prod's HEAD is untouched — the break surfaced at promote time, not runtime.
    assert.equal(store.getHead(ancestor, { env: "prod" }), prodOnly);
    // Drift detection reports the same divergence before any promotion runs.
    const drift = store.detectDrift(ancestor, "prod", r1);
    assert.equal(drift.drifted, true);
    assert.equal(drift.actual, prodOnly);
  } finally {
    cleanup();
  }
});

test("every promotion attempt lands in an internally verified hash chain", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const r1 = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    const prodOnly = store.appendRing(ancestor, { source: MOLT_PROD_ONLY, parentRappid: r1, verified: true });
    store.setHead(ancestor, r1, { env: "dev" });
    store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "alice", utc: "2026-08-19T00:00:00Z" });
    store.setHead(ancestor, prodOnly, { env: "prod" });
    store.setHead(ancestor, r1, { env: "dev" });
    store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "bob", utc: "2026-08-19T00:01:00Z" });

    const log = store.listPromotions(ancestor);
    assert.equal(log.length, 2);
    assert.equal(log[0].actor, "alice");
    assert.equal(log[0].ok, true);
    assert.equal(log[1].actor, "bob");
    assert.equal(log[1].conflict, true);
    assert.equal(log[1].prev_entry_sha256, log[0].entry_sha256);
    assert.deepEqual(store.verifyPromotions(ancestor), { ok: true, entries: 2 });

    // Rewriting history breaks the chain and is detected with the entry index.
    const file = path.join(
      store.root,
      filesystemSegment(ancestor),
      "promotions.json",
    );
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered[0].actor = "mallory";
    writeFileSync(file, JSON.stringify(tampered));
    assert.deepEqual(store.verifyPromotions(ancestor), { ok: false, broken_at: 0 });
  } finally {
    cleanup();
  }
});

test("the append-only promotion journal refuses growth past its byte bound", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const actor = "x".repeat(
      Math.floor(MAX_PROMOTION_JOURNAL_BYTES * 0.55),
    );
    const first = store.promote(ancestor, {
      actor,
      fromEnv: "default",
      toEnv: "default",
    });
    assert.equal(first.ok, true);
    assert.equal(first.noop, true);
    const file = path.join(
      store.root,
      filesystemSegment(ancestor),
      "promotions.json",
    );
    const before = readFileSync(file);
    assert.ok(before.byteLength <= MAX_PROMOTION_JOURNAL_BYTES);

    const refused = store.promote(ancestor, {
      actor,
      fromEnv: "default",
      toEnv: "default",
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.journal_refused, true);
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(store.verifyPromotions(ancestor), { ok: true, entries: 1 });
  } finally {
    cleanup();
  }
});

test("a corrupt promotion journal fails closed: promote refuses to move HEAD and verify reports the corruption", () => {
  const { store, cleanup } = freshStore();
  try {
    const ancestor = store.baselineAncestors()[0].ancestorRappid;
    const r1 = store.appendRing(ancestor, { source: MOLT_1, verified: true });
    assert.ok(store.setHead(ancestor, r1, { env: "dev" }));
    const file = path.join(
      store.root,
      filesystemSegment(ancestor),
      "promotions.json",
    );

    // Truthy-non-array JSON ('{}') and truncated JSON are both corruption — the
    // exact shapes that used to slip through as an empty journal and verify ok.
    for (const corruptBytes of ["{}", "{ truncated"]) {
      writeFileSync(file, corruptBytes);
      const res = store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "carol" });
      assert.equal(res.ok, false);
      assert.equal(res.journal_corrupt, true);
      assert.match(res.reason, /journal is corrupt/);
      // No HEAD moved: prod stays at baseline, the would-be fast-forward refused.
      assert.equal(store.getHead(ancestor, { env: "prod" }), ancestor);
      assert.equal(store.resolveLive(ancestor, { env: "prod" }).isBaseline, true);
      // The audit check flags the corruption instead of reporting ok...
      const verdict = store.verifyPromotions(ancestor);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.corrupt, true);
      // ...and the corrupt bytes are preserved as evidence, never appended over.
      assert.equal(readFileSync(file, "utf8"), corruptBytes);
      assert.deepEqual(store.listPromotions(ancestor), []);
    }

    // Restoring a valid journal restores promotion without leaving it unusable.
    rmSync(file);
    const recovered = store.promote(ancestor, { fromEnv: "dev", toEnv: "prod", actor: "carol" });
    assert.equal(recovered.ok, true);
    assert.equal(store.getHead(ancestor, { env: "prod" }), r1);
    assert.deepEqual(store.verifyPromotions(ancestor), { ok: true, entries: 1 });
  } finally {
    cleanup();
  }
});
