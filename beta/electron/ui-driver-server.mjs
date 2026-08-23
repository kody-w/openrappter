import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";

import {
  pruneLogFiles,
  redactCredentialText,
  rotateLogIfLarge,
} from "./log-redaction.mjs";
import { createUiDriverHelpers } from "./ui-driver-helpers.mjs";
import { probeMediaOrgan, resolveFfmpegExecutable } from "./video-tools.mjs";

const MAX_BODY_BYTES = 256 * 1024;
let recordingPermissionWebContents = null;
const capturedRecordings = new WeakMap();
const lastCapturedRecordings = new WeakMap();

function errorMessage(error) {
  return String(error?.message || error);
}

function jsonResponse(response, status, body) {
  if (!response.headersSent) {
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
  }
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("UI driver command is too large.");
    }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("UI driver command must be a JSON object.");
  }
  return value;
}

function frameTree(root) {
  const frames = [root];
  for (const child of root.frames || []) frames.push(...frameTree(child));
  return frames;
}

function brainstemFrame(window, loopbackUrl) {
  return frameTree(window.webContents.mainFrame)
    .find((frame) => loopbackUrl(frame.url));
}

// Find the iframe frame that hosts a given twin's UI (its custom-UI proxy origin
// or its own Grail origin), so the AI can drive a rapplication's UI in-tile
// exactly like the user — clicks, typing, the animated cursor, all in that tile.
function twinFrame(window, twinUrls) {
  const prefixes = (twinUrls || []).filter(Boolean).map((u) => String(u).replace(/\/+$/, ""));
  if (!prefixes.length) return null;
  return frameTree(window.webContents.mainFrame).find((frame) => {
    const url = String(frame.url || "");
    return prefixes.some((prefix) => url === prefix || url.startsWith(prefix + "/") || url.startsWith(prefix + "?"));
  });
}

// A frame script must never wedge the per-frame queue. Electron leaves the
// executeJavaScript promise dangling when the frame navigates or is destroyed
// mid-command (a route swap after a control word, a reload, a twin closing), and
// before v2 serialized commands per frame that only lost the one in-flight
// command — with the queue it would block every later command on that frame.
// So every frame script is raced against the frame going away and a deadline.
const FRAME_SCRIPT_TIMEOUT_MS = 20000;
const MAX_FRAME_SCRIPT_TIMEOUT_MS = 65 * 60 * 1000;
const FRAME_SCRIPT_POLL_MS = 100;
const UI_DRIVER_LIMITS = Object.freeze({
  announceDurationMs: 5000,
  settleMs: 5000,
  typedCharacters: 64 * 1024,
  typingDelayMs: 100,
  typingDurationMs: 60_000,
});

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(number) ? number : fallback),
  );
}

function boundedFrameTimeout(timeoutMs) {
  return boundedNumber(
    timeoutMs,
    250,
    MAX_FRAME_SCRIPT_TIMEOUT_MS,
    FRAME_SCRIPT_TIMEOUT_MS,
  );
}

class FrameGoneError extends Error {
  constructor(reason) {
    super(`The target frame ${reason} before the command finished; retry against the new frame.`);
    this.name = "FrameGoneError";
    this.retryable = true;
  }
}

function frameIsGone(frame, { window, startUrl }) {
  try {
    if (typeof frame.isDestroyed === "function" && frame.isDestroyed()) return "was destroyed";
  } catch {
    return "was destroyed";
  }
  let url;
  try {
    url = String(frame.url || "");
  } catch {
    return "was destroyed";
  }
  if (url !== startUrl) return "navigated";
  if (window?.webContents?.mainFrame && !frameTree(window.webContents.mainFrame).includes(frame)) {
    return "was detached";
  }
  return null;
}

// The watchdog must never fire on a HEALTHY frame that is simply doing what
// it was told: a delegated chat legitimately waits minutes for a reply. The
// deadline is derived from the command's own budget (mirroring the in-frame
// clamps) plus grace; 20 s is only the floor.
const FRAME_SCRIPT_GRACE_MS = 15000;
const FRAME_SCRIPT_MAX_MS = 60 * 60 * 1000 + 30000;

function stepBudgetMs(step) {
  const action = String(step?.action || "").toLowerCase();
  const settle = Math.max(0, Number(step?.settleMs) || 0);
  if (action === "chat" || action === "surgeon_chat") {
    const defaultTimeout = action === "surgeon_chat" ? 3600000 : 180000;
    return Math.max(
      1000,
      Math.min(3600000, Number(step?.timeoutMs) || defaultTimeout),
    ) + settle;
  }
  if (action === "wait") return Math.max(100, Math.min(120000, Number(step?.timeoutMs) || 10000));
  if (action === "announce") return Math.max(120, Number(step?.durationMs) || 900);
  if (action === "type") {
    const length = String(step?.value ?? step?.text ?? "").length;
    const delay = Math.max(0, Math.min(100, Number(step?.typingDelayMs) || 18));
    return length * delay + Math.max(160, settle || 300);
  }
  if (action === "tour") return Math.max(1000, Number(step?.durationMs) || 60000);
  if (action === "autopilot") {
    const commands = String(step?.script || "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .length;
    return Math.max(1000, Math.min(64, commands || 1) * 12000);
  }
  return settle + 1000;
}

function frameBudgetMs(command) {
  const explicit = Number(command?.frameTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(FRAME_SCRIPT_MAX_MS, Math.max(250, explicit));
  }
  const steps = Array.isArray(command?.steps) ? command.steps : [command];
  const budget = steps.reduce((sum, step) => sum + stepBudgetMs(step), 0);
  return Math.min(
    FRAME_SCRIPT_MAX_MS,
    Math.max(FRAME_SCRIPT_TIMEOUT_MS, budget + FRAME_SCRIPT_GRACE_MS),
  );
}

async function executeInFrame(frame, source, { window = null, timeoutMs = FRAME_SCRIPT_TIMEOUT_MS } = {}) {
  if (!frame) throw new Error("The live Brainstem frontend is not loaded yet.");
  const startUrl = String(frame.url || "");
  const effectiveTimeoutMs = boundedFrameTimeout(timeoutMs);
  const deadline = Date.now() + effectiveTimeoutMs;
  let timer = null;
  let settled = false;
  const watchdog = new Promise((resolve, reject) => {
    const check = () => {
      if (settled) return;
      const gone = frameIsGone(frame, { window, startUrl });
      if (gone) {
        reject(new FrameGoneError(gone));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`The frame command did not finish within ${Math.round(effectiveTimeoutMs / 1000)}s; the frame may be unresponsive.`));
        return;
      }
      timer = setTimeout(check, FRAME_SCRIPT_POLL_MS);
    };
    timer = setTimeout(check, FRAME_SCRIPT_POLL_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => frame.executeJavaScript(source, true)),
      watchdog,
    ]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}

