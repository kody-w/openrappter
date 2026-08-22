const AUTOPILOT_VERSION = "rapp-autopilot/1.0";
const COMMAND_LIMIT = 64;
const RESULT_LIMIT_BYTES = 64 * 1024;
const TEXT_LIMIT = 64 * 1024;
const CHAT_READ_DEFAULT_TURNS = 50;
const SURFACES = Object.freeze(["herd", "arena", "binder"]);
const SPEEDS = Object.freeze({
  natural: Object.freeze({ hoverMs: 240, moveMs: 720, steps: 12 }),
  fast: Object.freeze({ hoverMs: 60, moveMs: 180, steps: 6 }),
  instant: Object.freeze({ hoverMs: 0, moveMs: 0, steps: 1 }),
});

class AutopilotInputError extends Error {
  constructor(argument, accepts, message) {
    super(message);
    this.argument = argument;
    this.accepts = accepts;
  }
}

function frozenFields(fields) {
  return Object.freeze(fields.map((field) => Object.freeze({ ...field })));
}

function descriptor(value) {
  return Object.freeze({
    ...value,
    args: frozenFields(value.args || []),
    flags: frozenFields(value.flags || []),
  });
}

function textBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedEnvelope(envelope) {
  if (textBytes(envelope) <= RESULT_LIMIT_BYTES) return envelope;
  const results = envelope.results.map((result) => Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  ));
  const candidate = () => ({
    ...envelope,
    ok: results.every((result) => result.ok),
    results,
    result_truncated: true,
  });
  while (true) {
    let largest = null;
    for (const [resultIndex, result] of results.entries()) {
      for (const [key, value] of Object.entries(result)) {
        if (!Array.isArray(value) || value.length <= 1) continue;
        if (!largest || value.length > largest.length) {
          largest = { key, length: value.length, resultIndex };
        }
      }
    }
    if (!largest) break;
    const result = results[largest.resultIndex];
    const omitted = Math.max(1, Math.floor(largest.length / 2));
    result[largest.key] = result[largest.key].slice(omitted);
    result[`${largest.key}_omitted`] = (
      Number(result[`${largest.key}_omitted`]) || 0
    ) + omitted;
    result.result_truncated = true;
    const shrunk = candidate();
    if (textBytes(shrunk) <= RESULT_LIMIT_BYTES) return shrunk;
  }
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    results[index] = {
      cmd: result.cmd,
      ok: false,
      reason: "result_too_large",
      result_truncated: true,
    };
    const truncated = candidate();
    if (textBytes(truncated) <= RESULT_LIMIT_BYTES) return truncated;
  }
  return {
    ok: false,
    ran: 0,
    result_truncated: true,
    results: [{
      cmd: "script",
      ok: false,
      reason: "result_too_large",
      error: "The Autopilot result exceeded the 64 KB payload limit.",
    }],
  };
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function tokenize(line) {
  const tokens = [];
  let token = "";
  let quote = "";
  let quoted = false;
  let literal = false;
  let escaped = false;
  let started = false;
  for (const character of String(line || "")) {
    if (escaped) {
      token += character;
      quoted = true;
      if (token.length === 1) literal = true;
      started = true;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      quoted = true;
      started = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      if (!started) literal = true;
      quote = character;
      quoted = true;
      started = true;
      continue;
    }
    if (character === "#" && !started && tokens.length === 0) break;
    if (/\s/.test(character)) {
      if (started) {
        tokens.push({ literal, quoted, text: token });
        token = "";
        quoted = false;
        literal = false;
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped) token += "\\";
  if (quote) {
    throw new AutopilotInputError(
      "input",
      "a closed single- or double-quoted value",
      "Argument input requires a closed single- or double-quoted value.",
    );
  }
  if (started) tokens.push({ literal, quoted, text: token });
  return tokens;
}

function resultError(cmd, reason, error, fields = {}) {
  return {
    cmd,
    ok: false,
    reason,
    error: String(error || "The command could not be completed."),
    ...fields,
  };
}

function eventActor(event) {
  return event?.__rappAutopilotActor || null;
}

function setEventActor(event, actor = "ai") {
  try {
    Object.defineProperty(event, "__rappAutopilotActor", {
      configurable: true,
      value: actor,
    });
  } catch {
    try {
      event.__rappAutopilotActor = actor;
    } catch {
      // The per-window WeakSet still attributes non-extensible native events.
    }
  }
  return event;
}

export function createAutopilot(ctx = {}) {
  const doc = ctx.document;
  const win = ctx.window;
  const logConsole = ctx.console || { log() {} };
  const suppliedChat = ctx.chat || null;
  const capability = String(
    ctx.capability || win?.__rappAutopilotCapability || "",
  );
  const heldByUser = new Set();
  const heldPointers = new Map();
  const userDragging = new Set();
  const activeGestures = new Map();
  const remoteDrags = new Map();
  const remoteTargets = new Map();
  const pendingMessages = new Map();
  let messageSequence = 0;
  let lastFoldedTileId = null;

  function sleep(delayMs) {
    return new Promise((resolve) => {
      (win?.setTimeout || setTimeout)(resolve, Math.max(0, delayMs));
    });
  }

  function now() {
    return Number(win?.performance?.now?.() || Date.now());
  }

  function tileAdapter() {
    return ctx.tiles || win?.RappDimensionTiles || null;
  }

  function allByDrive() {
    return [...(doc?.querySelectorAll?.("[data-drive]") || [])];
  }

  function findByHandle(handle) {
    const requested = String(handle || "").trim();
    if (!requested) return null;
    if (requested.startsWith("#")) return doc?.getElementById?.(requested.slice(1)) || null;
    const raw = requested.startsWith("@") ? requested.slice(1) : requested;
    return allByDrive().find((element) => (
      String(element.dataset?.drive || element.getAttribute?.("data-drive") || "") === raw
    )) || null;
  }

  function driveHandle(element) {
    const drive = element?.dataset?.drive || element?.getAttribute?.("data-drive");
    if (drive) return `@${drive}`;
    if (element?.id) return `#${element.id}`;
    return "";
  }

  function shellHandle(handle) {
    const raw = String(handle || "").replace(/^@/, "");
    return [
      "arena.",
      "binder.",
      "herd.",
      "shell.",
      "tiles.",
    ].some((prefix) => raw.startsWith(prefix));
  }

  function normalizedText(element) {
    return String(
      element?.innerText
      || element?.textContent
      || element?.value
      || "",
    ).replace(/\s+/g, " ").trim();
  }

  function elementRect(element) {
    const rect = element?.getBoundingClientRect?.() || {};
    return {
      bottom: Number(rect.bottom) || (Number(rect.top) || 0) + (Number(rect.height) || 40),
      height: Number(rect.height) || 40,
      left: Number(rect.left) || 0,
      right: Number(rect.right) || (Number(rect.left) || 0) + (Number(rect.width) || 120),
      top: Number(rect.top) || 0,
      width: Number(rect.width) || 120,
    };
  }

  function center(rect) {
    return {
      x: rect.left + (rect.width / 2),
      y: rect.top + (rect.height / 2),
    };
  }

  function createDataTransfer(values = {}) {
    let transfer = null;
    try {
      transfer = win?.DataTransfer ? new win.DataTransfer() : null;
    } catch {
      transfer = null;
    }
    if (!transfer) {
      const data = new Map();
      transfer = {
        dropEffect: "none",
        effectAllowed: "all",
        files: [],
        items: [],
        get types() {
          return [...data.keys()];
        },
        clearData(type) {
          if (type) data.delete(type);
          else data.clear();
        },
        getData(type) {
          return data.get(type) || "";
        },
        setData(type, value) {
          data.set(String(type), String(value));
        },
      };
    }
    for (const [type, value] of Object.entries(values)) {
      transfer.setData(type, value);
    }
    return transfer;
  }

  function transferValues(transfer) {
    const values = {};
    for (const type of [...(transfer?.types || [])]) {
      values[type] = transfer.getData(type);
    }
    return values;
  }

  function makeEvent(type, options = {}, family = "event") {
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...options,
    };
    let event = null;
    const Constructor = family === "drag"
      ? win?.DragEvent
      : family === "pointer"
        ? win?.PointerEvent
        : family === "keyboard"
          ? win?.KeyboardEvent
          : win?.Event;
    try {
      event = Constructor ? new Constructor(type, common) : null;
    } catch {
      event = null;
    }
    if (!event && doc?.createEvent) {
      event = doc.createEvent("Event");
      event.initEvent(type, true, true);
    }
    if (!event) {
      event = {
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        type,
      };
    }
    for (const [name, value] of Object.entries(common)) {
      if (event[name] === value) continue;
      try {
        Object.defineProperty(event, name, {
          configurable: true,
          value,
        });
      } catch {
        // Native event fields already carry the requested value.
      }
    }
    const attributed = setEventActor(event);
    if (win) {
      win.__rappAutopilotEvents ||= new WeakSet();
      win.__rappAutopilotEvents.add(attributed);
    }
    return attributed;
  }

  function dispatchPointer(element, type, point, pointerId = 9137) {
    const event = makeEvent(type, {
      button: 0,
      buttons: type === "pointerdown" ? 1 : 0,
      clientX: point.x,
      clientY: point.y,
      pointerId,
      pointerType: "mouse",
    }, "pointer");
    element.dispatchEvent(event);
    return event;
  }

  function dispatchDrag(element, type, point, dataTransfer) {
    const event = makeEvent(type, {
      clientX: point.x,
      clientY: point.y,
      dataTransfer,
    }, "drag");
    element.dispatchEvent(event);
    return event;
  }

  function objectKey(element) {
    const tile = element?.closest?.("[data-dimension-tile]")
      || (element?.dataset?.dimensionTile ? element : null);
    if (tile?.dataset?.dimensionTile) return String(tile.dataset.dimensionTile);
    const drive = element?.closest?.("[data-drive]")?.dataset?.drive
      || element?.dataset?.drive
      || "";
    if (drive === "brainstem.primary") return "brainstem.primary";
    const match = String(drive).match(/^herd\.tile\[([^\]]+)\]/);
    return match?.[1] || null;
  }

  function abortGesture(key, reason) {
    const gesture = activeGestures.get(key);
    if (gesture && !gesture.aborted) gesture.aborted = reason;
    for (const remote of remoteDrags.values()) {
      if (remote.key === key && !remote.aborted) remote.aborted = reason;
    }
  }

  function bindGestureKey(gesture, key) {
    if (!gesture || !key) return;
    gesture.keys ||= new Set();
    gesture.keys.add(key);
    activeGestures.set(key, gesture);
  }

  function releaseGesture(gesture) {
    if (!gesture) return;
    for (const key of gesture.keys || [gesture.key]) {
      if (activeGestures.get(key) === gesture) activeGestures.delete(key);
    }
  }

  function humanPointerDown(event) {
    if (eventActor(event) === "ai") return;
    const key = objectKey(event.target);
    if (!key) return;
    heldPointers.set(event.pointerId, key);
    heldByUser.add(key);
    abortGesture(key, "yielded_to_user");
  }

  function releaseHumanPointer(event) {
    if (eventActor(event) === "ai") return;
    const key = heldPointers.get(event.pointerId) || objectKey(event.target);
    heldPointers.delete(event.pointerId);
    if (key && !userDragging.has(key)) heldByUser.delete(key);
  }

  function humanDragStart(event) {
    if (eventActor(event) === "ai") return;
    const key = objectKey(event.target);
    if (!key) return;
    userDragging.add(key);
    heldByUser.add(key);
    abortGesture(key, "yielded_to_user");
  }

  function humanDragEnd(event) {
    if (eventActor(event) === "ai") return;
    const key = objectKey(event.target);
    if (!key) return;
    userDragging.delete(key);
    heldByUser.delete(key);
    for (const [pointerId, heldKey] of heldPointers) {
      if (heldKey === key) heldPointers.delete(pointerId);
    }
  }

  function humanKeyDown(event) {
    if (eventActor(event) === "ai" || event.key !== "Escape") return;
    for (const key of activeGestures.keys()) abortGesture(key, "interrupted");
    for (const remote of remoteDrags.values()) {
      if (!remote.aborted) remote.aborted = "interrupted";
    }
    if (capability && win?.parent && win.parent !== win) {
      win.parent.postMessage({
        type: "rapp-autopilot:interrupt",
        capability,
      }, "*");
    }
  }

  doc?.addEventListener?.("pointerdown", humanPointerDown, true);
  doc?.addEventListener?.("dragstart", humanDragStart, true);
  doc?.addEventListener?.("pointerup", releaseHumanPointer, true);
  doc?.addEventListener?.("pointercancel", releaseHumanPointer, true);
  doc?.addEventListener?.("dragend", humanDragEnd, true);
  doc?.addEventListener?.("keydown", humanKeyDown, true);

  function userHolds(element, key) {
    const adapter = tileAdapter();
    return heldByUser.has(key)
      || userDragging.has(key)
      || adapter?.isUserHolding?.(key) === true
      || element?.classList?.contains?.("dragging")
      || element?.getAttribute?.("aria-grabbed") === "true";
  }

  function createCursor() {
    if (!doc?.createElement || !doc?.body) return null;
    let cursor = doc.getElementById?.("__rappAutopilotCursor");
    if (cursor) return cursor;
    cursor = doc.createElement("div");
    cursor.id = "__rappAutopilotCursor";
    cursor.dataset.rappActor = "ai";
    cursor.setAttribute?.("aria-hidden", "true");
    cursor.textContent = "AI";
    Object.assign(cursor.style || {}, {
      alignItems: "center",
      background: "#58a6ff",
      border: "2px solid #ffffff",
      borderRadius: "999px",
      boxShadow: "0 3px 14px rgba(0,0,0,.45)",
      color: "#08111c",
      display: "flex",
      font: "700 9px/1 system-ui,sans-serif",
      height: "25px",
      justifyContent: "center",
      left: "0",
      opacity: "0",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      transform: "translate(-100px,-100px)",
      transition: "none",
      width: "25px",
      zIndex: "2147483647",
    });
    doc.body.appendChild(cursor);
    return cursor;
  }

  function placeCursor(cursor, point, opacity = "1") {
    if (!cursor?.style) return;
    cursor.style.opacity = opacity;
    cursor.style.transform = `translate(${Math.round(point.x)}px,${Math.round(point.y)}px)`;
  }

  async function moveCursor(cursor, from, to, tempo, gesture = null) {
    placeCursor(cursor, from);
    const steps = Math.max(1, tempo.steps);
    const delay = tempo.moveMs / steps;
    for (let index = 1; index <= steps; index += 1) {
      if (gesture?.aborted) return false;
      const progress = index / steps;
      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - (Math.pow(-2 * progress + 2, 2) / 2);
      placeCursor(cursor, {
        x: from.x + ((to.x - from.x) * eased),
        y: from.y + ((to.y - from.y) * eased),
      });
      if (delay) await sleep(delay);
    }
    return !gesture?.aborted;
  }

  function hideCursor(cursor) {
    if (cursor?.style) cursor.style.opacity = "0";
  }

  async function waitUntil(predicate, timeoutMs = 7000) {
    const deadline = now() + timeoutMs;
    do {
      if (await predicate()) return true;
      await sleep(40);
    } while (now() < deadline);
    return false;
  }

  function completionTracker(type, matches) {
    let detail = null;
    const receive = (event) => {
      if (!matches || matches(event.detail || {})) detail = event.detail || {};
    };
    win?.addEventListener?.(type, receive);
    return {
      detail: () => detail,
      matched: () => Boolean(detail),
      stop() {
        win?.removeEventListener?.(type, receive);
      },
    };
  }

  function beginLocalDrag(element, key, values) {
    if (!element) {
      return { ok: false, reason: "drag_source_unavailable" };
    }
    if (userHolds(element, key)) {
      return { ok: false, reason: "yielded_to_user" };
    }
    const rect = elementRect(element);
    const point = center(rect);
    const transfer = createDataTransfer();
    const gesture = {
      aborted: null,
      element,
      key,
      keys: new Set(),
      point,
      transfer,
    };
    bindGestureKey(gesture, key);
    dispatchPointer(element, "pointerdown", point);
    if (gesture.aborted) return { ok: false, reason: gesture.aborted, gesture };
    const started = dispatchDrag(element, "dragstart", point, transfer);
    dispatchPointer(element, "pointercancel", point);
    if (started.defaultPrevented) {
      return { ok: false, reason: "drag_start_refused", gesture };
    }
    const expectedTypes = Object.keys(values);
    if (!expectedTypes.every((type) => [...transfer.types].includes(type))) {
      return { ok: false, reason: "drag_payload_missing", gesture };
    }
    return {
      ok: true,
      gesture,
      rect,
      values: transferValues(transfer),
    };
  }

  function endLocalDrag(started) {
    const gesture = started?.gesture;
    if (!gesture) return;
    dispatchDrag(gesture.element, "dragend", gesture.point, gesture.transfer);
    releaseGesture(gesture);
  }

  function enterLocalDrag(element, values) {
    if (!element) return { handled: false, reason: "drag_target_unavailable" };
    const rect = elementRect(element);
    const point = center(rect);
    const transfer = createDataTransfer(values);
    const entered = dispatchDrag(element, "dragenter", point, transfer);
    const over = dispatchDrag(element, "dragover", point, transfer);
    return {
      element,
      handled: entered.defaultPrevented || over.defaultPrevented,
      point,
      rect,
      transfer,
    };
  }

  function dropLocalDrag(entered) {
    if (!entered?.element) {
      return { handled: false, reason: "drag_target_unavailable" };
    }
    const dropped = dispatchDrag(
      entered.element,
      "drop",
      entered.point,
      entered.transfer,
    );
    return { handled: dropped.defaultPrevented };
  }

  function cancelLocalTarget(entered) {
    if (!entered?.element) return;
    dispatchDrag(
      entered.element,
      "dragleave",
      entered.point,
      entered.transfer,
    );
  }

  function shellFrame() {
    return findByHandle("shell.brainstem") || doc?.getElementById?.("brainstem") || null;
  }

  function isShellPage() {
    return Boolean(shellFrame());
  }

  function messageId() {
    messageSequence += 1;
    return `rapp-autopilot-${Date.now()}-${messageSequence}`;
  }

  function sendRequest(targetWindow, action, payload = {}, timeoutMs = 12000) {
    if (!capability || !targetWindow?.postMessage) {
      return Promise.reject(new Error("The target UI frame is unavailable."));
    }
    const id = messageId();
    return new Promise((resolve, reject) => {
      const timer = (win?.setTimeout || setTimeout)(() => {
        pendingMessages.delete(id);
        reject(new Error(`Timed out waiting for ${action}.`));
      }, timeoutMs);
      pendingMessages.set(id, {
        reject,
        resolve(value) {
          (win?.clearTimeout || clearTimeout)(timer);
          resolve(value);
        },
        source: targetWindow,
      });
      targetWindow.postMessage({
        type: "rapp-autopilot:request",
        action,
        capability,
        id,
        payload,
      }, "*");
    });
  }

  function requestFrame(action, payload = {}, timeoutMs = 12000) {
    return sendRequest(shellFrame()?.contentWindow, action, payload, timeoutMs);
  }

  function requestParent(action, payload = {}, timeoutMs = 12000) {
    if (!win?.parent || win.parent === win) {
      return Promise.reject(new Error("The OpenRappter shell is unavailable."));
    }
    return sendRequest(win.parent, action, payload, timeoutMs);
  }

  function framePoint(rect) {
    const frameRect = elementRect(shellFrame());
    return {
      bottom: frameRect.top + rect.bottom,
      height: rect.height,
      left: frameRect.left + rect.left,
      right: frameRect.left + rect.right,
      top: frameRect.top + rect.top,
      width: rect.width,
    };
  }

  async function performDrag({
    key,
    source,
    sourceRemote = false,
    target,
    targetKey = null,
    targetRemote = false,
    values,
    speed,
    verify,
  }) {
    const tempo = SPEEDS[speed] || SPEEDS.natural;
    let started = null;
    let remoteId = null;
    let gesture = null;
    let sourceRect = null;
    let targetId = null;
    let entered = null;
    let dropped = false;
    const cursor = createCursor();
    try {
      if (sourceRemote) {
        remoteId = messageId();
        started = await requestFrame("drag.start", {
          id: remoteId,
          key,
          role: source,
          values,
        });
        if (!started?.ok) {
          return {
            ok: false,
            reason: started?.reason || "drag_start_refused",
          };
        }
        sourceRect = framePoint(started.rect);
        gesture = { aborted: null, key, keys: new Set() };
        bindGestureKey(gesture, key);
      } else {
        started = beginLocalDrag(source, key, values);
        if (!started.ok) {
          return { ok: false, reason: started.reason };
        }
        sourceRect = started.rect;
        gesture = started.gesture;
      }

      let targetRect;
      if (targetRemote) {
        const bounds = await requestFrame("drag.bounds", { role: target });
        if (!bounds?.ok) {
          return {
            ok: false,
            reason: bounds?.reason || "drag_target_unavailable",
          };
        }
        targetRect = framePoint(bounds.rect);
      } else {
        if (targetKey && userHolds(target, targetKey)) {
          return { ok: false, reason: "yielded_to_user" };
        }
        bindGestureKey(gesture, targetKey);
        targetRect = elementRect(target);
      }
      const moved = await moveCursor(
        cursor,
        center(sourceRect),
        center(targetRect),
        tempo,
        gesture,
      );
      if (!moved || gesture.aborted) {
        return { ok: false, reason: gesture.aborted || "interrupted" };
      }
      if (sourceRemote) {
        const status = await requestFrame("drag.status", { id: remoteId });
        if (!status?.ok) {
          return {
            ok: false,
            reason: status?.reason || "yielded_to_user",
          };
        }
      }
      if (targetRemote) {
        targetId = messageId();
        entered = await requestFrame("drag.enter", {
          id: targetId,
          role: target,
          targetKey,
          values: started.values,
        });
      } else {
        entered = enterLocalDrag(target, started.values);
      }
      if (!entered?.handled) {
        return {
          ok: false,
          reason: entered?.reason || "drop_not_handled",
        };
      }
      if (tempo.hoverMs) await sleep(tempo.hoverMs);
      if (gesture.aborted) {
        return { ok: false, reason: gesture.aborted };
      }
      if (sourceRemote) {
        const status = await requestFrame("drag.status", { id: remoteId });
        if (!status?.ok) {
          return {
            ok: false,
            reason: status?.reason || "yielded_to_user",
          };
        }
      }
      const targeted = targetRemote
        ? await requestFrame("drag.drop", { id: targetId })
        : dropLocalDrag(entered);
      if (!targeted?.handled) {
        return {
          ok: false,
          reason: targeted?.reason || "drop_not_handled",
        };
      }
      dropped = true;
      const changed = await waitUntil(verify);
      if (!changed) {
        return {
          ok: false,
          reason: "drop_not_handled",
        };
      }
      return { ok: true };
    } finally {
      if (targetRemote && targetId && !dropped) {
        await requestFrame("drag.cancel-target", { id: targetId }).catch(() => {});
      } else if (!targetRemote && entered && !dropped) {
        cancelLocalTarget(entered);
      }
      if (sourceRemote && remoteId) {
        await requestFrame("drag.end", { id: remoteId }).catch(() => {});
        releaseGesture(gesture);
      } else {
        endLocalDrag(started);
      }
      hideCursor(cursor);
    }
  }

  function modelSendInputError(argument) {
    return new AutopilotInputError(
      argument,
      "a non-model UI action; use chat.send for model calls",
      `Argument ${argument} does not accept the chat send control; use chat.send, `
        + "which costs a model call.",
    );
  }

  async function clickElement(element, { animate = true, allowSend = false } = {}) {
    if (!element) {
      throw new AutopilotInputError(
        "handle",
        "an existing data-drive handle",
        "Argument handle requires an existing data-drive handle.",
      );
    }
    if (element.disabled || element.getAttribute?.("aria-disabled") === "true") {
      throw new Error(`UI control ${driveHandle(element) || "(unknown)"} is disabled.`);
    }
    if (!allowSend && element === chatSendControl()) {
      throw modelSendInputError("handle");
    }
    const point = center(elementRect(element));
    const cursor = createCursor();
    if (animate) {
      const current = center(elementRect(cursor));
      await moveCursor(cursor, current, point, {
        hoverMs: 0,
        moveMs: 140,
        steps: 5,
      });
    } else {
      placeCursor(cursor, point);
    }
    dispatchPointer(element, "pointerdown", point);
    dispatchPointer(element, "pointerup", point);
    element.click();
    hideCursor(cursor);
    return {
      actor: "ai",
      handle: driveHandle(element),
    };
  }

  function keyDetails(key) {
    const aliases = {
      esc: "Escape",
      return: "Enter",
      space: " ",
      spacebar: " ",
    };
    const requested = String(key || "");
    const normalized = aliases[requested.toLowerCase()] || requested;
    const allowed = new Set([
      " ",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "Backspace",
      "Delete",
      "End",
      "Enter",
      "Escape",
      "Home",
      "PageDown",
      "PageUp",
      "Tab",
    ]);
    if (normalized.length !== 1 && !allowed.has(normalized)) {
      throw new AutopilotInputError(
        "key",
        "a single character or a named navigation key",
        `Argument key does not accept "${requested}"; use a single character or a named navigation key.`,
      );
    }
    return {
      code: normalized === " " ? "Space" : normalized,
      key: normalized,
    };
  }

  function localPress(key) {
    const details = keyDetails(key);
    const element = doc?.activeElement || doc?.body;
    if (!element) throw new Error("The page has no keyboard target.");
    if (
      (details.key === "Enter" && element === chatInput())
      || (
        ["Enter", " "].includes(details.key)
        && element === chatSendControl()
      )
    ) {
      throw modelSendInputError("key");
    }
    const down = makeEvent("keydown", details, "keyboard");
    const up = makeEvent("keyup", details, "keyboard");
    element.dispatchEvent(down);
    let handled = down.defaultPrevented;
    if (!handled && ["button", "a"].includes(element.localName)) {
      if (details.key === "Enter" || details.key === " ") {
        element.click();
        handled = true;
      }
    }
    if (!handled && details.key === "Enter" && element.localName === "input") {
      const form = element.closest?.("form");
      if (form?.requestSubmit) {
        form.requestSubmit();
        handled = true;
      }
    }
    if (
      !handled
      && ["input", "textarea"].includes(element.localName)
      && (
        details.key.length === 1
        || ["Backspace", "Delete"].includes(details.key)
        || (details.key === "Enter" && element.localName === "textarea")
      )
    ) {
      const value = String(element.value || "");
      const start = Number.isInteger(element.selectionStart)
        ? element.selectionStart
        : value.length;
      const end = Number.isInteger(element.selectionEnd)
        ? element.selectionEnd
        : start;
      let next = value;
      let caret = start;
      if (details.key === "Backspace" && start === end && start > 0) {
        next = value.slice(0, start - 1) + value.slice(end);
        caret = start - 1;
      } else if (details.key === "Delete" && start === end) {
        next = value.slice(0, start) + value.slice(start + 1);
      } else {
        const inserted = details.key === "Enter" ? "\n" : details.key;
        next = value.slice(0, start) + inserted + value.slice(end);
        caret = start + inserted.length;
      }
      setControlValue(element, next);
      element.setSelectionRange?.(caret, caret);
      handled = true;
    }
    if (!handled && details.key === "Tab") {
      const controls = [...(doc?.querySelectorAll?.(
        "button,input,textarea,select,a[href],[tabindex]",
      ) || [])].filter((control) => !control.disabled);
      const index = controls.indexOf(element);
      const next = controls[(index + 1) % Math.max(1, controls.length)];
      if (next) {
        next.focus?.();
        if (doc && !next.focus) doc.activeElement = next;
        handled = true;
      }
    }
    element.dispatchEvent(up);
    return {
      actor: "ai",
      handled,
      key: details.key === " " ? "Space" : details.key,
    };
  }

  function outline(limit = 80) {
    const selector = [
      "[data-drive]",
      "button",
      "input",
      "textarea",
      "select",
      "a[href]",
      "[tabindex]",
    ].join(",");
    const elements = [...(doc?.querySelectorAll?.(selector) || [])];
    const seen = new Set();
    const rows = [];
    for (const element of elements) {
      if (rows.length >= limit) break;
      const handle = driveHandle(element);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      rows.push({
        handle,
        role: String(
          element.getAttribute?.("role")
          || element.localName
          || element.tagName
          || "",
        ).toLowerCase(),
        name: normalizedText(element).slice(0, 180),
        state: element.disabled
          ? "disabled"
          : element.getAttribute?.("aria-pressed") === "true"
            ? "pressed"
            : "enabled",
      });
    }
    return rows;
  }

  async function localWait(handle, text, timeoutMs = 10000) {
    let found = null;
    const matched = await waitUntil(() => {
      found = findByHandle(handle);
      return Boolean(found && (
        text === undefined
        || normalizedText(found).includes(String(text))
      ));
    }, timeoutMs);
    if (!matched) {
      throw new Error(
        text === undefined
          ? `Timed out waiting for ${handle}.`
          : `Timed out waiting for ${handle} to contain "${text}".`,
      );
    }
    return {
      handle: driveHandle(found),
      text: normalizedText(found).slice(0, 2000),
    };
  }

  function chatInput() {
    return findByHandle("brainstem.composer")
      || doc?.getElementById?.("input")
      || doc?.querySelector?.("textarea");
  }

  function chatSendControl() {
    return findByHandle("brainstem.send")
      || doc?.getElementById?.("send");
  }

  function chatRequestIds() {
    const chat = findByHandle("brainstem.chat") || doc?.getElementById?.("chat");
    return new Set(
      [...(chat?.querySelectorAll?.(".response-slot") || [])]
        .map((slot) => String(slot.dataset?.requestId || ""))
        .filter(Boolean),
    );
  }

  function modelCallStarted(before) {
    return [...chatRequestIds()].some((requestId) => !before.has(requestId));
  }

  async function observeModelCall(action) {
    const before = chatRequestIds();
    try {
      const result = await action();
      await Promise.resolve();
      return {
        ...(result && typeof result === "object" ? result : {}),
        costs_model: modelCallStarted(before),
      };
    } catch (error) {
      await Promise.resolve();
      if (modelCallStarted(before)) error.costsModel = true;
      throw error;
    }
  }

  function setControlValue(element, value) {
    const next = String(value);
    const prototype = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, next);
    else element.value = next;
    element.dispatchEvent(makeEvent("input", {
      data: next,
      inputType: "insertText",
    }));
    element.dispatchEvent(makeEvent("change"));
  }

  async function localChatRead(last) {
    let messages;
    let previouslyOmitted = 0;
    if (suppliedChat?.read) {
      const response = await suppliedChat.read({ last });
      messages = Array.isArray(response) ? response : response?.turns || [];
      previouslyOmitted = Number(response?.turns_omitted) || 0;
    } else {
      const chat = findByHandle("brainstem.chat") || doc?.getElementById?.("chat");
      if (!chat) throw new Error("The visible Brainstem transcript is unavailable.");
      messages = [...chat.querySelectorAll?.(".msg.user,.msg.assistant") || []]
        .filter((message) => (
          !message.classList?.contains?.("typing-indicator")
          && !message.classList?.contains?.("stream-arriving")
          && !message.hasAttribute?.("data-rapp-provisional")
        ))
        .map((message) => ({
          role: message.classList?.contains?.("user") ? "user" : "assistant",
          text: normalizedText(message.querySelector?.(".bubble") || message).slice(0, 16000),
        }));
    }
    const limit = last ?? CHAT_READ_DEFAULT_TURNS;
    const turns = messages.slice(-limit);
    return {
      turns,
      turns_omitted: previouslyOmitted + Math.max(0, messages.length - turns.length),
    };
  }

  async function localChatType(text) {
    if (suppliedChat?.type) {
      await suppliedChat.type(String(text));
    } else {
      const input = chatInput();
      if (!input) throw new Error("The visible Brainstem composer is unavailable.");
      setControlValue(input, text);
    }
    return {
      actor: "ai",
      text: String(text),
      typed: true,
    };
  }

  async function localChatSend(text) {
    if (suppliedChat?.send) {
      const sent = await suppliedChat.send(String(text));
      return {
        actor: "ai",
        sent: true,
        ...(sent && typeof sent === "object" ? sent : {}),
      };
    }
    await localChatType(text);
    const send = chatSendControl();
    if (!send) throw new Error("The visible Brainstem send control is unavailable.");
    const before = new Set(
      [...(doc?.querySelectorAll?.("#chat .response-slot[data-request-id]") || [])]
        .map((slot) => String(slot.dataset?.requestId || "")),
    );
    await clickElement(send, { allowSend: true });
    let requestId = null;
    const accepted = await waitUntil(() => {
      const slots = [...(doc?.querySelectorAll?.(
        "#chat .response-slot[data-request-id]",
      ) || [])];
      const created = slots.find((slot) => !before.has(String(slot.dataset?.requestId || "")));
      requestId = created?.dataset?.requestId || null;
      return Boolean(created);
    }, 2500);
    if (!accepted) {
      throw new Error("The visible Brainstem did not accept the chat request.");
    }
    return {
      actor: "ai",
      sent: true,
      ...(requestId ? { request_id: requestId } : {}),
    };
  }

  function currentSurface() {
    const adapter = tileAdapter();
    const fromAdapter = adapter?.currentSurface?.();
    if (SURFACES.includes(fromAdapter)) return fromAdapter;
    const herd = doc?.getElementById?.("surgeon-herd");
    const fromHerd = herd?.dataset?.tileSurface;
    if (SURFACES.includes(fromHerd)) return fromHerd;
    const surface = doc?.querySelector?.(".dimension-tile-surface");
    return SURFACES.includes(surface?.dataset?.surface)
      ? surface.dataset.surface
      : null;
  }

  function surfaceControl(surface) {
    const adapter = tileAdapter();
    return adapter?.surfaceControl?.(surface)
      || findByHandle(`tiles.surface.${surface}`);
  }

  function surfaceElement(surface) {
    const adapter = tileAdapter();
    return adapter?.surface?.(surface)
      || (
        currentSurface() === surface
          ? findByHandle(`tiles.surface[${surface}]`)
            || doc?.querySelector?.(".dimension-tile-surface")
          : null
      );
  }

  async function openSurface(surface) {
    const control = surfaceControl(surface);
    if (!control) {
      throw new Error(
        `The ${surface} surface control is unavailable; Agent Arena must be open in the visible UI.`,
      );
    }
    if (currentSurface() !== surface) {
      await clickElement(control, { animate: false });
      const opened = await waitUntil(() => currentSurface() === surface, 5000);
      if (!opened) throw new Error(`The ${surface} surface did not open.`);
    }
    return surfaceElement(surface);
  }

  function tileElement(id) {
    const adapter = tileAdapter();
    const found = adapter?.find?.(id);
    if (found) return found;
    return [...(doc?.querySelectorAll?.("[data-dimension-tile]") || [])]
      .find((element) => String(element.dataset?.dimensionTile || "") === id)
      || findByHandle(`herd.tile[${id}]`);
  }

  function tileRecord(element) {
    if (!element) return null;
    const id = String(
      element.dataset?.dimensionTile
      || String(element.dataset?.drive || "").match(/^herd\.tile\[([^\]]+)\]/)?.[1]
      || "",
    );
    return {
      id,
      title: normalizedText(
        element.querySelector?.(".dimension-tile-banner strong")
        || element.querySelector?.("strong")
        || element,
      ).slice(0, 180),
      status: String(element.dataset?.status || ""),
      surface: String(element.dataset?.surface || currentSurface() || ""),
      bunch: String(element.dataset?.bunch || ""),
    };
  }

  function visibleTiles() {
    const adapter = tileAdapter();
    const supplied = adapter?.list?.(currentSurface());
    if (Array.isArray(supplied)) {
      return supplied.map((item) => (
        item?.dispatchEvent ? tileRecord(item) : {
          id: String(item.id || ""),
          title: String(item.title || ""),
          status: String(item.status || ""),
          surface: String(item.surface || currentSurface() || ""),
          bunch: String(item.bunch || ""),
        }
      ));
    }
    return [...(doc?.querySelectorAll?.("[data-dimension-tile]") || [])]
      .map(tileRecord)
      .filter((tile) => tile?.id);
  }

  async function locateTile(id) {
    const initialSurface = currentSurface();
    let found = tileElement(id);
    if (found) return { element: found, surface: currentSurface() };
    for (const surface of SURFACES) {
      await openSurface(surface);
      found = tileElement(id);
      if (found) return { element: found, surface };
    }
    if (initialSurface && currentSurface() !== initialSurface) {
      await openSurface(initialSurface).catch(() => {});
    }
    throw new Error(`Tile "${id}" is not present on the herd, arena, or binder surface.`);
  }

  function descendantByHandle(element, handle) {
    return [...(element?.querySelectorAll?.("[data-drive]") || [])]
      .find((candidate) => candidate.dataset?.drive === handle)
      || null;
  }

  function primaryTarget() {
    return tileAdapter()?.primaryTarget?.()
      || findByHandle("brainstem.primary");
  }

  function chatDragSource() {
    return tileAdapter()?.chatSource?.()
      || findByHandle("brainstem.primary");
  }

  function emitChange(cmd, detail = {}) {
    if (doc?.body && doc?.createElement) {
      let badge = doc.getElementById?.("__rappAutopilotActor");
      if (!badge) {
        badge = doc.createElement("div");
        badge.id = "__rappAutopilotActor";
        badge.dataset.rappActor = "ai";
        badge.setAttribute?.("role", "status");
        Object.assign(badge.style || {}, {
          background: "rgba(13,17,23,.92)",
          border: "1px solid #58a6ff",
          borderRadius: "999px",
          bottom: "18px",
          color: "#c9e6ff",
          font: "600 11px/1.2 system-ui,sans-serif",
          padding: "7px 10px",
          pointerEvents: "none",
          position: "fixed",
          right: "18px",
          zIndex: "2147483647",
        });
        doc.body.appendChild(badge);
      }
      badge.textContent = `AI · ${cmd}`;
      (win?.setTimeout || setTimeout)(() => badge.remove?.(), 1400);
    }
    if (!doc?.dispatchEvent) return;
    let event = null;
    try {
      event = win?.CustomEvent
        ? new win.CustomEvent("rapp-autopilot:change", {
            detail: { actor: "ai", cmd, ...detail },
          })
        : null;
    } catch {
      event = null;
    }
    if (event) doc.dispatchEvent(setEventActor(event));
  }

  async function runSurface(surface) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", {
        args: {},
        cmd: surface === "arena"
          ? "arena.switch"
          : `${surface}.open`,
      });
    }
    await openSurface(surface);
    emitChange(surface === "arena" ? "arena.switch" : `${surface}.open`, {
      view: surface,
    });
    return { actor: "ai", ok: true, view: surface };
  }

  async function runList(surface) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", {
        args: {},
        cmd: `${surface}.list`,
      });
    }
    const initialSurface = currentSurface();
    try {
      await openSurface(surface);
      return {
        ok: true,
        surface,
        tiles: visibleTiles().filter((tile) => tile.surface === surface),
      };
    } finally {
      if (initialSurface && currentSurface() !== initialSurface) {
        await openSurface(initialSurface).catch(() => {});
      }
    }
  }

  async function runTileMove(args) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args, cmd: "tile.move" });
    }
    const located = await locateTile(args.id);
    const from = located.surface || tileRecord(located.element)?.surface;
    if (from === args.to) {
      return {
        ok: false,
        reason: "already_on_surface",
        error: `Tile "${args.id}" is already on the ${args.to} surface.`,
      };
    }
    const target = surfaceControl(args.to);
    if (!target) throw new Error(`The ${args.to} surface drop target is unavailable.`);
    const completion = completionTracker(
      "rapp-beta:tile-move-complete",
      (detail) => (
        detail.actor === "ai"
        && detail.id === args.id
        && detail.surface === args.to
      ),
    );
    let moved;
    try {
      moved = await performDrag({
        key: args.id,
        source: located.element,
        target,
        values: { "application/x-rapp-dimension-tile": args.id },
        speed: args.speed,
        verify: completion.matched,
      });
    } finally {
      completion.stop();
    }
    if (!moved.ok) {
      return {
        ok: false,
        reason: moved.reason,
        ...(moved.reason === "yielded_to_user"
          ? {}
          : { error: `The drop for tile "${args.id}" was not handled by the visible UI.` }),
      };
    }
    emitChange("tile.move", { id: args.id, from, to: args.to });
    return {
      actor: "ai",
      from,
      id: args.id,
      ok: true,
      to: args.to,
    };
  }

  async function runTilePrimary(args) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args, cmd: "tile.primary" });
    }
    const located = await locateTile(args.id);
    const localTarget = primaryTarget();
    const targetRemote = !localTarget && Boolean(shellFrame()?.contentWindow);
    if (!localTarget && !targetRemote) {
      throw new Error("The Brainstem primary drop target is unavailable.");
    }
    const completion = completionTracker(
      "rapp-beta:tile-primary-complete",
      (detail) => detail.actor === "ai" && detail.id === args.id,
    );
    let moved;
    try {
      moved = await performDrag({
        key: args.id,
        source: located.element,
        target: targetRemote ? "primary" : localTarget,
        targetKey: "brainstem.primary",
        targetRemote,
        values: { "application/x-rapp-dimension-tile": args.id },
        speed: args.speed,
        verify: completion.matched,
      });
    } finally {
      completion.stop();
    }
    if (!moved.ok) {
      return {
        ok: false,
        reason: moved.reason,
        ...(moved.reason === "yielded_to_user"
          ? {}
          : { error: `Tile "${args.id}" did not become primary through the visible drop target.` }),
      };
    }
    emitChange("tile.primary", { id: args.id });
    return {
      actor: "ai",
      id: args.id,
      ok: true,
      primary: true,
    };
  }

  async function runTilePark(args) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args, cmd: "tile.park" });
    }
    await openSurface(args.to);
    const target = surfaceElement(args.to);
    if (!target) throw new Error(`The ${args.to} surface drop target is unavailable.`);
    const localSource = chatDragSource();
    const sourceRemote = !localSource && Boolean(shellFrame()?.contentWindow);
    if (!localSource && !sourceRemote) {
      throw new Error("The Brainstem primary chat drag handle is unavailable.");
    }
    const completion = completionTracker(
      "rapp-beta:tile-park-complete",
      (detail) => detail.actor === "ai" && detail.surface === args.to,
    );
    let moved;
    try {
      moved = await performDrag({
        key: "brainstem.primary",
        source: sourceRemote ? "primary" : localSource,
        sourceRemote,
        target,
        values: { "application/x-rapp-brainstem-chat": "primary" },
        speed: args.speed,
        verify: completion.matched,
      });
    } finally {
      completion.stop();
    }
    if (!moved.ok) {
      return {
        ok: false,
        reason: moved.reason,
        ...(moved.reason === "yielded_to_user"
          ? {}
          : { error: "The primary chat was not parked through the visible drop target." }),
      };
    }
    const parked = completion.detail();
    emitChange("tile.park", { id: parked?.id || null, to: args.to });
    return {
      actor: "ai",
      ...(parked?.id ? { id: parked.id } : {}),
      ok: true,
      to: args.to,
    };
  }

  async function runTileBunch(args) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args, cmd: "tile.bunch" });
    }
    const sourceLocation = await locateTile(args.source_id);
    const sourceSurface = sourceLocation.surface;
    let target = tileElement(args.target_id);
    if (!target) {
      const targetLocation = await locateTile(args.target_id);
      if (targetLocation.surface !== sourceSurface) {
        return {
          ok: false,
          reason: "different_surfaces",
          error: "Tiles must share a visible surface before they can be bunched.",
        };
      }
      target = targetLocation.element;
    }
    await openSurface(sourceSurface);
    const source = tileElement(args.source_id);
    target = tileElement(args.target_id);
    if (!source || !target) {
      throw new Error("Both tiles must be visible on the same surface to bunch them.");
    }
    const completion = completionTracker(
      "rapp-beta:tile-bunch-complete",
      (detail) => (
        detail.actor === "ai"
        && detail.sourceId === args.source_id
        && detail.targetId === args.target_id
      ),
    );
    let moved;
    try {
      moved = await performDrag({
        key: args.source_id,
        source,
        target,
        targetKey: args.target_id,
        values: { "application/x-rapp-dimension-tile": args.source_id },
        speed: args.speed,
        verify: completion.matched,
      });
    } finally {
      completion.stop();
    }
    if (!moved.ok) {
      return {
        ok: false,
        reason: moved.reason,
        ...(moved.reason === "yielded_to_user"
          ? {}
          : { error: "The bunch drop was not handled by the visible tile." }),
      };
    }
    const bunch = completion.detail()?.bunch || "";
    emitChange("tile.bunch", {
      bunch,
      source_id: args.source_id,
      target_id: args.target_id,
    });
    return {
      actor: "ai",
      bunch,
      ok: true,
      source_id: args.source_id,
      target_id: args.target_id,
    };
  }

  async function runTileUnbunch(args) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args, cmd: "tile.unbunch" });
    }
    const located = await locateTile(args.id);
    if (!tileRecord(located.element)?.bunch) {
      return {
        ok: false,
        reason: "not_bunched",
        error: `Tile "${args.id}" is not in a bunch.`,
      };
    }
    const target = surfaceElement(located.surface);
    const completion = completionTracker(
      "rapp-beta:tile-move-complete",
      (detail) => (
        detail.actor === "ai"
        && detail.id === args.id
        && detail.surface === located.surface
      ),
    );
    let moved;
    try {
      moved = await performDrag({
        key: args.id,
        source: located.element,
        target,
        values: { "application/x-rapp-dimension-tile": args.id },
        speed: "natural",
        verify: completion.matched,
      });
    } finally {
      completion.stop();
    }
    if (!moved.ok) {
      return {
        ok: false,
        reason: moved.reason,
        ...(moved.reason === "yielded_to_user"
          ? {}
          : { error: `Tile "${args.id}" did not leave its bunch through the visible drop target.` }),
      };
    }
    emitChange("tile.unbunch", { id: args.id });
    return { actor: "ai", id: args.id, ok: true, unbunched: true };
  }

  async function runTileFold(args) {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args, cmd: "tile.fold" });
    }
    const located = await locateTile(args.id);
    const handle = `herd.tile[${args.id}].fold`;
    const control = descendantByHandle(located.element, handle) || findByHandle(handle);
    if (!control) throw new Error(`The fold control for tile "${args.id}" is unavailable.`);
    await clickElement(control);
    const folded = await waitUntil(() => (
      tileRecord(tileElement(args.id))?.status === "folded"
    ));
    if (!folded) throw new Error(`Tile "${args.id}" did not fold through its visible control.`);
    lastFoldedTileId = args.id;
    emitChange("tile.fold", { id: args.id });
    return { actor: "ai", folded: true, id: args.id, ok: true };
  }

  async function runTileUndo() {
    if (!isShellPage() && win?.parent && win.parent !== win) {
      return requestParent("command", { args: {}, cmd: "tile.undo" });
    }
    const preferredTile = lastFoldedTileId ? tileElement(lastFoldedTileId) : null;
    const control = descendantByHandle(preferredTile, "tiles.undo")
      || findByHandle("tiles.undo");
    if (!control) {
      throw new Error("The visible 10 second tile undo control is unavailable.");
    }
    const foldedBefore = new Set(
      visibleTiles().filter((tile) => tile.status === "folded").map((tile) => tile.id),
    );
    await clickElement(control);
    const undone = await waitUntil(() => (
      visibleTiles().some((tile) => (
        foldedBefore.has(tile.id) && tile.status !== "folded"
      ))
    ));
    if (!undone) throw new Error("The visible tile undo control did not restore a folded tile.");
    lastFoldedTileId = null;
    emitChange("tile.undo");
    return { actor: "ai", ok: true, undone: true };
  }

  const registry = Object.freeze([
    descriptor({
      cmd: "help",
      args: [],
      flags: [],
      costsModel: false,
      does: "describe every implemented Autopilot command",
      example: "help",
      run: async () => ({
        ok: true,
        version: AUTOPILOT_VERSION,
        commands: registry.map(helpEntry),
      }),
    }),
    descriptor({
      cmd: "ui.inspect",
      args: [],
      flags: [{ name: "target", type: "shell|brainstem", required: false }],
      costsModel: false,
      does: "read a capped outline of operable UI controls",
      example: "ui.inspect --target brainstem",
      run: async (args) => {
        const target = args.target || "brainstem";
        if (target === "shell") {
          if (isShellPage()) return { ok: true, target, outline: outline() };
          return requestParent("ui.inspect", { target });
        }
        if (isShellPage()) return requestFrame("ui.inspect", { target });
        return { ok: true, target, outline: outline() };
      },
    }),
    descriptor({
      cmd: "ui.click",
      args: [{ name: "handle", type: "handle", required: true }],
      flags: [],
      costsModel: false,
      does: "click a visible control by its data-drive handle",
      example: "ui.click brainstem.menu",
      run: async (args) => {
        const local = findByHandle(args.handle);
        if (local) {
          return {
            ok: true,
            ...(await observeModelCall(() => clickElement(local))),
          };
        }
        if (isShellPage()) return requestFrame("ui.click", args);
        throw new Error(`UI handle "${args.handle}" is unavailable.`);
      },
    }),
    descriptor({
      cmd: "ui.press",
      args: [{ name: "key", type: "key", required: true }],
      flags: [],
      costsModel: false,
      does: "press a keyboard key in the active visible UI",
      example: "ui.press Escape",
      run: async (args) => (
        isShellPage()
        && (
          doc?.activeElement === doc?.body
          || (
            !objectKey(doc?.activeElement)
            && !String(doc?.activeElement?.dataset?.drive || "").startsWith("shell.")
          )
        )
          ? requestFrame("ui.press", args)
          : {
              ok: true,
              ...(await observeModelCall(() => localPress(args.key))),
            }
      ),
    }),
    descriptor({
      cmd: "ui.wait",
      args: [{ name: "handle", type: "handle", required: true }],
      flags: [{ name: "text", type: "string", required: false }],
      costsModel: false,
      does: "wait for a visible handle and optional text",
      example: "ui.wait brainstem.send --text Send",
      run: async (args) => {
        if (
          findByHandle(args.handle)
          || !isShellPage()
          || shellHandle(args.handle)
        ) {
          return { ok: true, ...(await localWait(args.handle, args.text)) };
        }
        return requestFrame("ui.wait", args);
      },
    }),
    descriptor({
      cmd: "chat.read",
      args: [],
      flags: [{ name: "last", type: "positive-integer", required: false }],
      costsModel: false,
      does: "read the visible Brainstem transcript",
      example: "chat.read --last 1",
      run: async (args) => ({
        ok: true,
        ...(isShellPage()
          ? await requestFrame("chat.read", args)
          : await localChatRead(args.last)),
      }),
    }),
    descriptor({
      cmd: "chat.type",
      args: [{ name: "text", type: "text", required: true }],
      flags: [],
      costsModel: false,
      does: "put text in the visible Brainstem composer without sending",
      example: "chat.type \"Show me the active agents\"",
      run: async (args) => ({
        ok: true,
        ...(isShellPage()
          ? await requestFrame("chat.type", args)
          : await localChatType(args.text)),
      }),
    }),
    descriptor({
      cmd: "chat.send",
      args: [{ name: "text", type: "text", required: true }],
      flags: [],
      costsModel: true,
      does: "send text through the visible Brainstem chat to the model",
      example: "chat.send \"Explain this result\"",
      run: async (args) => ({
        ok: true,
        ...(isShellPage()
          ? await requestFrame("chat.send", args)
          : await localChatSend(args.text)),
      }),
    }),
    descriptor({
      cmd: "herd.open",
      args: [],
      flags: [],
      costsModel: false,
      does: "show the herd tile surface",
      example: "herd.open",
      run: async () => runSurface("herd"),
    }),
    descriptor({
      cmd: "arena.switch",
      args: [],
      flags: [],
      costsModel: false,
      does: "show the arena tile surface",
      example: "arena.switch",
      run: async () => runSurface("arena"),
    }),
    descriptor({
      cmd: "binder.open",
      args: [],
      flags: [],
      costsModel: false,
      does: "show the binder tile surface",
      example: "binder.open",
      run: async () => runSurface("binder"),
    }),
    descriptor({
      cmd: "herd.list",
      args: [],
      flags: [],
      costsModel: false,
      does: "list tiles on the herd surface with ids",
      example: "herd.list",
      run: async () => runList("herd"),
    }),
    descriptor({
      cmd: "arena.list",
      args: [],
      flags: [],
      costsModel: false,
      does: "list tiles on the arena surface with ids",
      example: "arena.list",
      run: async () => runList("arena"),
    }),
    descriptor({
      cmd: "binder.list",
      args: [],
      flags: [],
      costsModel: false,
      does: "list tiles on the binder surface with ids",
      example: "binder.list",
      run: async () => runList("binder"),
    }),
    descriptor({
      cmd: "tile.primary",
      args: [{ name: "id", type: "tile-id", required: true }],
      flags: [{ name: "speed", type: "natural|fast|instant", required: false }],
      costsModel: false,
      does: "drag a tile onto the Brainstem to make it primary",
      example: "tile.primary tile-7 --speed natural",
      run: runTilePrimary,
    }),
    descriptor({
      cmd: "tile.park",
      args: [],
      flags: [
        { name: "to", type: "herd|arena|binder", required: false },
        { name: "speed", type: "natural|fast|instant", required: false },
      ],
      costsModel: false,
      does: "drag the current Brainstem chat onto a tile surface",
      example: "tile.park --to herd",
      run: runTilePark,
    }),
    descriptor({
      cmd: "tile.move",
      args: [{ name: "id", type: "tile-id", required: true }],
      flags: [
        { name: "to", type: "herd|arena|binder", required: true },
        { name: "speed", type: "natural|fast|instant", required: false },
      ],
      costsModel: false,
      does: "drag a tile between surfaces",
      example: "tile.move tile-7 --to binder",
      run: runTileMove,
    }),
    descriptor({
      cmd: "tile.bunch",
      args: [
        { name: "source_id", type: "tile-id", required: true },
        { name: "target_id", type: "tile-id", required: true },
      ],
      flags: [{ name: "speed", type: "natural|fast|instant", required: false }],
      costsModel: false,
      does: "drag one tile onto another to bunch them",
      example: "tile.bunch tile-7 tile-8",
      run: runTileBunch,
    }),
    descriptor({
      cmd: "tile.unbunch",
      args: [{ name: "id", type: "tile-id", required: true }],
      flags: [],
      costsModel: false,
      does: "drag a tile out of its bunch onto its current surface",
      example: "tile.unbunch tile-7",
      run: runTileUnbunch,
    }),
    descriptor({
      cmd: "tile.fold",
      args: [{ name: "id", type: "tile-id", required: true }],
      flags: [],
      costsModel: false,
      does: "fold a tile with its visible Fold control",
      example: "tile.fold tile-7",
      run: runTileFold,
    }),
    descriptor({
      cmd: "tile.undo",
      args: [],
      flags: [],
      costsModel: false,
      does: "use the visible 10 second undo control for the last fold",
      example: "tile.undo",
      run: runTileUndo,
    }),
  ]);
  const commands = new Map(registry.map((entry) => [entry.cmd, entry]));

  function helpEntry(entry) {
    return {
      cmd: entry.cmd,
      args: entry.args.map((argument) => ({ ...argument })),
      flags: entry.flags.map((flag) => ({ ...flag })),
      costs_model: entry.costsModel,
      does: entry.does,
      example: entry.example,
    };
  }

  function acceptedType(field) {
    return {
      handle: "a non-empty data-drive handle",
      key: "a single character or named navigation key",
      "positive-integer": "an integer greater than zero",
      string: "a string",
      text: "non-empty text",
      "tile-id": "a tile id such as tile-7",
      "herd|arena|binder": "herd, arena, or binder",
      "natural|fast|instant": "natural, fast, or instant",
      "shell|brainstem": "shell or brainstem",
    }[field.type] || field.type;
  }

  function validateValue(field, value) {
    if (value === undefined || value === null || value === "") {
      if (field.required) {
        throw new AutopilotInputError(
          field.name,
          acceptedType(field),
          `Argument ${field.name} is required and accepts ${acceptedType(field)}.`,
        );
      }
      return undefined;
    }
    if (field.type === "positive-integer") {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(number) || number < 1) {
        throw new AutopilotInputError(
          field.name,
          acceptedType(field),
          `Argument ${field.name} accepts ${acceptedType(field)}; received "${value}".`,
        );
      }
      return number;
    }
    if (typeof value !== "string") {
      throw new AutopilotInputError(
        field.name,
        acceptedType(field),
        `Argument ${field.name} accepts ${acceptedType(field)}; received ${typeof value}.`,
      );
    }
    if (value.length > TEXT_LIMIT) {
      throw new AutopilotInputError(
        field.name,
        `at most ${TEXT_LIMIT} characters`,
        `Argument ${field.name} accepts at most ${TEXT_LIMIT} characters.`,
      );
    }
    if (field.type === "tile-id" && !/^tile-[A-Za-z0-9-]+$/.test(value)) {
      throw new AutopilotInputError(
        field.name,
        acceptedType(field),
        `Argument ${field.name} accepts ${acceptedType(field)}; received "${value}".`,
      );
    }
    const choices = field.type.split("|");
    if (choices.length > 1 && !choices.includes(value)) {
      throw new AutopilotInputError(
        field.name,
        acceptedType(field),
        `Argument ${field.name} accepts ${acceptedType(field)}; received "${value}".`,
      );
    }
    if ((field.type === "text" || field.type === "handle") && !value.trim()) {
      throw new AutopilotInputError(
        field.name,
        acceptedType(field),
        `Argument ${field.name} accepts ${acceptedType(field)}.`,
      );
    }
    if (field.type === "key") keyDetails(value);
    return value;
  }

  function unknownCommand(cmd) {
    const suggestion = [...commands.keys()].sort((left, right) => (
      levenshtein(cmd, left) - levenshtein(cmd, right)
    ))[0];
    const entry = commands.get(suggestion);
    return resultError(
      cmd || "(empty)",
      "unknown_command",
      `Unknown command "${cmd || "(empty)"}" — did you mean "${suggestion}"?`,
      {
        suggestion,
        help: helpEntry(entry),
      },
    );
  }

  function normalizeCli(tokens) {
    const cmd = String(tokens[0]?.text || "");
    const entry = commands.get(cmd);
    if (!entry) return { cmd, error: unknownCommand(cmd) };
    const positionals = [];
    const flags = {};
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token.literal && token.text === "--") {
        positionals.push(...tokens.slice(index + 1).map((item) => item.text));
        break;
      }
      if (token.literal || !token.text.startsWith("--")) {
        positionals.push(token.text);
        continue;
      }
      const equals = token.text.indexOf("=");
      const name = token.text.slice(2, equals > 2 ? equals : undefined);
      const field = entry.flags.find((candidate) => candidate.name === name);
      if (!field) {
        throw new AutopilotInputError(
          name || "flag",
          entry.flags.length
            ? entry.flags.map((candidate) => `--${candidate.name}`).join(", ")
            : "no flags",
          `Argument --${name || "(empty)"} is not accepted by ${cmd}; use ${
            entry.flags.length
              ? entry.flags.map((candidate) => `--${candidate.name}`).join(", ")
              : "no flags"
          }.`,
        );
      }
      let value = equals > 2 ? token.text.slice(equals + 1) : undefined;
      let valueWasQuoted = equals > 2 && token.quoted;
      if (value === undefined) {
        index += 1;
        value = tokens[index]?.text;
        valueWasQuoted = tokens[index]?.quoted === true;
      }
      if (
        value === undefined
        || (equals <= 2 && !valueWasQuoted && String(value).startsWith("--"))
      ) {
        throw new AutopilotInputError(
          name,
          acceptedType(field),
          `Argument --${name} requires ${acceptedType(field)}.`,
        );
      }
      flags[name] = value;
    }
    const values = {};
    let position = 0;
    for (const [index, field] of entry.args.entries()) {
      const isRest = field.type === "text" && index === entry.args.length - 1;
      const value = isRest
        ? positionals.slice(position).join(" ")
        : positionals[position];
      position += isRest ? positionals.length - position : 1;
      values[field.name] = validateValue(field, value);
    }
    if (position < positionals.length) {
      throw new AutopilotInputError(
        "arguments",
        entry.example,
        `Argument arguments accepts the shape "${entry.example}"; received extra value "${positionals[position]}".`,
      );
    }
    for (const field of entry.flags) {
      values[field.name] = validateValue(field, flags[field.name]);
    }
    return { args: values, cmd, entry };
  }

  function normalizeObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AutopilotInputError(
        "command",
        "an object with {cmd, args}",
        "Argument command accepts an object with {cmd, args}.",
      );
    }
    const cmd = typeof value.cmd === "string" ? value.cmd.trim() : "";
    const entry = commands.get(cmd);
    if (!entry) return { cmd, error: unknownCommand(cmd) };
    const args = value.args === undefined ? {} : value.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new AutopilotInputError(
        "args",
        "an object keyed by argument name",
        `Argument args for ${cmd} accepts an object keyed by argument name.`,
      );
    }
    const fields = [...entry.args, ...entry.flags];
    const allowed = new Set(fields.map((field) => field.name));
    for (const name of Object.keys(args)) {
      if (!allowed.has(name)) {
        throw new AutopilotInputError(
          name,
          fields.length ? [...allowed].join(", ") : "no arguments",
          `Argument ${name} is not accepted by ${cmd}; use ${
            fields.length ? [...allowed].join(", ") : "no arguments"
          }.`,
        );
      }
    }
    const values = {};
    for (const field of fields) {
      values[field.name] = validateValue(field, args[field.name]);
    }
    return { args: values, cmd, entry };
  }

  function defaultArgs(cmd, args) {
    const values = { ...args };
    if (["tile.primary", "tile.park", "tile.move", "tile.bunch"].includes(cmd)) {
      values.speed ||= "natural";
    }
    if (cmd === "tile.park") values.to ||= "herd";
    return values;
  }

  function commandItems(input) {
    if (typeof input === "string") {
      const items = [];
      for (const line of input.split(/\r?\n/)) {
        try {
          const tokens = tokenize(line);
          if (tokens.length) items.push({ kind: "cli", tokens });
        } catch (error) {
          items.push({
            cmd: String(line || "").trim().split(/\s+/, 1)[0] || "(parse)",
            error,
            kind: "parse-error",
          });
        }
      }
      return items;
    }
    if (Array.isArray(input)) {
      return input.map((value) => ({ kind: "object", value }));
    }
    return [{ kind: "object", value: input }];
  }

  async function executeItem(item, { log = true } = {}) {
    let normalized;
    try {
      if (item.kind === "parse-error") throw item.error;
      normalized = item.kind === "cli"
        ? normalizeCli(item.tokens)
        : normalizeObject(item.value);
      if (normalized.error) {
        if (log) logResult(normalized.error);
        return normalized.error;
      }
      const args = defaultArgs(normalized.cmd, normalized.args);
      const value = await normalized.entry.run(args);
      const costsModel = normalized.entry.costsModel === true
        || value?.costs_model === true;
      const result = {
        cmd: normalized.cmd,
        ok: value?.ok !== false,
        ...(value && typeof value === "object" ? value : {}),
        costs_model: costsModel,
      };
      if (
        result.ok
        && ["ui.click", "ui.press", "chat.type", "chat.send"].includes(result.cmd)
      ) {
        emitChange(result.cmd);
      }
      if (log) logResult(result);
      return result;
    } catch (error) {
      const cmd = normalized?.cmd
        || item.cmd
        || item.value?.cmd
        || item.tokens?.[0]?.text
        || "(command)";
      const result = error instanceof AutopilotInputError
        ? resultError(cmd, "bad_argument", error.message, {
            argument: error.argument,
            accepts: error.accepts,
            costs_model: Boolean(normalized?.entry?.costsModel || error?.costsModel),
          })
        : resultError(cmd, "command_failed", error?.message || error, {
            costs_model: Boolean(normalized?.entry?.costsModel || error?.costsModel),
          });
      if (log) logResult(result);
      return result;
    }
  }

  function logResult(result) {
    const suffix = result.ok
      ? "ok"
      : `failed (${result.reason || "command_failed"}): ${result.error || ""}`.trim();
    const cost = result.costs_model ? " [model call]" : "";
    logConsole.log(`[rapp] ${result.cmd} ${suffix}${cost}`);
  }

  async function executeForwarded(payload) {
    const allowed = new Set([
      "arena.list",
      "arena.switch",
      "binder.list",
      "binder.open",
      "herd.list",
      "herd.open",
      "tile.bunch",
      "tile.fold",
      "tile.move",
      "tile.park",
      "tile.primary",
      "tile.unbunch",
      "tile.undo",
    ]);
    if (!allowed.has(payload.cmd)) {
      throw new Error(`Frame command "${payload.cmd}" is not allowed in the shell.`);
    }
    return executeItem({
      kind: "object",
      value: { cmd: payload.cmd, args: payload.args || {} },
    }, { log: false });
  }

  function remoteElement(role) {
    if (role === "primary") {
      return findByHandle("brainstem.primary");
    }
    return null;
  }

  async function handleRequest(action, payload) {
    if (action === "command") return executeForwarded(payload);
    if (action === "ui.inspect") {
      return { ok: true, target: payload.target || "brainstem", outline: outline() };
    }
    if (action === "ui.click") {
      const element = findByHandle(payload.handle);
      if (!element) throw new Error(`UI handle "${payload.handle}" is unavailable.`);
      return {
        ok: true,
        ...(await observeModelCall(() => clickElement(element))),
      };
    }
    if (action === "ui.press") {
      return {
        ok: true,
        ...(await observeModelCall(() => localPress(payload.key))),
      };
    }
    if (action === "ui.wait") {
      return { ok: true, ...(await localWait(payload.handle, payload.text)) };
    }
    if (action === "chat.read") return { ok: true, ...(await localChatRead(payload.last)) };
    if (action === "chat.type") return { ok: true, ...(await localChatType(payload.text)) };
    if (action === "chat.send") return { ok: true, ...(await localChatSend(payload.text)) };
    if (action === "drag.bounds") {
      const element = remoteElement(payload.role);
      return element
        ? { ok: true, rect: elementRect(element) }
        : { ok: false, reason: "drag_target_unavailable" };
    }
    if (action === "drag.start") {
      const element = remoteElement(payload.role);
      const started = beginLocalDrag(element, payload.key, payload.values || {});
      if (!started.ok) return { ok: false, reason: started.reason };
      remoteDrags.set(payload.id, {
        ...started,
        aborted: null,
        key: payload.key,
      });
      return {
        ok: true,
        rect: started.rect,
        values: started.values,
      };
    }
    if (action === "drag.status") {
      const started = remoteDrags.get(payload.id);
      if (!started) return { ok: false, reason: "drag_not_active" };
      const reason = started.gesture?.aborted || started.aborted;
      return reason ? { ok: false, reason } : { ok: true };
    }
    if (action === "drag.enter") {
      const element = remoteElement(payload.role);
      if (payload.targetKey && userHolds(element, payload.targetKey)) {
        return { ok: true, handled: false, reason: "yielded_to_user" };
      }
      const targetGesture = {
        aborted: null,
        key: payload.targetKey,
        keys: new Set(),
      };
      bindGestureKey(targetGesture, payload.targetKey);
      const entered = enterLocalDrag(element, payload.values || {});
      if (entered.element) {
        remoteTargets.set(payload.id, {
          ...entered,
          gesture: targetGesture,
          key: payload.targetKey,
        });
      } else {
        releaseGesture(targetGesture);
      }
      return {
        ok: true,
        handled: entered.handled,
        ...(entered.reason ? { reason: entered.reason } : {}),
      };
    }
    if (action === "drag.drop") {
      const entered = remoteTargets.get(payload.id);
      remoteTargets.delete(payload.id);
      const reason = entered?.gesture?.aborted
        || (entered?.key && userHolds(entered.element, entered.key)
          ? "yielded_to_user"
          : null);
      if (reason) {
        cancelLocalTarget(entered);
        releaseGesture(entered?.gesture);
        return { ok: true, handled: false, reason };
      }
      const result = dropLocalDrag(entered);
      releaseGesture(entered?.gesture);
      return { ok: true, ...result };
    }
    if (action === "drag.cancel-target") {
      const entered = remoteTargets.get(payload.id);
      if (entered) cancelLocalTarget(entered);
      releaseGesture(entered?.gesture);
      remoteTargets.delete(payload.id);
      return { ok: true };
    }
    if (action === "drag.end") {
      const started = remoteDrags.get(payload.id);
      if (started) {
        endLocalDrag(started);
        remoteDrags.delete(payload.id);
      }
      return { ok: true };
    }
    throw new Error(`Unsupported Autopilot frame request: ${action}.`);
  }

  async function receiveMessage(event) {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "rapp-autopilot:response") {
      const pending = pendingMessages.get(data.id);
      if (
        !pending
        || pending.source !== event.source
        || data.capability !== capability
      ) return;
      pendingMessages.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error || "The frame request failed."));
      return;
    }
    if (
      data.type === "rapp-autopilot:interrupt"
      && capability
      && data.capability === capability
    ) {
      for (const key of activeGestures.keys()) abortGesture(key, "interrupted");
      for (const remote of remoteDrags.values()) {
        if (!remote.aborted) remote.aborted = "interrupted";
      }
      return;
    }
    if (data.type !== "rapp-autopilot:request") return;
    if (!capability || data.capability !== capability) return;
    const fromParent = event.source === win?.parent && win?.parent !== win;
    const fromFrame = isShellPage() && !fromParent;
    if (!fromParent && !fromFrame) return;
    if (fromFrame && !["command", "ui.inspect"].includes(data.action)) return;
    if (fromParent && data.action === "command") return;
    try {
      const result = await handleRequest(data.action, data.payload || {});
      event.source.postMessage({
        type: "rapp-autopilot:response",
        capability,
        id: data.id,
        ok: true,
        result,
      }, "*");
    } catch (error) {
      event.source.postMessage({
        type: "rapp-autopilot:response",
        capability,
        id: data.id,
        ok: false,
        error: String(error?.message || error),
      }, "*");
    }
  }

  win?.addEventListener?.("message", receiveMessage);

  async function rapp(input) {
    let items;
    try {
      items = commandItems(input);
    } catch (error) {
      const result = resultError(
        "script",
        "bad_input",
        String(error?.message || error),
      );
      logResult(result);
      return boundedEnvelope({ ok: false, ran: 1, results: [result] });
    }
    if (items.length > COMMAND_LIMIT) {
      const result = resultError(
        "script",
        "command_limit",
        `Autopilot accepts at most ${COMMAND_LIMIT} commands per script; received ${items.length}.`,
      );
      logResult(result);
      return boundedEnvelope({ ok: false, ran: 0, results: [result] });
    }
    const results = [];
    for (const item of items) {
      const result = await executeItem(item);
      results.push(result);
      if (!result.ok) break;
    }
    return boundedEnvelope({
      ok: results.every((result) => result.ok),
      ran: results.length,
      results,
    });
  }

  Object.defineProperty(rapp, "registry", {
    configurable: false,
    enumerable: true,
    value: registry,
    writable: false,
  });
  return rapp;
}

if (
  typeof window !== "undefined"
  && typeof document !== "undefined"
  && !window.rapp
) {
  window.rapp = createAutopilot({
    console: window.console,
    capability: window.__rappAutopilotCapability,
    document: window.document,
    tiles: window.RappDimensionTiles,
    window,
  });
}
