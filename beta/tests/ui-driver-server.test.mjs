import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  startUiDriverServer,
  uiDriverInternals,
} from "../electron/ui-driver-server.mjs";
import {
  measureUiDriver,
  shellFixture,
  shellInspectMeasurements,
} from "../scripts/measure-ui-driver-v2.mjs";

function fixtureElement({
  drive = "",
  id = "",
  tag = "button",
} = {}) {
  return {
    children: [],
    dataset: drive ? { drive } : {},
    getAttribute(name) {
      return name === "data-drive" ? drive || null : null;
    },
    id,
    localName: tag,
    parentElement: null,
  };
}

function append(parent, ...children) {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
}

function fakeDriverWindow({ delayMs = 0 } = {}) {
  const executed = [];
  const execute = async (source) => {
    executed.push(source);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (source.includes('"action":"click"')) {
      return {
        __trace: {
          snapshot_after: "oafter",
          snapshot_before: "obefore",
        },
        effect: {
          added: ["@brainstem.chat.msg[r-2]:streaming"],
          changed: [],
          removed: [],
          route: null,
        },
        h: "@brainstem.send",
        ok: true,
      };
    }
    if (source.includes('"action":"autopilot"')) {
      return {
        ok: true,
        ran: 1,
        results: [{ cmd: "help", ok: true }],
      };
    }
    return {
      __trace: {
        snapshot_after: "osteady",
        snapshot_before: "osteady",
      },
      actual: "enabled",
      h: "@brainstem.send",
      ok: true,
    };
  };
  const brainstem = {
    executeJavaScript: execute,
    frames: [],
    url: "http://127.0.0.1:7071/",
  };
  const mainFrame = {
    executeJavaScript: execute,
    frames: [brainstem],
    url: "file:///frontier/index.html",
  };
  return {
    executed,
    window: {
      webContents: { mainFrame },
    },
  };
}

function commandHeaders(token) {
  return {
    authorization: ["Bearer", token].join(" "),
    "content-type": "application/json",
  };
}

async function postCommand(metadata, command, token = metadata.token) {
  const response = await fetch(
    `http://${metadata.host}:${metadata.port}/v1/command`,
    {
      body: JSON.stringify(command),
      headers: commandHeaders(token),
      method: "POST",
    },
  );
  const text = await response.text();
  return {
    payload: JSON.parse(text.trim()),
    status: response.status,
    text,
  };
}

function eventRecorder(values = {}) {
  return {
    ...values,
    preventDefaultCalled: false,
    stopImmediatePropagationCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
    stopImmediatePropagation() {
      this.stopImmediatePropagationCalled = true;
    },
  };
}

function makeLeaseHarness() {
  const elements = new Map();
  const timers = [];
  let onSetAttribute = null;
  const eventTarget = (id) => {
    const attributes = new Map();
    const listeners = new Map();
    const element = {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      attributes,
      dataset: {},
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      id,
      listeners,
      setAttribute(name, value) {
        attributes.set(name, String(value));
        onSetAttribute?.({ element, name, value: String(value) });
      },
    };
    elements.set(id, element);
    return element;
  };
  const input = eventTarget("input");
  const send = eventTarget("send");
  const starters = eventTarget("starter-prompts");
  const document = {
    activeElement: null,
    body: {
      appendChild(element) {
        elements.set(element.id, element);
      },
    },
    createElement: () => ({
      dataset: {},
      hidden: false,
      id: "",
      style: {},
      textContent: "",
    }),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const helpers = {
    buildOutline: () => ({ rows: [], snapshot: "steady" }),
    caps: { inspectDefault: 60 },
    diffOutlines: () => ({ added: [], changed: [], removed: [] }),
    selectorFor: () => null,
  };
  const context = vm.createContext({
    clearTimeout() {},
    document,
    setTimeout(callback, ms) {
      timers.push({ callback, ms });
      return timers.length;
    },
    window: {},
  });
  const command = vm.runInContext(
    `(${uiDriverInternals.browserDriverCommand.toString()})`,
    context,
  );
  return {
    command: (value) => command(value, () => helpers),
    context,
    elements,
    input,
    send,
    setOnSetAttribute(callback) {
      onSetAttribute = callback;
    },
    starters,
    timers,
  };
}

function makeChatHarness() {
  const elements = new Map();
  const observers = new Set();
  const slots = [];
  let onInputValue = null;
  let onSend = null;
  let onTimer = null;
  let sendClicks = 0;

  const classList = () => {
    const values = new Set();
    return {
      add: (...names) => names.forEach((name) => values.add(name)),
      contains: (name) => values.has(name),
      remove: (...names) => names.forEach((name) => values.delete(name)),
    };
  };
  const attributesFor = () => {
    const attributes = new Map();
    return {
      attributes,
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
    };
  };
  class FakeInput {
    constructor() {
      Object.assign(this, attributesFor());
      this._value = "";
      this.classList = classList();
      this.dataset = {};
      this.id = "input";
      this.isContentEditable = false;
      this.listeners = new Map();
      this.localName = "textarea";
    }

    get value() {
      return this._value;
    }

    set value(value) {
      this._value = String(value);
      onInputValue?.(this, this._value);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    contains(element) {
      return element === this;
    }

    dispatchEvent(event) {
      this.listeners.get(event.type)?.(event);
      return true;
    }

    focus() {
      document.activeElement = this;
    }

    getBoundingClientRect() {
      return { height: 36, left: 80, top: 600, width: 300 };
    }

    scrollIntoView() {}
  }
  class FakeTextArea extends FakeInput {}
  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = options.bubbles === true;
      this.isTrusted = false;
    }
  }

  const input = new FakeInput();
  const sendAttributes = attributesFor();
  const send = {
    ...sendAttributes,
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    classList: classList(),
    click() {
      sendClicks += 1;
      this.listeners.get("click")?.({ isTrusted: false });
      onSend?.();
    },
    contains(element) {
      return element === this;
    },
    dataset: {},
    disabled: false,
    focus() {
      document.activeElement = this;
    },
    getBoundingClientRect() {
      return { height: 36, left: 420, top: 600, width: 80 };
    },
    id: "send",
    listeners: new Map(),
    localName: "button",
    scrollIntoView() {},
  };
  const starters = {
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    listeners: new Map(),
  };
  const chat = { id: "chat" };
  elements.set("input", input);
  elements.set("send", send);
  elements.set("starter-prompts", starters);
  elements.set("chat", chat);

  const genericElement = (tag) => ({
    classList: classList(),
    dataset: {},
    getBoundingClientRect: () => ({
      height: 20,
      left: 10,
      top: 10,
      width: 20,
    }),
    id: "",
    localName: tag,
    offsetWidth: 0,
    style: {},
    textContent: "",
  });
  const appendElement = (element) => {
    if (element.id) elements.set(element.id, element);
  };
  const document = {
    activeElement: null,
    body: {
      appendChild: appendElement,
      cloneNode: () => ({
        innerText: "",
        querySelectorAll: () => [],
      }),
    },
    createElement: genericElement,
    elementFromPoint(x) {
      return x < 360 ? input : send;
    },
    getElementById: (id) => elements.get(id) || null,
    head: { appendChild: appendElement },
    querySelector(selector) {
      const match = selector.match(
        /^#chat \.response-slot\[data-request-id="(\d+)"\]$/,
      );
      return match
        ? slots.find((slot) => slot.dataset.requestId === match[1]) || null
        : null;
    },
    querySelectorAll(selector) {
      return selector === "#chat .response-slot" ? [...slots] : [];
    },
    readyState: "complete",
    visibilityState: "visible",
  };
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
    }

    disconnect() {
      this.connected = false;
      observers.delete(this);
    }

    observe() {
      this.connected = true;
      observers.add(this);
    }
  }
  const notifyObservers = () => {
    for (const observer of [...observers]) {
      if (observer.connected) observer.callback([]);
    }
  };
  const appendSlot = ({
    agentLogs = "",
    id,
    response,
    user,
  }, notify = true) => {
    const userBubble = {
      dataset: {},
      innerText: String(user),
      title: "",
    };
    const responseBubble = { innerText: String(response) };
    const reply = {
      querySelector(selector) {
        if (selector === ".bubble") return responseBubble;
        if (selector === ".agent-logs") {
          return agentLogs ? { innerText: agentLogs } : null;
        }
        return null;
      },
    };
    const slot = {
      dataset: { requestId: String(id) },
      previousElementSibling: userBubble,
      querySelector(selector) {
        if (selector === ".msg.system") return null;
        if (selector.startsWith(".msg.assistant")) return reply;
        return null;
      },
    };
    slots.push(slot);
    if (notify) notifyObservers();
    return slot;
  };
  onSend = () => {
    const user = input.value;
    input._value = "";
    const id = Math.max(
      0,
      ...slots.map((slot) => Number(slot.dataset.requestId) || 0),
    ) + 1;
    appendSlot({ id, response: `reply:${user}`, user });
  };

  const helpers = {
    buildOutline: () => ({ rows: [], snapshot: "steady" }),
    caps: { inspectDefault: 60 },
    diffOutlines: () => ({ added: [], changed: [], removed: [] }),
    selectorFor: (element) => (element?.id ? `#${element.id}` : null),
  };
  const context = vm.createContext({
    CSS: { escape: (value) => value },
    clearTimeout() {},
    document,
    Event: FakeEvent,
    getComputedStyle: () => ({
      display: "block",
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
    }),
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    innerHeight: 800,
    innerWidth: 1000,
    location: { href: "http://127.0.0.1:7071/" },
    MutationObserver: FakeMutationObserver,
    setTimeout(callback, ms) {
      queueMicrotask(() => {
        onTimer?.({ ms, observing: observers.size > 0 });
        callback();
      });
      return 1;
    },
    window: {},
  });
  const driverCommand = vm.runInContext(
    `(${uiDriverInternals.browserDriverCommand.toString()})`,
    context,
  );

  return {
    appendSlot,
    command: (value) => driverCommand(value, () => helpers),
    context,
    input,
    notifyObservers,
    removeSlot(id, notify = true) {
      const index = slots.findIndex(
        (slot) => slot.dataset.requestId === String(id),
      );
      if (index >= 0) slots.splice(index, 1);
      if (notify) notifyObservers();
    },
    send,
    sendClicks: () => sendClicks,
    setInputValue(value) {
      input._value = String(value);
    },
    setOnInputValue(callback) {
      onInputValue = callback;
    },
    setOnSend(callback) {
      onSend = callback;
    },
    setOnTimer(callback) {
      onTimer = callback;
    },
    slots,
  };
}