async function browserDriverCommand(command, createHelpers, commandId = null, limits = {
  announceDurationMs: 5000,
  frameBudgetMs: 20_000,
  settleMs: 5000,
  typedCharacters: 64 * 1024,
  typingDelayMs: 100,
  typingDurationMs: 60_000,
}) {
  const bounded = (value, minimum, maximum, fallback) => {
    const number = Number(value);
    return Math.max(
      minimum,
      Math.min(maximum, Number.isFinite(number) ? number : fallback),
    );
  };
  // The frame's own deadline is the SAME budget the bus watchdog was given
  // (derived from the command's steps; 20 s is only the floor), so in-frame
  // work and the watchdog agree instead of racing each other.
  const frameBudget = bounded(
    limits.frameBudgetMs ?? command.frameTimeoutMs,
    250,
    65 * 60 * 1000,
    20_000,
  );
  const commandDeadline = Date.now() + Math.max(1, frameBudget - 250);
  const state = window.__brainstemAiDriver ||= {};
  // One command per frame: if the bus abandoned this script (watchdog) and a
  // later command took the frame, every loop here stops at its next tick
  // instead of driving the frame alongside the newcomer.
  const myCommandId = commandId || String(Date.now()) + Math.random().toString(16).slice(2);
  state.activeCommandId = myCommandId;
  const sleep = (ms) => {
    const requestedMs = Math.max(0, Number(ms) || 0);
    const remainingMs = commandDeadline - Date.now();
    if (remainingMs <= 0) {
      return Promise.reject(new Error("UI driver command exceeded its frame time budget."));
    }
    const waitMs = Math.min(requestedMs, remainingMs);
    return new Promise((resolve, reject) => setTimeout(() => {
      if (state.activeCommandId !== myCommandId) {
        const error = new Error("This command was superseded by a later command on the same frame.");
        error.name = "UiDriverSupersededError";
        reject(error);
        return;
      }
      if (waitMs < requestedMs || Date.now() >= commandDeadline) {
        reject(new Error("UI driver command exceeded its frame time budget."));
        return;
      }
      resolve();
    }, waitMs));
  };
  const helpers = createHelpers({
    cssEscape: (value) => CSS.escape(value),
    document,
  });
  const frameName = command.twin
    ? `twin:${command.twin}`
    : (command.target === "shell" ? "shell" : "brainstem");

  function ensureUi() {
    let style = document.getElementById("brainstem-ai-driver-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "brainstem-ai-driver-style";
      style.textContent = `
        #brainstem-ai-driver-cursor {
          position: fixed; z-index: 2147483645; width: 28px; height: 28px;
          left: 24px; top: 24px; pointer-events: none; opacity: 0;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,.65));
          transition: left .58s cubic-bezier(.22,.8,.24,1),
                      top .58s cubic-bezier(.22,.8,.24,1), opacity .16s ease;
        }
        #brainstem-ai-driver-cursor svg { width: 100%; height: 100%; display: block; }
        #brainstem-ai-driver-pulse {
          position: fixed; z-index: 2147483644; width: 14px; height: 14px;
          border: 2px solid #58a6ff; border-radius: 50%; pointer-events: none;
          opacity: 0; transform: translate(-50%,-50%) scale(.4);
        }
        #brainstem-ai-driver-pulse.go {
          animation: brainstemAiDriverPulse .62s ease-out forwards;
        }
        #brainstem-ai-driver-label {
          position: fixed; z-index: 2147483646; max-width: min(360px, 70vw);
          padding: 8px 11px; border: 1px solid #388bfd; border-radius: 8px;
          color: #e6edf3; background: rgba(13,17,23,.96);
          box-shadow: 0 8px 28px rgba(0,0,0,.45);
          font: 600 12px/1.35 ui-sans-serif, system-ui, sans-serif;
          pointer-events: none; opacity: 0; transform: translateY(4px);
          transition: opacity .16s ease, transform .16s ease;
        }
        #brainstem-ai-driver-label.show { opacity: 1; transform: translateY(0); }
        .brainstem-ai-driver-target {
          outline: 2px solid #58a6ff !important; outline-offset: 3px !important;
          transition: outline-color .18s ease;
        }
        @keyframes brainstemAiDriverPulse {
          0% { opacity: .95; transform: translate(-50%,-50%) scale(.4); }
          100% { opacity: 0; transform: translate(-50%,-50%) scale(3.2); }
        }
        @media (prefers-reduced-motion: reduce) {
          #brainstem-ai-driver-cursor { transition-duration: .08s; }
          #brainstem-ai-driver-pulse.go { animation-duration: .12s; }
        }
      `;
      document.head.appendChild(style);
    }

    let cursor = document.getElementById("brainstem-ai-driver-cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "brainstem-ai-driver-cursor";
      cursor.dataset.brainstemAiDriver = "true";
      cursor.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 01.35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.85a.5.5 0 00-.85.36z" fill="#f0f6fc" stroke="#0d1117" stroke-width="1.5"/></svg>';
      document.body.appendChild(cursor);
    }

    let pulse = document.getElementById("brainstem-ai-driver-pulse");
    if (!pulse) {
      pulse = document.createElement("div");
      pulse.id = "brainstem-ai-driver-pulse";
      pulse.dataset.brainstemAiDriver = "true";
      document.body.appendChild(pulse);
    }

    let label = document.getElementById("brainstem-ai-driver-label");
    if (!label) {
      label = document.createElement("div");
      label.id = "brainstem-ai-driver-label";
      label.dataset.brainstemAiDriver = "true";
      document.body.appendChild(label);
    }
    return { cursor, label, pulse };
  }

  function hideLabel(label = ensureUi().label) {
    label.classList.remove("show");
    setTimeout(() => {
      if (!label.classList.contains("show")) label.textContent = "";
    }, 180);
  }

  // Keep the synthetic cursor visible while it moves, then clear the stage.
  const CURSOR_IDLE_HIDE_MS = 4000;
  function wakeCursor(cursor) {
    cursor.style.opacity = "1";
    if (state.cursorIdleTimer) clearTimeout(state.cursorIdleTimer);
    state.cursorIdleTimer = setTimeout(() => {
      cursor.style.opacity = "0";
    }, CURSOR_IDLE_HIDE_MS);
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number.parseFloat(style.opacity || "1") > 0;
  }

  function normalizedText(element) {
    return String(
      element?.innerText
      || element?.getAttribute?.("aria-label")
      || element?.getAttribute?.("title")
      || element?.value
      || "",
    ).replace(/\s+/g, " ").trim();
  }

  function pageTextForWait() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(".msg.user,[data-brainstem-ai-driver]").forEach(
      (element) => element.remove(),
    );
    return String(clone.innerText || clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const { selectorFor } = helpers;

  function findElement(step) {
    if (step.handle) return helpers.resolveHandle(step.handle);
    if (step.selector) {
      return helpers.resolveSelector(step.selector);
    }
    const wanted = String(step.targetText || step.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!wanted) return null;
    const candidates = [
      ...document.querySelectorAll(
        "button,a,input,textarea,select,[role='button'],[role='menuitem'],[tabindex]",
      ),
    ].filter(visible);
    return candidates.find((element) => normalizedText(element).toLowerCase() === wanted)
      || candidates.find((element) => normalizedText(element).toLowerCase().includes(wanted));
  }

  function currentOutline(limit = helpers.caps.inspectDefault) {
    const elements = [
      ...document.querySelectorAll(
        "button,a,input,textarea,select,[role='button'],[role='menuitem'],"
        + "[tabindex],[data-drive][data-drive-outline='true']",
      ),
    ].filter((element) => visible(element) && !element.dataset.brainstemAiDriver);
    return helpers.buildOutline(elements, { frame: frameName, limit });
  }

  function actionabilityReason(element) {
    if (!visible(element)) return "not visible";
    if (
      Boolean(element.disabled)
      || element.getAttribute?.("aria-disabled") === "true"
    ) return "disabled";
    if (getComputedStyle(element).pointerEvents === "none") {
      return "pointer-events is none";
    }
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return null;
    const top = document.elementFromPoint?.(x, y);
    // Occluded means something ELSE is on top. A hit on the element, on one
    // of its descendants, or on one of its own ancestors (a button inside the
    // first-run intro tile, a link inside a panel) is the element itself being
    // reachable — the ancestor rule is what lets the driver dismiss an overlay
    // through the overlay's own button.
    if (
      top
      && top !== element
      && !element.contains(top)
      && !top.contains(element)
    ) {
      return `occluded by ${selectorFor(top) || top.localName || "another element"}`;
    }
    return null;
  }

  function renderChatLease(handedOff = false) {
    let banner = document.getElementById("brainstem-beta-chat-lease");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "brainstem-beta-chat-lease";
      Object.assign(banner.style, {
        position: "fixed",
        zIndex: "2147483645",
        right: "18px",
        bottom: "72px",
        padding: "8px 11px",
        border: "1px solid rgba(88, 166, 255, .55)",
        borderRadius: "999px",
        background: "rgba(13, 17, 23, .94)",
        color: "#79c0ff",
        font: "700 11px/1 ui-sans-serif, system-ui, sans-serif",
        pointerEvents: "none",
      });
      document.body.appendChild(banner);
    }
    if (state.chatLeaseLocked) {
      banner.textContent = `Rappter Surgeon is using this chat (${
        state.chatLeaseTokens.size
      }) · type or press Send to take it back`;
    } else if (handedOff) {
      banner.textContent = "You took this chat back";
    }
    banner.hidden = !(state.chatLeaseLocked || handedOff);
    if (handedOff) {
      clearTimeout(state.chatLeaseBannerTimer);
      state.chatLeaseBannerTimer = setTimeout(() => {
        const element = document.getElementById("brainstem-beta-chat-lease");
        if (element && !state.chatLeaseLocked) element.hidden = true;
      }, 4000);
    }
    const send = document.getElementById("send");
    if (send) {
      send.setAttribute("aria-disabled", "false");
      if (state.chatLeaseLocked) send.dataset.rappChatLease = "advisory";
      else delete send.dataset.rappChatLease;
    }
  }

  function handOffComposer(reason) {
    state.composerHandoffs = (state.composerHandoffs || 0) + 1;
    state.composerHandoffAt = Date.now();
    state.composerHandoffReason = String(reason || "input");
    state.chatLeaseTokens?.clear();
    state.chatLeaseLocked = false;
    state.driverComposerValue = null;
    renderChatLease(true);
  }

  function ensureComposerWatch() {
    if (state.chatLeaseGuardInstalled) return;
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    if (!input || !send) return;
    const witness = (reason) => (event) => {
      if (!event.isTrusted) return;
      handOffComposer(reason);
    };
    send.addEventListener("click", witness("send"), true);
    document.getElementById("starter-prompts")?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (!event.target?.closest?.(".starter-btn")) return;
      handOffComposer("starter");
    }, true);
    input.addEventListener("keydown", (event) => {
      if (!event.isTrusted) return;
      if (event.key !== "Enter" || event.shiftKey) return;
      handOffComposer("enter");
    }, true);
    input.addEventListener("beforeinput", witness("typing"), true);
    state.chatLeaseGuardInstalled = true;
  }

  function requireActionable(element) {
    const reason = actionabilityReason(element);
    if (!reason) return;
    // "not visible" on a CI runner is only diagnosable with the numbers: the
    // element's box, its computed visibility, and the frame's own viewport.
    let detail = "";
    if (reason === "not visible") {
      try {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        detail = ` [rect ${Math.round(rect.width)}x${Math.round(rect.height)} @${Math.round(rect.left)},${Math.round(rect.top)}; display=${style.display} visibility=${style.visibility} opacity=${style.opacity}; viewport ${innerWidth}x${innerHeight}; document ${document.visibilityState}; readyState ${document.readyState}]`;
      } catch {
        detail = "";
      }
    }
    const error = new Error(
      `UI target ${selectorFor(element) || "(unknown)"} is not actionable: ${reason}.${detail}`,
    );
    error.name = "UiDriverActionabilityError";
    error.reason = reason;
    throw error;
  }

  function effectBetween(before, after, routeBefore, routeAfter, extra = {}) {
    return {
      ...helpers.diffOutlines(before.rows, after.rows, 5),
      focus: selectorFor(document.activeElement),
      route: routeBefore === routeAfter
        ? null
        : { from: routeBefore, to: routeAfter },
      ...extra,
    };
  }

  function stepSummary(step, result) {
    const action = String(step.action || "action").toLowerCase();
    const verbs = {
      announce: "announced",
      autopilot: "ran",
      chat: "sent",
      click: "clicked",
      expect: "checked",
      inspect: "inspected",
      press: "pressed",
      read: "read",
      surgeon_chat: "sent",
      type: "typed",
      wait: "waited for",
    };
    const h = result?.h
      || result?.effect?.focus
      || step.handle
      || step.selector
      || (action === "inspect" ? `@${frameName}` : "@page");
    const effect = result?.effect || {};
    const change = effect.added?.[0]
      ? `added ${effect.added[0]}`
      : effect.changed?.[0]
        ? `changed ${effect.changed[0]}`
        : effect.removed?.[0]
          ? `removed ${effect.removed[0]}`
          : effect.route
            ? `route ${effect.route.to}`
            : "";
    return `▶ ${verbs[action] || action} ${h}${change ? ` → ${change}` : ""} ${
      result?.ok === false ? "✗" : "✓"
    }`.replace(/\s+/g, " ").trim().slice(0, 220);
  }

  function publishStep(step, result) {
    const summary = stepSummary(step, result);
    state.lastStep = summary;
    window.__rappBetaRenderDriveStep?.(summary);
    if (
      ["click", "press", "type"].includes(String(step.action || "").toLowerCase())
      && result
      && typeof result === "object"
      && !Array.isArray(result)
    ) {
      result.summary = summary;
    }
    return summary;
  }

  function conditionResult(condition, beforeSnapshot = null) {
    if (condition?.snapshot_changed === true || condition?.snapshotChanged === true) {
      const actual = currentOutline().snapshot;
      return {
        actual,
        h: "@page",
        matched: Boolean(beforeSnapshot && actual !== beforeSnapshot),
      };
    }
    let element;
    try {
      element = findElement(condition || {});
    } catch (error) {
      if (error.name === "UiDriverHandleNotFoundError") {
        return { actual: "missing", h: condition?.handle || null, matched: false };
      }
      throw error;
    }
    if (!element || !visible(element)) {
      return { actual: "missing", h: condition?.handle || null, matched: false };
    }
    const h = selectorFor(element);
    if (condition.state !== undefined) {
      const actual = helpers.stateFor(element);
      return {
        actual,
        h,
        matched: actual === String(condition.state),
      };
    }
    const actual = helpers.capText(normalizedText(element), helpers.caps.readMax);
    return {
      actual,
      h,
      matched: actual.includes(String(condition.text || "")),
    };
  }

  async function waitUntil(condition, beforeSnapshot) {
    if (!condition) return null;
    const timeoutMs = bounded(condition.timeoutMs, 100, 120000, 10000);
    const deadline = Date.now() + timeoutMs;
    let result = conditionResult(condition, beforeSnapshot);
    while (!result.matched && Date.now() < deadline) {
      await sleep(100);
      result = conditionResult(condition, beforeSnapshot);
    }
    if (!result.matched) {
      const error = new Error(
        `Timed out waiting for UI post-condition on ${result.h || "@page"}; `
        + `actual was ${JSON.stringify(result.actual)}.`,
      );
      error.name = "UiDriverUntilTimeoutError";
      throw error;
    }
    return result;
  }

  function labelText(step, fallback) {
    return String(step.label || fallback || "").trim();
  }

  async function announce(text, durationMs = 900) {
    const { label } = ensureUi();
    label.textContent = text;
    label.style.left = "50%";
    label.style.top = "18px";
    label.style.transform = "translate(-50%, 4px)";
    label.classList.add("show");
    await sleep(bounded(durationMs, 120, limits.announceDurationMs, 900));
    hideLabel(label);
  }

  async function pointAt(element, text) {
    const { cursor, label } = ensureUi();
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(220);
    requireActionable(element);
    const rect = element.getBoundingClientRect();
    const x = Math.max(8, Math.min(innerWidth - 12, rect.left + rect.width / 2));
    const y = Math.max(8, Math.min(innerHeight - 12, rect.top + rect.height / 2));
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    wakeCursor(cursor);
    if (text) {
      label.textContent = text;
      label.style.left = `${Math.min(innerWidth - 370, x + 22)}px`;
      label.style.top = `${Math.min(innerHeight - 54, y + 24)}px`;
      label.style.transform = "none";
      label.classList.add("show");
    }
    element.classList.add("brainstem-ai-driver-target");
    await sleep(650);
    return { x, y };
  }

  async function clickElement(element, step) {
    requireActionable(element);
    const h = selectorFor(element);
    const before = currentOutline();
    const routeBefore = location.href;
    const description = labelText(
      step,
      `Clicking ${normalizedText(element) || h}`,
    );
    const { x, y } = await pointAt(element, description);
    const { label, pulse } = ensureUi();
    pulse.style.left = `${x}px`;
    pulse.style.top = `${y}px`;
    pulse.classList.remove("go");
    void pulse.offsetWidth;
    pulse.classList.add("go");
    element.focus({ preventScroll: true });
    const beforeClickResult = step.beforeClick?.();
    if (beforeClickResult) {
      element.classList.remove("brainstem-ai-driver-target");
      hideLabel(label);
      return beforeClickResult;
    }
    element.click();
    await sleep(bounded(step.settleMs, 260, limits.settleMs, 520));
    await waitUntil(step.until, before.snapshot);
    const after = currentOutline();
    const routeAfter = location.href;
    element.classList.remove("brainstem-ai-driver-target");
    hideLabel(label);
    return {
      ok: true,
      h,
      clicked: h,
      text: normalizedText(element),
      effect: effectBetween(before, after, routeBefore, routeAfter),
    };
  }

  async function swipeElement(element, step) {
    requireActionable(element);
    const h = selectorFor(element);
    const before = currentOutline();
    const routeBefore = location.href;
    const direction = String(step.direction || "right").toLowerCase();
    if (!["left", "right"].includes(direction)) {
      throw new Error("Swipe direction must be left or right.");
    }
    const distance = Math.max(80, Math.min(400, Number(step.distance) || 110));
    const description = labelText(step, `Swiping ${direction} on ${h}`);
    const { x, y } = await pointAt(element, description);
    const pointerId = 71;
    const endX = x + (direction === "right" ? distance : -distance);
    const dispatch = (type, clientX, buttons) => element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        buttons,
        cancelable: true,
        clientX,
        clientY: y,
        isPrimary: true,
        pointerId,
        pointerType: "touch",
      }),
    );
    element.focus?.({ preventScroll: true });
    dispatch("pointerdown", x, 1);
    for (let stepIndex = 1; stepIndex <= 4; stepIndex += 1) {
      dispatch("pointermove", x + ((endX - x) * stepIndex / 4), 1);
      await sleep(24);
    }
    dispatch("pointerup", endX, 0);
    await sleep(Math.max(260, Number(step.settleMs) || 520));
    await waitUntil(step.until, before.snapshot);
    const after = currentOutline();
    const routeAfter = location.href;
    element.classList?.remove("brainstem-ai-driver-target");
    hideLabel();
    return {
      ok: true,
      h,
      direction,
      distance,
      swiped: h,
      effect: effectBetween(before, after, routeBefore, routeAfter),
    };
  }

  function setControlValue(element, value) {
    if (element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText",
      }));
      return;
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    const setter = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")?.set
      : null;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeInto(element, step) {
    if (
      !(
        element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element.isContentEditable
      )
    ) {
      throw new Error("The requested UI target does not accept text.");
    }
    requireActionable(element);
    const h = selectorFor(element);
    const before = currentOutline();
    const routeBefore = location.href;
    const value = String(step.value ?? "");
    const description = labelText(step, "Typing in the Brainstem");
    const shouldAbort = () => step.abortWhen?.() === true;
    const abortedResult = () => {
      element.classList.remove("brainstem-ai-driver-target");
      hideLabel();
      return { aborted: true, h, selector: h };
    };
    await pointAt(element, description);
    element.focus({ preventScroll: true });
    if (shouldAbort()) return abortedResult();
    const startingValue = step.replace === false
      ? String(element.value || element.textContent || "")
      : "";
    setControlValue(element, startingValue);
    if (shouldAbort()) return abortedResult();
    const requestedDelayMs = bounded(
      step.typingDelayMs,
      0,
      limits.typingDelayMs,
      18,
    );
    const delayMs = value.length
      ? Math.min(
          requestedDelayMs,
          Math.floor(limits.typingDurationMs / value.length),
        )
      : requestedDelayMs;
    let nextValue = startingValue;
    if (!delayMs) {
      nextValue += value;
      setControlValue(element, nextValue);
      if (shouldAbort()) return abortedResult();
    } else {
      for (const character of value) {
        if (shouldAbort()) return abortedResult();
        nextValue += character;
        setControlValue(element, nextValue);
        if (shouldAbort()) return abortedResult();
        await sleep(delayMs);
      }
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(bounded(step.settleMs, 160, limits.settleMs, 300));
    await waitUntil(step.until, before.snapshot);
    const after = currentOutline();
    const routeAfter = location.href;
    element.classList.remove("brainstem-ai-driver-target");
    hideLabel();
    return {
      ok: true,
      h,
      typed: value.length,
      selector: h,
      effect: effectBetween(before, after, routeBefore, routeAfter),
    };
  }

  async function waitFor(step) {
    const timeoutMs = bounded(step.timeoutMs, 100, 120000, 10000);
    const deadline = Date.now() + timeoutMs;
    const wantedText = String(step.text || "").replace(/\s+/g, " ").trim();
    while (Date.now() < deadline) {
      let element = null;
      if (step.handle || step.selector) {
        try {
          const candidate = findElement(step);
          if (
            visible(candidate)
            && (!wantedText || normalizedText(candidate).includes(wantedText))
          ) {
            element = candidate;
          }
        } catch (error) {
          if (error.name !== "UiDriverHandleNotFoundError") throw error;
        }
      }
      const textFound = !wantedText || (
        step.handle || step.selector
          ? Boolean(element)
          : pageTextForWait().includes(wantedText)
      );
      if ((!step.handle && !step.selector || element) && textFound) {
        return {
          matched: true,
          h: element ? selectorFor(element) : "@page",
        };
      }
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for ${
        step.handle || step.selector || JSON.stringify(wantedText) || "the page"
      }.`,
    );
  }

  async function pressKey(element, step) {
    requireActionable(element);
    const h = selectorFor(element);
    const before = currentOutline();
    const routeBefore = location.href;
    if (step.handle || step.selector) {
      await pointAt(element, labelText(step, `Pressing ${step.key}`));
    }
    element.focus?.({ preventScroll: true });
    const init = {
      bubbles: true,
      cancelable: true,
      key: String(step.key || "Enter"),
      code: String(step.code || ""),
      altKey: Boolean(step.altKey),
      ctrlKey: Boolean(step.ctrlKey),
      metaKey: Boolean(step.metaKey),
      shiftKey: Boolean(step.shiftKey),
    };
    const defaultAllowed = element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keypress", init));
    let submittedVia = null;
    if (init.key === "Enter" && !defaultAllowed && !init.shiftKey) {
      const handledButton = element.id === "input"
        ? document.getElementById("send")
        : element.id === "surgeon-input"
          ? document.getElementById("surgeon-send")
          : null;
      submittedVia = handledButton ? selectorFor(handledButton) : "keydown-handler";
    } else if (init.key === "Enter" && defaultAllowed && !init.shiftKey) {
      const form = element.form || element.closest?.("form");
      if (form?.requestSubmit) {
        form.requestSubmit();
        submittedVia = selectorFor(form);
      } else {
        const button = (
          element.id === "input"
            ? document.getElementById("send")
            : element.id === "surgeon-input"
              ? document.getElementById("surgeon-send")
              : element.closest?.("form,[data-drive]")?.querySelector?.(
                  "button[type='submit'],input[type='submit']",
                )
        );
        if (button && !actionabilityReason(button)) {
          button.click();
          submittedVia = selectorFor(button);
        } else if (element.matches?.("button,[role='button']")) {
          element.click();
          submittedVia = h;
        }
      }
    }
    element.dispatchEvent(new KeyboardEvent("keyup", init));
    await sleep(bounded(step.settleMs, 120, limits.settleMs, 280));
    await waitUntil(step.until, before.snapshot);
    const after = currentOutline();
    const routeAfter = location.href;
    element.classList?.remove("brainstem-ai-driver-target");
    hideLabel();
    return {
      ok: true,
      h,
      pressed: init.key,
      selector: h,
      effect: effectBetween(
        before,
        after,
        routeBefore,
        routeAfter,
        submittedVia ? { submit: submittedVia } : {},
      ),
    };
  }

  async function perform(step) {
    const action = String(step.action || "").toLowerCase();
    if (action === "set_chat_lease") {
      const input = document.getElementById("input");
      const send = document.getElementById("send");
      if (!input || !send) {
        throw new Error("The visible Brainstem chat composer is unavailable.");
      }
      ensureComposerWatch();
      state.chatLeaseTokens ||= new Set();
      const leaseToken = String(step.token || "legacy");
      if (step.locked) state.chatLeaseTokens.add(leaseToken);
      else state.chatLeaseTokens.delete(leaseToken);
      state.chatLeaseLocked = state.chatLeaseTokens.size > 0;
      renderChatLease(false);
      return {
        leaseCount: state.chatLeaseTokens.size,
        locked: state.chatLeaseLocked,
      };
    }
    if (action === "surgeon_chat") {
      const panel = document.getElementById("surgeon");
      const tab = document.getElementById("surgeon-tab");
      if (!panel) throw new Error("The Rappter Surgeon panel is unavailable.");
      if (!visible(panel)) {
        if (visible(tab)) {
          await clickElement(tab, {
            action: "click",
            label: "Opening GitHub Copilot Agent mode",
            settleMs: 350,
          });
        } else {
          panel.classList.add("open");
          document.body.classList.add("surgeon-open");
          await sleep(350);
        }
      }
      const input = document.getElementById("surgeon-input");
      const send = document.getElementById("surgeon-send");
      if (!visible(input) || !visible(send)) {
        throw new Error("The visible Rappter Surgeon composer is unavailable.");
      }
      const baseline = document.querySelectorAll(
        "#surgeon-log .surgeon-message.assistant",
      ).length;
      const errorBaseline = document.querySelectorAll(
        "#surgeon-log .surgeon-message.error",
      ).length;
      await typeInto(input, {
        action: "type",
        value: String(step.value || step.text || ""),
        label: step.label || "Directing the Rappter Surgeon",
        typingDelayMs: step.typingDelayMs ?? 5,
      });
      await clickElement(send, {
        action: "click",
        label: step.sendLabel || "Sending to GitHub Copilot",
        settleMs: 200,
      });

      const timeoutMs = bounded(
        step.timeoutMs,
        1000,
        60 * 60 * 1000,
        60 * 60 * 1000,
      );
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = document.querySelectorAll(
          "#surgeon-log .surgeon-message.assistant",
        );
        const errors = document.querySelectorAll(
          "#surgeon-log .surgeon-message.error",
        );
        const error = errors.length > errorBaseline
          ? errors[errors.length - 1]
          : null;
        if (error && !send.disabled) {
          throw new Error(normalizedText(error));
        }
        if (replies.length > baseline && !send.disabled) {
          return {
            response: normalizedText(replies[replies.length - 1]),
          };
        }
        await sleep(150);
      }
      throw new Error("Timed out waiting for the visible Rappter Surgeon reply.");
    }
    if (action === "chat") {
      const input = document.getElementById("input");
      const send = document.getElementById("send");
      if (!visible(input) || !visible(send)) {
        throw new Error("The visible Brainstem chat composer is unavailable.");
      }
      ensureComposerWatch();
      const handoffBaseline = state.composerHandoffs || 0;
      const yielded = (reason) => ({ yielded_to_user: true, reason });
      const existingText = String(input.value || "").trim();
      if (
        existingText
        && existingText !== String(state.driverComposerValue || "").trim()
      ) return yielded("person_has_text_in_composer");
      if ((state.composerHandoffs || 0) > handoffBaseline) {
        return yielded("person_took_composer");
      }
      let requestId = null;
      const typingResult = await typeInto(input, {
        action: "type",
        abortWhen: () => (state.composerHandoffs || 0) > handoffBaseline,
        value: String(step.value || step.text || ""),
        label: step.label || "Giving the Brainstem the job",
        typingDelayMs: step.typingDelayMs ?? 5,
      });
      if (typingResult?.aborted) {
        state.driverComposerValue = null;
        return yielded("person_took_composer");
      }
      state.driverComposerValue = String(step.value || step.text || "");
      if ((state.composerHandoffs || 0) > handoffBaseline) {
        return yielded("person_took_composer");
      }
      const sendBaselineRequestId = Math.max(
        0,
        ...[...document.querySelectorAll("#chat .response-slot")]
          .map((slot) => Number(slot.dataset.requestId) || 0),
      );
      const mine = String(step.value || step.text || "").replace(/\s+/g, " ").trim();
      const pickRequestId = () => {
        const fresh = [...document.querySelectorAll("#chat .response-slot")]
          .filter((slot) => (
            (Number(slot.dataset.requestId) || 0) > sendBaselineRequestId
          ));
        if (!fresh.length) return null;
        const owned = fresh.find(
          (slot) => normalizedText(slot.previousElementSibling) === mine,
        );
        const chosen = owned
          || fresh.reduce((low, slot) => (
            (Number(slot.dataset.requestId) || 0)
              < (Number(low.dataset.requestId) || 0)
              ? slot
              : low
          ));
        return Number(chosen.dataset.requestId) || null;
      };
      let resolveRequestId;
      const requestCreated = new Promise((resolve) => {
        resolveRequestId = resolve;
      });
      const observer = new MutationObserver(() => {
        const created = pickRequestId();
        if (Number.isFinite(created)) {
          observer.disconnect();
          resolveRequestId(created);
        }
      });
      observer.observe(document.getElementById("chat"), {
        childList: true,
        subtree: true,
      });
      const yieldBeforeSend = () => {
        if ((state.composerHandoffs || 0) <= handoffBaseline) return null;
        observer.disconnect();
        if (String(input.value || "") === String(state.driverComposerValue || "")) {
          setControlValue(input, "");
        }
        state.driverComposerValue = null;
        return yielded("person_took_composer");
      };
      const preSendYield = yieldBeforeSend();
      if (preSendYield) {
        return preSendYield;
      }
      const clickResult = await clickElement(send, {
        action: "click",
        beforeClick: yieldBeforeSend,
        label: step.sendLabel || "Sending through Brainstem chat",
        settleMs: 200,
      });
      if (clickResult?.yielded_to_user === true) return clickResult;
      requestId = await Promise.race([
        requestCreated,
        sleep(2000).then(() => null),
      ]);
      observer.disconnect();
      if (!Number.isFinite(requestId)) {
        throw new Error("The visible Brainstem request ID was not created.");
      }
      const ownSlot = document.querySelector(
        `#chat .response-slot[data-request-id="${requestId}"]`,
      );
      const ownBubble = ownSlot?.previousElementSibling;
      if (ownBubble?.dataset) {
        ownBubble.dataset.rappActor = "ai";
        ownBubble.title = "Sent by the Rappter Surgeon";
      }
      state.driverComposerValue = null;

      const timeoutMs = bounded(
        step.timeoutMs,
        1000,
        60 * 60 * 1000,
        180000,
      );
      const deadline = Date.now() + timeoutMs;
      let missedSlotPolls = 0;
      while (Date.now() < deadline) {
        const slot = document.querySelector(
          `#chat .response-slot[data-request-id="${requestId}"]`,
        );
        if (!slot) {
          missedSlotPolls += 1;
          if (missedSlotPolls >= 2) {
            throw new Error(
              "The visible Brainstem chat was cleared or reset before the reply "
                + "arrived; the delegated request was cancelled.",
            );
          }
          await sleep(150);
          continue;
        }
        missedSlotPolls = 0;
        const reply = slot?.querySelector(
          ".msg.assistant:not(.typing-indicator):not(.stream-arriving)",
        );
        const system = slot?.querySelector(".msg.system");
        if (system) {
          throw new Error(
            normalizedText(system.querySelector(".bubble"))
            || "The visible Brainstem request failed.",
          );
        }
        if (reply) {
          const response = normalizedText(reply.querySelector(".bubble"));
          if (response) {
            return {
              requestId,
              response,
              agentLogs: normalizedText(reply.querySelector(".agent-logs")),
            };
          }
        }
        await sleep(150);
      }
      throw new Error("Timed out waiting for the visible Brainstem reply.");
    }
    if (action === "recording_status") {
      const recording = window.__brainstemBetaRecording;
      if (!recording) return { active: false };
      const track = recording.stream.getVideoTracks()[0] || null;
      return {
        active: recording.recorder.state !== "inactive",
        bytes: recording.chunks.reduce(
          (total, chunk) => total + Number(chunk.size || 0),
          0,
        ),
        chunks: recording.chunks.length,
        dataEvents: recording.dataEvents,
        error: recording.lastError,
        recorderState: recording.recorder.state,
        track: track
          ? {
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
              settings: track.getSettings(),
            }
          : null,
      };
    }
    if (action === "expect") {
      const result = conditionResult(step);
      return {
        ok: result.matched,
        h: result.h,
        actual: result.actual,
      };
    }
    if (action === "inspect") {
      const outline = currentOutline(step.limit);
      state.outlineSnapshots ||= new Map();
      const previous = step.since
        ? state.outlineSnapshots.get(String(step.since))
        : null;
      if (step.since && !previous) {
        const error = new Error(`Unknown UI outline snapshot: ${step.since}`);
        error.name = "UiDriverSnapshotNotFoundError";
        throw error;
      }
      state.outlineSnapshots.set(outline.snapshot, outline.rows);
      while (state.outlineSnapshots.size > 20) {
        state.outlineSnapshots.delete(state.outlineSnapshots.keys().next().value);
      }
      return previous
        ? { ...outline, rows: helpers.diffRows(previous, outline.rows) }
        : outline;
    }
    if (action === "read") {
      const element = step.handle || step.selector ? findElement(step) : document.body;
      if (!element) {
        if (step.optional) return { skipped: true, reason: "target not found" };
        throw new Error(`UI target not found: ${step.handle || step.selector || step.targetText}`);
      }
      const limit = helpers.capNumber(
        step.limit,
        1,
        helpers.caps.readMax,
        helpers.caps.readMax,
      );
      return {
        h: selectorFor(element),
        selector: selectorFor(element),
        text: helpers.capText(normalizedText(element), limit, {
          tail: Boolean(step.tail),
        }),
      };
    }
    if (action === "autopilot") {
      if (typeof window.rapp !== "function") {
        throw new Error("RAPP Autopilot is not installed in this driven frame.");
      }
      return window.rapp(String(step.script || ""));
    }
    if (action === "wait") return waitFor(step);
    if (action === "tour" || action === "force_mode") {
      throw new Error(`Use ${action} as a top-level UI driver command, not inside run.`);
    }
    if (action === "announce") {
      await announce(String(step.text || step.label || "AI is operating the Brainstem"), step.durationMs);
      return { announced: String(step.text || step.label || "") };
    }
    if (action === "press") {
      const element = findElement(step) || document.activeElement || document.body;
      if ((step.handle || step.selector) && !element) {
        if (step.optional) return { skipped: true, reason: "target not found" };
        throw new Error(`UI target not found: ${step.handle || step.selector}`);
      }
      return pressKey(element, step);
    }

    const element = findElement(step);
    const reason = element ? actionabilityReason(element) : "target not found";
    if (!element || reason) {
      if (step.optional) return { skipped: true, reason };
      if (element) requireActionable(element);
      throw new Error(
        `Visible UI target not found: ${step.handle || step.selector || step.targetText || step.text || "(unspecified)"}`,
      );
    }
    if (action === "click") return clickElement(element, step);
    if (action === "swipe") return swipeElement(element, step);
    if (action === "type") return typeInto(element, step);
    throw new Error(`Unsupported UI driver action: ${action || "(empty)"}`);
  }

  async function performWithTrace(step) {
    const before = currentOutline();
    const result = await perform(step);
    const after = currentOutline();
    if (result && typeof result === "object" && !Array.isArray(result)) {
      result.__trace = {
        snapshot_after: after.snapshot,
        snapshot_before: before.snapshot,
      };
    }
    return result;
  }

  if (String(command.action || "").toLowerCase() === "run") {
    if (!Array.isArray(command.steps) || command.steps.length === 0) {
      throw new Error("A UI driver run requires at least one step.");
    }
    const results = [];
    const summaries = [];
    const runHandoffBaseline = state.composerHandoffs || 0;
    let yieldedToUser = false;
    for (const step of command.steps) {
      const result = await performWithTrace(step);
      summaries.push(publishStep(step, result));
      results.push(result);
      if ((state.composerHandoffs || 0) > runHandoffBaseline) {
        yieldedToUser = true;
        break;
      }
    }
    state.lastRun = Date.now();
    return {
      results,
      summaries,
      ...(yieldedToUser ? { yielded_to_user: true } : {}),
    };
  }
  const result = await performWithTrace(command);
  publishStep(command, result);
  state.lastRun = Date.now();
  return result;
}

