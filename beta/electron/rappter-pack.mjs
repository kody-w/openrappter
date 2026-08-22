import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exactRapp1Success } from "./rapp1-chat-envelope.mjs";

export const RAPPTER_PACK_CONFIG_SCHEMA = "rappter-pack/1.0";
export const RAPPTER_PACK_MATRIX_SCHEMA = "rappter-pack-matrix/1.0";
export const RAPPTER_PACK_REPORT_SCHEMA = "rappter-pack-report/1.0";

const ID = /^[a-z][a-z0-9-]{2,63}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const CAPABILITY = /^[a-z][a-z0-9-]{1,63}$/;
const NODE_KINDS = new Set(["brainstem", "openrappter"]);
const TRANSPORT_KINDS = new Set(["http", "local", "ssh"]);
const CASE_MODES = new Set(["all", "race", "relay"]);
const CASE_ACTIONS = new Set(["chat", "health"]);
const MAX_PACK_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_PACK_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PACK_STDERR_BYTES = 1024 * 1024;
const CHAT_ENVELOPE_TYPES = new Map([
  ["schema", "string"],
  ["status", "string"],
  ["response", "string"],
  ["content", "string"],
  ["session_id", "string"],
  ["sessionId", "string"],
  ["agent_logs", "string[]"],
  ["voice_mode", "boolean"],
  ["model", "string"],
  ["requested_model", "string"],
]);