test("visible UI driver accepts bounded v2 actions", () => {
  assert.equal(
    uiDriverInternals.validateCommand({
      action: "run",
      steps: [
        { action: "announce", text: "Opening the beta menu" },
        {
          action: "click",
          handle: "@brainstem.send",
          until: { snapshot_changed: true },
        },
        { action: "expect", handle: "@brainstem.send", state: "enabled" },
        {
          action: "swipe",
          direction: "right",
          handle: "@herd.tile[tile-fixture]",
        },
      ],
    }).action,
    "run",
  );
  for (const action of [
    "recording_status",
    "route_telemetry",
    "set_chat_lease",
    "swipe",
  ]) {
    assert.equal(
      uiDriverInternals.validateCommand({ action }).action,
      action,
    );
  }
  assert.equal(
    uiDriverInternals.frameKeyForCommand({ action: "swipe" }),
    "brainstem",
  );
  assert.equal(
    uiDriverInternals.frameKeyForCommand({
      action: "swipe",
      target: "shell",
    }),
    "shell",
  );
});

test("visible UI driver rejects unknown and unbounded commands", () => {
  assert.throws(
    () => uiDriverInternals.validateCommand({ action: "evaluate" }),
    /Unsupported UI driver action/,
  );
  assert.throws(
    () => uiDriverInternals.validateCommand({ action: "run", steps: [] }),
    /between 1 and 40 steps/,
  );
  assert.throws(
    () => uiDriverInternals.validateCommand({
      action: "run",
      steps: Array.from({ length: 41 }, () => ({ action: "click" })),
    }),
    /between 1 and 40 steps/,
  );
  assert.throws(
    () => uiDriverInternals.validateCommand({ action: "inspect", limit: 81 }),
    /between 1 and 80/,
  );
});