async function startWindowRecording(browserWindow, command, uploadUrl) {
  const sourceId = browserWindow.getMediaSourceId();
  const maxDurationMs = Math.max(
    1000,
    Math.min(10 * 60 * 1000, Number(command.maxDurationMs) || 5 * 60 * 1000),
  );
  recordingPermissionWebContents = browserWindow.webContents;
  try {
    const source = `(${async function startRecording(options) {
      if (
        window.__brainstemBetaRecording
        && window.__brainstemBetaRecording.recorder.state !== "inactive"
      ) {
        throw new Error("The OpenRappter window is already recording.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: options.sourceId,
            maxFrameRate: 30,
            maxHeight: 1240,
            maxWidth: 1920,
          },
        },
      });
      const mimeTypes = [
        "video/webm;codecs=vp8",
        "video/webm;codecs=vp9",
        "video/webm",
      ];
      const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type))
        || "";
      const preview = document.createElement("video");
      preview.muted = true;
      preview.playsInline = true;
      preview.srcObject = stream;
      Object.assign(preview.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        width: "2px",
        height: "2px",
        opacity: ".001",
        pointerEvents: "none",
      });
      document.body.appendChild(preview);
      await preview.play();
      const chunks = [];
      let dataEvents = 0;
      let lastError = null;
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, videoBitsPerSecond: 2_000_000 } : undefined,
      );
      const stopped = new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
      });
      recorder.addEventListener("dataavailable", (event) => {
        dataEvents += 1;
        if (event.data?.size) chunks.push(event.data);
      });
      recorder.addEventListener("error", (event) => {
        lastError = String(event.error?.message || event.error || "MediaRecorder error");
      });
      recorder.start(500);

      let indicator = document.getElementById("brainstem-beta-recording-indicator");
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.id = "brainstem-beta-recording-indicator";
        indicator.textContent = "REC  AUTOPILOT";
        Object.assign(indicator.style, {
          position: "fixed",
          zIndex: "2147483647",
          top: "14px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "7px 11px",
          border: "1px solid #ff7b72",
          borderRadius: "999px",
          background: "rgba(40, 8, 12, .94)",
          color: "#ff7b72",
          font: "700 11px/1 ui-sans-serif, system-ui, sans-serif",
          letterSpacing: ".08em",
          pointerEvents: "none",
          boxShadow: "0 6px 24px rgba(0,0,0,.4)",
        });
        document.body.appendChild(indicator);
      }
      indicator.hidden = false;

      const state = {
        autoStop: null,
        chunks,
        get dataEvents() { return dataEvents; },
        finalize: null,
        finalizePromise: null,
        indicator,
        mimeType: recorder.mimeType || mimeType || "video/webm",
        preview,
        recorder,
        get lastError() { return lastError; },
        startedAt: Date.now(),
        stopped,
        stream,
        uploadUrl: options.uploadUrl,
      };
      state.finalize = () => {
        if (state.finalizePromise) return state.finalizePromise;
        state.finalizePromise = (async () => {
          try {
            clearTimeout(state.autoStop);
            if (state.recorder.state !== "inactive") {
              state.recorder.stop();
            }
            await state.stopped;
            await new Promise((resolve) => setTimeout(resolve, 500));
            const durationMs = Date.now() - state.startedAt;
            const blob = new Blob(state.chunks, { type: state.mimeType });
            if (!blob.size) {
              throw new Error(
                `The recorded window produced an empty WebM blob from ${
                  state.chunks.length
                } chunks.`,
              );
            }
            const bytes = await blob.arrayBuffer();
            const response = await fetch(state.uploadUrl, {
              method: "POST",
              headers: {
                "Content-Type": state.mimeType,
                "X-Recording-Duration": String(durationMs),
                "X-Recording-Size": String(blob.size),
              },
              body: bytes,
            });
            const result = await response.json();
            if (!response.ok || !result?.ok) {
              throw new Error(result?.error || `Recording upload HTTP ${response.status}`);
            }
            const recording = result.recording;
            window.__brainstemBetaLastRecording = recording;
            return recording;
          } finally {
            for (const track of state.stream.getTracks()) track.stop();
            state.preview.pause();
            state.preview.srcObject = null;
            state.preview.remove();
            state.indicator.hidden = true;
            if (window.__brainstemBetaRecording === state) {
              delete window.__brainstemBetaRecording;
            }
          }
        })();
        return state.finalizePromise;
      };
      state.autoStop = setTimeout(() => {
        void state.finalize().catch(() => {
          for (const track of state.stream.getTracks()) track.stop();
          state.preview.pause();
          state.preview.srcObject = null;
          state.preview.remove();
          state.indicator.hidden = true;
        });
      }, options.maxDurationMs);
      window.__brainstemBetaRecording = state;
      return {
        maxDurationMs: options.maxDurationMs,
        mimeType: state.mimeType,
        startedAt: state.startedAt,
        track: stream.getVideoTracks()[0]?.getSettings() || null,
      };
    }.toString()})(${JSON.stringify({ sourceId, maxDurationMs, uploadUrl })})`;
    return await browserWindow.webContents.mainFrame.executeJavaScript(source, true);
  } finally {
    recordingPermissionWebContents = null;
  }
}

