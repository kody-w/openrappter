import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeLineageCommand } from "../electron/lineage-control.mjs";
import { lineageStoreInternals } from "../electron/lineage-store.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";


const betaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(betaRoot, "..");
const grailDirectory = path.join(repositoryRoot, "rapp_brainstem");
const python = "/Users/kodywildfeuer/.brainstem/venv/bin/python";
const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "rapp-lineage-alm-proof-"),
);
const previousKillSwitch = process.env.RAPP_MOLT_LINEAGE;
process.env.RAPP_MOLT_LINEAGE = "1";

const rows = [];
let failed = false;

function printable(value) {
  return String(value ?? "")
    .replaceAll("|", "/")
    .replaceAll("\n", " ");
}

async function step(name, run) {
  try {
    const outcome = await run();
    const pass = outcome === true || outcome?.pass === true;
    const detail = outcome && typeof outcome === "object"
      ? outcome.detail
      : "";
    rows.push({ name, result: pass ? "PASS" : "FAIL", detail });
    if (!pass) failed = true;
    return outcome?.value;
  } catch (error) {
    failed = true;
    rows.push({
      name,
      result: "FAIL",
      detail: String(error?.message || error),
    });
    return undefined;
  }
}

function printTable() {
  console.log("| Check | Result | Detail |");
  console.log("|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${printable(row.name)} | ${row.result} | ${printable(row.detail)} |`,
    );
  }
}

let manager;
let store;
let context;
let ring1;
let prodOnly;
let firstPromotion;
let conflictPromotion;
let driftReport;
let prodDescriptor;