test("visible UI driver bounds frame sleeps and typed input work", () => {
  for (const command of [
    { action: "announce", durationMs: 5_001 },
    { action: "click", selector: "#send", settleMs: 5_001 },
    { action: "press", key: "Enter", settleMs: 5_001 },
    { action: "type", selector: "#input", typingDelayMs: 101, value: "x" },
    {
      action: "type",
      selector: "#input",
      typingDelayMs: 100,
      value: "x".repeat(601),
    },
    {
      action: "type",
      selector: "#input",
      typingDelayMs: 0,
      value: "x".repeat((64 * 1024) + 1),
    },
    { action: "wait", selector: "#send", timeoutMs: 120_001 },
    { action: "click", selector: "#send", until: {
      handle: "@brainstem.send",
      state: "enabled",
      timeoutMs: 120_001,
    } },
    { action: "announce", frameTimeoutMs: 65 * 60 * 1000 + 1 },
    { action: "wait", selector: "#send", timeoutMs: 10_000, frameTimeoutMs: 1000 },
    {
      action: "run",
      steps: Array.from(
        { length: 40 },
        () => ({ action: "wait", selector: "#send", timeoutMs: 120_000 }),
      ),
    },
  ]) {
    assert.throws(
      () => uiDriverInternals.validateCommand(command),
      /must be|exceeds/,
    );
  }

  const instantType = uiDriverInternals.validateCommand({
    action: "type",
    selector: "#input",
    typingDelayMs: 0,
    value: "x".repeat(64 * 1024),
  });
  assert.equal(instantType.typingDelayMs, 0);
  assert.ok(
    instantType.frameTimeoutMs >= 20_000
      && instantType.frameTimeoutMs <= 65 * 60 * 1000,
  );
  assert.equal(
    uiDriverInternals.boundedFrameTimeout(1e15),
    65 * 60 * 1000,
  );
  const browserSource = uiDriverInternals.browserDriverCommand.toString();
  assert.match(browserSource, /frameBudget - 250/);
  assert.match(browserSource, /exceeded its frame time budget/);
  assert.match(
    browserSource,
    /if \(!delayMs\) \{[\s\S]*setControlValue\(element, nextValue\)/,
  );
});

test("handles resolve exactly and fallback selectors stay anchored", () => {
  const body = fixtureElement({ tag: "body" });
  const panel = fixtureElement({ drive: "shell.panel", tag: "section" });
  const group = fixtureElement({ tag: "div" });
  const first = fixtureElement();
  const second = fixtureElement();
  append(body, panel);
  append(panel, group);
  append(group, first, second);

  const elements = [panel, first, second];
  const document = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-drive]" ? elements : [];
    },
  };
  const helpers = uiDriverInternals.createUiDriverHelpers({ document });
  assert.equal(helpers.resolveHandle("@shell.panel"), panel);
  assert.equal(
    helpers.selectorFor(first),
    '[data-drive="shell.panel"] > div > button:nth-of-type(1)',
  );
  assert.match(helpers.selectorFor(second), /^\[data-drive=/);
  assert.throws(
    () => helpers.resolveHandle("@shell.missing"),
    (error) => (
      error.name === "UiDriverHandleNotFoundError"
      && error.matches === 0
    ),
  );

  elements.push(fixtureElement({ drive: "shell.panel" }));
  assert.throws(
    () => helpers.resolveHandle("@shell.panel"),
    (error) => (
      error.name === "UiDriverHandleAmbiguityError"
      && error.matches === 2
    ),
  );
});

test("shell fixture produces compact deterministic outlines and diffs", () => {
  const fixture = shellFixture();
  const measurement = shellInspectMeasurements(fixture);
  const helpers = uiDriverInternals.createUiDriverHelpers();
  assert.ok(fixture.interactive.length > 0);
  assert.ok(fixture.interactive.every((item) => item.h.startsWith("@")));
  assert.ok(measurement.after.rows.length <= 60);
  assert.ok(measurement.afterBytes <= 2000);
  assert.doesNotMatch(JSON.stringify(measurement.after), /nth-of-type/);
  assert.equal(
    helpers.snapshotFor(measurement.after.rows),
    measurement.after.snapshot,
  );

  const before = measurement.after.rows.slice(0, 3);
  const after = [
    { ...before[0], state: "disabled" },
    before[1],
    {
      h: "@fixture[new].row",
      name: "New",
      role: "button",
      state: "enabled",
    },
  ];
  assert.deepEqual(helpers.diffOutlines(before, after), {
    added: ["@fixture[new].row:enabled"],
    changed: [`${before[0].h}:disabled`],
    removed: [before[2].h],
  });
  assert.deepEqual(
    helpers.diffRows(before, after).map((row) => [row.h, row.state]),
    [
      [before[0].h, "disabled"],
      ["@fixture[new].row", "enabled"],
      [before[2].h, "removed"],
    ],
  );
});

test("caps and byte budgets enforce the v2 ceilings", () => {
  const helpers = uiDriverInternals.createUiDriverHelpers();
  assert.equal(helpers.capNumber(200, 1, 80, 60), 80);
  assert.equal(helpers.capText("abcdef", 3), "abc");
  assert.equal(helpers.capText("abcdef", 3, { tail: true }), "def");
  const fitted = helpers.fitBudget(
    { text: "x".repeat(9000) },
    { handle: "@shell.agentTree", limit: 6000 },
  );
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.bytes <= 6000);
  assert.match(
    fitted.value,
    /…\(\+\d+ bytes — read handle:@shell\.agentTree\)$/,
  );

  const measurements = measureUiDriver();
  assert.ok(measurements.inspect.after <= measurements.inspect.target);
  assert.ok(measurements.screenshot.after <= measurements.screenshot.target);
  assert.ok(measurements.read.after <= measurements.read.target);
  assert.ok(measurements.overhead.after <= measurements.overhead.target);
  assert.ok(measurements.overhead.detail.context <= 250);
});

test("real server enforces auth, body, heartbeat, conditions, and traces", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-ui-driver-v2-"));
  const betaHome = path.join(root, "beta-home");
  const fake = fakeDriverWindow({ delayMs: 60 });
  const driver = await startUiDriverServer({
    brainstemHome: root,
    env: {
      BRAINSTEM_BETA_HOME: betaHome,
      BRAINSTEM_BETA_UI_DRIVER_HEARTBEAT_MS: "10",
    },
    loopbackUrl: (url) => url.startsWith("http://127.0.0.1:7071"),
    window: fake.window,
  });
  t.after(async () => {
    await driver.stop();
    rmSync(root, { force: true, recursive: true });
  });
  const metadata = JSON.parse(readFileSync(driver.metadataPath, "utf8"));
  assert.equal(metadata.version, 2);

  const unauthorized = await postCommand(
    metadata,
    { action: "expect", handle: "@brainstem.send", state: "enabled" },
    "wrong-token",
  );
  assert.equal(unauthorized.status, 401);

  const tooLarge = await postCommand(metadata, {
    action: "read",
    padding: "x".repeat((256 * 1024) + 1),
  });
  assert.equal(tooLarge.status, 400);
  assert.match(tooLarge.payload.error, /too large/);

  for (const invalid of [
    { action: "expect", handle: "@brainstem.send" },
    { action: "read", until: { snapshot_changed: true } },
    {
      action: "click",
      handle: "@brainstem.send",
      until: {
        handle: "@brainstem.send",
        state: "enabled",
        text: "Send",
      },
    },
  ]) {
    const response = await postCommand(metadata, invalid);
    assert.equal(response.status, 400);
  }

  const expected = await postCommand(metadata, {
    action: "expect",
    handle: "@brainstem.send",
    state: "enabled",
  });
  assert.equal(expected.status, 200);
  assert.deepEqual(expected.payload, {
    ok: true,
    result: {
      actual: "enabled",
      h: "@brainstem.send",
      ok: true,
    },
  });

  const autopilot = await postCommand(metadata, {
    action: "autopilot",
    script: "help",
  });
  assert.equal(autopilot.status, 200);
  assert.deepEqual(autopilot.payload, {
    ok: true,
    result: {
      ok: true,
      ran: 1,
      results: [{ cmd: "help", ok: true }],
    },
  });

  const effect = await postCommand(metadata, {
    action: "click",
    handle: "@brainstem.send",
    until: { snapshot_changed: true },
  });
  assert.equal(effect.status, 200);
  assert.equal(
    effect.payload.result.effect.added[0],
    "@brainstem.chat.msg[r-2]:streaming",
  );
  assert.equal(Object.hasOwn(effect.payload.result, "__trace"), false);

  const heartbeatResponse = await fetch(
    `http://${metadata.host}:${metadata.port}/v1/command`,
    {
      body: JSON.stringify({
        action: "expect",
        handle: "@brainstem.send",
        state: "enabled",
      }),
      headers: commandHeaders(metadata.token),
      method: "POST",
    },
  );
  const reader = heartbeatResponse.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value).trim(), "");
  let heartbeatBody = decoder.decode(first.value);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    heartbeatBody += decoder.decode(chunk.value);
  }
  assert.equal(JSON.parse(heartbeatBody.trim()).ok, true);

  const traces = readFileSync(metadata.tracePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(traces.length >= 3);
  const autopilotTrace = traces.find((entry) => entry.action === "autopilot");
  assert.deepEqual(autopilotTrace.commands, [{
    actor: null,
    cmd: "help",
    ok: true,
    reason: null,
  }]);
  for (const trace of traces) {
    const expectedKeys = [
      "action",
      "handle",
      "effect",
      "snapshot_before",
      "snapshot_after",
    ];
    if (trace.action === "autopilot") expectedKeys.push("actor", "commands");
    assert.deepEqual(Object.keys(trace), expectedKeys);
  }
  const clickTrace = traces.find((trace) => trace.action === "click");
  assert.equal(clickTrace.handle, "@brainstem.send");
  assert.equal(clickTrace.snapshot_before, "obefore");
  assert.equal(clickTrace.snapshot_after, "oafter");
});