function walkthroughRecapChapters(mode = "baseline") {
  if (mode === "stack-churn") {
    return [
      "1 · Identity — start from one default stack",
      "2 · Compose — create a child leaf and ordered overlay",
      "3 · Prove — persistent StackChurnProof returned STACK_CHURN_READY",
      "4 · Retire — remove the role and superseded workers",
      "5 · Restore — delete temporary stacks and return to baseline",
      "6 · Promote — carry only the proven capability downstream",
    ];
  }
  if (mode === "repeat-ephemeral") {
    return [
      "1 · Identity — one caller RAPPID and one private memory anchor",
      "2 · First turn — inject, execute, and clean one temporary tool",
      "3 · Second turn — repeat the same source on the same live worker",
      "4 · Evidence — both exact request results remain in one transcript",
      "5 · Cleanup — zero leases, files, bytecode, or cache growth",
      "6 · Promotion — reusable skills stay; temporary tools disappear",
    ];
  }
  if (mode === "control-handoff") {
    return [
      "1 · Direct control — a person sends the first visible Brainstem turn",
      "2 · Repeat — a second direct turn stays in the same transcript",
      "3 · Handoff — Rappter Surgeon takes control without replacing the iframe",
      "4 · Proof — all three request IDs and markers remain ordered",
      "5 · Cleanup — the delegated temporary tool disappears and the lease clears",
      "6 · Outcome — one chat surface, whichever intelligence is driving it",
    ];
  }
  return [
    "1 · Identity — one caller RAPPID and one private memory anchor",
    "2 · Composition — global + inherited + leaf + ordered overlays",
    "3 · Hotload — a single-file agent became a real tool for one turn",
    "4 · Evidence — the center Brainstem returned a testable result",
    "5 · Cleanup — the ephemeral worker disappeared automatically",
    "6 · Promotion — OpenRappter Brainstem → Hippocampus → Microsoft stack",
  ];
}