function chatEnvelopeFieldMatches(field, value) {
  const expected = CHAT_ENVELOPE_TYPES.get(field);
  if (expected === "string[]") {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  if (field === "session_id") {
    return typeof value === "string" && value.length > 0;
  }
  return typeof value === expected;
}

function chatEnvelopeDifferences(envelope, requiredFields) {
  const differences = [];
  if (!requiredFields.length) return differences;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return ["missing observed /chat envelope"];
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(envelope, field)) {
      differences.push(`missing /chat envelope field ${field}`);
    } else if (
      CHAT_ENVELOPE_TYPES.has(field)
      && !chatEnvelopeFieldMatches(field, envelope[field])
    ) {
      differences.push(
        `/chat envelope field ${field} must be ${
          CHAT_ENVELOPE_TYPES.get(field)
        }`,
      );
    }
  }
  return differences;
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function atomicPrivateWrite(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function fixedArray(value, label, matcher = null) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const values = value.map((entry) => String(entry || ""));
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate values.`);
  }
  if (matcher && values.some((entry) => !matcher.test(entry))) {
    throw new Error(`${label} contains an invalid value.`);
  }
  return values;
}

function safeHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("HTTP pack transport requires a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("HTTP pack transport requires http(s) without embedded credentials.");
  }
  if (!["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("HTTP pack transport URL must name only the node origin.");
  }
  if (url.protocol === "http:" && !privateLanHost(url.hostname)) {
    throw new Error("Plain HTTP pack transport is limited to loopback or explicit private-LAN hosts.");
  }
  return url.origin;
}

function privateLanHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (["localhost", "::1", "[::1]"].includes(host) || host.endsWith(".local")) return true;
  const pieces = host.split(".").map(Number);
  if (pieces.length !== 4 || pieces.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return pieces[0] === 10
    || pieces[0] === 127
    || (pieces[0] === 192 && pieces[1] === 168)
    || (pieces[0] === 172 && pieces[1] >= 16 && pieces[1] <= 31);
}

function loopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return ["localhost", "::1", "[::1]"].includes(host)
    || host.startsWith("127.");
}

function normalizeTransport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Every pack node requires a transport.");
  }
  const kind = String(value.kind || "");
  if (!TRANSPORT_KINDS.has(kind)) {
    throw new Error(`Unsupported pack transport ${kind}.`);
  }
  if (kind === "ssh") {
    const host = String(value.host || "");
    if (!HOST.test(host) || host.includes("..")) {
      throw new Error("SSH pack transport requires a safe host name.");
    }
    return { kind, host };
  }
  if (kind === "http") {
    if (value.secret !== undefined) {
      throw new Error("HTTP pack transport refuses inline secrets.");
    }
    const secretEnv = value.secret_env === undefined
      ? ""
      : String(value.secret_env);
    const secretFile = value.secret_file === undefined
      ? ""
      : String(value.secret_file);
    if (secretEnv && !/^[A-Z_][A-Z0-9_]{1,127}$/.test(secretEnv)) {
      throw new Error("HTTP pack transport secret_env is invalid.");
    }
    if (secretFile && !path.isAbsolute(secretFile)) {
      throw new Error("HTTP pack transport secret_file must be absolute.");
    }
    if (secretEnv && secretFile) {
      throw new Error("HTTP pack transport accepts one secret reference.");
    }
    const url = safeHttpUrl(value.url);
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol === "http:"
      && !loopbackHost(parsedUrl.hostname)
      && value.allow_insecure_http !== true
    ) {
      throw new Error(
        "Private-LAN HTTP requires allow_insecure_http: true; prefer pinned SSH.",
      );
    }
    return {
      kind,
      url,
      ...(value.allow_insecure_http === true
        ? { allow_insecure_http: true }
        : {}),
      ...(secretEnv ? { secret_env: secretEnv } : {}),
      ...(secretFile ? { secret_file: secretFile } : {}),
    };
  }
  if (value.home !== undefined) {
    const home = String(value.home || "");
    if (!path.isAbsolute(home)) {
      throw new Error("Local pack transport home must be absolute.");
    }
    return { kind, home: path.resolve(home) };
  }
  return { kind };
}

export function validatePackConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rappter Pack config must be an object.");
  }
  if (value.schema !== RAPPTER_PACK_CONFIG_SCHEMA) {
    throw new Error(`Rappter Pack config must use ${RAPPTER_PACK_CONFIG_SCHEMA}.`);
  }
  const packId = String(value.pack_id || "");
  if (!ID.test(packId)) throw new Error("Rappter Pack pack_id is invalid.");
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 64) {
    throw new Error("Rappter Pack config requires 1-64 nodes.");
  }
  const seen = new Set();
  const nodes = value.nodes.map((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error("Every pack node must be an object.");
    }
    const id = String(node.id || "");
    if (!ID.test(id)) throw new Error(`Pack node id is invalid: ${id}`);
    if (seen.has(id)) throw new Error(`Pack config contains duplicate node ${id}.`);
    seen.add(id);
    const kind = String(node.kind || "");
    if (!NODE_KINDS.has(kind)) throw new Error(`Pack node ${id} has invalid kind.`);
    const machine = String(node.machine || "");
    if (!machine || machine.length > 255 || /[\0\r\n]/.test(machine)) {
      throw new Error(`Pack node ${id} has invalid machine.`);
    }
    const transport = normalizeTransport(node.transport);
    if (
      kind === "openrappter"
      && transport.kind === "http"
      && !loopbackHost(new URL(transport.url).hostname)
    ) {
      throw new Error(
        `Pack node ${id} cannot expose OpenRappter through direct LAN HTTP; use pinned SSH.`,
      );
    }
    return {
      id,
      machine,
      kind,
      capabilities: fixedArray(node.capabilities || [], `${id} capabilities`, CAPABILITY),
      transport,
    };
  });
  return {
    schema: RAPPTER_PACK_CONFIG_SCHEMA,
    pack_id: packId,
    nodes,
  };
}

function normalizeExpectation(value, candidateCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Every matrix case requires expected acceptance criteria.");
  }
  const contains = fixedArray(value.contains || [], "expected.contains");
  const excludes = fixedArray(value.excludes || [], "expected.excludes");
  const requiredEnvelopeFields = fixedArray(
    value.required_envelope_fields || [],
    "expected.required_envelope_fields",
    /^[a-z][a-z0-9_]{0,63}$/,
  );
  if ([...contains, ...excludes].some((entry) => !entry)) {
    throw new Error("Matrix expected text must not contain empty values.");
  }
  const maxDuration = Number(value.max_duration_ms);
  const minPassing = value.min_passing === undefined
    ? candidateCount
    : Number(value.min_passing);
  if (
    !contains.length
    && !excludes.length
    && !requiredEnvelopeFields.length
    && !Number.isFinite(maxDuration)
  ) {
    throw new Error("Matrix expected criteria are vacuous.");
  }
  if (
    !Number.isInteger(minPassing)
    || minPassing < 1
    || minPassing > candidateCount
  ) {
    throw new Error("Matrix expected.min_passing is invalid.");
  }
  if (Number.isFinite(maxDuration) && maxDuration <= 0) {
    throw new Error("Matrix expected.max_duration_ms must be positive.");
  }
  return {
    contains,
    excludes,
    required_envelope_fields: requiredEnvelopeFields,
    ...(Number.isFinite(maxDuration) ? { max_duration_ms: maxDuration } : {}),
    min_passing: minPassing,
  };
}

export function validatePackMatrix(value, configValue) {
  const config = validatePackConfig(configValue);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rappter Pack matrix must be an object.");
  }
  if (value.schema !== RAPPTER_PACK_MATRIX_SCHEMA) {
    throw new Error(`Rappter Pack matrix must use ${RAPPTER_PACK_MATRIX_SCHEMA}.`);
  }
  const name = String(value.name || "").trim();
  if (!name) throw new Error("Rappter Pack matrix requires a name.");
  if (!Array.isArray(value.cases) || !value.cases.length || value.cases.length > 200) {
    throw new Error("Rappter Pack matrix requires 1-200 cases.");
  }
  const nodes = new Set(config.nodes.map((node) => node.id));
  const seen = new Set();
  const cases = value.cases.map((entry) => {
    const id = String(entry?.id || "");
    if (!ID.test(id)) throw new Error(`Matrix case id is invalid: ${id}`);
    if (seen.has(id)) throw new Error(`Matrix contains duplicate case ${id}.`);
    seen.add(id);
    const action = String(entry.action || "");
    const mode = String(entry.mode || "");
    if (!CASE_ACTIONS.has(action)) throw new Error(`${id} has invalid action.`);
    if (!CASE_MODES.has(mode)) throw new Error(`${id} has invalid mode.`);
    const requestedCandidates = fixedArray(entry.candidates, `${id} candidates`);
    let candidates = requestedCandidates.length === 1
      && requestedCandidates[0] === "*"
      ? config.nodes.map((node) => node.id)
      : requestedCandidates;
    if (
      requestedCandidates.includes("*")
      && !(requestedCandidates.length === 1 && requestedCandidates[0] === "*")
    ) {
      throw new Error(`${id} must use wildcard candidates alone.`);
    }
    if (!candidates.length || candidates.some((candidate) => !nodes.has(candidate))) {
      throw new Error(`${id} names an unknown or empty candidate set.`);
    }
    if (entry.reverse_candidates === true) candidates = [...candidates].reverse();
    const prompt = String(entry.prompt || "");
    if (action === "chat" && !prompt.trim()) throw new Error(`${id} requires a prompt.`);
    const handoffPrompt = String(entry.handoff_prompt || "");
    if (
      mode === "relay"
      && (
        action !== "chat"
        || candidates.length < 2
        || !handoffPrompt.includes("{{previous}}")
      )
    ) {
      throw new Error(`${id} relay requires two neighbors and a {{previous}} handoff_prompt.`);
    }
    const expected = normalizeExpectation(entry.expected, candidates.length);
    if (mode === "race" && expected.min_passing > candidates.length) {
      throw new Error(`${id} race acceptance is impossible.`);
    }
    return {
      id,
      action,
      mode,
      candidates,
      prompt,
      ...(mode === "relay" ? { handoff_prompt: handoffPrompt } : {}),
      ...(entry.reverse_candidates === true ? { reverse_candidates: true } : {}),
      expected,
    };
  });
  return {
    schema: RAPPTER_PACK_MATRIX_SCHEMA,
    name,
    cases,
  };
}

export function evaluatePackExpectation(result, expectedValue) {
  const expected = normalizeExpectation(expectedValue, Math.max(1, expectedValue.min_passing || 1));
  const response = String(result?.response || "");
  const differences = [];
  if (result?.ok !== true) {
    differences.push("transport or node did not return success");
  }
  if (result?.refused === true) {
    differences.push("node returned an HTTP refusal");
  }
  if (!Number.isInteger(result?.http_status) || result.http_status !== 200) {
    differences.push(
      `/chat requires HTTP 200; observed ${
        Number.isInteger(result?.http_status) ? result.http_status : "missing-or-invalid"
      }`,
    );
  }
  const duration = Number(result?.duration_ms);
  if (!Number.isFinite(duration) || duration < 0) {
    differences.push("node returned an invalid duration");
  }
  for (const needle of expected.contains) {
    if (!response.includes(needle)) differences.push(`missing expected text ${needle}`);
  }
  for (const needle of expected.excludes) {
    if (response.includes(needle)) differences.push(`contained excluded text ${needle}`);
  }
  differences.push(...chatEnvelopeDifferences(
    result?.envelope,
    expected.required_envelope_fields,
  ));
  if (
    expected.max_duration_ms !== undefined
    && duration > expected.max_duration_ms
  ) {
    differences.push(
      `duration ${result.duration_ms}ms exceeded ${expected.max_duration_ms}ms`,
    );
  }
  return {
    pass: differences.length === 0,
    differences,
    expected,
    observed: {
      ok: result?.ok === true,
      response,
      duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
      envelope: result?.envelope || null,
    },
  };
}

function normalizedResult(node, result, expected) {
  const evaluation = evaluatePackExpectation(result, expected);
  const duration = Number(result?.duration_ms);
  const outcome = result?.cancelled === true
    ? "cancelled_after_winner"
    : result?.ok !== true
      ? "failed"
      : result?.refused === true
        ? "refused"
        : evaluation.pass
          ? "accepted"
          : "invalid";
  return {
    node_id: node.id,
    machine: node.machine,
    kind: node.kind,
    transport: node.transport.kind,
    transport_ok: result?.ok === true,
    response: String(result?.response || ""),
    duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    envelope: result?.envelope || null,
    http_status: Number(result?.http_status) || null,
    refused: result?.refused === true,
    accepted: evaluation.pass,
    differences: evaluation.differences,
    outcome,
  };
}

function normalizedRelayIntermediate(node, result, expected) {
  const rawDuration = Number(result?.duration_ms);
  const duration = Number.isFinite(rawDuration) && rawDuration >= 0
    ? rawDuration
    : null;
  const differences = [];
  if (result?.ok !== true) differences.push("transport or node did not return success");
  if (result?.refused === true) differences.push("node returned an HTTP refusal");
  if (!Number.isInteger(result?.http_status) || result.http_status !== 200) {
    differences.push(
      `/chat requires HTTP 200; observed ${
        Number.isInteger(result?.http_status) ? result.http_status : "missing-or-invalid"
      }`,
    );
  }
  if (duration === null) differences.push("node returned an invalid duration");
  differences.push(...chatEnvelopeDifferences(
    result?.envelope,
    expected.required_envelope_fields,
  ));
  if (
    expected.max_duration_ms !== undefined
    && duration !== null
    && duration > expected.max_duration_ms
  ) {
    differences.push(`duration ${duration}ms exceeded ${expected.max_duration_ms}ms`);
  }
  return {
    node_id: node.id,
    machine: node.machine,
    kind: node.kind,
    transport: node.transport.kind,
    transport_ok: result?.ok === true,
    response: String(result?.response || ""),
    duration_ms: duration,
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    envelope: result?.envelope || null,
    http_status: Number(result?.http_status) || null,
    refused: result?.refused === true,
    accepted: differences.length === 0,
    differences,
    outcome: result?.refused === true
      ? "refused"
      : differences.length === 0
        ? "accepted"
        : "failed",
  };
}

function digestExpectation(expected = {}) {
  return {
    contains: expected.contains ?? null,
    excludes: expected.excludes ?? null,
    required_envelope_fields: expected.required_envelope_fields ?? null,
    max_duration_ms: expected.max_duration_ms ?? null,
    min_passing: expected.min_passing ?? null,
  };
}

function digestObserved(observed = {}) {
  return {
    passing: observed.passing ?? null,
    failing: observed.failing ?? null,
    transport_failures: observed.transport_failures ?? null,
    cancelled_after_winner: observed.cancelled_after_winner ?? null,
    completion_order: observed.completion_order ?? null,
    relay: observed.relay ?? null,
    relationship: observed.relationship ?? null,
    neighborhood_protocol: observed.neighborhood_protocol ?? null,
  };
}

function digestEvidenceValue(value, depth = 0) {
  if (depth > 64) throw new Error("Pack evidence JSON is nested too deeply.");
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Pack evidence JSON contains a non-finite number.");
    }
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, value, false);
    return [
      "number-f64",
      Buffer.from(bytes).toString("hex"),
    ];
  }
  if (Array.isArray(value)) {
    return [
      "array",
      value.map((entry) => digestEvidenceValue(entry, depth + 1)),
    ];
  }
  if (typeof value === "object") {
    return [
      "object",
      Object.keys(value).sort().map((key) => [
        key,
        digestEvidenceValue(value[key], depth + 1),
      ]),
    ];
  }
  throw new Error(`Pack evidence JSON contains unsupported ${typeof value}.`);
}

export function packOutputDigest(report) {
  const payload = {
    schema: report?.schema ?? null,
    wire: report?.wire ? digestEvidenceValue(report.wire) : null,
    pack_id: report?.pack_id ?? null,
    matrix: report?.matrix ?? null,
    nodes: (report?.nodes || []).map((node) => ({
      id: node.id ?? null,
      machine: node.machine ?? null,
      kind: node.kind ?? null,
      capabilities: node.capabilities ?? null,
      transport: node.transport ?? null,
    })),
    cases: (report?.cases || []).map((entry) => ({
    id: entry.id ?? null,
    action: entry.action ?? null,
    mode: entry.mode ?? null,
    candidates: entry.candidates ?? null,
    prompt: entry.prompt ?? null,
    handoff_prompt: entry.handoff_prompt ?? null,
    reverse_candidates: entry.reverse_candidates ?? false,
    expected: digestExpectation(entry.expected),
    observed: digestObserved(entry.observed),
    results: (entry.results || []).map((result) => ({
      node_id: result.node_id ?? null,
      machine: result.machine ?? null,
      kind: result.kind ?? null,
      transport: result.transport ?? null,
      transport_ok: result.transport_ok ?? null,
      response: result.response ?? null,
      duration_ms: result.duration_ms ?? null,
      accepted: result.accepted ?? null,
      differences: result.differences ?? null,
      evidence: result.evidence ?? null,
      envelope: result.envelope === null || result.envelope === undefined
        ? null
        : digestEvidenceValue(result.envelope),
      http_status: result.http_status ?? null,
      refused: result.refused ?? null,
      outcome: result.outcome ?? null,
      settled_order: result.settled_order ?? null,
    })),
    winner: entry.winner
      ? {
          node_id: entry.winner.node_id ?? null,
          accepted: entry.winner.accepted ?? null,
          settled_order: entry.winner.settled_order ?? null,
        }
      : null,
    pass: entry.pass ?? null,
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export async function runPackMatrix({
  config: configValue,
  dispatch = dispatchPackNode,
  matrix: matrixValue,
  now = () => new Date(),
} = {}) {
  const config = validatePackConfig(configValue);
  const matrix = validatePackMatrix(matrixValue, config);
  const nodes = new Map(config.nodes.map((node) => [node.id, node]));
  const cases = [];
  for (const entry of matrix.cases) {
    const caseStarted = Date.now();
    let settlementOrder = 0;
    let results;
    if (entry.mode === "relay") {
      results = [];
      let previous = "";
      for (const [index, nodeId] of entry.candidates.entries()) {
        const node = nodes.get(nodeId);
        const prompt = index === 0
          ? entry.prompt
          : entry.handoff_prompt.replaceAll("{{previous}}", previous);
        try {
          const result = await dispatch(node, {
            action: entry.action,
            case_id: entry.id,
            prompt,
            relay_from: index ? entry.candidates[index - 1] : null,
          });
          const normalized = index === entry.candidates.length - 1
            ? normalizedResult(node, result, entry.expected)
            : normalizedRelayIntermediate(
                node,
                result,
                entry.expected,
              );
          results.push({
            ...normalized,
            settled_order: ++settlementOrder,
          });
          if (!normalized.transport_ok) break;
          previous = normalized.response;
        } catch (error) {
          results.push({
            ...normalizedResult(node, {
            ok: false,
            response: "",
            duration_ms: 0,
            evidence: [`${error?.name || "Error"}: ${error?.message || error}`],
            }, entry.expected),
            settled_order: ++settlementOrder,
          });
          break;
        }
      }
    } else if (entry.mode === "race") {
      results = [];
      const pending = new Map();
      for (const nodeId of entry.candidates) {
        const node = nodes.get(nodeId);
        const controller = new AbortController();
        const promise = (async () => {
          try {
            return {
              node,
              result: await dispatch(node, {
                action: entry.action,
                case_id: entry.id,
                prompt: entry.prompt,
              }, { signal: controller.signal }),
            };
          } catch (error) {
            return { node, error };
          }
        })();
        pending.set(nodeId, { controller, node, promise });
      }
      while (pending.size) {
        const settled = await Promise.race(
          [...pending.values()].map(({ promise }) => promise),
        );
        pending.delete(settled.node.id);
        const normalized = settled.error
          ? normalizedResult(settled.node, {
              ok: false,
              response: "",
              duration_ms: Date.now() - caseStarted,
              evidence: [
                `${settled.error?.name || "Error"}: ${
                  settled.error?.message || settled.error
                }`,
              ],
            }, entry.expected)
          : normalizedResult(settled.node, settled.result, entry.expected);
        results.push({
          ...normalized,
          settled_order: ++settlementOrder,
        });
        const passing = results.filter((result) => result.accepted).length;
        if (passing < entry.expected.min_passing) continue;
        const winner = results.find((result) => result.accepted);
        for (const { controller, node } of pending.values()) {
          controller.abort(
            new Error(`Pack race ${entry.id} accepted ${winner.node_id}.`),
          );
          results.push({
            ...normalizedResult(node, {
              ok: false,
              cancelled: true,
              response: "",
              duration_ms: Date.now() - caseStarted,
              evidence: [
                `AbortError: cancelled after winner ${winner.node_id}`,
              ],
            }, entry.expected),
            settled_order: ++settlementOrder,
          });
        }
        pending.clear();
      }
    } else {
      results = await Promise.all(entry.candidates.map(async (nodeId) => {
      const node = nodes.get(nodeId);
      try {
        const result = await dispatch(node, {
          action: entry.action,
          case_id: entry.id,
          prompt: entry.prompt,
        });
        return {
          ...normalizedResult(node, result, entry.expected),
          settled_order: ++settlementOrder,
        };
      } catch (error) {
        return {
          ...normalizedResult(node, {
            ok: false,
            response: "",
            duration_ms: 0,
            evidence: [`${error?.name || "Error"}: ${error?.message || error}`],
          }, entry.expected),
          settled_order: ++settlementOrder,
        };
      }
      }));
    }
    const accepted = results
      .filter((result) => result.accepted)
      .sort((left, right) => (
        left.settled_order - right.settled_order
        || left.node_id.localeCompare(right.node_id)
      ));
    const relayFinal = entry.mode === "relay"
      ? results[results.length - 1]
      : null;
    const pass = entry.mode === "relay"
      ? (
          results.length === entry.candidates.length
          && results.every((result) => result.accepted)
          && relayFinal?.accepted === true
        )
      : accepted.length >= entry.expected.min_passing;
    cases.push({
      id: entry.id,
      action: entry.action,
      mode: entry.mode,
      candidates: [...entry.candidates],
      prompt: entry.prompt,
      handoff_prompt: entry.handoff_prompt || null,
      reverse_candidates: entry.reverse_candidates === true,
      expected: entry.expected,
      observed: {
        passing: accepted.length,
        failing: results.length - accepted.length,
        transport_failures: results.filter((result) => !result.transport_ok).length,
        cancelled_after_winner: results.filter(
          (result) => result.outcome === "cancelled_after_winner",
        ).length,
        completion_order: [...results]
          .sort((left, right) => left.settled_order - right.settled_order)
          .map((result) => result.node_id),
        ...(entry.mode === "relay"
          ? {
              relay: results.map((result) => result.node_id),
              relationship: "pack-neighbors-over-post-chat",
              neighborhood_protocol: "not-claimed",
            }
          : {}),
      },
      results,
      winner: entry.mode === "race" && accepted.length
        ? accepted[0]
        : entry.mode === "relay" && relayFinal?.accepted
          ? relayFinal
          : null,
      pass,
    });
  }
  const passed = cases.filter((entry) => entry.pass).length;
  const report = {
    schema: RAPPTER_PACK_REPORT_SCHEMA,
    wire: {
      method: "POST",
      path: "/chat",
      adapter: "legacy-success-envelope-to-rapp1",
      upstream_contract: "normalized",
      neighborhood_protocol: "not-claimed",
    },
    pack_id: config.pack_id,
    matrix: matrix.name,
    created_at: now().toISOString(),
    nodes: config.nodes.map(({ id, machine, kind, capabilities, transport }) => ({
      id,
      machine,
      kind,
      capabilities,
      transport: transport.kind,
    })),
    cases,
    summary: {
      pass: passed,
      fail: cases.length - passed,
      total: cases.length,
    },
  };
  return {
    ...report,
    output_digest: packOutputDigest(report),
  };
}

function reportName(directory, createdAt) {
  const base = createdAt.replace(/[:.]/g, "-");
  let index = 0;
  let name = `${base}-${String(index).padStart(3, "0")}.json`;
  while (existsSync(path.join(directory, name))) {
    index += 1;
    name = `${base}-${String(index).padStart(3, "0")}.json`;
  }
  return name;
}

export function writePackReport(home, report) {
  if (report?.schema !== RAPPTER_PACK_REPORT_SCHEMA) {
    throw new Error("Only rappter-pack-report/1.0 reports may be persisted.");
  }
  const packRoot = path.join(path.resolve(home), "pack");
  const runs = path.join(packRoot, "runs");
  privateDirectory(runs);
  const source = `${JSON.stringify(report, null, 2)}\n`;
  const file = path.join(runs, reportName(runs, report.created_at));
  atomicPrivateWrite(file, source);
  atomicPrivateWrite(path.join(packRoot, "latest.json"), source);
  const history = path.join(packRoot, "history.jsonl");
  appendFileSync(history, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  try {
    chmodSync(history, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
  return file;
}

export async function runContinuousPackMatrix({
  config,
  dispatch = dispatchPackNode,
  intervalMs = 60_000,
  iterations = Infinity,
  matrix,
  now = () => new Date(),
  onIteration = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const count = iterations === Infinity ? Infinity : Number(iterations);
  if (!(count === Infinity || (Number.isInteger(count) && count > 0))) {
    throw new Error("Pack loop iterations must be a positive integer or Infinity.");
  }
  const reports = [];
  for (let iteration = 0; iteration < count; iteration += 1) {
    const report = await runPackMatrix({ config, dispatch, matrix, now });
    reports.push(report);
    if (reports.length > 100) reports.shift();
    await onIteration(report, iteration);
    if (iteration + 1 < count) await sleep(Math.max(0, Number(intervalMs) || 0));
  }
  return reports;
}

function spawnJson(
  command,
  args,
  input,
  timeoutMs = 10 * 60 * 1000,
  options = {},
) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error, { kill = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PACK_STDOUT_BYTES) {
        fail(new Error(`${command} stdout exceeded ${MAX_PACK_STDOUT_BYTES} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PACK_STDERR_BYTES) {
        fail(new Error(`${command} stderr exceeded ${MAX_PACK_STDERR_BYTES} bytes.`));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      fail(error, { kill: false });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(err || `${command} exited ${code}.`));
        return;
      }
      try {
        const result = JSON.parse(out);
        resolve({
          ...result,
          duration_ms: Number(result.duration_ms) || (Date.now() - started),
        });
      } catch (error) {
        reject(new Error(`${command} returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function readBoundedResponseText(response, limit = MAX_PACK_HTTP_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`Pack HTTP response exceeds ${limit} bytes.`);
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) {
      throw new Error(`Pack HTTP response exceeds ${limit} bytes.`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("Pack response overflow");
      throw new Error(`Pack HTTP response exceeds ${limit} bytes.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function dispatchPackNode(nodeValue, request, {
  fetchImpl = fetch,
  signal = null,
} = {}) {
  const node = validatePackConfig({
    schema: RAPPTER_PACK_CONFIG_SCHEMA,
    pack_id: "dispatch-pack",
    nodes: [nodeValue],
  }).nodes[0];
  if (node.transport.kind === "http") {
    const started = Date.now();
    const endpoint = request.action === "health" ? "/health" : "/chat";
    let secret = "";
    if (node.transport.secret_env) {
      secret = String(process.env[node.transport.secret_env] || "");
      if (!secret) {
        throw new Error(`Pack secret environment ${node.transport.secret_env} is unset.`);
      }
    } else if (node.transport.secret_file) {
      const stats = statSync(node.transport.secret_file);
      if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o077))) {
        throw new Error("Pack secret file must be a private regular file.");
      }
      secret = readFileSync(node.transport.secret_file, "utf8").trim();
      if (!secret) throw new Error("Pack secret file is empty.");
    }
    const timeoutSignal = AbortSignal.timeout(5 * 60 * 1000);
    const response = await fetchImpl(`${node.transport.url}${endpoint}`, {
      method: request.action === "health" ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Brainstem-Secret": secret } : {}),
      },
      ...(request.action === "health" ? {} : {
        body: JSON.stringify(node.kind === "openrappter"
          ? { user_input: request.prompt }
          : {
              user_input: request.prompt,
              conversation_history: [],
            }),
      }),
      signal: signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal,
    });
    const rawBody = await readBoundedResponseText(response);
    let body = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // A non-JSON HTTP refusal remains a refusal with its body retained.
    }
    let envelope = body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
    if (request.action === "chat" && response.ok && envelope) {
      try {
        envelope = exactRapp1Success(envelope);
      } catch {
        // Keep malformed success evidence so the expectation gate can reject it.
      }
    }
    return {
      ok: true,
      response: request.action === "health"
          ? (envelope ? JSON.stringify(envelope) : rawBody)
          : String(envelope?.response ?? rawBody),
      envelope,
      http_status: response.status,
      refused: !response.ok,
      duration_ms: Date.now() - started,
      evidence: [`${node.transport.url}${endpoint}`],
    };
  }
  const nodeScript = fileURLToPath(
    new URL("../scripts/rappter-pack-node.mjs", import.meta.url),
  );
  if (node.transport.kind === "local") {
    return spawnJson(process.execPath, [nodeScript], {
      ...request,
      node_kind: node.kind,
    }, 10 * 60 * 1000, {
      env: {
        ...process.env,
        ...(node.transport.home
          ? {
              OPENRAPPTER_HOME: node.transport.home,
              BRAINSTEM_BETA_HOME: path.join(
                node.transport.home,
                "desktop",
              ),
            }
          : {}),
      },
      signal,
    });
  }
  return spawnJson("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes",
    node.transport.host,
    "openrappter-pack-node",
  ], {
    ...request,
    node_kind: node.kind,
  }, 10 * 60 * 1000, { signal });
}