test("visible chat waits for stable SSE replies and ignores prompt text", () => {
  const source = uiDriverInternals.browserDriverCommand.toString();
  assert.match(
    source,
    /\.msg\.assistant:not\(\.typing-indicator\):not\(\.stream-arriving\)/,
  );
  assert.match(source, /data-request-id/);
  assert.match(source, /const errorBaseline = document\.querySelectorAll/);
  assert.match(source, /errors\.length > errorBaseline/);
  assert.match(source, /\.msg\.user,\[data-brainstem-ai-driver\]/);
  assert.doesNotMatch(
    source,
    /__rappSetNextAgentLease|__rappSetNextUserGuid|agentLease|userGuid/,
  );
});

test("driver UI opens off-canvas panels and clears faded narration", () => {
  const source = uiDriverInternals.browserDriverCommand.toString();
  assert.match(source, /if \(!panel\)/);
  assert.match(source, /panel\.classList\.add\("open"\)/);
  assert.match(source, /const CURSOR_IDLE_HIDE_MS = 4000/);
  assert.match(source, /clearTimeout\(state\.cursorIdleTimer\)/);
  assert.match(source, /cursor\.style\.opacity = "0"/);
  assert.match(source, /label\.textContent = ""/);
});

test("walkthrough recording pads with visible recap tiles", () => {
  const source = uiDriverInternals.stopWindowRecording.toString();
  assert.match(source, /minimumDurationMs/);
  assert.match(source, /brainstem-beta-walkthrough-recap/);
  assert.match(
    uiDriverInternals.walkthroughRecapChapters("baseline").join(" "),
    /Frontier Brainstem → Hippocampus → Microsoft stack/,
  );
  assert.match(
    uiDriverInternals.walkthroughRecapChapters("stack-churn").join(" "),
    /STACK_CHURN_READY/,
  );
});