async function stopWindowRecording(browserWindow, command = {}) {
  const minimumDurationMs = Math.max(
    0,
    Math.min(5 * 60 * 1000, Number(command.minimumDurationMs) || 0),
  );
  const source = `(${async function stopRecording(options) {
    const state = window.__brainstemBetaRecording;
    if (state) {
      const remaining = Math.max(
        0,
        options.minimumDurationMs - (Date.now() - state.startedAt),
      );
      if (remaining) {
        let recap = document.getElementById("brainstem-beta-walkthrough-recap");
        if (!recap) {
          recap = document.createElement("div");
          recap.id = "brainstem-beta-walkthrough-recap";
          Object.assign(recap.style, {
            position: "fixed",
            zIndex: "2147483646",
            left: "50%",
            bottom: "54px",
            width: "min(760px, calc(100vw - 48px))",
            transform: "translateX(-50%)",
            padding: "18px 22px",
            border: "1px solid rgba(88, 166, 255, .55)",
            borderRadius: "16px",
            background: "rgba(13, 17, 23, .94)",
            color: "#f0f6fc",
            font: "700 18px/1.35 ui-sans-serif, system-ui, sans-serif",
            textAlign: "center",
            boxShadow: "0 18px 70px rgba(0,0,0,.58)",
            pointerEvents: "none",
          });
          document.body.appendChild(recap);
        }
        const chapters = options.chapters;
        const started = Date.now();
        const intervalMs = Math.max(
          5000,
          Math.min(12000, Math.floor(remaining / chapters.length) || 5000),
        );
        let index = 0;
        while (Date.now() - started < remaining) {
          recap.textContent = chapters[index % chapters.length];
          index += 1;
          await new Promise((resolve) => setTimeout(
            resolve,
            Math.min(intervalMs, remaining - (Date.now() - started)),
          ));
        }
        recap.remove();
      }
      return state.finalize();
    }
    const last = window.__brainstemBetaLastRecording;
    if (last) {
      delete window.__brainstemBetaLastRecording;
      return last;
    }
    throw new Error("The OpenRappter window is not recording.");
  }.toString()})(${JSON.stringify({
    chapters: walkthroughRecapChapters(command.recapMode),
    minimumDurationMs,
  })})`;
  return browserWindow.webContents.mainFrame.executeJavaScript(source, true);
}

async function setCapturedRecordingIndicator(browserWindow, visible) {
  const source = `(${function setIndicator(show) {
    let indicator = document.getElementById("brainstem-beta-recording-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "brainstem-beta-recording-indicator";
      indicator.textContent = "REC  AUTOPILOT";
      Object.assign(indicator.style, {
        position: "fixed",
        zIndex: "2147483647",
        top: "14px",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "7px 11px",
        border: "1px solid #ff7b72",
        borderRadius: "999px",
        background: "rgba(40, 8, 12, .94)",
        color: "#ff7b72",
        font: "700 11px/1 ui-sans-serif, system-ui, sans-serif",
        letterSpacing: ".08em",
        pointerEvents: "none",
        boxShadow: "0 6px 24px rgba(0,0,0,.4)",
      });
      document.body.appendChild(indicator);
    }
    indicator.hidden = !show;
    return true;
  }.toString()})(${JSON.stringify(Boolean(visible))})`;
  await browserWindow.webContents.mainFrame.executeJavaScript(source, true);
}

async function showCapturedRecordingRecap(
  browserWindow,
  durationMs,
  recapMode = "baseline",
) {
  if (durationMs <= 0) return;
  const source = `(${async function showRecap(options) {
    let recap = document.getElementById("brainstem-beta-walkthrough-recap");
    if (!recap) {
      recap = document.createElement("div");
      recap.id = "brainstem-beta-walkthrough-recap";
      Object.assign(recap.style, {
        position: "fixed",
        zIndex: "2147483646",
        left: "50%",
        bottom: "54px",
        width: "min(760px, calc(100vw - 48px))",
        transform: "translateX(-50%)",
        padding: "18px 22px",
        border: "1px solid rgba(88, 166, 255, .55)",
        borderRadius: "16px",
        background: "rgba(13, 17, 23, .94)",
        color: "#f0f6fc",
        font: "700 18px/1.35 ui-sans-serif, system-ui, sans-serif",
        textAlign: "center",
        boxShadow: "0 18px 70px rgba(0,0,0,.58)",
        pointerEvents: "none",
      });
      document.body.appendChild(recap);
    }
    const chapters = options.chapters;
    const started = Date.now();
    const intervalMs = Math.max(
      5000,
      Math.min(12000, Math.floor(options.durationMs / chapters.length) || 5000),
    );
    let index = 0;
    while (Date.now() - started < options.durationMs) {
      recap.textContent = chapters[index % chapters.length];
      index += 1;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(intervalMs, options.durationMs - (Date.now() - started)),
      ));
    }
    recap.remove();
  }.toString()})(${JSON.stringify({
    chapters: walkthroughRecapChapters(recapMode),
    durationMs,
  })})`;
  await browserWindow.webContents.mainFrame.executeJavaScript(source, true);
}

async function writeCapturedFrame(state, browserWindow) {
  if (state.captureInFlight || state.stopping) return;
  state.captureInFlight = true;
  try {
    const image = await browserWindow.webContents.capturePage();
    if (image.isEmpty()) throw new Error("Electron captured an empty window frame.");
    const size = image.getSize();
    const frame = size.width > 1920 ? image.resize({ width: 1920 }) : image;
    const png = frame.toPNG();
    const targetFrames = Math.max(
      1,
      Math.floor((Date.now() - state.startedAt) / state.frameIntervalMs) + 1,
    );
    const copies = Math.max(1, targetFrames - state.framesWritten);
    for (let index = 0; index < copies; index += 1) {
      if (!state.process.stdin.write(png)) {
        await once(state.process.stdin, "drain");
      }
    }
    state.framesWritten += copies;
    state.lastFrame = png;
    state.lastFrameAt = Date.now();
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.captureInFlight = false;
  }
}