try {
  await step("fixed Brainstem Python exists", () => ({
    pass: existsSync(python),
    detail: python,
  }));
  await step("real Grail is present", () => ({
    pass: existsSync(path.join(grailDirectory, "brainstem.py")),
    detail: grailDirectory,
  }));

  const stubVerifier = (source) => ({
    ok: typeof source === "string" && source.includes("BasicAgent"),
  });
  manager = new BetaRouteManager({
    betaHome: path.join(temporaryRoot, "beta-home-default"),
    brainstemConfig: {
      brainstemDir: grailDirectory,
      python,
    },
    lineageRoot: path.join(temporaryRoot, "lineage"),
    lineageEnv: "default",
    moltVerifier: stubVerifier,
  });
  store = manager.lineageStore;
  context = manager.baselineAncestor("context_memory_agent.py");

  await step("ring-1 ContextMemory auto-seeded", () => {
    ring1 = context
      ? store.getHead(context.ancestorRappid, { env: "default" })
      : null;
    return {
      pass: Boolean(context && ring1 && ring1 !== context.ancestorRappid),
      detail: ring1 || "missing ContextMemory ring-1",
    };
  });

  await step("prod environment created at baseline", () => {
    const writes = store.baselineAncestors().map((baseline) => (
      store.setHead(
        baseline.ancestorRappid,
        baseline.ancestorRappid,
        { env: "prod" },
      )
    ));
    const prod = store.environments(context.ancestorRappid)
      .find((entry) => entry.env === "prod");
    return {
      pass: writes.every((result) => result === true)
        && prod?.isBaseline === true,
      detail: prod?.isBaseline ? "HEAD.prod = baseline" : "HEAD.prod missing",
    };
  });

  await step("promote default to prod fast-forwards", () => {
    firstPromotion = manager.promoteLineage({
      fromEnv: "default",
      toEnv: "prod",
      actor: "lineage-alm-proof",
      utc: "2026-08-20T16:00:00.000Z",
    });
    const prodHead = store.getHead(
      context.ancestorRappid,
      { env: "prod" },
    );
    return {
      pass: firstPromotion.changed.includes(context.ancestorRappid)
        && prodHead === ring1,
      detail: `changed=${firstPromotion.changed.length}; prod=${prodHead}`,
    };
  });

  await step("prod composition contains routed ContextMemory ring-1", () => {
    const prodManager = new BetaRouteManager({
      betaHome: path.join(temporaryRoot, "beta-home-prod"),
      brainstemConfig: {
        brainstemDir: grailDirectory,
        python,
      },
      lineageStore: store,
      lineageEnv: "prod",
      seedLineageDefaults: false,
      moltVerifier: stubVerifier,
    });
    prodDescriptor = prodManager.compositionDescriptor();
    const materialized = prodManager.materializeComposition(prodDescriptor);
    const source = readFileSync(
      path.join(
        materialized.agentDirectory,
        "context_memory_agent.py",
      ),
      "utf8",
    );
    const marker = "class RoutedContextMemoryAgent(_ContextMemoryRing1)";
    return {
      pass: source.includes(marker),
      detail: marker,
    };
  });

  await step("verified prod-only ring appended", () => {
    const ring1Source = store.resolveRing(
      context.ancestorRappid,
      ring1,
    ).source;
    const source = `${ring1Source.trimEnd()}\n\n# prod-only proof ring\n`;
    const verdict = stubVerifier(source);
    prodOnly = store.appendRing(context.ancestorRappid, {
      source,
      parentRappid: ring1,
      verified: verdict.ok === true,
      meta: {
        author: "lineage-alm-proof",
        environment: "prod",
        verifiedBy: "stub verifier",
      },
    });
    const moved = store.setHead(
      context.ancestorRappid,
      prodOnly,
      { env: "prod" },
    );
    return {
      pass: verdict.ok === true && moved === true,
      detail: prodOnly,
    };
  });

  await step("promotion detects CONFLICT and moves nothing", () => {
    const before = store.getHead(
      context.ancestorRappid,
      { env: "prod" },
    );
    conflictPromotion = manager.promoteLineage({
      fromEnv: "default",
      toEnv: "prod",
      actor: "lineage-alm-proof",
      utc: "2026-08-20T16:01:00.000Z",
    });
    const conflict = conflictPromotion.conflicts.find(
      (entry) => entry.ancestorRappid === context.ancestorRappid,
    );
    const after = store.getHead(
      context.ancestorRappid,
      { env: "prod" },
    );
    return {
      pass: Boolean(
        conflict
        && conflict.common_ancestor === ring1
        && before === prodOnly
        && after === prodOnly,
      ),
      detail: conflict
        ? `common=${conflict.common_ancestor}; prod unchanged`
        : "ContextMemory conflict missing",
    };
  });

  await step("promotion journal verifies with 2 entries", () => {
    const verification = store.verifyPromotions(context.ancestorRappid);
    return {
      pass: verification.ok === true && verification.entries === 2,
      detail: JSON.stringify(verification),
    };
  });

  await step("prod drift is reported", () => {
    driftReport = manager.lineageDrift("prod");
    const drift = driftReport.drifted.find(
      (entry) => entry.ancestorRappid === context.ancestorRappid,
    );
    return {
      pass: Boolean(
        drift
        && drift.actual === prodOnly
        && drift.expected === ring1,
      ),
      detail: drift
        ? `actual=${drift.actual}; expected=${drift.expected}`
        : "ContextMemory drift missing",
    };
  });

  await step("corrupt journal refuses promotion without changing bytes", () => {
    const journalFile = path.join(
      store.root,
      lineageStoreInternals.filesystemSegment(context.ancestorRappid),
      "promotions.json",
    );
    const corruptBytes = "{ deliberately corrupt";
    writeFileSync(journalFile, corruptBytes);
    const beforeHead = store.getHead(
      context.ancestorRappid,
      { env: "prod" },
    );
    const refusal = store.promote(context.ancestorRappid, {
      fromEnv: "default",
      toEnv: "prod",
      actor: "lineage-alm-proof",
    });
    const afterHead = store.getHead(
      context.ancestorRappid,
      { env: "prod" },
    );
    return {
      pass: refusal.journal_corrupt === true
        && beforeHead === afterHead
        && readFileSync(journalFile, "utf8") === corruptBytes,
      detail: refusal.reason,
    };
  });

  await step("chat words execute through the lineage controller", async () => {
    let starts = 0;
    const stub = {
      lastLineageFallback: null,
      lineageEnvironments: () => manager.lineageEnvironments(),
      promoteLineage: () => conflictPromotion,
      lineageDrift: () => driftReport,
      rollbackLineage: () => ({
        disabled: false,
        changed: [context.ancestorRappid],
        unchanged: [],
        failed: [],
      }),
      restoreLineage: () => ({
        disabled: false,
        changed: [context.ancestorRappid],
        unchanged: [],
        failed: [],
      }),
      startDefault: async () => {
        starts += 1;
        return {
          compositionHash: prodDescriptor.compositionHash,
          url: "http://127.0.0.1:7071",
        };
      },
    };
    const messages = [
      "baseline",
      "restore",
      "environments",
      "promote default prod",
      "drift prod",
    ];
    const results = [];
    for (const message of messages) {
      results.push(await executeLineageCommand({
        message,
        routeManager: stub,
      }));
    }
    return {
      pass: results.every((result) => (
        result.intercepted === true
        && typeof result.reply === "string"
        && result.reply.length > 0
      )) && starts === 2,
      detail: `${messages.join(", ")}; startDefault=${starts}`,
    };
  });
} catch (error) {
  failed = true;
  rows.push({
    name: "proof harness",
    result: "FAIL",
    detail: String(error?.message || error),
  });
} finally {
  if (previousKillSwitch === undefined) {
    delete process.env.RAPP_MOLT_LINEAGE;
  } else {
    process.env.RAPP_MOLT_LINEAGE = previousKillSwitch;
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}

printTable();
if (failed || rows.some((row) => row.result === "FAIL")) {
  process.exitCode = 1;
}