test("long recordings stream to disk without base64 IPC", () => {
  const captureSource = uiDriverInternals.startCapturedWindowRecording.toString();
  const frameSource = uiDriverInternals.writeCapturedFrame.toString();
  const recorderSource = uiDriverInternals.startWindowRecording.toString();
  const serverSource = startUiDriverServer.toString();
  assert.match(frameSource, /capturePage/);
  assert.match(captureSource, /libvpx-vp9/);
  assert.match(captureSource, /image2pipe/);
  assert.match(captureSource, /framesWritten/);
  assert.match(recorderSource, /fetch\(state\.uploadUrl/);
  assert.match(recorderSource, /blob\.arrayBuffer/);
  assert.match(recorderSource, /video\/webm;codecs=vp8/);
  assert.match(serverSource, /\/v1\/recording-upload/);
  assert.match(serverSource, /createWriteStream/);
  assert.match(serverSource, /500 \* 1024 \* 1024/);
  assert.doesNotMatch(recorderSource, /FileReader|saveRecording|base64/);
});

test("a control inside its own overlay is actionable: an ancestor hit is not an occluder", () => {
  // Live regression: `click #enter` on the first-run intro returned ok:false
  // ("occluded by @shell.intro") because elementFromPoint reported the intro
  // tile — the button's own ancestor — and the walkthrough could no longer
  // dismiss the intro. Only something OUTSIDE the element's subtree and
  // ancestry occludes it.
  const source = uiDriverInternals.browserDriverCommand.toString();
  assert.match(source, /!element\.contains\(top\)\s*&&\s*!top\.contains\(element\)/);
  assert.match(source, /occluded by \$\{selectorFor\(top\)/);
});

test("click scrolls an offscreen control before testing for occlusion", async () => {
  const ids = new Map();
  const classList = () => {
    const names = new Set();
    return {
      add: (...values) => values.forEach((value) => names.add(value)),
      contains: (value) => names.has(value),
      remove: (...values) => values.forEach((value) => names.delete(value)),
    };
  };
  const uiElement = (tag) => ({
    classList: classList(),
    dataset: {},
    id: "",
    localName: tag,
    offsetWidth: 0,
    style: {},
    textContent: "",
  });
  let rect = { height: 32, left: 120, top: 2400, width: 180 };
  let clicks = 0;
  let scrolls = 0;
  const target = {
    classList: classList(),
    click() {
      clicks += 1;
    },
    contains: (element) => element === target,
    dataset: { drive: "list.below" },
    disabled: false,
    focus() {},
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    innerText: "Below the fold",
    localName: "button",
    scrollIntoView() {
      scrolls += 1;
      rect = { ...rect, top: 280 };
    },
  };
  const footer = {
    contains: () => false,
    localName: "footer",
  };
  const append = (element) => {
    if (element.id) ids.set(element.id, element);
  };
  const document = {
    activeElement: target,
    body: { appendChild: append },
    createElement: uiElement,
    elementFromPoint: () => (rect.top > 700 ? footer : target),
    getElementById: (id) => ids.get(id) || null,
    head: { appendChild: append },
    querySelectorAll: () => [],
  };
  const helpers = {
    buildOutline: () => ({ rows: [], snapshot: "steady" }),
    caps: { inspectDefault: 60 },
    diffOutlines: () => ({ added: [], changed: [], removed: [] }),
    resolveSelector: () => target,
    selectorFor: (element) => (
      element === target ? "@list.below" : element?.localName || null
    ),
  };
  const context = vm.createContext({
    CSS: { escape: (value) => value },
    clearTimeout() {},
    document,
    getComputedStyle: () => ({
      display: "block",
      opacity: "1",
      pointerEvents: "auto",
      visibility: "visible",
    }),
    innerHeight: 700,
    innerWidth: 1000,
    location: { href: "http://127.0.0.1:7071/" },
    setTimeout(callback) {
      callback();
      return 1;
    },
    window: {},
  });
  const command = vm.runInContext(
    `(${uiDriverInternals.browserDriverCommand.toString()})`,
    context,
  );

  const result = await command(
    { action: "click", selector: "#below" },
    () => helpers,
  );

  assert.equal(result.ok, true);
  assert.equal(clicks, 1);
  assert.equal(scrolls, 1);
});

test("a frame script is abandoned when its frame navigates, and the queue moves on", async () => {
  const { executeInFrame, FrameGoneError } = uiDriverInternals;
  const navigating = {
    executeJavaScript: () => new Promise(() => {}),
    frames: [],
    url: "http://127.0.0.1:7071/",
  };
  const mainFrame = { executeJavaScript: () => null, frames: [navigating], url: "file:///frontier/index.html" };
  const window = { webContents: { mainFrame } };
  setTimeout(() => { navigating.url = "http://127.0.0.1:7072/"; }, 120);
  const started = Date.now();
  await assert.rejects(
    executeInFrame(navigating, "1", { window, timeoutMs: 10_000 }),
    (error) => error instanceof FrameGoneError && /navigated/.test(error.message) && error.retryable === true,
  );
  assert.ok(Date.now() - started < 2_000, "the abandoned script must not wait for the deadline");

  const destroyed = {
    executeJavaScript: () => new Promise(() => {}),
    frames: [],
    isDestroyed: () => false,
    url: "http://127.0.0.1:7071/",
  };
  setTimeout(() => { destroyed.isDestroyed = () => true; }, 120);
  await assert.rejects(
    executeInFrame(destroyed, "1", { window: null, timeoutMs: 10_000 }),
    (error) => error instanceof FrameGoneError && /destroyed/.test(error.message),
  );

  const slow = { executeJavaScript: () => new Promise(() => {}), frames: [], url: "http://127.0.0.1:7071/" };
  await assert.rejects(
    executeInFrame(slow, "1", { window: null, timeoutMs: 300 }),
    /did not finish within/,
  );
});

test("a wedged frame command does not block the next command on the same frame", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-driver-wedge-"));
  const betaHome = path.join(root, "beta-launcher");
  let calls = 0;
  const brainstem = {
    executeJavaScript: () => {
      calls += 1;
      if (calls === 1) {
        // The route swaps underneath the first command: Electron never settles it.
        setTimeout(() => { brainstem.url = "http://127.0.0.1:7072/"; }, 150);
        return new Promise(() => {});
      }
      return Promise.resolve({ h: "@brainstem.composer", ok: true, text: "ready" });
    },
    frames: [],
    url: "http://127.0.0.1:7071/",
  };
  const mainFrame = { executeJavaScript: () => 0, frames: [brainstem], url: "file:///frontier/index.html" };
  const driver = await startUiDriverServer({
    brainstemHome: root,
    env: { BRAINSTEM_BETA_HOME: betaHome, BRAINSTEM_BETA_UI_DRIVER_HEARTBEAT_MS: "10" },
    loopbackUrl: (url) => url.startsWith("http://127.0.0.1:707"),
    window: { webContents: { mainFrame } },
  });
  try {
    const metadata = JSON.parse(readFileSync(path.join(betaHome, "ui-driver.json"), "utf8"));
    const started = Date.now();
    const [first, second] = await Promise.all([
      postCommand(metadata, { action: "read", selector: "#input" }),
      postCommand(metadata, { action: "read", selector: "#input" }),
    ]);
    // HTTP arrival order is not guaranteed, and the bus always answers 200 once
    // its headers are flushed; the verdict lives in the payload. Exactly one
    // command rode the navigating frame and was abandoned; the other ran on
    // the new frame.
    const payloads = [first.payload, second.payload];
    const detail = JSON.stringify(payloads);
    const abandoned = payloads.filter((payload) => payload.ok === false);
    const served = payloads.filter((payload) => payload.ok === true);
    assert.equal(abandoned.length, 1, detail);
    assert.match(abandoned[0].error, /navigated/, detail);
    assert.equal(served.length, 1, detail);
    assert.equal(served[0].result?.text, "ready", detail);
    assert.ok(Date.now() - started < 5_000, "the second command must not wait behind the wedged one");
    assert.equal(calls, 2);
  } finally {
    await driver.stop();
    rmSync(root, { force: true, recursive: true });
  }
});

test("persisted UI driver traces redact errors and rotate within bounded retention", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-driver-trace-cap-"));
  const betaHome = path.join(root, "beta-launcher");
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const fakeToken = `ghp_${"A".repeat(36)}`;
  const oversized = `token=${fakeToken} ${"x".repeat(100 * 1024)}`;
  const logDir = path.join(betaHome, "logs");
  mkdirSync(logDir, { recursive: true });
  const now = Date.now();
  for (let index = 1; index <= 25; index += 1) {
    const file = path.join(logDir, `ui-driver-old-${index}.jsonl`);
    writeFileSync(file, "{}\n");
    const when = new Date(now - index * 60 * 60 * 1000);
    utimesSync(file, when, when);
  }
  const brainstem = {
    executeJavaScript: async () => {
      throw new Error(`UI target not found: ${oversized}`);
    },
    frames: [],
    url: "http://127.0.0.1:7071/",
  };
  const mainFrame = {
    executeJavaScript: async () => null,
    frames: [brainstem],
    url: "file:///frontier/index.html",
  };
  const driver = await startUiDriverServer({
    brainstemHome: root,
    env: {
      BRAINSTEM_BETA_HOME: betaHome,
      BRAINSTEM_BETA_UI_DRIVER_TRACE_MAX_BYTES: "1024",
    },
    loopbackUrl: (url) => url.startsWith("http://127.0.0.1:707"),
    window: { webContents: { mainFrame } },
  });
  t.after(() => driver.stop());
  const metadata = JSON.parse(readFileSync(driver.metadataPath, "utf8"));
  assert.equal(
    readdirSync(logDir)
      .filter((name) => /^ui-driver-.*\.jsonl(?:\.\d+)?$/.test(name))
      .length,
    20,
  );

  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await postCommand(metadata, {
      action: "read",
      selector: oversized,
    });
    assert.equal(response.payload.ok, false);
  }

  const [trace] = readFileSync(metadata.tracePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(trace.effect.error.length <= 2000);
  assert.ok(readFileSync(metadata.tracePath).byteLength < 5000);
  assert.ok(existsSync(`${metadata.tracePath}.1`));
  const persisted = [
    readFileSync(metadata.tracePath, "utf8"),
    readFileSync(`${metadata.tracePath}.1`, "utf8"),
  ].join("\n");
  assert.doesNotMatch(persisted, /ghp_/);
  assert.doesNotMatch(persisted, new RegExp(fakeToken));
  assert.match(persisted, /\[redacted:token\]/);
  assert.equal(
    readdirSync(logDir)
      .filter((name) => /^ui-driver-.*\.jsonl(?:\.\d+)?$/.test(name))
      .length,
    21,
  );
});