async function startCapturedWindowRecording(
  browserWindow,
  command,
  {
    env,
    publishArtifact,
    recordingDir,
  },
) {
  const existing = capturedRecordings.get(browserWindow);
  if (existing && !existing.stopping) {
    throw new Error("The OpenRappter window is already recording.");
  }
  const maxDurationMs = Math.max(
    1000,
    Math.min(10 * 60 * 1000, Number(command.maxDurationMs) || 5 * 60 * 1000),
  );
  const frameRate = Math.max(
    2,
    Math.min(12, Number(command.frameRate) || 8),
  );
  const frameIntervalMs = 1000 / frameRate;
  mkdirSync(recordingDir, { recursive: true });
  const outputPath = path.join(
    recordingDir,
    `brainstem-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
  );
  const temporaryPath = `${outputPath}.${process.pid}.tmp.webm`;
  // Do not start a recording by discovering mid-spawn that the organ is absent.
  const organ = probeMediaOrgan(env);
  if (!organ.ok) {
    const error = new Error(
      `${organ.name} are not installed, so this run cannot be recorded `
      + `(${organ.detail}; ${organ.reason}). Enable Showtime to install them.`,
    );
    error.name = "MediaOrganUnavailableError";
    error.organ = organ;
    throw error;
  }
  const executable = organ.executable || resolveFfmpegExecutable(env);
  const child = spawn(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(frameRate),
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "1800k",
      "-deadline",
      "realtime",
      "-cpu-used",
      "5",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "webm",
      "-y",
      temporaryPath,
    ],
    {
      env,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16000);
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const state = {
    autoStop: null,
    captureInFlight: false,
    closePromise,
    error: null,
    finalizePromise: null,
    frameIntervalMs,
    frameRate,
    framesWritten: 0,
    lastFrame: null,
    lastFrameAt: null,
    maxDurationMs,
    outputPath,
    process: child,
    publishArtifact,
    startedAt: Date.now(),
    stopping: false,
    temporaryPath,
  };
  child.stdin.on("error", (error) => {
    state.error ||= errorMessage(error);
  });
  state.finalize = () => {
    if (state.finalizePromise) return state.finalizePromise;
    state.finalizePromise = (async () => {
      let completed = false;
      try {
        clearInterval(state.captureTimer);
        clearTimeout(state.autoStop);
        while (state.captureInFlight) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        state.stopping = true;
        const durationMs = Date.now() - state.startedAt;
        const targetFrames = Math.max(1, Math.ceil(durationMs / frameIntervalMs));
        if (state.lastFrame) {
          while (state.framesWritten < targetFrames) {
            if (!child.stdin.write(state.lastFrame)) {
              await once(child.stdin, "drain");
            }
            state.framesWritten += 1;
          }
        }
        child.stdin.end();
        const result = await Promise.race([
          state.closePromise,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("ffmpeg did not finalize within 60 seconds.")),
            60000,
          )),
        ]);
        if (result.code !== 0) {
          throw new Error(
            `ffmpeg exited with ${result.code ?? result.signal}: ${stderr.trim()}`,
          );
        }
        if (state.error) throw new Error(state.error);
        if (!existsSync(temporaryPath) || !statSync(temporaryPath).size) {
          throw new Error("ffmpeg produced an empty walkthrough recording.");
        }
        renameSync(temporaryPath, outputPath);
        const recording = {
          durationMs,
          frameRate,
          framesWritten: state.framesWritten,
          mimeType: "video/webm",
          path: outputPath,
          sizeBytes: statSync(outputPath).size,
          url: publishArtifact(outputPath, "video/webm", "recordings"),
        };
        completed = true;
        lastCapturedRecordings.set(browserWindow, recording);
        return recording;
      } finally {
        capturedRecordings.delete(browserWindow);
        await setCapturedRecordingIndicator(browserWindow, false).catch(() => {});
        if (!completed) {
          child.kill("SIGTERM");
          rmSync(temporaryPath, { force: true });
        }
      }
    })();
    return state.finalizePromise;
  };
  capturedRecordings.set(browserWindow, state);
  await setCapturedRecordingIndicator(browserWindow, true);
  await writeCapturedFrame(state, browserWindow);
  if (state.error || !state.framesWritten) {
    await state.finalize().catch(() => {});
    throw new Error(state.error || "The first walkthrough frame was not captured.");
  }
  state.captureTimer = setInterval(() => {
    void writeCapturedFrame(state, browserWindow);
  }, frameIntervalMs);
  state.autoStop = setTimeout(() => {
    void state.finalize().catch(() => {});
  }, maxDurationMs);
  return {
    encoder: "ffmpeg",
    frameRate,
    maxDurationMs,
    startedAt: state.startedAt,
  };
}

async function stopCapturedWindowRecording(browserWindow, command = {}) {
  const state = capturedRecordings.get(browserWindow);
  if (!state) {
    const last = lastCapturedRecordings.get(browserWindow);
    if (last) {
      lastCapturedRecordings.delete(browserWindow);
      return last;
    }
    throw new Error("The OpenRappter window is not recording.");
  }
  const minimumDurationMs = Math.max(
    0,
    Math.min(5 * 60 * 1000, Number(command.minimumDurationMs) || 0),
  );
  const remaining = Math.max(
    0,
    minimumDurationMs - (Date.now() - state.startedAt),
  );
  await showCapturedRecordingRecap(
    browserWindow,
    remaining,
    command.recapMode,
  );
  return state.finalize();
}

function capturedWindowRecordingStatus(browserWindow) {
  const state = capturedRecordings.get(browserWindow);
  if (!state) return { active: false };
  return {
    active: !state.stopping,
    elapsedMs: Date.now() - state.startedAt,
    encoder: "ffmpeg",
    error: state.error,
    frameRate: state.frameRate,
    framesWritten: state.framesWritten,
    lastFrameAt: state.lastFrameAt,
    pid: state.process.pid,
  };
}

async function abortCapturedWindowRecording(browserWindow) {
  const state = capturedRecordings.get(browserWindow);
  if (!state) return;
  clearInterval(state.captureTimer);
  clearTimeout(state.autoStop);
  state.stopping = true;
  state.process.stdin.destroy();
  state.process.kill("SIGTERM");
  capturedRecordings.delete(browserWindow);
  rmSync(state.temporaryPath, { force: true });
  await setCapturedRecordingIndicator(browserWindow, false).catch(() => {});
}

function validateCondition(condition, label) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    throw new Error(`UI driver ${label} must be an object.`);
  }
  if (condition.snapshot_changed === true || condition.snapshotChanged === true) {
    return condition;
  }
  if (
    typeof condition.handle !== "string"
    && typeof condition.selector !== "string"
  ) {
    throw new Error(`UI driver ${label} requires a handle or selector.`);
  }
  const hasState = typeof condition.state === "string";
  const hasText = typeof condition.text === "string";
  if (hasState === hasText) {
    throw new Error(`UI driver ${label} requires exactly one of state or text.`);
  }
  validateNumberField(
    condition.timeoutMs,
    `${label} timeoutMs`,
    100,
    120000,
  );
  return condition;
}

function validateNumberField(value, label, minimum, maximum) {
  if (value === undefined) return;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `UI driver ${label} must be between ${minimum} and ${maximum}.`,
    );
  }
}

function commandInput(command, action) {
  return String(
    action === "type"
      ? command.value ?? ""
      : command.value || command.text || "",
  );
}

function commandTypingDelay(command, action) {
  return boundedNumber(
    command.typingDelayMs,
    0,
    UI_DRIVER_LIMITS.typingDelayMs,
    action === "type" ? 18 : 5,
  );
}

function estimatedCommandDuration(command) {
  const action = String(command.action || "").toLowerCase();
  const untilMs = command.until
    ? boundedNumber(command.until.timeoutMs, 100, 120000, 10000)
    : 0;
  const pointerMs = 220 + 650;
  if (action === "announce") {
    return boundedNumber(
      command.durationMs,
      120,
      UI_DRIVER_LIMITS.announceDurationMs,
      900,
    );
  }
  if (action === "autopilot") {
    const commands = String(command.script || "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .length;
    return Math.max(1000, Math.min(64, commands || 1) * 12000);
  }
  if (action === "click") {
    return pointerMs
      + boundedNumber(command.settleMs, 260, UI_DRIVER_LIMITS.settleMs, 520)
      + untilMs;
  }
  if (action === "type") {
    return pointerMs
      + (commandInput(command, action).length * commandTypingDelay(command, action))
      + boundedNumber(command.settleMs, 160, UI_DRIVER_LIMITS.settleMs, 300)
      + untilMs;
  }
  if (action === "press") {
    return (command.handle || command.selector ? pointerMs : 0)
      + boundedNumber(command.settleMs, 120, UI_DRIVER_LIMITS.settleMs, 280)
      + untilMs;
  }
  if (action === "wait") {
    return boundedNumber(command.timeoutMs, 100, 120000, 10000);
  }
  if (action === "chat" || action === "surgeon_chat") {
    const replyTimeoutMs = boundedNumber(
      command.timeoutMs,
      1000,
      60 * 60 * 1000,
      action === "chat" ? 180000 : 60 * 60 * 1000,
    );
    const typingMs = commandInput(command, action).length
      * commandTypingDelay(command, action);
    const openPanelMs = action === "surgeon_chat" ? pointerMs + 350 : 0;
    const requestIdMs = action === "chat" ? 2000 : 0;
    return openPanelMs
      + pointerMs
      + typingMs
      + 300
      + pointerMs
      + 260
      + requestIdMs
      + replyTimeoutMs;
  }
  if (action === "run") {
    return command.steps.reduce(
      (total, step) => total + estimatedCommandDuration(step),
      0,
    );
  }
  return 0;
}

function validateCommand(command, { nested = false } = {}) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("UI driver command must be an object.");
  }
  const action = String(command.action || "").toLowerCase();
  const allowed = new Set([
    "announce",
    "autopilot",
    "chat",
    "click",
    "expect",
    "force_mode",
    "inspect",
    "press",
    "read",
    "recording_status",
    "route_telemetry",
    "refresh",
    "run",
    "screenshot",
    "start_recording",
    "set_chat_lease",
    "stop_recording",
    "surgeon_chat",
    "swipe",
    "tour",
    "type",
    "wait",
  ]);
  if (!allowed.has(action)) {
    throw new Error(`Unsupported UI driver action: ${action || "(empty)"}`);
  }
  const normalized = { ...command, action };
  if (action === "autopilot") {
    if (typeof command.script !== "string") {
      throw new Error("UI driver autopilot script must be a string.");
    }
    if (command.script.length > UI_DRIVER_LIMITS.typedCharacters) {
      throw new Error(
        `UI driver autopilot script must be at most ${
          UI_DRIVER_LIMITS.typedCharacters
        } characters.`,
      );
    }
  }
  validateNumberField(
    command.durationMs,
    "durationMs",
    0,
    UI_DRIVER_LIMITS.announceDurationMs,
  );
  validateNumberField(
    command.settleMs,
    "settleMs",
    0,
    UI_DRIVER_LIMITS.settleMs,
  );
  validateNumberField(
    command.typingDelayMs,
    "typingDelayMs",
    0,
    UI_DRIVER_LIMITS.typingDelayMs,
  );
  validateNumberField(
    command.frameTimeoutMs,
    "frameTimeoutMs",
    1000,
    MAX_FRAME_SCRIPT_TIMEOUT_MS,
  );
  if (["type", "chat", "surgeon_chat"].includes(action)) {
    const input = commandInput(command, action);
    if (input.length > UI_DRIVER_LIMITS.typedCharacters) {
      throw new Error(
        `UI driver ${action} input must be at most ${
          UI_DRIVER_LIMITS.typedCharacters
        } characters.`,
      );
    }
    if (
      input.length * commandTypingDelay(command, action)
      > UI_DRIVER_LIMITS.typingDurationMs
    ) {
      throw new Error(
        `UI driver ${action} typing animation exceeds ${
          UI_DRIVER_LIMITS.typingDurationMs
        }ms.`,
      );
    }
  }
  if (action === "inspect") {
    if (
      command.limit !== undefined
      && (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 80)
    ) {
      throw new Error("UI driver inspect limit must be between 1 and 80.");
    }
    if (command.since !== undefined && typeof command.since !== "string") {
      throw new Error("UI driver inspect since must be a snapshot string.");
    }
  }
  if (action === "wait") {
    validateNumberField(command.timeoutMs, "wait timeoutMs", 100, 120000);
  }
  if (action === "chat" || action === "surgeon_chat") {
    validateNumberField(
      command.timeoutMs,
      `${action} timeoutMs`,
      1000,
      60 * 60 * 1000,
    );
  }
  if (command.until !== undefined) {
    if (!["click", "press", "type"].includes(action)) {
      throw new Error("UI driver until is supported only for click, press, and type.");
    }
    normalized.until = validateCondition(command.until, "until");
  }
  if (action === "expect") validateCondition(command, "expect");
  if (action === "run") {
    if (!Array.isArray(command.steps) || command.steps.length < 1 || command.steps.length > 40) {
      throw new Error("UI driver runs require between 1 and 40 steps.");
    }
    normalized.steps = command.steps.map((step) => {
      const nestedCommand = validateCommand(step, { nested: true });
      if (
        nestedCommand.action === "tour"
        || nestedCommand.action === "force_mode"
      ) {
        throw new Error(`Use ${nestedCommand.action} as a top-level UI driver command, not inside run.`);
      }
      return nestedCommand;
    });
  }
  if (!nested && commandHasAutopilot(normalized)) normalized.target = "shell";
  if (nested) return normalized;

  const requiredFrameTimeoutMs = Math.ceil(
    estimatedCommandDuration(normalized) + 1000,
  );
  if (requiredFrameTimeoutMs > MAX_FRAME_SCRIPT_TIMEOUT_MS) {
    throw new Error(
      `UI driver ${action} estimated duration exceeds the frame time limit.`,
    );
  }
  if (
    command.frameTimeoutMs !== undefined
    && Number(command.frameTimeoutMs) < requiredFrameTimeoutMs
  ) {
    throw new Error(
      `UI driver frameTimeoutMs must be at least ${requiredFrameTimeoutMs} for this command.`,
    );
  }
  normalized.frameTimeoutMs = command.frameTimeoutMs === undefined
    ? Math.max(FRAME_SCRIPT_TIMEOUT_MS, requiredFrameTimeoutMs)
    : Number(command.frameTimeoutMs);
  return normalized;
}

function twinTarget(command) {
  const id = command && typeof command.twin === "string" ? command.twin.trim() : "";
  return id || null;
}

function commandHasAutopilot(command) {
  const action = String(command?.action || "").toLowerCase();
  return action === "autopilot"
    || (
      action === "run"
      && command.steps?.some((step) => (
        String(step?.action || "").toLowerCase() === "autopilot"
      ))
    );
}

function frameKeyForCommand(command) {
  const twin = twinTarget(command);
  if (twin) return `twin:${twin}`;
  const action = String(command?.action || "").toLowerCase();
  if (
    command?.target === "shell"
    || [
      "force_mode",
      "recording_status",
      "route_telemetry",
      "screenshot",
      "start_recording",
      "stop_recording",
      "surgeon_chat",
      "tour",
    ].includes(action)
    || commandHasAutopilot(command)
  ) return "shell";
  return "brainstem";
}

function createFrameQueue() {
  const tails = new Map();
  return {
    async enter(key) {
      const previous = tails.get(key) || Promise.resolve();
      let releaseGate;
      const gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      const tail = previous.catch(() => {}).then(() => gate);
      tails.set(key, tail);
      await previous.catch(() => {});
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseGate();
        if (tails.get(key) === tail) tails.delete(key);
      };
    },
    get size() {
      return tails.size;
    },
  };
}

// ── AI force mode ─────────────────────────────────────────────────────────
// A hidden, opt-in visual state: while an AI is driving the visible window on
// the user's behalf, the whole window's edges glow and a small tag says so.
// It is only ever lit by an explicit `force_mode` command or by a driver
// command carrying `forceMode: true`, and it fades on its own after the AI
// goes quiet, so it never lingers when a person is driving.
const FORCE_MODE_IDLE_MS = 30000;
const forceModeState = new WeakMap();

async function setForceMode(browserWindow, on, options = {}) {
  const source = `(${function forceModeOverlay(settings) {
    const STYLE_ID = "brainstem-ai-force-mode-style";
    const ID = "brainstem-ai-force-mode";
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        #${ID} { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
        #${ID}[hidden] { display: none; }
        #${ID} .brainstem-ai-force-edge { position: absolute; inset: 0;
          box-shadow: inset 0 0 0 2px rgba(124,140,255,.9), inset 0 0 44px rgba(124,140,255,.30), inset 0 0 130px rgba(88,166,255,.16);
          animation: brainstem-ai-force-glow 2.4s ease-in-out infinite; }
        #${ID} .brainstem-ai-force-tag { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
          display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px;
          border: 1px solid rgba(124,140,255,.75); background: rgba(10,12,32,.94); color: #c7ceff;
          font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase;
          box-shadow: 0 6px 24px rgba(0,0,0,.45), 0 0 18px rgba(124,140,255,.35); white-space: nowrap; }
        #${ID} .brainstem-ai-force-dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa6ff;
          box-shadow: 0 0 0 3px rgba(154,166,255,.25); animation: brainstem-ai-force-pulse 1.6s ease-in-out infinite; }
        @keyframes brainstem-ai-force-glow { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
        @keyframes brainstem-ai-force-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.35); } }
        @media (prefers-reduced-motion: reduce) {
          #${ID} .brainstem-ai-force-edge, #${ID} .brainstem-ai-force-dot { animation: none; }
        }`;
      document.head.appendChild(style);
    }
    let overlay = document.getElementById(ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = ID;
      overlay.dataset.brainstemAiDriver = "true";
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-live", "polite");
      overlay.innerHTML = '<div class="brainstem-ai-force-edge"></div>'
        + '<div class="brainstem-ai-force-tag"><span class="brainstem-ai-force-dot"></span><span class="brainstem-ai-force-text"></span></div>';
      document.body.appendChild(overlay);
    }
    overlay.querySelector(".brainstem-ai-force-text").textContent = String(
      settings.label || "Automated control · an agent is operating this Brainstem",
    ).slice(0, 120);
    overlay.hidden = !settings.on;
    return { forceMode: Boolean(settings.on) };
  }.toString()})(${JSON.stringify({ on: Boolean(on), label: options.label || "" })})`;
  const result = await browserWindow.webContents.mainFrame.executeJavaScript(source, true);
  const state = forceModeState.get(browserWindow) || {};
  clearTimeout(state.timer);
  state.on = Boolean(on);
  state.timer = null;
  forceModeState.set(browserWindow, state);
  return result;
}

