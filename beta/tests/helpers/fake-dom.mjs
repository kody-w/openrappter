function dataProperty(name) {
  return String(name)
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function normalizedSelector(selector) {
  return String(selector || "").trim().replace(/\s*>\s*/g, ">");
}

function lastCombinator(selector) {
  let bracketDepth = 0;
  for (let index = selector.length - 1; index >= 0; index -= 1) {
    const character = selector[index];
    if (character === "]") bracketDepth += 1;
    else if (character === "[") bracketDepth -= 1;
    else if (bracketDepth === 0 && character === ">") {
      return { index, type: "child" };
    } else if (bracketDepth === 0 && /\s/.test(character)) {
      let start = index;
      while (start > 0 && /\s/.test(selector[start - 1])) start -= 1;
      return { index: start, type: "descendant" };
    }
  }
  return null;
}

function matchesSimple(element, selector) {
  const value = selector.trim();
  if (!value || !element?.tagName) return false;
  const attributePattern =
    /\[([^\]=\s]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  const structural = value.replace(attributePattern, "");
  const tag = structural.match(/^[A-Za-z][\w-]*/)?.[0];
  if (tag && element.localName !== tag.toLowerCase()) return false;
  for (const id of structural.matchAll(/#([\w-]+)/g)) {
    if (element.id !== id[1]) return false;
  }
  for (const className of structural.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(className[1])) return false;
  }
  for (const attribute of value.matchAll(attributePattern)) {
    const actual = element.getAttribute(attribute[1]);
    if (actual === null) return false;
    const expected = attribute[2] ?? attribute[3] ?? attribute[4];
    if (expected !== undefined && actual !== expected) return false;
  }
  return true;
}

function matchesSelector(element, rawSelector) {
  const selector = normalizedSelector(rawSelector);
  const combinator = lastCombinator(selector);
  if (!combinator) return matchesSimple(element, selector);
  const left = selector.slice(0, combinator.index).trim();
  const right = selector.slice(combinator.index + 1).trim();
  if (!matchesSimple(element, right)) return false;
  if (combinator.type === "child") {
    return matchesSelector(element.parentElement, left);
  }
  let ancestor = element.parentElement;
  while (ancestor) {
    if (matchesSelector(ancestor, left)) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

function selectorList(selector) {
  return String(selector || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export class FakeEvent {
  constructor(type, options = {}) {
    Object.assign(this, {
      bubbles: options.bubbles !== false,
      cancelable: options.cancelable !== false,
      clientX: options.clientX || 0,
      clientY: options.clientY || 0,
      code: options.code || "",
      currentTarget: null,
      dataTransfer: options.dataTransfer || null,
      defaultPrevented: false,
      deltaX: options.deltaX || 0,
      deltaY: options.deltaY || 0,
      immediateStopped: false,
      isTrusted: options.isTrusted === true,
      key: options.key || "",
      pointerId: options.pointerId || 1,
      propagationStopped: false,
      relatedTarget: options.relatedTarget ?? null,
      target: options.target || null,
      type,
    });
    if (options.actor) this.__rappAutopilotActor = options.actor;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopImmediatePropagation() {
    this.immediateStopped = true;
    this.propagationStopped = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

export class FakeCustomEvent extends FakeEvent {
  constructor(type, options = {}) {
    super(type, options);
    this.detail = options.detail;
  }
}

export class FakeDataTransfer {
  constructor() {
    this.data = new Map();
    this.dropEffect = "none";
    this.effectAllowed = "all";
    this.files = [];
    this.items = [];
  }

  get types() {
    return [...this.data.keys()];
  }

  getData(type) {
    return this.data.get(type) || "";
  }

  setData(type, value) {
    this.data.set(String(type), String(value));
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  contains(name) {
    return this.values.has(name);
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  toString() {
    return [...this.values].join(" ");
  }
}

export class FakeElement {
  constructor(ownerDocument, tagName = "div") {
    this.ownerDocument = ownerDocument;
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.disabled = false;
    this.draggable = false;
    this.id = "";
    this.listeners = new Map();
    this.offsetWidth = 100;
    this.parentElement = null;
    this.parentNode = null;
    this.tabIndex = undefined;
    this.title = "";
    this.type = "";
    this.value = "";
    this._textContent = "";
    const styleValues = new Map();
    this.style = {
      removeProperty(name) {
        styleValues.delete(name);
      },
      setProperty(name, value) {
        styleValues.set(name, String(value));
      },
    };
  }

  get childNodes() {
    return this.children;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new FakeClassList();
    this.classList.add(...String(value || "").split(/\s+/).filter(Boolean));
  }

  get innerText() {
    return this.textContent;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.ownerDocument.documentElement) return true;
      node = node.parentElement;
    }
    return false;
  }

  get options() {
    return this.children;
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || "").join("");
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({
      capture: options === true || options?.capture === true,
      listener,
      once: options?.once === true,
    });
    this.listeners.set(type, entries);
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click"));
  }

  closest(selector) {
    const selectors = selectorList(selector);
    let node = this;
    while (node) {
      if (selectors.some((candidate) => matchesSelector(node, candidate))) return node;
      node = node.parentElement;
    }
    return null;
  }

  contains(element) {
    if (element === this) return true;
    return this.children.some((child) => child.contains?.(element));
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    const path = [];
    let node = this;
    while (node) {
      path.push(node);
      node = node.parentElement;
    }
    path.push(this.ownerDocument);
    for (const target of [...path].reverse()) {
      target.invokeListeners?.(event, true);
      if (event.propagationStopped) return !event.defaultPrevented;
    }
    for (const target of path) {
      target.invokeListeners?.(event, false);
      if (event.propagationStopped || !event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  getAttribute(name) {
    if (name === "class") return this.className || null;
    if (name === "id") return this.id || null;
    if (name.startsWith("data-")) {
      return this.dataset[dataProperty(name)] ?? null;
    }
    if (name === "draggable") return this.draggable ? "true" : null;
    if (name === "tabindex") {
      return this.tabIndex === undefined ? null : String(this.tabIndex);
    }
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  insertBefore(child, reference) {
    child.parentElement?.removeChild(child);
    const index = reference ? this.children.indexOf(reference) : -1;
    child.parentElement = this;
    child.parentNode = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  invokeListeners(event, capture) {
    const entries = [...(this.listeners.get(event.type) || [])];
    for (const entry of entries) {
      if (entry.capture !== capture) continue;
      event.currentTarget = this;
      entry.listener.call(this, event);
      if (entry.once) {
        const current = this.listeners.get(event.type) || [];
        this.listeners.set(
          event.type,
          current.filter((candidate) => candidate !== entry),
        );
      }
      if (event.immediateStopped) break;
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = selectorList(selector);
    const matches = [];
    const visit = (element) => {
      if (selectors.some((candidate) => matchesSelector(element, candidate))) {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  removeAttribute(name) {
    if (name === "class") this.className = "";
    else if (name === "id") this.id = "";
    else if (name.startsWith("data-")) delete this.dataset[dataProperty(name)];
    else if (name === "draggable") this.draggable = false;
    else if (name === "tabindex") this.tabIndex = undefined;
    else this.attributes.delete(name);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentElement = null;
      child.parentNode = null;
    }
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    if (name === "class") this.className = value;
    else if (name === "id") this.id = String(value);
    else if (name.startsWith("data-")) {
      this.dataset[dataProperty(name)] = String(value);
    } else if (name === "draggable") {
      this.draggable = String(value) === "true";
    } else if (name === "tabindex") {
      this.tabIndex = Number(value);
    } else {
      this.attributes.set(name, String(value));
    }
  }

  setPointerCapture() {}

  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }
}

export class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.baseURI = "file:///frontier/ui/index.html";
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({
      capture: options === true || options?.capture === true,
      listener,
      once: options?.once === true,
    });
    this.listeners.set(type, entries);
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    this.invokeListeners(event, true);
    if (!event.propagationStopped) this.invokeListeners(event, false);
    return !event.defaultPrevented;
  }

  getElementById(id) {
    if (this.documentElement.id === id) return this.documentElement;
    return this.documentElement.querySelector(`#${id}`);
  }

  invokeListeners(event, capture) {
    const entries = [...(this.listeners.get(event.type) || [])];
    for (const entry of entries) {
      if (entry.capture !== capture) continue;
      event.currentTarget = this;
      entry.listener.call(this, event);
      if (entry.once) {
        const current = this.listeners.get(event.type) || [];
        this.listeners.set(
          event.type,
          current.filter((candidate) => candidate !== entry),
        );
      }
      if (event.immediateStopped) break;
    }
  }

  querySelector(selector) {
    if (selectorList(selector).some((candidate) => (
      matchesSelector(this.documentElement, candidate)
    ))) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    const matches = this.documentElement.querySelectorAll(selector);
    if (selectorList(selector).some((candidate) => (
      matchesSelector(this.documentElement, candidate)
    ))) matches.unshift(this.documentElement);
    return matches;
  }
}

export function createFakeWindow(document = new FakeDocument()) {
  const listeners = new Map();
  const window = {
    CustomEvent: FakeCustomEvent,
    Event: FakeEvent,
    clearTimeout,
    crypto: {
      getRandomValues(values) {
        values[0] = 0;
        return values;
      },
      randomUUID: () => "fake-uuid",
    },
    document,
    innerHeight: 900,
    innerWidth: 1400,
    performance,
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return timer;
    },
    __rappAutopilotEvents: new WeakSet(),
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) {
        listener(event);
      }
      return !event.defaultPrevented;
    },
    receiveMessage(data, source) {
      window.dispatchEvent({ data, source, type: "message" });
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      listeners.set(type, entries.filter((candidate) => candidate !== listener));
    },
  };
  window.parent = window;
  return window;
}