test("the chat lease never marks the composer disabled", async () => {
  const source = uiDriverInternals.browserDriverCommand.toString();
  assert.doesNotMatch(source, /rappChatLease === "locked"/);
  assert.doesNotMatch(
    source,
    /aria-disabled", *\n? *state\.chatLeaseLocked/,
  );
  assert.doesNotMatch(source, /send\.dataset\.rappChatLease = "locked"/);

  const harness = makeLeaseHarness();
  await harness.command({
    action: "set_chat_lease",
    locked: true,
    token: "delegate",
  });
  assert.equal(harness.send.attributes.get("aria-disabled"), "false");
  assert.equal(harness.send.dataset.rappChatLease, "advisory");
});

test("the frame watchdog budget follows the command's own budget, never truncating a healthy chat", () => {
  const { frameBudgetMs, stepBudgetMs } = uiDriverInternals;
  // a delegated chat with a 60 s budget gets that plus grace
  assert.ok(frameBudgetMs({ action: "chat", timeoutMs: 60_000 }) >= 75_000);
  // the in-frame default for chat is 180 s, so the watchdog must not fire at 20 s
  assert.ok(frameBudgetMs({ action: "chat" }) >= 180_000);
  // a one-hour chat is honoured (capped at one hour plus grace)
  assert.ok(frameBudgetMs({ action: "chat", timeoutMs: 3_600_000 }) >= 3_600_000);
  assert.ok(frameBudgetMs({ action: "chat", timeoutMs: 99_999_999 }) <= 3_600_000 + 30_000);
  // The visible Surgeon itself defaults to a one-hour wait.
  assert.ok(frameBudgetMs({ action: "surgeon_chat" }) >= 3_600_000);
  // a run adds up its steps: typing 2000 chars at 18 ms is 36 s of legitimate work
  const typing = frameBudgetMs({ action: "run", steps: [{ action: "type", value: "x".repeat(2000) }, { action: "click", settleMs: 500 }] });
  assert.ok(typing >= 36_000 + 500);
  // a quick read keeps the 20 s floor
  assert.equal(frameBudgetMs({ action: "read", selector: "#input" }), 20_000);
  // an explicit frameTimeoutMs still wins
  assert.equal(frameBudgetMs({ action: "chat", frameTimeoutMs: 1234 }), 1234);
  assert.equal(stepBudgetMs({ action: "wait", timeoutMs: 999_999 }), 120_000);
});

test("a frame script abandoned by the watchdog stops at its next tick when a later command takes the frame", () => {
  const source = uiDriverInternals.browserDriverCommand.toString();
  assert.match(source, /state\.activeCommandId = myCommandId/);
  assert.match(source, /if \(state\.activeCommandId !== myCommandId\)/);
  assert.match(source, /UiDriverSupersededError/);
  // the id rides beside the command, not inside it (traces stay identical pass to pass)
  const server = readFileSync(new URL("../electron/ui-driver-server.mjs", import.meta.url), "utf8");
  assert.match(server, /createUiDriverHelpers\.toString\(\)\}, \$\{JSON\.stringify\(commandId\)\}, \$\{/);
  assert.match(server, /timeoutMs: frameBudgetMs\(command\)/);
});

test("every script sent to the Brainstem or a twin frame goes through the watchdog", () => {
  const server = readFileSync(new URL("../electron/ui-driver-server.mjs", import.meta.url), "utf8");
  // the only bare frame.executeJavaScript( is the one inside executeInFrame itself
  const bare = server.match(/[^.\w]frame\.executeJavaScript\(/g) || [];
  assert.equal(bare.length, 1, `bare frame.executeJavaScript calls: ${bare.length}`);
  assert.doesNotMatch(server, /activeFrame\.executeJavaScript\(/);
  assert.doesNotMatch(server, /target\.executeJavaScript\(/);
});

test("a trace that cannot be written does not turn a finished command into a failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-driver-trace-"));
  const betaHome = path.join(root, "beta-launcher");
  mkdirSync(betaHome, { recursive: true });
  // `logs` is a FILE, so every trace append fails with ENOTDIR/EEXIST
  writeFileSync(path.join(betaHome, "logs"), "not a directory\n");
  const brainstem = {
    executeJavaScript: () => Promise.resolve({ h: "@brainstem.composer", ok: true, text: "ready" }),
    frames: [],
    url: "http://127.0.0.1:7071/",
  };
  const mainFrame = { executeJavaScript: () => 0, frames: [brainstem], url: "file:///frontier/index.html" };
  const driver = await startUiDriverServer({
    brainstemHome: root,
    env: { BRAINSTEM_BETA_HOME: betaHome, BRAINSTEM_BETA_UI_DRIVER_HEARTBEAT_MS: "10" },
    loopbackUrl: (url) => url.startsWith("http://127.0.0.1:7071"),
    window: { webContents: { mainFrame } },
  });
  try {
    const metadata = JSON.parse(readFileSync(path.join(betaHome, "ui-driver.json"), "utf8"));
    const { payload } = await postCommand(metadata, { action: "read", selector: "#input" });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.result?.text, "ready");
    assert.match(String(payload.trace_error || ""), /ENOTDIR|EEXIST|ENOENT|not a directory/i);
  } finally {
    await driver.stop();
    rmSync(root, { force: true, recursive: true });
  }
});

test("outline state treats advisory leases as enabled without exempting disabled controls", () => {
  const helpers = uiDriverInternals.createUiDriverHelpers();
  const send = {
    dataset: { rappChatLease: "advisory" },
    disabled: false,
    getAttribute: (name) => (name === "aria-disabled" ? "false" : null),
    localName: "button",
  };

  assert.equal(helpers.stateFor(send), "enabled");
  send.dataset.rappChatLease = "locked";
  send.getAttribute = (name) => (name === "aria-disabled" ? "true" : null);
  assert.equal(helpers.stateFor(send), "disabled");
});