function armForceModeIdle(browserWindow, idleMs = FORCE_MODE_IDLE_MS) {
  const state = forceModeState.get(browserWindow);
  if (!state?.on) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    setForceMode(browserWindow, false).catch(() => {});
  }, Math.max(1000, Math.min(10 * 60 * 1000, Number(idleMs) || FORCE_MODE_IDLE_MS)));
  state.timer.unref?.();
}

function forceModeStatus(browserWindow) {
  return { forceMode: Boolean(forceModeState.get(browserWindow)?.on) };
}

// ── Show Mode click-through (tour) ────────────────────────────────────────
// Drives the Show Mode click-through preview that lives in the shell window
// (ui/show-mode-tour.js) so an AI can walk it, pause on a step, and capture
// evidence exactly as a person clicking Next would see it.
async function runTourCommand(browserWindow, command) {
  const source = `(${async function tourCommand(cmd) {
    const tour = window.rappShowModeTour;
    if (!tour) return { available: false, error: "Show Mode click-through is not loaded in this window." };
    const value = String(cmd.value || "status").toLowerCase();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const indexOf = (ref) => {
      if (ref === undefined || ref === null || ref === "") return -1;
      const asNumber = Number(ref);
      if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < tour.steps.length) return asNumber;
      return tour.steps.indexOf(String(ref));
    };
    if (value === "start") tour.start(0);
    else if (value === "next") tour.running ? tour.next() : tour.start(0);
    else if (value === "prev") tour.prev();
    else if (value === "stop") tour.stop();
    else if (value === "goto") {
      const index = indexOf(cmd.step);
      if (index < 0) return { available: true, error: `Unknown tour step ${cmd.step}`, steps: tour.steps };
      tour.start(index);
    } else if (value !== "status") {
      return { available: true, error: `Unsupported tour command ${value}`, steps: tour.steps };
    }
    if (value !== "status") {
      await sleep(Math.max(0, Math.min(5000, Number(cmd.settleMs) || 750)));
      // Let the compositor commit the new step before anyone captures the page.
      await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        sleep(400),
      ]);
    }
    return {
      available: true,
      running: Boolean(tour.running),
      step: tour.step || null,
      index: tour.steps.indexOf(tour.step),
      total: tour.steps.length,
      steps: tour.steps,
    };
  }.toString()})(${JSON.stringify(command)})`;
  const value = String(command.value || "status").toLowerCase();
  if (value !== "status") {
    // The click-through is a presentation: keep painting while it runs so
    // captures reflect the current step, and surface the window without
    // stealing keyboard focus from wherever the person is typing.
    try {
      browserWindow.webContents.setBackgroundThrottling(value !== "stop");
      if (value !== "stop" && !browserWindow.isFocused()) {
        if (browserWindow.isMinimized()) browserWindow.restore();
        browserWindow.moveTop?.();
      }
    } catch {
      // best effort
    }
  }
  return browserWindow.webContents.mainFrame.executeJavaScript(source, true);
}

function writeMetadata(metadataPath, metadata) {
  mkdirSync(path.dirname(metadataPath), { recursive: true });
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, metadataPath);
}

function removeOwnedMetadata(metadataPath, token) {
  try {
    const current = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (current.token === token && current.pid === process.pid) {
      rmSync(metadataPath, { force: true });
    }
  } catch {
    // A missing or replaced metadata file belongs to no cleanup action here.
  }
}

