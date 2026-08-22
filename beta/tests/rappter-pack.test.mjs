import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RAPPTER_PACK_CONFIG_SCHEMA,
  RAPPTER_PACK_MATRIX_SCHEMA,
  dispatchPackNode,
  evaluatePackExpectation,
  packOutputDigest,
  packNodeReady,
  packInternals,
  readEstateInventory,
  runContinuousPackMatrix,
  runPackMatrix,
  validatePackConfig,
  validatePackMatrix,
  writePackReport,
} from "../electron/rappter-pack.mjs";
import {
  MAX_PACK_NODE_RESPONSE_BYTES,
  packNodeResponse,
} from "../scripts/rappter-pack-node.mjs";

const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(betaRoot, relative), "utf8");

function config() {
  return {
    schema: RAPPTER_PACK_CONFIG_SCHEMA,
    pack_id: "mac-mini-pack",
    nodes: [
      {
        id: "brainstem-one",
        machine: "mini-one.local",
        kind: "brainstem",
        capabilities: ["chat", "rapp1"],
        transport: { kind: "ssh", host: "mini-one.local" },
      },
      {
        id: "openrappter-two",
        machine: "mini-two.local",
        kind: "openrappter",
        capabilities: ["chat", "rapp1", "tiles", "arena"],
        transport: { kind: "ssh", host: "mini-two.local" },
      },
      {
        id: "offline-three",
        machine: "mini-three.local",
        kind: "openrappter",
        capabilities: ["chat"],
        transport: { kind: "ssh", host: "mini-three.local" },
      },
    ],
  };
}

function matrix() {
  return {
    schema: RAPPTER_PACK_MATRIX_SCHEMA,
    name: "mixed Brainstem/OpenRappter acceptance",
    cases: [
      {
        id: "all-nodes-return-contract",
        action: "chat",
        mode: "all",
        candidates: ["brainstem-one", "openrappter-two"],
        prompt: "Return PACK_CONTRACT_OK.",
        expected: {
          contains: ["PACK_CONTRACT_OK"],
          excludes: ["ERROR"],
          max_duration_ms: 5_000,
          min_passing: 2,
        },
      },
      {
        id: "first-valid-deliverable-wins",
        action: "chat",
        mode: "race",
        candidates: ["brainstem-one", "openrappter-two", "offline-three"],
        prompt: "Return a completed artifact ending DELIVERABLE_OK.",
        expected: {
          contains: ["DELIVERABLE_OK"],
          max_duration_ms: 5_000,
          min_passing: 1,
        },
      },
    ],
  };
}

test("pack config is machine-agnostic, typed, and rejects unsafe transport", () => {
  const parsed = validatePackConfig(config());
  assert.equal(parsed.nodes.length, 3);
  assert.deepEqual(
    parsed.nodes.map((node) => [node.id, node.machine, node.kind]),
    [
      ["brainstem-one", "mini-one.local", "brainstem"],
      ["openrappter-two", "mini-two.local", "openrappter"],
      ["offline-three", "mini-three.local", "openrappter"],
    ],
  );

  const duplicate = config();
  duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.throws(() => validatePackConfig(duplicate), /duplicate/i);

  const unsafe = config();
  unsafe.nodes[0].transport.host = "https://example.com/; touch /tmp/no";
  assert.throws(() => validatePackConfig(unsafe), /host|safe|transport/i);
  const localHome = config();
  localHome.nodes[1].transport = {
    kind: "local",
    home: "/tmp/openrappter-two",
  };
  assert.equal(
    validatePackConfig(localHome).nodes[1].transport.home,
    path.resolve("/tmp/openrappter-two"),
  );

  const inlineSecret = config();
  inlineSecret.nodes[0].transport = {
    kind: "http",
    url: "http://192.168.1.5:7071",
    secret: "do-not-store-this",
  };
  assert.throws(() => validatePackConfig(inlineSecret), /secret|inline/i);

  const implicitPlainHttp = config();
  implicitPlainHttp.nodes[0].transport = {
    kind: "http",
    url: "http://192.168.1.5:7071",
    secret_env: "RAPPTER_PACK_SECRET",
  };
  assert.throws(
    () => validatePackConfig(implicitPlainHttp),
    /allow_insecure_http|pinned SSH/i,
  );

  const exposedOpenRappter = config();
  exposedOpenRappter.nodes[1].transport = {
    kind: "http",
    url: "http://192.168.1.6:7071",
    allow_insecure_http: true,
  };
  assert.throws(
    () => validatePackConfig(exposedOpenRappter),
    /OpenRappter.*LAN HTTP|pinned SSH/i,
  );
});

