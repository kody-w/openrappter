export function createUiDriverHelpers(environment = {}) {
  const documentRef = environment.document || null;
  const caps = Object.freeze({
    budgetDefault: 6000,
    inspectDefault: 60,
    inspectMax: 80,
    readMax: 4000,
    screenshotTextDefault: 300,
    screenshotTextMax: 2000,
    telemetryMax: 20,
  });

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function capNumber(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
  }

  function capText(value, limit, { tail = false } = {}) {
    const text = normalizeText(value);
    const size = Math.max(0, Number(limit) || 0);
    if (text.length <= size) return text;
    return tail ? text.slice(-size) : text.slice(0, size);
  }

  function byteLength(value) {
    const text = String(value ?? "");
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).byteLength;
    }
    let bytes = 0;
    for (const character of text) {
      const code = character.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  }

  function truncateBytes(value, maximum) {
    const text = String(value ?? "");
    if (byteLength(text) <= maximum) return text;
    let result = "";
    let used = 0;
    for (const character of text) {
      const size = byteLength(character);
      if (used + size > maximum) break;
      result += character;
      used += size;
    }
    return result;
  }

  function fitBudget(value, {
    limit = caps.budgetDefault,
    handle = "@page",
  } = {}) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const maximum = Math.max(128, Number(limit) || caps.budgetDefault);
    const total = byteLength(serialized);
    if (total <= maximum) {
      return { bytes: total, truncated: false, value };
    }
    let omitted = total - maximum;
    let marker = `…(+${omitted} bytes — read handle:${handle})`;
    let preview = truncateBytes(serialized, Math.max(0, maximum - byteLength(marker)));
    omitted = total - byteLength(preview);
    marker = `…(+${omitted} bytes — read handle:${handle})`;
    preview = truncateBytes(serialized, Math.max(0, maximum - byteLength(marker)));
    return {
      bytes: byteLength(preview + marker),
      omitted: total - byteLength(preview),
      truncated: true,
      value: preview + marker,
    };
  }

  function normalizedHandle(value) {
    const raw = normalizeText(value).replace(/^@/, "");
    if (!raw) {
      const error = new Error("A UI driver handle cannot be empty.");
      error.name = "UiDriverHandleError";
      throw error;
    }
    return `@${raw}`;
  }

  function handleFor(element) {
    const value = element?.dataset?.drive
      || element?.getAttribute?.("data-drive")
      || element?.drive;
    return value ? normalizedHandle(value) : null;
  }

  function requireDocument() {
    if (!documentRef?.querySelectorAll) {
      throw new Error("A document adapter is required for handle resolution.");
    }
    return documentRef;
  }

  function resolveHandle(value) {
    const handle = normalizedHandle(value);
    const raw = handle.slice(1);
    const matches = [...requireDocument().querySelectorAll("[data-drive]")]
      .filter((element) => (
        String(element.dataset?.drive || element.getAttribute?.("data-drive") || "") === raw
      ));
    if (matches.length !== 1) {
      const error = new Error(`UI driver handle ${handle} matched ${matches.length} elements.`);
      error.name = matches.length === 0
        ? "UiDriverHandleNotFoundError"
        : "UiDriverHandleAmbiguityError";
      error.handle = handle;
      error.matches = matches.length;
      throw error;
    }
    return matches[0];
  }

  function cssEscape(value) {
    if (typeof environment.cssEscape === "function") {
      return environment.cssEscape(String(value));
    }
    return String(value).replace(/[^A-Za-z0-9_-]/g, (character) => (
      `\\${character.codePointAt(0).toString(16)} `
    ));
  }

  function attributeEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function pathPart(element) {
    let part = String(element?.localName || element?.tagName || "").toLowerCase();
    if (!part) return "";
    const siblings = element.parentElement
      ? [...element.parentElement.children].filter((child) => (
          String(child.localName || child.tagName || "").toLowerCase() === part
        ))
      : [];
    if (siblings.length > 1) {
      part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    }
    return part;
  }

  function anchorFor(element) {
    const drive = element?.dataset?.drive || element?.getAttribute?.("data-drive");
    if (drive) return `[data-drive="${attributeEscape(drive)}"]`;
    if (element?.id) return `#${cssEscape(element.id)}`;
    const name = String(element?.localName || element?.tagName || "").toLowerCase();
    return ["html", "body"].includes(name) ? name : null;
  }

  function selectorFor(element) {
    if (!element) return null;
    const handle = handleFor(element);
    if (handle) return handle;
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    let node = element;
    while (node) {
      const anchor = anchorFor(node);
      if (anchor && node !== element) {
        return [anchor, ...parts].join(" > ");
      }
      const part = pathPart(node);
      if (part) parts.unshift(part);
      if (anchor) return parts.join(" > ");
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function resolveSelector(value) {
    const selector = normalizeText(value);
    if (selector.startsWith("@")) return resolveHandle(selector);
    try {
      return requireDocument().querySelector(selector);
    } catch (error) {
      const invalid = new Error(`Invalid selector ${selector}: ${error.message}`);
      invalid.name = "UiDriverSelectorError";
      throw invalid;
    }
  }

  function elementValue(element, name) {
    if (element && Object.hasOwn(element, name)) return element[name];
    return element?.getAttribute?.(name);
  }

  function roleFor(element) {
    const explicit = element?.dataset?.driveRole
      || elementValue(element, "role");
    if (explicit) return normalizeText(explicit);
    const tag = String(element?.localName || element?.tagName || element?.tag || "")
      .toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (["input", "textarea"].includes(tag)) return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "iframe") return "document";
    return tag === "article" ? "article" : "group";
  }

  function nameFor(element) {
    const explicit = element?.dataset?.driveName
      || elementValue(element, "aria-label")
      || elementValue(element, "title")
      || element?.name;
    if (explicit) return capText(explicit, 80);
    return capText(
      element?.innerText
      || element?.textContent
      || element?.value
      || element?.text,
      80,
    );
  }

  function stateFor(element) {
    const explicit = element?.dataset?.driveState || element?.state;
    if (explicit) return normalizeText(explicit);
    if (
      Boolean(element?.disabled)
      || elementValue(element, "aria-disabled") === "true"
    ) return "disabled";
    if (
      Boolean(element?.checked)
      || elementValue(element, "aria-checked") === "true"
    ) return "checked";
    const expanded = elementValue(element, "aria-expanded");
    if (expanded === "true") return "expanded";
    if (expanded === "false") return "collapsed";
    if (
      Boolean(element?.selected)
      || elementValue(element, "aria-selected") === "true"
    ) return "selected";
    const tag = String(element?.localName || element?.tagName || element?.tag || "")
      .toLowerCase();
    if (["input", "textarea"].includes(tag) || element?.isContentEditable) {
      return normalizeText(element?.value || element?.textContent) ? "filled" : "empty";
    }
    const className = String(element?.className || "");
    if (/typing-indicator|stream-arriving|\bstreaming\b/.test(className)) {
      return "streaming";
    }
    if (element?.ownerDocument?.activeElement === element || element?.focused) {
      return "focused";
    }
    if (/response-slot|\bmsg\b/.test(className)) return "complete";
    return "enabled";
  }

  function rowFor(element) {
    return {
      h: element?.h || element?.handle || selectorFor(element),
      role: roleFor(element),
      name: nameFor(element),
      state: stateFor(element),
    };
  }

  function hashText(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function snapshotFor(rows) {
    const stable = rows.map(({ h, role, name, state }) => ({
      h,
      role,
      name: /\bmsg\[/.test(h) ? role : name,
      state,
    }));
    return `o${hashText(JSON.stringify(stable))}`;
  }

  function buildOutline(elements, {
    frame = "brainstem",
    limit = caps.inspectDefault,
  } = {}) {
    const maximum = capNumber(limit, 1, caps.inspectMax, caps.inspectDefault);
    const seen = new Set();
    const rows = [];
    for (const element of elements || []) {
      const row = rowFor(element);
      if (!row.h || seen.has(row.h)) continue;
      seen.add(row.h);
      rows.push(row);
      if (rows.length >= maximum) break;
    }
    return {
      snapshot: snapshotFor(rows),
      frame,
      rows,
    };
  }

  function diffOutlines(beforeRows = [], afterRows = [], limit = 5) {
    const before = new Map(beforeRows.map((row) => [row.h, row]));
    const after = new Map(afterRows.map((row) => [row.h, row]));
    const added = [];
    const changed = [];
    const removed = [];
    for (const [handle, row] of after) {
      if (!before.has(handle)) added.push(`${handle}:${row.state}`);
      else if (JSON.stringify(before.get(handle)) !== JSON.stringify(row)) {
        changed.push(`${handle}:${row.state}`);
      }
    }
    for (const handle of before.keys()) {
      if (!after.has(handle)) removed.push(handle);
    }
    const maximum = Math.max(1, Number(limit) || 5);
    return {
      added: added.slice(0, maximum),
      changed: changed.slice(0, maximum),
      removed: removed.slice(0, maximum),
    };
  }

  function diffRows(beforeRows = [], afterRows = []) {
    const before = new Map(beforeRows.map((row) => [row.h, row]));
    const after = new Map(afterRows.map((row) => [row.h, row]));
    const rows = [];
    for (const row of afterRows) {
      const previous = before.get(row.h);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) rows.push(row);
    }
    for (const row of beforeRows) {
      if (!after.has(row.h)) rows.push({ ...row, state: "removed" });
    }
    return rows;
  }

  return {
    buildOutline,
    byteLength,
    capNumber,
    capText,
    caps,
    diffOutlines,
    diffRows,
    fitBudget,
    handleFor,
    nameFor,
    normalizeText,
    normalizedHandle,
    resolveHandle,
    resolveSelector,
    roleFor,
    rowFor,
    selectorFor,
    snapshotFor,
    stateFor,
  };
}