export async function startUiDriverServer({
  window,
  brainstemHome,
  brainstemRuntimeFingerprint = null,
  loopbackUrl,
  env = process.env,
  routeTelemetry = () => null,
  runtimeFingerprint = null,
  resolveTwinUrls = () => [],
} = {}) {
  if (!window || typeof loopbackUrl !== "function") {
    throw new Error("The UI driver requires a BrowserWindow and loopback URL guard.");
  }
  const betaHome = env.BRAINSTEM_BETA_HOME
    || path.join(brainstemHome, "beta-launcher");
  const metadataPath = env.BRAINSTEM_BETA_UI_DRIVER_FILE
    || path.join(betaHome, "ui-driver.json");
  const captureDir = path.join(betaHome, "captures");
  const logDir = path.join(betaHome, "logs");
  const recordingDir = path.join(betaHome, "recordings");
  const nodeHelpers = createUiDriverHelpers();
  const startedAt = new Date().toISOString();
  const traceRunId = `${startedAt.replace(/[:.]/g, "-")}-${
    randomBytes(5).toString("hex")
  }`;
  const tracePath = path.join(logDir, `ui-driver-${traceRunId}.jsonl`);
  const configuredTraceMaxBytes = Number(
    env.BRAINSTEM_BETA_UI_DRIVER_TRACE_MAX_BYTES,
  );
  const traceMaxBytes = Number.isFinite(configuredTraceMaxBytes)
    && configuredTraceMaxBytes >= 1024
    ? Math.floor(configuredTraceMaxBytes)
    : 5 * 1024 * 1024;
  const pruneUiDriverTraces = ({ protectCurrent = true } = {}) => (
    pruneLogFiles(logDir, {
      keep: 20,
      match: (name) => /^ui-driver-.*\.jsonl(?:\.\d+)?$/.test(name),
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
      protectedNames: protectCurrent ? [path.basename(tracePath)] : [],
    })
  );
  pruneUiDriverTraces({ protectCurrent: false });
  const frameQueue = createFrameQueue();
  const heartbeatMs = Math.max(
    10,
    Number(env.BRAINSTEM_BETA_UI_DRIVER_HEARTBEAT_MS) || 15000,
  );
  const token = randomBytes(32).toString("hex");
  const artifactToken = randomBytes(32).toString("hex");
  const artifacts = new Map();
  const sockets = new Set();
  let stopping = false;

  function boundedResult(result, command) {
    const limit = nodeHelpers.capNumber(
      command.byteBudget ?? command.byte_budget,
      512,
      64 * 1024,
      nodeHelpers.caps.budgetDefault,
    );
    const lastStep = Array.isArray(command.steps)
      ? [...command.steps].reverse().find((step) => step?.handle)
      : null;
    const fitted = nodeHelpers.fitBudget(result, {
      handle: command.handle || lastStep?.handle || "@page",
      limit,
    });
    return fitted.truncated ? fitted.value : result;
  }

  function traceItems(result) {
    if (!Array.isArray(result?.results)) return [result];
    return result?.__trace ? [result, ...result.results] : result.results;
  }

  function autopilotTraceResults(command, result) {
    const action = String(command?.action || "").toLowerCase();
    if (action === "autopilot") {
      return Array.isArray(result?.results) ? result.results : [];
    }
    if (action !== "run" || !Array.isArray(result?.results)) return [];
    return result.results.flatMap((stepResult, index) => (
      String(command.steps?.[index]?.action || "").toLowerCase() === "autopilot"
      && Array.isArray(stepResult?.results)
        ? stepResult.results
        : []
    ));
  }

  function mergedEffect(items) {
    const effects = items.map((item) => item?.effect).filter(Boolean);
    if (!effects.length) return null;
    const merged = {
      added: effects.flatMap((effect) => effect.added || []).slice(0, 5),
      changed: effects.flatMap((effect) => effect.changed || []).slice(0, 5),
      removed: effects.flatMap((effect) => effect.removed || []).slice(0, 5),
      route: [...effects].reverse().find((effect) => effect.route)?.route || null,
    };
    const focus = [...effects].reverse().find((effect) => effect.focus)?.focus;
    if (focus) merged.focus = focus;
    const submit = [...effects].reverse().find((effect) => effect.submit)?.submit;
    if (submit) merged.submit = submit;
    return merged;
  }

  function appendCommandTrace(command, result, error = null) {
    const items = traceItems(result);
    const traces = items.map((item) => item?.__trace).filter(Boolean);
    const handles = items.map((item) => item?.h).filter(Boolean);
    const traceText = (value) => (
      value == null ? null : nodeHelpers.capText(value, 2000)
    );
    const autopilotCommands = autopilotTraceResults(command, result)
      .slice(0, 64)
      .map((item) => ({
        actor: item?.actor === "ai" ? "ai" : null,
        cmd: traceText(item?.cmd || ""),
        ok: item?.ok === true,
        reason: traceText(item?.reason || null),
      }));
    const entry = {
      action: String(command?.action || ""),
      handle: traceText(
        command?.handle || handles[handles.length - 1] || null,
      ),
      effect: error
        ? { error: traceText(errorMessage(error)) }
        : mergedEffect(items),
      snapshot_before: traceText(
        traces[0]?.snapshot_before || command?.since || null,
      ),
      snapshot_after: traceText(
        traces[traces.length - 1]?.snapshot_after
          || result?.snapshot
          || null,
      ),
      ...(autopilotCommands.length
        ? {
            actor: autopilotCommands.every((item) => item.actor === "ai")
              ? "ai"
              : null,
            commands: autopilotCommands,
          }
        : {}),
      // Lease transitions are the one fact about concurrency that polling a
      // banner cannot observe reliably (a "(2)" can last milliseconds); the
      // trace records the count the lock or unlock saw, so a test can assert
      // the overlap after the fact instead of racing it.
      ...(Number.isInteger(result?.leaseCount)
        ? { lease_count: result.leaseCount, locked: result.locked === true }
        : {}),
      ...(result?.yielded_to_user === true ? { yielded_to_user: true } : {}),
    };
    mkdirSync(logDir, { recursive: true });
    const rotated = rotateLogIfLarge(tracePath, {
      maxBytes: traceMaxBytes,
    });
    if (rotated) pruneUiDriverTraces();
    const serialized = redactCredentialText(JSON.stringify(entry));
    appendFileSync(tracePath, `${serialized}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  function stripTraceMetadata(value) {
    if (Array.isArray(value)) {
      value.forEach((item) => stripTraceMetadata(item));
      return value;
    }
    if (!value || typeof value !== "object") return value;
    delete value.__trace;
    for (const item of Object.values(value)) stripTraceMetadata(item);
    return value;
  }

  function commandResponse(response, command, result, { budget = false } = {}) {
    // The command already happened; a trace that cannot be written is a
    // diagnostic on the answer, never a reason to report the click as failed
    // (callers retry failures, which would double-send the chat).
    let traceError = null;
    try {
      appendCommandTrace(command, result);
    } catch (error) {
      traceError = errorMessage(error);
      console.warn("UI driver trace write failed:", traceError);
    }
    const clean = stripTraceMetadata(result);
    jsonResponse(response, 200, {
      ok: true,
      result: budget ? boundedResult(clean, command) : clean,
      ...(traceError ? { trace_error: traceError } : {}),
    });
  }

  function publishArtifact(filePath, contentType, kind) {
    if (!existsSync(filePath)) {
      throw new Error(`UI driver artifact is missing: ${filePath}`);
    }
    const artifactId = randomBytes(18).toString("base64url");
    artifacts.set(artifactId, {
      contentType,
      kind,
      path: filePath,
      createdAt: Date.now(),
    });
    while (artifacts.size > 100) {
      artifacts.delete(artifacts.keys().next().value);
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("The UI driver artifact server is unavailable.");
    }
    return `http://127.0.0.1:${address.port}/v1/${kind}/${artifactId}`
      + `?token=${encodeURIComponent(artifactToken)}`;
  }

  async function captureEvidence(command = {}) {
    mkdirSync(captureDir, { recursive: true });
    const image = await window.webContents.capturePage();
    const outputPath = path.join(
      captureDir,
      `brainstem-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    );
    writeFileSync(outputPath, image.toPNG(), { mode: 0o600 });
    const preview = image.getSize().width > 1280
      ? image.resize({ width: 1280 })
      : image;
    const frame = brainstemFrame(window, loopbackUrl);
    const text = frame
      ? await executeInFrame(
          frame,
          `(${function screenshotText(options) {
            const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
            const active = document.activeElement;
            const activeHandle = active?.dataset?.drive
              ? `@${active.dataset.drive}`
              : (active?.id ? `#${active.id}` : "");
            const lastStep = normalize(
              window.__brainstemAiDriver?.lastStep
              || document.querySelector("[data-drive-step-tile]:last-of-type")?.textContent,
            );
            const caption = [
              normalize(document.title),
              activeHandle,
              lastStep,
            ].filter(Boolean).join(" · ").slice(0, 300);
            let fullText = "";
            if (options.includeText) {
              const clone = document.body.cloneNode(true);
              clone.querySelectorAll("[data-brainstem-ai-driver]").forEach(
                (element) => element.remove(),
              );
              fullText = normalize(clone.innerText || clone.textContent).slice(0, 2000);
            }
            return { caption, fullText };
          }.toString()})(${JSON.stringify({
            includeText: command.includeText === true || command.include_text === true,
          })})`,
          { timeoutMs: 5000, window },
        ).catch(() => ({ caption: "", fullText: "" }))
      : { caption: "", fullText: "" };
    const caption = String(text?.caption || "OpenRappter capture").slice(0, 300);
    const includeText = command.includeText === true || command.include_text === true;
    return {
      caption,
      captureUrl: publishArtifact(outputPath, "image/png", "captures"),
      dataUrl: `data:image/jpeg;base64,${preview.toJPEG(72).toString("base64")}`,
      path: outputPath,
      size: image.getSize(),
      ...(includeText ? { text: String(text?.fullText || "").slice(0, 2000) } : {}),
      visibleText: includeText
        ? String(text?.fullText || "").slice(0, 2000)
        : caption,
    };
  }

  async function renderGrailMedia(artifact) {
    const frame = brainstemFrame(window, loopbackUrl);
    if (!frame || !artifact?.url) return false;
    return executeInFrame(
      frame,
      `Boolean(window.__rappBetaRenderDriveMedia?.(${JSON.stringify(artifact)}))`,
      { timeoutMs: 5000, window },
    ).catch(() => false);
  }

  async function renderGrailStep(summary) {
    const frame = brainstemFrame(window, loopbackUrl);
    const line = String(summary || "").replace(/\s+/g, " ").trim().slice(0, 220);
    if (!frame || !line) return false;
    return executeInFrame(
      frame,
      `Boolean(window.__rappBetaRenderDriveStep?.(${JSON.stringify(line)}))`,
      { timeoutMs: 5000, window },
    ).catch(() => false);
  }

  const server = createServer(async (request, response) => {
    if (stopping) {
      jsonResponse(response, 503, { ok: false, error: "UI driver is shutting down." });
      return;
    }
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (
      request.method === "OPTIONS"
      && requestUrl.pathname === "/v1/recording-upload"
    ) {
      if (requestUrl.searchParams.get("token") !== artifactToken) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type, X-Recording-Duration, X-Recording-Size",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    if (
      request.method === "POST"
      && requestUrl.pathname === "/v1/recording-upload"
    ) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (requestUrl.searchParams.get("token") !== artifactToken) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }
      const mimeType = String(request.headers["content-type"] || "")
        .split(";", 1)[0];
      if (mimeType !== "video/webm") {
        jsonResponse(response, 415, {
          ok: false,
          error: "The recording upload must be video/webm.",
        });
        return;
      }
      mkdirSync(recordingDir, { recursive: true });
      const outputPath = path.join(
        recordingDir,
        `brainstem-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
      );
      const temporaryPath = `${outputPath}.${process.pid}.tmp`;
      const output = createWriteStream(temporaryPath, { mode: 0o600 });
      let size = 0;
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 500 * 1024 * 1024) {
            throw new Error("The recorded window exceeds 500 MB.");
          }
          if (!output.write(chunk)) await once(output, "drain");
        }
        output.end();
        await once(output, "finish");
        if (!size) {
          throw new Error(
            `The recorded window is empty (renderer reported ${
              request.headers["x-recording-size"] || "unknown"
            } bytes).`,
          );
        }
        renameSync(temporaryPath, outputPath);
        const durationMs = Number(request.headers["x-recording-duration"]) || null;
        jsonResponse(response, 200, {
          ok: true,
          recording: {
            durationMs,
            mimeType,
            path: outputPath,
            sizeBytes: size,
            url: publishArtifact(outputPath, mimeType, "recordings"),
          },
        });
      } catch (error) {
        output.destroy();
        rmSync(temporaryPath, { force: true });
        jsonResponse(response, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    const artifactMatch = requestUrl.pathname.match(
      /^\/v1\/(captures|recordings)\/([A-Za-z0-9_-]+)$/,
    );
    if (request.method === "GET" && artifactMatch) {
      const artifact = artifacts.get(artifactMatch[2]);
      if (
        requestUrl.searchParams.get("token") !== artifactToken
        || !artifact
        || artifact.kind !== artifactMatch[1]
        || !existsSync(artifact.path)
      ) {
        jsonResponse(response, 404, { ok: false, error: "Artifact not found." });
        return;
      }
      const body = readFileSync(artifact.path);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": artifact.contentType,
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      response.end(body);
      return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== "/v1/command") {
      jsonResponse(response, 404, { ok: false, error: "Not found." });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      jsonResponse(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    let command = null;
    let heartbeat = null;
    let releaseFrame = null;
    try {
      command = validateCommand(await readJsonBody(request));
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.flushHeaders();
      heartbeat = setInterval(() => {
        if (!response.writableEnded) response.write(" ");
      }, heartbeatMs);
      releaseFrame = await frameQueue.enter(frameKeyForCommand(command));
      if (command.forceMode === true) {
        await setForceMode(window, true, { label: command.forceLabel });
      }
      if (command.action === "force_mode") {
        const wanted = String(command.value || "status").toLowerCase();
        if (wanted === "on") await setForceMode(window, true, { label: command.label });
        else if (wanted === "off") await setForceMode(window, false);
        else if (wanted !== "status") {
          throw new Error(`Unsupported force_mode value: ${wanted}`);
        }
        if (wanted === "on") armForceModeIdle(window, command.idleMs);
        commandResponse(response, command, forceModeStatus(window));
        return;
      }
      if (command.action === "tour") {
        const result = await runTourCommand(window, command);
        armForceModeIdle(window, command.idleMs);
        commandResponse(response, command, result);
        return;
      }
      if (
        command.action === "recording_status"
        && capturedRecordings.has(window)
      ) {
        commandResponse(
          response,
          command,
          capturedWindowRecordingStatus(window),
        );
        return;
      }
      if (command.action === "route_telemetry") {
        const navigationCount = await window.webContents.mainFrame
          .executeJavaScript(
            "Number(window.__brainstemBetaNavigationCount || 0)",
            true,
          );
        const activeFrame = brainstemFrame(window, loopbackUrl);
        const composer = activeFrame
          ? await executeInFrame(
              activeFrame,
              "(() => { const s = window.__brainstemAiDriver; return { count: Number(s?.chatLeaseTokens?.size || 0), handoffs: Number(s?.composerHandoffs || 0) }; })()",
              { timeoutMs: 5000, window },
            ).catch(() => null)
          : null;
        const telemetry = routeTelemetry() || {};
        const allEvents = Array.isArray(telemetry.events) ? telemetry.events : [];
        const requestedCursor = Math.max(0, Number(command.cursor) || 0);
        const events = allEvents.filter((event, index) => {
          const eventCursor = Number(event?.sequence ?? event?.cursor ?? (index + 1));
          return !requestedCursor || eventCursor > requestedCursor;
        }).slice(-20);
        const cursor = Number(
          events[events.length - 1]?.sequence
          ?? events[events.length - 1]?.cursor
          ?? telemetry.sequence
          ?? requestedCursor,
        ) || requestedCursor;
        commandResponse(response, command, {
          ...telemetry,
          chat_lease_count: composer ? composer.count : null,
          composer_handoffs: composer ? composer.handoffs : null,
          cursor,
          events,
          navigation_count: navigationCount,
        }, { budget: true });
        return;
      }
      if (command.action === "refresh") {
        const frame = brainstemFrame(window, loopbackUrl);
        if (!frame) {
          throw new Error("The live Brainstem frontend is not loaded yet.");
        }
        await executeInFrame(
          frame,
          "setTimeout(() => location.reload(), 25); true",
          { timeoutMs: 5000, window },
        );
        commandResponse(response, command, { refreshing: true });
        return;
      }
      if (command.action === "start_recording") {
        let result;
        try {
          result = await startCapturedWindowRecording(window, command, {
            env,
            publishArtifact,
            recordingDir,
          });
        } catch (captureError) {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw captureError;
          }
          const uploadUrl = `http://127.0.0.1:${address.port}/v1/recording-upload`
            + `?token=${encodeURIComponent(artifactToken)}`;
          result = await startWindowRecording(window, command, uploadUrl);
          result.fallback = errorMessage(captureError);
        }
        commandResponse(response, command, result);
        return;
      }
      if (command.action === "stop_recording") {
        const recording = (
          capturedRecordings.has(window)
          || lastCapturedRecordings.has(window)
        )
          ? await stopCapturedWindowRecording(window, command)
          : await stopWindowRecording(window, command);
        const screenshot = await captureEvidence(command);
        await renderGrailMedia({
          alt: "Brainstem UI driver recording",
          kind: "video",
          url: recording?.url,
        });
        await renderGrailMedia({
          alt: "Final Brainstem UI driver capture",
          kind: "image",
          url: screenshot.captureUrl,
        });
        commandResponse(response, command, {
          recording,
          screenshot,
        });
        return;
      }
      if (command.action === "screenshot") {
        const result = await captureEvidence(command);
        await renderGrailMedia({
          alt: "Brainstem UI driver capture",
          kind: "image",
          url: result.captureUrl,
        });
        commandResponse(response, command, result);
        return;
      }

      const wantedTwin = twinTarget(command);
      const target = wantedTwin
        ? twinFrame(window, resolveTwinUrls(wantedTwin))
        : (command.target === "shell" || commandHasAutopilot(command)
          ? window.webContents.mainFrame
          : brainstemFrame(window, loopbackUrl));
      if (!target) {
        throw new Error(wantedTwin
          ? `Twin ${wantedTwin} UI is not visible in the herd yet — open the herd and its tile first.`
          : "The live Brainstem frontend is not loaded yet.");
      }
      // The command id is passed BESIDE the command (not inside it) so traces
      // stay identical from pass to pass; the frame uses it to notice when a
      // later command has taken over and to stop its own loops.
      const commandId = randomBytes(6).toString("hex");
      const source = `(${browserDriverCommand.toString()})(${
        JSON.stringify(command)
      }, ${createUiDriverHelpers.toString()}, ${JSON.stringify(commandId)}, ${
        JSON.stringify({ ...UI_DRIVER_LIMITS, frameBudgetMs: frameBudgetMs(command) })
      })`;
      const result = await executeInFrame(target, source, {
        timeoutMs: frameBudgetMs(command),
        window,
      });
      if (wantedTwin || command.target === "shell") {
        const summaries = Array.isArray(result?.summaries)
          ? result.summaries.filter(Boolean)
          : [result?.summary].filter(Boolean);
        for (const summary of summaries) await renderGrailStep(summary);
      }
      armForceModeIdle(window, command.idleMs);
      commandResponse(response, command, result, { budget: true });
    } catch (error) {
      let failure = error;
      if (command) {
        try {
          appendCommandTrace(command, null, error);
        } catch (traceError) {
          failure = new Error(
            `${errorMessage(error)} Trace write also failed: ${errorMessage(traceError)}`,
          );
        }
      }
      jsonResponse(response, 400, { ok: false, error: errorMessage(failure) });
    } finally {
      releaseFrame?.();
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The UI driver could not allocate a loopback port.");
  }

  writeMetadata(metadataPath, {
    version: 2,
    host: "127.0.0.1",
    port: address.port,
    token,
    pid: process.pid,
    brainstemRuntimeFingerprint,
    runtimeFingerprint,
    startedAt,
    tracePath,
  });

  return {
    metadataPath,
    publishArtifact,
    async stop() {
      stopping = true;
      await abortCapturedWindowRecording(window);
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      removeOwnedMetadata(metadataPath, token);
    },
  };
}

export const uiDriverInternals = {
  boundedFrameTimeout,
  browserDriverCommand,
  commandLimits: UI_DRIVER_LIMITS,
  createFrameQueue,
  createUiDriverHelpers,
  frameKeyForCommand,
  executeInFrame,
  FrameGoneError,
  frameBudgetMs,
  stepBudgetMs,
  forceModeStatus,
  runTourCommand,
  setForceMode,
  startCapturedWindowRecording,
  startWindowRecording,
  stopCapturedWindowRecording,
  stopWindowRecording,
  validateCommand,
  walkthroughRecapChapters,
  writeCapturedFrame,
};

export function allowsUiDriverMediaPermission(webContents, permission) {
  return permission === "media" && webContents === recordingPermissionWebContents;
}