test("private HTTP reads its Brainstem secret from an environment reference", async () => {
  process.env.RAPPTER_PACK_TEST_SECRET = "test-secret";
  try {
    let observed;
    const result = await dispatchPackNode({
      id: "lan-brainstem",
      machine: "mini.local",
      kind: "brainstem",
      capabilities: ["chat"],
      transport: {
        kind: "http",
        url: "http://192.168.1.5:7071",
        allow_insecure_http: true,
        secret_env: "RAPPTER_PACK_TEST_SECRET",
      },
    }, {
      action: "chat",
      case_id: "secret",
      prompt: "hello",
    }, {
      fetchImpl: async (_url, options) => {
        observed = options;
        return new Response(JSON.stringify({
          response: "SECRET_OK",
          agent_logs: [],
          session_id: "s",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(observed.headers["X-Brainstem-Secret"], "test-secret");
    assert.equal(result.response, "SECRET_OK");
  } finally {
    delete process.env.RAPPTER_PACK_TEST_SECRET;
  }
});

test("HTTP refusals and non-JSON bodies remain refusals", async () => {
  const result = await dispatchPackNode({
    id: "loopback-brainstem",
    machine: "this-mac",
    kind: "brainstem",
    capabilities: ["chat"],
    transport: { kind: "http", url: "http://127.0.0.1:7071" },
  }, {
    action: "chat",
    case_id: "refusal",
    prompt: "hello",
  }, {
    fetchImpl: async () => new Response("REFUSAL_MARKER", { status: 503 }),
  });

  test("local and SSH node adapter preserve bounded non-JSON refusals", async () => {
    const result = await packNodeResponse(
      new Response("REFUSAL_MARKER", { status: 503 }),
      "chat",
    );
    assert.deepEqual(result, {
      ok: true,
      response: "REFUSAL_MARKER",
      envelope: null,
      http_status: 503,
      refused: true,
    });
    await assert.rejects(
      packNodeResponse(
        new Response("x".repeat(MAX_PACK_NODE_RESPONSE_BYTES + 1)),
        "chat",
      ),
      /exceeds 4 MiB/,
    );
  });

  test("Pack bounds HTTP and child-process evidence before buffering", async () => {
    await assert.rejects(
      dispatchPackNode({
        id: "bounded-http",
        machine: "this-mac",
        kind: "brainstem",
        capabilities: ["chat"],
        transport: { kind: "http", url: "http://127.0.0.1:7071" },
      }, {
        action: "chat",
        case_id: "overflow",
        prompt: "hello",
      }, {
        fetchImpl: async () => new Response(
          "x".repeat(packInternals.MAX_PACK_HTTP_BYTES + 1),
          { status: 200 },
        ),
      }),
      /HTTP response exceeds/,
    );
    await assert.rejects(
      packInternals.spawnJson(
        process.execPath,
        ["-e", `process.stdout.write("x".repeat(${
          packInternals.MAX_PACK_STDOUT_BYTES + 1
        }))`],
        {},
        5_000,
      ),
      /stdout exceeded/,
    );
    await assert.rejects(
      packInternals.spawnJson(
        process.execPath,
        ["-e", `process.stderr.write("x".repeat(${
          packInternals.MAX_PACK_STDERR_BYTES + 1
        }))`],
        {},
        5_000,
      ),
      /stderr exceeded/,
    );
  });
  assert.equal(result.ok, true, "the HTTP exchange itself completed");
  assert.equal(result.refused, true);
  assert.equal(result.http_status, 503);
  assert.equal(result.response, "REFUSAL_MARKER");
  assert.equal(result.envelope, null);
  const evaluation = evaluatePackExpectation(result, {
    contains: ["REFUSAL_MARKER"],
  });
  assert.equal(evaluation.pass, false);
  assert.match(evaluation.differences.join(" "), /HTTP refusal/);
});

test("loopback OpenRappter health requires an active-route 200 response", async () => {
  let observedUrl;
  const result = await dispatchPackNode({
    id: "loopback-openrappter",
    machine: "this-mac",
    kind: "openrappter",
    capabilities: ["chat"],
    transport: { kind: "http", url: "http://127.0.0.1:57412" },
  }, {
    action: "health",
    case_id: "status",
    prompt: "",
  }, {
    fetchImpl: async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify({
        schema: "openrappter-neighborhood-health/1.0",
        status: "ready",
        neighborhood_id: "openrappter:alpha",
      }), { status: 200 });
    },
  });
  assert.equal(observedUrl, "http://127.0.0.1:57412/health");
  assert.equal(result.ok, true);
  assert.equal(result.refused, false);
  assert.equal(result.http_status, 200);
  assert.match(result.response, /"status":"ready"/);
  assert.equal(packNodeReady(result), true);
  assert.equal(packNodeReady({
    ok: true,
    refused: true,
    http_status: 403,
    response: "not ready",
  }), false);
});

test("matrix cases declare expected outcomes before they run", () => {
  const parsed = validatePackMatrix(matrix(), config());
  assert.equal(parsed.cases.length, 2);
  assert.throws(
    () => validatePackMatrix({
      schema: RAPPTER_PACK_MATRIX_SCHEMA,
      name: "vacuous",
      cases: [{
        id: "no-expectation",
        action: "chat",
        mode: "race",
        candidates: ["brainstem-one"],
        prompt: "anything",
        expected: {},
      }],
    }, config()),
    /expected|acceptance|vacuous/i,
  );
});

test("wildcard candidates expand to every Brainstem and OpenRappter in the pack", () => {
  const wildcard = matrix();
  wildcard.cases[0].candidates = ["*"];
  const parsed = validatePackMatrix(wildcard, config());
  assert.deepEqual(
    parsed.cases[0].candidates,
    ["brainstem-one", "openrappter-two", "offline-three"],
  );
  wildcard.cases[0].reverse_candidates = true;
  assert.deepEqual(
    validatePackMatrix(wildcard, config()).cases[0].candidates,
    ["offline-three", "openrappter-two", "brainstem-one"],
  );
});

test("expectations report observed versus expected without model judgement", () => {
  assert.equal(evaluatePackExpectation({
    ok: true,
    response: "artifact DELIVERABLE_OK",
    duration_ms: 20,
  }, {
    contains: ["DELIVERABLE_OK"],
    excludes: ["ERROR"],
    max_duration_ms: 30,
  }).pass, true);
  const failed = evaluatePackExpectation({
    ok: true,
    response: "fast but incomplete",
    duration_ms: 5,
  }, {
    contains: ["DELIVERABLE_OK"],
    max_duration_ms: 30,
  });
  assert.equal(failed.pass, false);
  assert.match(failed.differences.join(" "), /DELIVERABLE_OK/);
  const missingEnvelope = evaluatePackExpectation(
    { ok: true, response: "PACK_CONTRACT_OK", duration_ms: 1 },
    {
      contains: ["PACK_CONTRACT_OK"],
      required_envelope_fields: ["response", "agent_logs", "session_id"],
    },
  );
  assert.equal(missingEnvelope.pass, false);
  assert.match(missingEnvelope.differences.join(" "), /envelope/);
  const malformedEnvelope = evaluatePackExpectation({
    ok: true,
    response: "PACK_CONTRACT_OK",
    duration_ms: 1,
    envelope: {
      response: "PACK_CONTRACT_OK",
      agent_logs: [],
      session_id: 7,
      extra: true,
    },
  }, {
    contains: ["PACK_CONTRACT_OK"],
    required_envelope_fields: ["response", "agent_logs", "session_id"],
  });
  assert.equal(malformedEnvelope.pass, false);
  assert.match(
    malformedEnvelope.differences.join(" "),
    /agent_logs must be string|session_id must be string/,
  );
  assert.throws(
    () => evaluatePackExpectation(
      { ok: true, response: "anything", duration_ms: 1 },
      { contains: [""] },
    ),
    /empty|vacuous|expected/i,
  );
});

test("race elects the first valid deliverable, not the first response", async () => {
  const dispatch = async (node, request) => {
    if (
      request.case_id === "first-valid-deliverable-wins"
      && node.id === "offline-three"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("host unreachable");
    }
    if (node.id === "openrappter-two") {
      if (request.case_id === "first-valid-deliverable-wins") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return request.case_id === "first-valid-deliverable-wins"
        ? { ok: true, response: "finished first but incomplete", duration_ms: 5 }
        : { ok: true, response: "PACK_CONTRACT_OK from OpenRappter", duration_ms: 15 };
    }
    if (request.case_id === "first-valid-deliverable-wins") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return request.case_id === "first-valid-deliverable-wins"
      ? { ok: true, response: "artifact DELIVERABLE_OK", duration_ms: 20 }
      : { ok: true, response: "PACK_CONTRACT_OK from Brainstem", duration_ms: 10 };
  };
  const report = await runPackMatrix({
    config: config(),
    dispatch,
    matrix: matrix(),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });

  assert.equal(report.schema, "rappter-pack-report/1.0");
  assert.deepEqual(report.wire, {
    method: "POST",
    path: "/chat",
    adapter: "none",
    upstream_contract: "preserved",
    neighborhood_protocol: "not-claimed",
  });
  assert.equal(report.summary.pass, 2);
  assert.equal(report.summary.fail, 0);
  const race = report.cases.find((entry) => entry.id === "first-valid-deliverable-wins");
  assert.equal(race.winner.node_id, "brainstem-one");
  assert.equal(race.results.find((entry) => entry.node_id === "openrappter-two").accepted, false);
  assert.equal(race.results.find((entry) => entry.node_id === "offline-three").transport_ok, false);
  assert.equal(race.pass, true, "one dead node and one fast-invalid node do not block a valid winner");
});

test("race order is observed by the controller, never trusted from remote duration", async () => {
  const raceMatrix = matrix();
  raceMatrix.cases = [raceMatrix.cases[1]];
  raceMatrix.cases[0].candidates = ["brainstem-one", "openrappter-two"];
  const report = await runPackMatrix({
    config: config(),
    matrix: raceMatrix,
    dispatch: async (node) => {
      if (node.id === "brainstem-one") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, response: "1. x 2. y 3. z DELIVERABLE_OK", duration_ms: 999 };
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, response: "1. x 2. y 3. z DELIVERABLE_OK", duration_ms: 1 };
    },
  });
  const race = report.cases[0];
  assert.equal(race.winner.node_id, "brainstem-one");
  assert.deepEqual(race.observed.completion_order, [
    "brainstem-one",
    "openrappter-two",
  ]);
  assert.equal(
    race.results.find((entry) => entry.node_id === "openrappter-two").outcome,
    "cancelled_after_winner",
  );
});

test("race winner remains first-settled when acceptance requires two valid results", async () => {
  const raceMatrix = matrix();
  raceMatrix.cases = [raceMatrix.cases[1]];
  raceMatrix.cases[0].candidates = ["brainstem-one", "openrappter-two"];
  raceMatrix.cases[0].expected.min_passing = 2;
  const report = await runPackMatrix({
    config: config(),
    matrix: raceMatrix,
    dispatch: async (node) => {
      if (node.id === "brainstem-one") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: true,
          response: "DELIVERABLE_OK",
          duration_ms: 999,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 35));
      return {
        ok: true,
        response: "DELIVERABLE_OK",
        duration_ms: 1,
      };
    },
  });
  assert.equal(report.cases[0].winner.node_id, "brainstem-one");
  assert.deepEqual(report.cases[0].observed.completion_order, [
    "brainstem-one",
    "openrappter-two",
  ]);
});

