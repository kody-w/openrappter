import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { scrubDiagnosticValue } from "./log-redaction.mjs";

export const SEMANTIC_PLAN_SCHEMA = "openrappter-ui-plan/1.0";
export const SEMANTIC_PLAN_LIMITS = Object.freeze({
  actions: 40,
  bytes: 64 * 1024,
  text: 16 * 1024,
  timeoutMs: 10 * 60 * 1000,
});
export const SEMANTIC_ACTIONS = Object.freeze([
  "inspect_state",
  "select_store_item",
  "hatch",
  "wait_status",
  "send_chat",
  "click_known",
  "assert_visible_text",
  "assert_state",
  "screenshot",
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SCREENSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_HANDLE = /^@?(?:shell|store|twin|brainstem|herd|arena|binder|tiles)[A-Za-z0-9_.%[\]-]*$/;
const TOP_LEVEL_KEYS = new Set(["schema", "name", "timeoutMs", "actions"]);
const ACTION_KEYS = Object.freeze({
  inspect_state: new Set(["action", "target", "limit"]),
  select_store_item: new Set(["action", "id", "timeoutMs"]),
  hatch: new Set(["action", "id", "timeoutMs"]),
  wait_status: new Set(["action", "status", "timeoutMs", "twinId"]),
  send_chat: new Set(["action", "text", "timeoutMs", "twinId", "waitText"]),
  click_known: new Set(["action", "handle", "timeoutMs"]),
  assert_visible_text: new Set(["action", "target", "text", "timeoutMs"]),
  assert_state: new Set(["action", "handle", "state", "timeoutMs"]),
  screenshot: new Set(["action", "includeText", "name"]),
});

function fail(message) {
  throw new Error(`Invalid semantic UI plan: ${message}`);
}

function closedObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} does not accept "${key}".`);
  }
}

function boundedInteger(value, {
  fallback,
  label,
  maximum,
  minimum = 1,
} = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function boundedText(value, label, {
  maximum = SEMANTIC_PLAN_LIMITS.text,
  optional = false,
} = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be non-empty text.`);
  }
  if (Buffer.byteLength(value) > maximum) {
    fail(`${label} exceeds ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function safeId(value, label, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail(`${label} must match ${SAFE_ID}.`);
  }
  return value;
}

function safeHandle(value, label = "handle") {
  if (typeof value !== "string" || !SAFE_HANDLE.test(value)) {
    fail(`${label} must be a known semantic data-drive handle.`);
  }
  return value.startsWith("@") ? value : `@${value}`;
}

function timeout(value, label, fallback = 30_000) {
  return boundedInteger(value, {
    fallback,
    label,
    maximum: 120_000,
    minimum: 100,
  });
}

function normalizeAction(value, index) {
  const label = `actions[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const action = value.action;
  if (!SEMANTIC_ACTIONS.includes(action)) {
    fail(`${label}.action must be one of ${SEMANTIC_ACTIONS.join(", ")}.`);
  }
  closedObject(value, ACTION_KEYS[action], label);
  switch (action) {
    case "inspect_state":
      if (value.target !== undefined && !["shell", "brainstem"].includes(value.target)) {
        fail(`${label}.target must be shell or brainstem.`);
      }
      return {
        action,
        limit: boundedInteger(value.limit, {
          fallback: 60,
          label: `${label}.limit`,
          maximum: 80,
        }),
        target: value.target || "shell",
      };
    case "select_store_item":
    case "hatch":
      return {
        action,
        id: safeId(value.id, `${label}.id`),
        timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
      };
    case "wait_status":
      if (!["ready", "working", "needs-auth", "error"].includes(value.status)) {
        fail(`${label}.status must be ready, working, needs-auth, or error.`);
      }
      return {
        action,
        status: value.status,
        timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
        twinId: safeId(value.twinId, `${label}.twinId`, { optional: true }),
      };
    case "send_chat":
      return {
        action,
        text: boundedText(value.text, `${label}.text`),
        timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`, 120_000),
        twinId: safeId(value.twinId, `${label}.twinId`, { optional: true }),
        waitText: boundedText(value.waitText, `${label}.waitText`, {
          maximum: 4 * 1024,
          optional: true,
        }),
      };
    case "click_known":
      return {
        action,
        handle: safeHandle(value.handle, `${label}.handle`),
        timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
      };
    case "assert_visible_text":
      if (value.target !== undefined && !["shell", "brainstem"].includes(value.target)) {
        fail(`${label}.target must be shell or brainstem.`);
      }
      return {
        action,
        target: value.target || "shell",
        text: boundedText(value.text, `${label}.text`, { maximum: 4 * 1024 }),
        timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
      };
    case "assert_state":
      if (!["visible", "enabled", "disabled", "focused"].includes(value.state)) {
        fail(`${label}.state must be visible, enabled, disabled, or focused.`);
      }
      return {
        action,
        handle: safeHandle(value.handle, `${label}.handle`),
        state: value.state,
        timeoutMs: timeout(value.timeoutMs, `${label}.timeoutMs`),
      };
    case "screenshot":
      if (
        value.name !== undefined
        && (typeof value.name !== "string" || !SAFE_SCREENSHOT_NAME.test(value.name))
      ) {
        fail(`${label}.name must be a safe filename stem.`);
      }
      if (value.includeText !== undefined && typeof value.includeText !== "boolean") {
        fail(`${label}.includeText must be boolean.`);
      }
      return {
        action,
        includeText: value.includeText === true,
        name: value.name || `step-${index + 1}`,
      };
    default:
      throw new Error(`Unreachable semantic action: ${action}`);
  }
}

export function validateSemanticPlan(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > SEMANTIC_PLAN_LIMITS.bytes) {
    fail(`serialized input exceeds ${SEMANTIC_PLAN_LIMITS.bytes} bytes.`);
  }
  closedObject(value, TOP_LEVEL_KEYS, "plan");
  if (value.schema !== SEMANTIC_PLAN_SCHEMA) {
    fail(`schema must be "${SEMANTIC_PLAN_SCHEMA}".`);
  }
  if (value.name !== undefined) safeId(value.name, "plan.name");
  if (
    !Array.isArray(value.actions)
    || value.actions.length < 1
    || value.actions.length > SEMANTIC_PLAN_LIMITS.actions
  ) {
    fail(`actions must contain 1 through ${SEMANTIC_PLAN_LIMITS.actions} items.`);
  }
  return {
    schema: SEMANTIC_PLAN_SCHEMA,
    name: value.name || "semantic-plan",
    timeoutMs: boundedInteger(value.timeoutMs, {
      fallback: SEMANTIC_PLAN_LIMITS.timeoutMs,
      label: "plan.timeoutMs",
      maximum: SEMANTIC_PLAN_LIMITS.timeoutMs,
      minimum: 1000,
    }),
    actions: value.actions.map(normalizeAction),
  };
}

function driveKey(value) {
  return encodeURIComponent(String(value));
}

function twinIdFromHandle(handle) {
  const match = String(handle || "").match(/^@twin\[([^\]]+)\]\.tile$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function rowsFromInspect(result) {
  return Array.isArray(result?.rows)
    ? result.rows
    : Array.isArray(result?.outline?.rows)
      ? result.outline.rows
      : [];
}

function rowHandle(row) {
  return row?.h || row?.handle || "";
}

function actionFailed(result) {
  if (result?.ok === false) return true;
  if (result?.reason === "yielded_to_user") return true;
  return Array.isArray(result?.results)
    && result.results.some((item) => item?.ok === false || item?.reason === "yielded_to_user");
}

function summarizeResult(value, depth = 0) {
  if (depth > 5) return "[bounded]";
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeResult(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const rows = rowsFromInspect(value);
  if (rows.length) {
    return {
      frame: value.frame || value.outline?.frame || null,
      rows: rows.length,
      snapshot: value.snapshot || value.outline?.snapshot || null,
    };
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["dataUrl", "visibleText"].includes(key))
      .map(([key, nested]) => [key, summarizeResult(nested, depth + 1)]),
  );
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}.`);
}

export class SemanticUiPlanRunner {
  constructor({ command, record = () => {} } = {}) {
    if (typeof command !== "function") {
      throw new TypeError("SemanticUiPlanRunner requires a UI driver command function.");
    }
    this.command = command;
    this.record = record;
    this.selectedStoreId = null;
    this.twinId = null;
  }

  async inspect(target = "shell", limit = 80) {
    return this.command({ action: "inspect", target, limit });
  }

  async issue(command) {
    const result = await this.command(command);
    if (actionFailed(result)) {
      throw new Error(`Visible UI action failed: ${JSON.stringify(result)}.`);
    }
    return result;
  }

  async run(input) {
    const plan = validateSemanticPlan(input);
    const deadline = Date.now() + plan.timeoutMs;
    const results = [];
    for (const [index, action] of plan.actions.entries()) {
      if (Date.now() >= deadline) {
        throw new Error(`Semantic UI plan exceeded ${plan.timeoutMs} ms.`);
      }
      const result = await this.runAction(action);
      const event = {
        action: action.action,
        index,
        ok: true,
        result: summarizeResult(result),
      };
      results.push(event);
      this.record(event);
    }
    return {
      ok: true,
      plan: plan.name,
      ran: results.length,
      results,
    };
  }

  async runAction(action) {
    switch (action.action) {
      case "inspect_state":
        return this.inspect(action.target, action.limit);
      case "select_store_item": {
        const key = driveKey(action.id);
        const storeRowHandle = `@store[${key}].row`;
        try {
          await this.command({
            action: "wait",
            handle: storeRowHandle,
            target: "shell",
            timeoutMs: 100,
          });
          this.selectedStoreId = action.id;
          return { id: action.id, selected: true };
        } catch {
          // Open the visible surfaces below.
        }
        const visibleHandles = new Set(
          rowsFromInspect(await this.inspect("shell", 80)).map(rowHandle),
        );
        await this.issue({
          action: "run",
          target: "shell",
          steps: [
            ...(visibleHandles.has("@shell.enter")
              ? [{ action: "click", handle: "@shell.enter", settleMs: 50 }]
              : []),
            ...(!visibleHandles.has("@shell.storeOpen")
              ? [{ action: "click", handle: "@shell.surgeonHerd", settleMs: 100 }]
              : []),
            { action: "click", handle: "@shell.storeOpen", settleMs: 100 },
            {
              action: "wait",
              handle: storeRowHandle,
              timeoutMs: action.timeoutMs,
            },
          ],
        });
        this.selectedStoreId = action.id;
        return { id: action.id, selected: true };
      }
      case "hatch": {
        if (this.selectedStoreId !== action.id) {
          await this.runAction({ ...action, action: "select_store_item" });
        }
        const before = new Set(
          rowsFromInspect(await this.inspect("shell", 80))
            .map((row) => twinIdFromHandle(rowHandle(row)))
            .filter(Boolean),
        );
        await this.issue({
          action: "run",
          target: "shell",
          steps: [{
            action: "click",
            handle: `@store[${driveKey(action.id)}].hatch`,
            settleMs: 100,
          }],
        });
        const twinId = await waitFor(async () => {
          const rows = rowsFromInspect(await this.inspect("shell", 80));
          const newId = rows
            .map((row) => twinIdFromHandle(rowHandle(row)))
            .find((id) => id && !before.has(id));
          if (newId) return newId;
          for (let suffix = 1; suffix <= 8; suffix += 1) {
            const candidate = `${action.id}-${suffix}`;
            if (before.has(candidate)) continue;
            try {
              await this.command({
                action: "wait",
                handle: `@twin[${driveKey(candidate)}].tile`,
                target: "shell",
                timeoutMs: 100,
              });
              return candidate;
            } catch {
              // The bounded poll continues through the known eight-twin cap.
            }
          }
          return null;
        }, action.timeoutMs, `a twin hatched from ${action.id}`);
        this.twinId = twinId;
        return { id: action.id, twinId };
      }
      case "wait_status": {
        const twinId = action.twinId || this.twinId;
        if (!twinId) throw new Error("wait_status requires a prior hatch or twinId.");
        const handle = `@twin[${driveKey(twinId)}].tile`;
        await this.issue({
          action: "wait",
          handle,
          target: "shell",
          text: action.status,
          timeoutMs: action.timeoutMs,
        });
        return { status: action.status, twinId };
      }
      case "send_chat": {
        const twinId = action.twinId || this.twinId;
        if (!twinId) {
          const result = await this.issue({
            action: "chat",
            value: action.text,
            timeoutMs: action.timeoutMs,
          });
          return { target: "brainstem", response: result.response || "" };
        }
        const key = driveKey(twinId);
        await this.issue({
          action: "run",
          target: "shell",
          steps: [
            {
              action: "type",
              handle: `@twin[${key}].composer`,
              typingDelayMs: 0,
              value: action.text,
            },
            {
              action: "click",
              handle: `@twin[${key}].send`,
              settleMs: 100,
            },
            ...(action.waitText
              ? [{
                  action: "wait",
                  handle: `@twin[${key}].tile`,
                  text: action.waitText,
                  timeoutMs: action.timeoutMs,
                }]
              : []),
          ],
        });
        return { target: "twin", twinId, ...(action.waitText ? { matched: action.waitText } : {}) };
      }
      case "click_known":
        return this.issue({
          action: "run",
          target: action.handle.startsWith("@brainstem.") ? "brainstem" : "shell",
          steps: [{ action: "click", handle: action.handle }],
        });
      case "assert_visible_text":
        return this.issue({
          action: "wait",
          target: action.target,
          text: action.text,
          timeoutMs: action.timeoutMs,
        });
      case "assert_state": {
        return waitFor(async () => {
          const target = action.handle.startsWith("@brainstem.")
            ? "brainstem"
            : "shell";
          const rows = rowsFromInspect(await this.inspect(target, 80));
          const row = rows.find((candidate) => rowHandle(candidate) === action.handle);
          if (!row) return null;
          const actual = String(row.state || "");
          const matched = action.state === "visible"
            || actual.split(/\s+/).includes(action.state);
          return matched ? { actual, handle: action.handle } : null;
        }, action.timeoutMs, `${action.handle} to become ${action.state}`);
      }
      case "screenshot":
        return this.issue({
          action: "screenshot",
          includeText: action.includeText,
          label: action.name,
          target: "shell",
        });
      default:
        throw new Error(`Unsupported semantic action: ${action.action}`);
    }
  }
}

function atomicWrite(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, filePath);
}

export class SemanticTrace {
  constructor({ filePath, roots = [] } = {}) {
    this.filePath = filePath;
    this.roots = roots;
    this.events = [];
  }

  record(event) {
    const safe = scrubDiagnosticValue(event, { roots: this.roots });
    this.events.push(safe);
    atomicWrite(
      this.filePath,
      this.events.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
  }
}

export function acquirePlanLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const attempt = () => {
    const descriptor = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`);
    } finally {
      closeSync(descriptor);
    }
  };
  try {
    attempt();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const owner = JSON.parse(readFileSync(lockPath, "utf8"));
      process.kill(Number(owner.pid), 0);
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new Error("Another semantic UI plan is already active.");
    }
    rmSync(lockPath, { force: true });
    attempt();
  }
  return () => {
    if (!existsSync(lockPath)) return;
    try {
      const owner = JSON.parse(readFileSync(lockPath, "utf8"));
      if (Number(owner.pid) === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // A replaced lock belongs to somebody else and is left alone.
    }
  };
}