export function packNodeReady(result) {
  if (result?.ok !== true || result?.refused === true) return false;
  const status = Number(result?.http_status);
  if (!Number.isInteger(status)) return true;
  return status >= 200 && status < 300;
}

export const packInternals = {
  MAX_PACK_HTTP_BYTES,
  MAX_PACK_STDERR_BYTES,
  MAX_PACK_STDOUT_BYTES,
  readBoundedResponseText,
  spawnJson,
};

export function readEstateInventory(file) {
  const target = path.resolve(String(file || ""));
  if (statSync(target).size > 20 * 1024 * 1024) {
    throw new Error("RAPP estate manifest is too large.");
  }
  const value = JSON.parse(readFileSync(target, "utf8"));
  const raw = value.repos || value.repositories;
  const rows = Array.isArray(raw)
    ? raw.map((entry) => [entry.name || entry.repo, entry])
    : Object.entries(raw || {});
  const commits = {};
  let files = 0;
  for (const [name, entry] of rows) {
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("RAPP estate manifest contains an invalid repository name.");
    }
    const commit = String(entry?.commit || entry?.sha || "");
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(`RAPP estate repository ${name} lacks a full commit.`);
    }
    commits[name] = commit.toLowerCase();
    files += Number(entry?.files || entry?.file_count || 0);
  }
  return {
    captured_at: value.captured_at || value.capturedAt || null,
    repositories: rows.length,
    files,
    commits,
  };
}