test("race returns after acceptance and aborts hanging losers", async () => {
  const raceMatrix = matrix();
  raceMatrix.cases = [raceMatrix.cases[1]];
  raceMatrix.cases[0].candidates = ["brainstem-one", "openrappter-two"];
  let loserAborted = false;
  const started = Date.now();
  const report = await runPackMatrix({
    config: config(),
    matrix: raceMatrix,
    dispatch: async (node, _request, { signal } = {}) => {
      if (node.id === "brainstem-one") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ok: true,
          response: "DELIVERABLE_OK",
          duration_ms: 10,
        };
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          loserAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  const elapsed = Date.now() - started;
  const race = report.cases[0];
  assert.equal(race.winner.node_id, "brainstem-one");
  assert.equal(loserAborted, true);
  assert.ok(elapsed < 200, `race waited ${elapsed}ms for a hanging loser`);
  assert.equal(race.observed.cancelled_after_winner, 1);
  assert.equal(
    race.results.find((entry) => entry.node_id === "openrappter-two").outcome,
    "cancelled_after_winner",
  );
});

test("report digest binds every deterministic acceptance input", async () => {
  const report = await runPackMatrix({
    config: config(),
    matrix: {
      ...matrix(),
      cases: [matrix().cases[0]],
    },
    dispatch: async () => ({
      ok: true,
      response: "PACK_CONTRACT_OK",
      duration_ms: 10,
      envelope: {
        response: "PACK_CONTRACT_OK",
        agent_logs: "",
        session_id: "s",
      },
      http_status: 200,
      refused: false,
      evidence: ["fixture"],
    }),
  });
  const original = report.output_digest;
  const mutations = [
    ["schema", (value) => { value.schema = "mutated"; }],
    ["wire", (value) => { value.wire.path = "/mutated"; }],
    ["pack id", (value) => { value.pack_id = "mutated-pack"; }],
    ["matrix", (value) => { value.matrix = "mutated-matrix"; }],
    ["node machine", (value) => { value.nodes[0].machine = "machine-b"; }],
    ["node kind", (value) => { value.nodes[0].kind = "openrappter"; }],
    ["node transport", (value) => { value.nodes[0].transport = "http"; }],
    ["mode", (value) => { value.cases[0].mode = "race"; }],
    ["candidate order", (value) => { value.cases[0].candidates.reverse(); }],
    ["prompt", (value) => { value.cases[0].prompt = "MUTATED"; }],
    ["handoff", (value) => { value.cases[0].handoff_prompt = "MUTATED {{previous}}"; }],
    ["reverse", (value) => { value.cases[0].reverse_candidates = true; }],
    ["expected", (value) => { value.cases[0].expected.max_duration_ms = 1; }],
    ["observed", (value) => { value.cases[0].observed.passing = 0; }],
    ["result machine", (value) => { value.cases[0].results[0].machine = "machine-b"; }],
    ["result kind", (value) => { value.cases[0].results[0].kind = "openrappter"; }],
    ["result transport", (value) => { value.cases[0].results[0].transport = "http"; }],
    ["duration", (value) => { value.cases[0].results[0].duration_ms = 999; }],
    ["refused", (value) => { value.cases[0].results[0].refused = true; }],
    ["status", (value) => { value.cases[0].results[0].http_status = 503; }],
    ["envelope key", (value) => { value.cases[0].results[0].envelope.extra = true; }],
    ["session", (value) => { value.cases[0].results[0].envelope.session_id = "mutated"; }],
    ["logs", (value) => { value.cases[0].results[0].envelope.agent_logs = "mutated"; }],
    ["outcome", (value) => { value.cases[0].results[0].outcome = "failed"; }],
    ["pass", (value) => { value.cases[0].pass = false; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.notEqual(packOutputDigest(changed), original, label);
  }
});

test("Brainstem and OpenRappter collaborate as /chat neighbors", async () => {
  const neighborMatrix = {
    schema: RAPPTER_PACK_MATRIX_SCHEMA,
    name: "neighbor relay",
    cases: [{
      id: "brainstem-to-openrappter",
      action: "chat",
      mode: "relay",
      candidates: ["brainstem-one", "openrappter-two"],
      prompt: "Propose one pack test and end BRAINSTEM_HANDOFF.",
      handoff_prompt:
        "Your Brainstem neighbor replied:\n{{previous}}\nImprove it and end NEIGHBOR_COLLAB_OK.",
      expected: {
        contains: ["NEIGHBOR_COLLAB_OK"],
        max_duration_ms: 5_000,
        min_passing: 1,
      },
    }],
  };
  const calls = [];
  const report = await runPackMatrix({
    config: config(),
    matrix: neighborMatrix,
    dispatch: async (node, request) => {
      calls.push({ node: node.id, prompt: request.prompt });
      return node.kind === "brainstem"
        ? { ok: true, response: "test the exact wire BRAINSTEM_HANDOFF", duration_ms: 10 }
        : { ok: true, response: "test exact wire plus failure isolation NEIGHBOR_COLLAB_OK", duration_ms: 20 };
    },
  });
  assert.deepEqual(calls.map((call) => call.node), [
    "brainstem-one",
    "openrappter-two",
  ]);
  assert.match(calls[1].prompt, /test the exact wire BRAINSTEM_HANDOFF/);
  assert.equal(report.cases[0].pass, true);
  assert.equal(report.cases[0].winner.node_id, "openrappter-two");
  assert.deepEqual(
    report.cases[0].observed.relay,
    ["brainstem-one", "openrappter-two"],
  );
  assert.equal(
    report.cases[0].observed.neighborhood_protocol,
    "not-claimed",
  );
});

test("continuous loop persists private reports and preserves every observed delta", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rappter-pack-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let iteration = 0;
  const reports = await runContinuousPackMatrix({
    config: config(),
    iterations: 3,
    matrix: matrix(),
    intervalMs: 0,
    now: () => new Date(`2026-08-21T12:00:0${iteration}.000Z`),
    dispatch: async (_node, request) => ({
      ok: true,
      response: request.case_id === "first-valid-deliverable-wins"
        ? `DELIVERABLE_OK iteration ${iteration}`
        : `PACK_CONTRACT_OK iteration ${iteration}`,
      duration_ms: 10,
    }),
    onIteration: (report) => {
      writePackReport(home, report);
      iteration += 1;
    },
    sleep: async () => {},
  });
  assert.equal(reports.length, 3);
  const files = fs.readdirSync(path.join(home, "pack", "runs"))
    .filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 3);
  const byCreatedAt = new Map(reports.map((report) => [
    report.created_at,
    report,
  ]));
  for (const file of files) {
    const full = path.join(home, "pack", "runs", file);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(full).mode & 0o777, 0o600);
    }
    const report = JSON.parse(fs.readFileSync(full, "utf8"));
    assert.deepEqual(report, byCreatedAt.get(report.created_at));
    for (const entry of report.cases) {
      assert.ok(entry.expected && entry.observed);
      assert.ok(Array.isArray(entry.results) && entry.results.length);
      for (const result of entry.results) {
        assert.equal(typeof result.response, "string");
        assert.equal(typeof result.transport_ok, "boolean");
        assert.equal(typeof result.accepted, "boolean");
        assert.equal(typeof result.duration_ms, "number");
        assert.ok(Array.isArray(result.differences));
        assert.ok(Array.isArray(result.evidence));
      }
    }
  }
  const latest = JSON.parse(fs.readFileSync(
    path.join(home, "pack", "latest.json"),
    "utf8",
  ));
  assert.deepEqual(latest, reports.at(-1));
  const history = fs.readFileSync(
    path.join(home, "pack", "history.jsonl"),
    "utf8",
  ).trim().split("\n").map(JSON.parse);
  assert.deepEqual(history, reports);
});