test("a trusted starter-prompt click hands the composer to the person instead of being swallowed", async () => {
  const harness = makeLeaseHarness();
  await harness.command(
    { action: "set_chat_lease", locked: true, token: "delegate" },
  );
  const trustedClick = eventRecorder({
    isTrusted: true,
    target: { closest: () => ({}) },
  });

  harness.starters.listeners.get("click")(trustedClick);

  assert.equal(trustedClick.preventDefaultCalled, false);
  assert.equal(trustedClick.stopImmediatePropagationCalled, false);
  const state = harness.context.window.__brainstemAiDriver;
  assert.equal(state.chatLeaseTokens.size, 0);
  assert.equal(state.chatLeaseLocked, false);
  assert.equal(state.composerHandoffs, 1);
  assert.equal(state.composerHandoffReason, "starter");
  const banner = harness.elements.get("brainstem-beta-chat-lease");
  assert.match(banner.textContent, /took this chat back/i);
  assert.equal(banner.hidden, false);
  assert.equal(harness.send.dataset.rappChatLease, undefined);
});

test("a trusted click in the starter-prompt container's padding does not hand off", async () => {
  const harness = makeLeaseHarness();
  await harness.command(
    { action: "set_chat_lease", locked: true, token: "delegate" },
  );
  const trustedClick = eventRecorder({
    isTrusted: true,
    target: { closest: () => null },
  });

  harness.starters.listeners.get("click")(trustedClick);

  const state = harness.context.window.__brainstemAiDriver;
  assert.equal(state.composerHandoffs || 0, 0);
  assert.equal(state.chatLeaseTokens.size, 1);
  assert.equal(state.chatLeaseLocked, true);
  assert.equal(trustedClick.preventDefaultCalled, false);
  assert.equal(trustedClick.stopImmediatePropagationCalled, false);
});

test("the person's Enter and Send click hand the composer off rather than being swallowed", async () => {
  const harness = makeLeaseHarness();
  await harness.command(
    { action: "set_chat_lease", locked: true, token: "send-token" },
  );
  const sendClick = eventRecorder({ isTrusted: true });
  harness.send.listeners.get("click")(sendClick);
  let state = harness.context.window.__brainstemAiDriver;
  assert.equal(sendClick.preventDefaultCalled, false);
  assert.equal(sendClick.stopImmediatePropagationCalled, false);
  assert.equal(state.chatLeaseTokens.size, 0);
  assert.equal(state.composerHandoffs, 1);
  assert.equal(state.composerHandoffReason, "send");

  await harness.command(
    { action: "set_chat_lease", locked: true, token: "enter-token" },
  );
  const enter = eventRecorder({
    isTrusted: true,
    key: "Enter",
    shiftKey: false,
  });
  harness.input.listeners.get("keydown")(enter);
  state = harness.context.window.__brainstemAiDriver;
  assert.equal(enter.preventDefaultCalled, false);
  assert.equal(enter.stopImmediatePropagationCalled, false);
  assert.equal(state.chatLeaseTokens.size, 0);
  assert.equal(state.composerHandoffs, 2);
  assert.equal(state.composerHandoffReason, "enter");

  await harness.command(
    { action: "set_chat_lease", locked: true, token: "ignored-token" },
  );
  const count = state.composerHandoffs;
  const shiftEnter = eventRecorder({
    isTrusted: true,
    key: "Enter",
    shiftKey: true,
  });
  const tab = eventRecorder({
    isTrusted: true,
    key: "Tab",
    shiftKey: false,
  });
  harness.input.listeners.get("keydown")(shiftEnter);
  harness.input.listeners.get("keydown")(tab);
  assert.equal(state.chatLeaseTokens.size, 1);
  assert.equal(state.composerHandoffs, count);
  assert.equal(shiftEnter.preventDefaultCalled, false);
  assert.equal(tab.preventDefaultCalled, false);
});

test("a real keystroke in the composer hands it back, exactly as the banner promises", async () => {
  const harness = makeLeaseHarness();
  await harness.command(
    { action: "set_chat_lease", locked: true, token: "person" },
  );
  const typing = eventRecorder({ isTrusted: true });
  harness.input.listeners.get("beforeinput")(typing);
  const state = harness.context.window.__brainstemAiDriver;
  assert.equal(typing.preventDefaultCalled, false);
  assert.equal(typing.stopImmediatePropagationCalled, false);
  assert.equal(state.chatLeaseTokens.size, 0);
  assert.equal(state.chatLeaseLocked, false);
  assert.equal(state.composerHandoffs, 1);
  assert.equal(state.composerHandoffReason, "typing");
  assert.match(
    harness.elements.get("brainstem-beta-chat-lease").textContent,
    /took this chat back/i,
  );

  await harness.command(
    { action: "set_chat_lease", locked: true, token: "synthetic" },
  );
  harness.input.listeners.get("beforeinput")(
    eventRecorder({ isTrusted: false }),
  );
  assert.equal(state.chatLeaseTokens.size, 1);
  assert.equal(state.chatLeaseLocked, true);
  assert.equal(state.composerHandoffs, 1);
});

test("a synthetic click never hands off the composer", async () => {
  const harness = makeLeaseHarness();
  await harness.command(
    { action: "set_chat_lease", locked: true, token: "delegate" },
  );
  const starterClick = eventRecorder({
    isTrusted: false,
    target: { closest: () => ({}) },
  });
  const sendClick = eventRecorder({ isTrusted: false });

  harness.starters.listeners.get("click")(starterClick);
  harness.send.listeners.get("click")(sendClick);

  // This pins only that automation cannot impersonate a person's handoff.
  const state = harness.context.window.__brainstemAiDriver;
  assert.equal(starterClick.preventDefaultCalled, false);
  assert.equal(sendClick.preventDefaultCalled, false);
  assert.equal(state.chatLeaseTokens.size, 1);
  assert.equal(state.chatLeaseLocked, true);
  assert.equal(state.composerHandoffs || 0, 0);
});

test("chat yields without sending when the person takes the composer mid-type", async () => {
  const harness = makeChatHarness();
  await harness.command(
    { action: "set_chat_lease", locked: true, token: "delegate" },
  );
  const prompt = "delegate this";
  let handedOff = false;
  harness.setOnInputValue((element, value) => {
    if (handedOff || value.length < 4 || value === prompt) return;
    handedOff = true;
    element.listeners.get("beforeinput")?.({ isTrusted: true });
    element._value += " + person's correction";
  });

  const result = await harness.command({
    action: "chat",
    typingDelayMs: 1,
    value: prompt,
  });

  const publicResult = { ...result };
  delete publicResult.__trace;
  assert.deepEqual(
    JSON.parse(JSON.stringify(publicResult)),
    { yielded_to_user: true, reason: "person_took_composer" },
  );
  assert.equal(harness.sendClicks(), 0);
  assert.equal(harness.slots.length, 0);
  assert.equal(
    harness.context.window.__brainstemAiDriver.chatLeaseTokens.size,
    0,
  );
  assert.match(harness.input.value, /person's correction/);
});

test("chat yields if the person acts during the send animation", async () => {
  const harness = makeChatHarness();
  const prompt = "delegate this";
  let handedOff = false;
  harness.setOnTimer(({ observing }) => {
    if (handedOff || !observing) return;
    handedOff = true;
    harness.input.listeners.get("beforeinput")?.({ isTrusted: true });
    harness.input._value += " + wait";
  });

  const result = await harness.command({
    action: "chat",
    typingDelayMs: 0,
    value: prompt,
  });

  const publicResult = { ...result };
  delete publicResult.__trace;
  assert.deepEqual(
    JSON.parse(JSON.stringify(publicResult)),
    { yielded_to_user: true, reason: "person_took_composer" },
  );
  assert.equal(harness.sendClicks(), 0);
  assert.equal(harness.slots.length, 0);
  assert.match(harness.input.value, /\+ wait$/);
});

test("chat never adopts a request slot the person created", async (t) => {
  const prompt = "driver prompt";
  await t.test("does not adopt a slot the person created mid-typing", async () => {
    const duringTyping = makeChatHarness();
    let personSlotAdded = false;
    duringTyping.setOnInputValue((_element, value) => {
      if (personSlotAdded || !value) return;
      personSlotAdded = true;
      duringTyping.appendSlot({
        id: 5,
        response: "private reply",
        user: "my private question",
      }, false);
    });
    duringTyping.setOnSend(() => {
      duringTyping.setInputValue("");
      duringTyping.appendSlot({
        id: 6,
        response: "driver reply",
        user: prompt,
      });
    });

    const result = await duringTyping.command({
      action: "chat",
      typingDelayMs: 1,
      value: prompt,
    });
    assert.equal(result.requestId, 6);
    assert.equal(result.response, "driver reply");
    assert.equal(
      duringTyping.slots[0].previousElementSibling.dataset.rappActor,
      undefined,
    );
  });

  await t.test("correlates post-send slots by its own user-bubble text", async () => {
    const afterBaseline = makeChatHarness();
    afterBaseline.setOnSend(() => {
      afterBaseline.setInputValue("");
      afterBaseline.appendSlot({
        id: 5,
        response: "private reply",
        user: "my private question",
      }, false);
      afterBaseline.appendSlot({
        id: 6,
        response: "driver reply",
        user: prompt,
      }, false);
      afterBaseline.notifyObservers();
    });
    const correlated = await afterBaseline.command({
      action: "chat",
      typingDelayMs: 0,
      value: prompt,
    });
    assert.equal(correlated.requestId, 6);
    assert.equal(correlated.response, "driver reply");
  });

  await t.test("stamps AI attribution on the owned user bubble", async () => {
    const attribution = makeChatHarness();
    const result = await attribution.command({
      action: "chat",
      typingDelayMs: 0,
      value: prompt,
    });
    const ownBubble = attribution.slots[0].previousElementSibling;
    assert.equal(result.requestId, 1);
    assert.equal(ownBubble.dataset.rappActor, "ai");
    assert.equal(ownBubble.title, "Sent by the Brain Surgeon");
  });
});

test("chat never adopts a pre-existing slot before its own renders", async () => {
  const harness = makeChatHarness();
  harness.appendSlot({
    id: 3,
    response: "stranger reply",
    user: "stranger question",
  }, false);
  const prompt = "driver prompt";
  harness.setOnSend(() => {
    harness.setInputValue("");
    harness.notifyObservers();
    harness.appendSlot({
      id: 4,
      response: "driver reply",
      user: prompt,
    });
  });

  const result = await harness.command({
    action: "chat",
    typingDelayMs: 0,
    value: prompt,
  });
  assert.equal(result.requestId, 4);
  assert.equal(result.response, "driver reply");
});

test("chat fails fast when its owned response slot is cleared", async () => {
  const harness = makeChatHarness();
  const prompt = "driver prompt";
  let removed = false;
  harness.setOnSend(() => {
    harness.setInputValue("");
    harness.appendSlot({
      id: 1,
      response: "",
      user: prompt,
    });
  });
  harness.setOnTimer(({ ms }) => {
    if (removed || ms !== 150) return;
    removed = true;
    harness.removeSlot(1, false);
  });

  const startedAt = Date.now();
  await assert.rejects(
    harness.command({
      action: "chat",
      timeoutMs: 1000,
      typingDelayMs: 0,
      value: prompt,
    }),
    /chat was cleared or reset before the reply arrived.*request was cancelled/,
  );
  assert.ok(Date.now() - startedAt < 500, "a dead request must not hold the queue");
});

test("chat refuses to clobber text the person already typed", async () => {
  const harness = makeChatHarness();
  harness.setInputValue("stop, that's wrong");

  const yielded = await harness.command({
    action: "chat",
    typingDelayMs: 0,
    value: "do the thing",
  });
  const publicYield = { ...yielded };
  delete publicYield.__trace;
  assert.deepEqual(
    JSON.parse(JSON.stringify(publicYield)),
    {
      yielded_to_user: true,
      reason: "person_has_text_in_composer",
    },
  );
  assert.equal(harness.input.value, "stop, that's wrong");
  assert.equal(harness.sendClicks(), 0);

  harness.setInputValue("");
  const completed = await harness.command({
    action: "chat",
    typingDelayMs: 0,
    value: "do the thing",
  });
  assert.equal(completed.requestId, 1);
  assert.equal(completed.response, "reply:do the thing");
  assert.equal(harness.sendClicks(), 1);
});

test("a run breaks and reports yielded_to_user when the person takes the composer", async () => {
  const harness = makeLeaseHarness();
  let fired = false;
  harness.setOnSetAttribute(({ name }) => {
    if (fired || name !== "aria-disabled") return;
    fired = true;
    harness.setOnSetAttribute(null);
    harness.input.listeners.get("beforeinput")?.({ isTrusted: true });
  });
  const yielded = await harness.command({
    action: "run",
    steps: [
      { action: "set_chat_lease", locked: true, token: "first" },
      { action: "recording_status" },
      { action: "recording_status" },
    ],
  });
  assert.equal(yielded.results.length, 1);
  assert.equal(yielded.yielded_to_user, true);

  const completed = await harness.command({
    action: "run",
    steps: [
      { action: "recording_status" },
      { action: "recording_status" },
    ],
  });
  assert.deepEqual(Object.keys(completed), ["results", "summaries"]);
  assert.equal(completed.results.length, 2);
});