test("rapp-monorepo inventory is read as a pinned matrix authority", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rapp-estate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    schema: "rapp-monorepo-manifest/1.0",
    captured_at: "2026-08-21T08:59:53Z",
    repos: {
      openrappter: { commit: "a".repeat(40), files: 1396 },
      "rapp-sentinel": { commit: "b".repeat(40), files: 112 },
      RAPP: { commit: "c".repeat(40), files: 691 },
    },
  };
  const file = path.join(root, "MANIFEST.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  const inventory = readEstateInventory(file);
  assert.equal(inventory.repositories, 3);
  assert.equal(inventory.files, 2199);
  assert.equal(inventory.captured_at, manifest.captured_at);
  assert.deepEqual(inventory.commits["rapp-sentinel"], "b".repeat(40));
});

test("Pack Sentinel is a self-proving rapp-sentinel/1.0 plugin", () => {
  const sentinel = path.join(
    betaRoot,
    "resources",
    "rappter-pack",
    "rappter_pack_sentinel.py",
  );
  const result = spawnSync("python3", [sentinel, "--prove"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const source = fs.readFileSync(sentinel, "utf8");
  assert.match(source, /"schema": "rapp-sentinel\/1\.0"/);
  assert.match(source, /pack_nodes_reachable/);
  assert.match(source, /pack_matrix_moving/);
  assert.match(source, /pack_matrix_expected/);
});

test("the packaged CLI exposes status, run, and continuous loop", () => {
  const packageJson = JSON.parse(read("package.json"));
  const cli = read("scripts/rappter-pack.mjs");
  assert.ok(packageJson.build.files.includes("scripts/rappter-pack.mjs"));
  assert.ok(packageJson.build.files.includes("scripts/rappter-pack-node.mjs"));
  assert.ok(packageJson.build.files.includes("resources/rappter-pack/**"));
  assert.match(packageJson.scripts["pack:status"], /rappter-pack\.mjs status/);
  assert.match(cli, /status/);
  assert.match(cli, /run/);
  assert.match(cli, /loop/);
  assert.match(cli, /--iterations/);
});

test("the Electron app exposes Pack Sentinel status and matrix execution", () => {
  const main = read("electron/main.mjs");
  const preload = read("electron/preload.cjs");
  const ui = read("ui/index.html");
  const renderer = read("ui/renderer.js");
  for (const channel of [
    "beta:rappter-pack-status",
    "beta:rappter-pack-run",
  ]) {
    assert.ok(main.includes(channel), `${channel} must be handled`);
    assert.ok(preload.includes(channel), `${channel} must be exposed`);
  }
  assert.match(ui, /id="rappter-pack-sentinel"/);
  assert.match(ui, /id="rappter-pack-run"/);
  assert.match(renderer, /rappterPackStatus/);
  assert.match(renderer, /rappterPackRun/);
});
