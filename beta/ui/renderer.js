const frame = document.getElementById("brainstem");
const splash = document.getElementById("splash");
const error = document.getElementById("error");
const intro = document.getElementById("intro");
const introStorageKey = "rapp-brainstem-beta-intro-v1";
const surgeon = document.getElementById("surgeon");
const surgeonLog = document.getElementById("surgeon-log");
const surgeonInput = document.getElementById("surgeon-input");
const surgeonSend = document.getElementById("surgeon-send");
const surgeonTabs = document.getElementById("surgeon-tabs");
const surgeonHerdBtn = document.getElementById("surgeon-herd-btn");
const ambientDialog = document.getElementById("ambient-settings");
const ambientGranularity = document.getElementById("ambient-granularity");
const ambientLocationLabel = document.getElementById("ambient-location-label");
const ambientLocationLat = document.getElementById("ambient-location-lat");
const ambientLocationLon = document.getElementById("ambient-location-lon");
const ambientApproximate = document.getElementById("ambient-approximate");
const ambientStatus = document.getElementById("ambient-settings-status");
let surgeonHerdEl = null;
let surgeonGridEl = null;
// rapplication twins hatched into the herd (id -> {descriptor, tileEl}).
const twins = new Map();
const surgeonHistoryKey = "rapp-brainstem-beta-surgeon-sessions-v1";
const surgeonOpenKey = "rapp-brainstem-beta-surgeon-open-v1";
const explorer = document.getElementById("explorer");
const agentTree = document.getElementById("agent-tree");
const agentSource = document.getElementById("agent-source");
const agentViewerEmpty = document.getElementById("agent-viewer-empty");
const agentViewerTab = document.getElementById("agent-viewer-tab");
const explorerStatus = document.getElementById("explorer-status");
const explorerOpenKey = "rapp-brainstem-beta-explorer-open-v1";
let loadedUrl = null;
let brainstemNavigationCount = 0;
window.__brainstemBetaNavigationCount = 0;
let latestState = null;
// Multi-chat Rappter Surgeon state (several independent Copilot chats).
let surgeonSessions = [];
let surgeonActiveId = 0;
let surgeonSeq = 0;
let surgeonHerd = false;
let currentAgentFile = null;
let currentAgentScope = "global";
let currentAgentRevision = null;
let agentTreeSignature = null;
let agentRefreshPromise = null;
let openBetaMenuOnNextSync = false;
let pendingLineageReply = null;
let loadedFrameUrl = null;
const chatStreamMode = ["smooth", "raw", "hold"].includes(
  window.brainstemBeta.chatStreamMode,
)
  ? window.brainstemBeta.chatStreamMode
  : "smooth";
let chatTypingEnabled = chatStreamMode === "hold";
document.documentElement.dataset.rappStream = chatStreamMode;
const { createDelivery } = window.RappTypingDelivery;
const { createTailFollower } = window.RappStreamFollow;
const {
  createStreamPacer,
  setStreamArriving,
} = window.RappStreamPacing;
const {
  applyLookStyles,
  markArrived,
  markGroupLast,
  normalizeChatLook,
  surgeonCss,
} = window.RappChatLook;
let currentChatLook = normalizeChatLook(window.brainstemBeta.chatLook);
let dimensionTilesLoader = null;
let dimensionTilesGeneration = 0;
let dimensionTilesRequested = false;

function loadDimensionTiles() {
  if (window.RappDimensionTiles) return Promise.resolve(window.RappDimensionTiles);
  if (dimensionTilesLoader) return dimensionTilesLoader;
  dimensionTilesLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "__rappDimensionTilesScript";
    script.src = "dimension-tiles.js";
    script.addEventListener("load", () => resolve(window.RappDimensionTiles), {
      once: true,
    });
    script.addEventListener("error", () => {
      dimensionTilesLoader = null;
      reject(new Error("Could not load Agent Arena."));
    }, { once: true });
    document.body.appendChild(script);
  });
  return dimensionTilesLoader;
}

async function syncDimensionTiles(state, generation) {
  const tiles = await loadDimensionTiles();
  if (
    generation !== dimensionTilesGeneration
    || !dimensionTilesRequested
    || latestState?.viewMode?.mode !== "arena"
  ) {
    tiles.disable();
    return;
  }
  return tiles.sync({
    api: window.brainstemBeta,
    viewMode: state.viewMode,
    destroyHerd: destroySurgeonHerdDom,
    ensureHerd: () => {
      ensureSurgeonHerdDom();
      return { grid: surgeonGridEl, herd: surgeonHerdEl };
    },
    enterHerd: () => {
      if (!surgeonHerd) enterSurgeonHerd();
    },
    exitHerd: () => {
      if (surgeonHerd) exitSurgeonHerd();
    },
    frame,
    frameGeneration: brainstemNavigationCount,
    hadHerdDom: Boolean(surgeonHerdEl),
    state,
  });
}

function describeAmbientState(value) {
  if (!value?.deviceEnabled) {
    return "Device context is disabled by RAPP_AMBIENT_DEVICE=0.";
  }
  const location = value.device?.data?.location;
  if (!location) return "Device context is starting.";
  const coordinates = Number.isFinite(location.lat)
    && Number.isFinite(location.lon)
    ? ` · ${location.lat}, ${location.lon}`
    : "";
  return [
    `source=${location.source}`,
    `detail=${location.granularity}`,
    location.label ? `label=${location.label}` : "",
  ].filter(Boolean).join(" · ") + coordinates;
}

function applyAmbientState(value, { updateForm = true } = {}) {
  const settings = value?.settings || {};
  if (updateForm) {
    ambientGranularity.value = settings.granularity || "precise";
    ambientApproximate.checked = settings.approximateFallback === true;
    ambientLocationLabel.value = settings.userLocation?.label || "";
    ambientLocationLat.value = settings.userLocation?.lat ?? "";
    ambientLocationLon.value = settings.userLocation?.lon ?? "";
  }
  ambientStatus.textContent = describeAmbientState(value);
  return value;
}

async function loadAmbientSettings({ updateForm = true } = {}) {
  try {
    return applyAmbientState(
      await window.brainstemBeta.getAmbientSettings(),
      { updateForm },
    );
  } catch (cause) {
    ambientStatus.textContent =
      `Could not read ambient settings: ${String(cause?.message || cause)}`;
    return null;
  }
}

function ambientSettingsPayload({ userLocation = undefined } = {}) {
  const label = ambientLocationLabel.value.trim();
  const lat = ambientLocationLat.value === ""
    ? null
    : Number(ambientLocationLat.value);
  const lon = ambientLocationLon.value === ""
    ? null
    : Number(ambientLocationLon.value);
  const inferredLocation = label || lat !== null || lon !== null
    ? { label, lat, lon }
    : null;
  return {
    approximateFallback: ambientApproximate.checked,
    granularity: ambientGranularity.value,
    userLocation: userLocation === undefined
      ? inferredLocation
      : userLocation,
  };
}

async function saveAmbientSettings({ userLocation = undefined } = {}) {
  ambientStatus.textContent = "Saving on-device ambient settings...";
  try {
    const value = await window.brainstemBeta.setAmbientSettings(
      ambientSettingsPayload({ userLocation }),
    );
    return applyAmbientState(value);
  } catch (cause) {
    ambientStatus.textContent =
      `Could not save ambient settings: ${String(cause?.message || cause)}`;
    return null;
  }
}

async function requestDeviceLocation({ clearSaved = false } = {}) {
  let state = await loadAmbientSettings({ updateForm: false });
  if (!state?.deviceEnabled || state.settings?.granularity === "off") return state;
  if (clearSaved && state.settings?.userLocation) {
    state = await saveAmbientSettings({ userLocation: null });
    if (!state) return null;
  } else if (state.settings?.userLocation) {
    return state;
  }
  if (!navigator.geolocation) {
    return applyAmbientState(await window.brainstemBeta.updateGeolocation({
      reason: "navigator.geolocation is unavailable in this renderer",
    }));
  }
  ambientStatus.textContent = "Requesting location from this device...";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      void window.brainstemBeta.updateGeolocation({
        accuracy_m: position.coords.accuracy,
        at: new Date(position.timestamp).toISOString(),
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      }).then((value) => applyAmbientState(value, { updateForm: false }))
        .catch((cause) => {
          ambientStatus.textContent =
            `Could not save device location: ${String(cause?.message || cause)}`;
        });
    },
    (geolocationError) => {
      void window.brainstemBeta.updateGeolocation({
        reason: geolocationError?.message
          || `navigator.geolocation error ${geolocationError?.code || "unknown"}`,
      }).then((value) => applyAmbientState(value, { updateForm: false }))
        .catch((cause) => {
          ambientStatus.textContent =
            `Could not report device location: ${String(cause?.message || cause)}`;
        });
    },
    {
      enableHighAccuracy: state.settings?.granularity === "precise",
      maximumAge: 0,
      timeout: 10000,
    },
  );
  return state;
}

async function openAmbientSettings() {
  await loadAmbientSettings();
  if (typeof ambientDialog.showModal === "function") ambientDialog.showModal();
  else ambientDialog.setAttribute("open", "");
}

async function maintainAmbientContext() {
  try {
    const value = applyAmbientState(
      await window.brainstemBeta.refreshAmbient(),
      { updateForm: false },
    );
    if (
      value?.deviceEnabled
      && !value.settings?.userLocation
      && value.settings?.granularity !== "off"
    ) void requestDeviceLocation();
    return value;
  } catch (cause) {
    ambientStatus.textContent =
      `Could not refresh ambient context: ${String(cause?.message || cause)}`;
    return null;
  }
}

function syncSurgeonMessageGroups(session) {
  const messages = session?.logEl?.querySelectorAll(
    ".surgeon-message.user, .surgeon-message.assistant",
  ) || [];
  markGroupLast(
    messages,
    currentChatLook === "messages" ? undefined : () => null,
  );
}

function syncTwinMessageGroups(tile) {
  const turns = tile?.querySelectorAll(".twin-chat .tw-turn") || [];
  markGroupLast(
    turns,
    currentChatLook === "messages"
      ? (turn) => turn.classList.contains("self") ? "user" : "assistant"
      : () => null,
  );
}

function clearShellMessageMarkers() {
  document.querySelectorAll(
    ".surgeon-message, .twin-chat .tw-turn",
  ).forEach((message) => {
    message.removeAttribute("data-group-last");
    message.removeAttribute("data-rapp-arrived");
    message.classList.remove("rapp-group-last", "rapp-message-arrived");
  });
}

function applyShellChatLook(look, typingEnabled = chatTypingEnabled) {
  currentChatLook = normalizeChatLook(look);
  chatTypingEnabled = Boolean(typingEnabled);
  applyLookStyles(
    document,
    currentChatLook,
    surgeonCss,
    "__rappSurgeonChatLook",
  );
  if (currentChatLook === "messages") {
    for (const session of surgeonSessions) syncSurgeonMessageGroups(session);
    for (const twin of twins.values()) syncTwinMessageGroups(twin.tileEl);
  } else {
    clearShellMessageMarkers();
  }
  return {
    chatLook: currentChatLook,
    chatTypingEnabled,
  };
}

function driveKey(value) {
  return encodeURIComponent(String(value ?? ""));
}

function deliverPendingLineageReply() {
  if (
    !pendingLineageReply
    || pendingLineageReply.url !== loadedFrameUrl
    || pendingLineageReply.sent
  ) return;
  pendingLineageReply.sent = true;
  frame.contentWindow?.postMessage({
    type: "rapp-beta:lineage-confirmation",
    confirmationId: pendingLineageReply.id,
    reply: pendingLineageReply.reply,
  }, "*");
}

frame.addEventListener("load", () => {
  loadedFrameUrl = loadedUrl;
  if (pendingLineageReply?.url === loadedFrameUrl) {
    pendingLineageReply.sent = false;
  }
  brainstemNavigationCount += 1;
  window.__brainstemBetaNavigationCount = brainstemNavigationCount;
  window.RappDimensionTiles?.frameChanged({
    generation: brainstemNavigationCount,
    url: loadedFrameUrl,
  });
  void window.brainstemBeta.installFrameBridge().then(() => {
    syncBetaUpdate(latestState?.update, openBetaMenuOnNextSync);
    syncExplorerState();
    openBetaMenuOnNextSync = false;
    deliverPendingLineageReply();
  });
});
window.addEventListener("message", async (event) => {
  const type = event.data?.type;
  if ([
    "rapp-beta:twin-ledger-turn",
    "rapp-beta:twin-refresh-ambient",
  ].includes(type)) {
    const twinId = String(event.data.twinId || "");
    const twinUrl = twins.get(twinId)?.descriptor?.url;
    try {
      if (!twinUrl || event.origin !== new URL(twinUrl).origin) return;
    } catch {
      return;
    }
    if (type === "rapp-beta:twin-refresh-ambient") {
      const requestId = String(event.data.requestId || "");
      try {
        const result = await window.brainstemBeta.refreshAmbient();
        event.source.postMessage({
          type: "rapp-beta:twin-refresh-ambient-result",
          requestId,
          ok: true,
          result: { ok: Boolean(result) },
        }, "*");
      } catch (cause) {
        event.source.postMessage({
          type: "rapp-beta:twin-refresh-ambient-result",
          requestId,
          ok: false,
          error: String(cause?.message || cause),
        }, "*");
      }
      return;
    }
    void window.brainstemBeta.recordTwinTurn(twinId, event.data.turn).catch(
      (cause) => console.warn(
        "OpenRappter could not persist the completed twin turn.",
        cause,
      ),
    );
    return;
  }
  if (event.source !== frame.contentWindow) return;
  if (type === "rapp-beta:tile-pending-complete") {
    try {
      const tile = await window.brainstemBeta.tilesComplete(
        event.data.id,
        {
          ...event.data.completion,
          requestId: event.data.requestId,
        },
      );
      event.source.postMessage({
        type: "rapp-beta:tile-completion-ack",
        requestId: event.data.requestId,
      }, "*");
      window.RappDimensionTiles?.completionSaved({
        ...event.data,
        tile,
      });
    } catch (cause) {
      console.error("Could not persist a completed dimension tile reply:", cause);
      window.RappDimensionTiles?.completionFailed(cause);
    }
    return;
  }
  if (type === "rapp-beta:tile-detached") {
    window.RappDimensionTiles?.tileDetached(event.data.id);
    return;
  }
  if (type === "rapp-beta:set-chat-look") {
    try {
      await window.brainstemBeta.setChatLook(event.data.look);
    } catch (cause) {
      window.alert(`Could not change chat look: ${String(cause?.message || cause)}`);
    }
    return;
  }
  if (type === "rapp-beta:set-view-mode") {
    try {
      await window.brainstemBeta.setViewMode(event.data.viewMode || {});
    } catch (cause) {
      window.alert(
        `Could not change the herd view mode: ${String(cause?.message || cause)}`,
      );
    }
    return;
  }
  if (type === "rapp-beta:check-updates") {
    await window.brainstemBeta.checkForUpdates();
    return;
  }
  if (type === "rapp-beta:install-update") {
    await window.brainstemBeta.installUpdate();
    return;
  }
  if (type === "rapp-beta:toggle-explorer") {
    setExplorerOpen(!explorer.classList.contains("open"));
    return;
  }
  if (type === "rapp-beta:open-ambient-settings") {
    await openAmbientSettings();
    return;
  }
  if (type === "rapp-beta:refresh-ambient") {
    const requestId = String(event.data.requestId || "");
    try {
      const result = await window.brainstemBeta.refreshAmbient();
      event.source.postMessage({
        type: "rapp-beta:refresh-ambient-result",
        requestId,
        ok: true,
        result: { ok: Boolean(result) },
      }, "*");
    } catch (cause) {
      event.source.postMessage({
        type: "rapp-beta:refresh-ambient-result",
        requestId,
        ok: false,
        error: String(cause?.message || cause),
      }, "*");
    }
    return;
  }
  if (type === "rapp-beta:ledger-turn") {
    void window.brainstemBeta.recordBrainstemTurn(event.data.turn).catch(
      (cause) => console.warn(
        "OpenRappter could not persist the completed Brainstem turn.",
        cause,
      ),
    );
    return;
  }
  if (type === "rapp-beta:lineage-confirmation-ack") {
    if (
      pendingLineageReply
      && event.data.confirmationId === pendingLineageReply.id
    ) {
      void window.brainstemBeta.recordBrainstemTurn({
        agentLogs: "",
        model: null,
        requestId: pendingLineageReply.id,
        response: pendingLineageReply.reply,
        sessionId: null,
        userInput: pendingLineageReply.userInput,
      }).catch((cause) => console.warn(
        "OpenRappter could not persist the delivered lineage reply.",
        cause,
      ));
      pendingLineageReply = null;
    }
    return;
  }
  if (type === "rapp-beta:lineage-chat") {
    const requestId = String(event.data.requestId || "");
    const previousUrl = loadedUrl;
    try {
      const result = await window.brainstemBeta.lineageCommand(
        event.data.message,
      );
      if (result?.intercepted && result.url && result.url !== previousUrl) {
        pendingLineageReply = {
          id: requestId,
          reply: result.reply,
          sent: false,
          userInput: String(event.data.message || ""),
          url: result.url,
        };
        if (loadedFrameUrl === result.url) {
          await window.brainstemBeta.installFrameBridge();
          deliverPendingLineageReply();
        }
      }
      event.source.postMessage({
        type: "rapp-beta:lineage-chat-result",
        requestId,
        ok: true,
        result,
      }, "*");
    } catch (cause) {
      event.source.postMessage({
        type: "rapp-beta:lineage-chat-result",
        requestId,
        ok: false,
        error: String(cause?.message || cause),
      }, "*");
    }
    return;
  }
  if (!["rapp-beta-delete-agent", "rapp-beta-export-agent"].includes(type)) return;
  const requestId = String(event.data.requestId || "");
  try {
    const filename = String(event.data.filename || "");
    const result = type === "rapp-beta-delete-agent"
      ? await window.brainstemBeta.deleteAgent(filename)
      : await window.brainstemBeta.exportAgent(filename);
    event.source.postMessage({
      type: `${type}-result`,
      requestId,
      ok: true,
      result,
    }, "*");
    agentTreeSignature = null;
    await refreshAgentExplorer();
  } catch (cause) {
    event.source.postMessage({
      type: `${type}-result`,
      requestId,
      ok: false,
      error: String(cause?.message || cause),
    }, "*");
  }
});

function setExplorerOpen(open) {
  if (open && window.innerWidth < 820) setSurgeonOpen(false);
  explorer.classList.toggle("open", open);
  document.body.classList.toggle("explorer-open", open);
  localStorage.setItem(explorerOpenKey, open ? "open" : "closed");
  syncExplorerState();
  if (open) void refreshAgentExplorer();
}

function syncExplorerState() {
  frame.contentWindow?.postMessage({
    type: "rapp-beta:explorer-state",
    open: explorer.classList.contains("open"),
  }, "*");
}

function setSurgeonOpen(open) {
  if (open && window.innerWidth < 820) setExplorerOpen(false);
  surgeon.classList.toggle("open", open);
  document.body.classList.toggle("surgeon-open", open);
  localStorage.setItem(surgeonOpenKey, open ? "open" : "closed");
  if (open) setTimeout(() => surgeonInput.focus(), 300);
}

function shortIdentifier(value, length = 24) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function agentTreeRow(item, depth = 1) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `agent-tree-file${
    item.filename === currentAgentFile && item.scope === currentAgentScope
      ? " active"
      : ""
  }`;
  button.setAttribute("role", "treeitem");
  button.dataset.drive = `agent[${
    driveKey(`${item.scope || "global"}:${item.filename}`)
  }].row`;
  button.title = item.filename;
  button.style.paddingLeft = `${22 + (depth * 16)}px`;
  const icon = document.createElement("span");
  icon.textContent = "🐍";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.filename;
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(item.scope || "").startsWith("stack:")
    ? "role"
    : (item.loadable ? "hot-load" : "support");
  button.append(icon, name, count);
  button.addEventListener(
    "click",
    () => void openAgentFile(item.filename, item.revision, item.scope),
  );
  return button;
}

function appendStackNode(node, filesByStack, depth = 0) {
  const row = document.createElement("div");
  row.className = `agent-tree-stack${
    node.active ? " active" : (node.overlay_order ? " overlay" : "")
  }`;
  row.setAttribute("role", "treeitem");
  row.dataset.drive = `stack[${driveKey(node.rappid)}].row`;
  row.style.paddingLeft = `${20 + (depth * 16)}px`;
  row.title = node.rappid;
  const state = node.active
    ? "selected"
    : (node.overlay_order ? `overlay ${node.overlay_order}` : `${node.agent_count} agents`);
  row.textContent = `${
    node.children?.length ? "▾" : "•"
  } ${node.name} · ${state} · ${shortIdentifier(node.rappid, 18)}`;
  agentTree.appendChild(row);
  for (const item of filesByStack.get(node.rappid) || []) {
    agentTree.appendChild(agentTreeRow(item, depth + 2));
  }
  for (const child of node.children || []) {
    appendStackNode(child, filesByStack, depth + 1);
  }
}

async function refreshAgentExplorer() {
  if (agentRefreshPromise) return agentRefreshPromise;
  if (!explorer.classList.contains("open") || latestState?.brainstem?.phase !== "ready") {
    return;
  }
  agentRefreshPromise = (async () => {
    try {
      const payload = await window.brainstemBeta.listAgentFiles();
      const files = [...(payload.files || [])]
        .filter((item) => (
          typeof item.filename === "string" && item.filename.endsWith(".py")
        ))
        .sort((left, right) => left.filename.localeCompare(right.filename));
      const stackTree = Array.isArray(payload.stack_tree)
        ? payload.stack_tree
        : [];
      const signature = JSON.stringify({
        caller: payload.caller_rappid,
        memory: payload.memory_guid,
        active: payload.active_stack_rappid,
        overlays: payload.overlay_stack_rappids,
        stackTree,
        files,
      });
      if (signature !== agentTreeSignature) {
        agentTreeSignature = signature;
        agentTree.replaceChildren();
        const root = document.createElement("div");
        root.className = "agent-tree-root";
        root.textContent = "▾ RAPP/1 RUNTIME";
        agentTree.append(root);

        for (const [label, value] of [
          ["caller", payload.caller_rappid],
          ["memory", payload.memory_guid],
          ["composition", payload.composition_hash],
        ]) {
          const identityRow = document.createElement("div");
          identityRow.className = "agent-tree-identity";
          identityRow.title = String(value || "");
          identityRow.textContent = `${label}: ${shortIdentifier(value, 28)}`;
          agentTree.appendChild(identityRow);
        }

        const globalFiles = files.filter(
          (item) => !String(item.scope || "").startsWith("stack:"),
        );
        const stackFiles = files.filter(
          (item) => String(item.scope || "").startsWith("stack:"),
        );
        const globalFolder = document.createElement("div");
        globalFolder.className = "agent-tree-folder";
        globalFolder.textContent = "▾ 📁 agents/ · shared + memory";
        agentTree.appendChild(globalFolder);
        for (const item of globalFiles) {
          agentTree.appendChild(agentTreeRow(item));
        }

        const stackFolder = document.createElement("div");
        stackFolder.className = "agent-tree-folder";
        stackFolder.textContent = "▾ 🌳 stack RAPPIDs";
        agentTree.appendChild(stackFolder);
        const filesByStack = new Map();
        for (const item of stackFiles) {
          const rappid = item.scope.slice("stack:".length);
          if (!filesByStack.has(rappid)) filesByStack.set(rappid, []);
          filesByStack.get(rappid).push(item);
        }
        for (const stack of stackTree) {
          appendStackNode(stack, filesByStack);
        }
        if (!files.length) {
          const empty = document.createElement("div");
          empty.className = "agent-tree-file";
          empty.textContent = "No Python files in the active composition";
          agentTree.appendChild(empty);
        }
        if (
          currentAgentFile
          && !files.some((item) => (
            item.filename === currentAgentFile
            && item.scope === currentAgentScope
          ))
        ) {
          currentAgentFile = null;
          currentAgentScope = "global";
          currentAgentRevision = null;
          agentSource.hidden = true;
          agentViewerEmpty.hidden = false;
          agentViewerTab.textContent = "No agent selected";
        }
      }
      const selected = files.find((item) => (
        item.filename === currentAgentFile
        && item.scope === currentAgentScope
      ));
      if (selected && selected.revision !== currentAgentRevision) {
        const result = await window.brainstemBeta.readAgentFile(
          selected.filename,
          selected.scope,
        );
        currentAgentRevision = selected.revision;
        agentViewerTab.textContent = `🐍 ${
          String(selected.scope).startsWith("stack:") ? "agent_stacks" : "agents"
        }/${result.filename} · read-only`;
        agentSource.textContent = result.content;
        agentSource.hidden = false;
        agentViewerEmpty.hidden = true;
      }
      explorerStatus.textContent = `${files.length} files · memory ${
        shortIdentifier(payload.memory_guid, 8)
      } · ${(payload.overlay_stack_rappids || []).length} overlays · live`;
    } catch (cause) {
      explorerStatus.textContent = `Explorer unavailable: ${String(cause?.message || cause)}`;
    } finally {
      agentRefreshPromise = null;
    }
  })();
  return agentRefreshPromise;
}

async function openAgentFile(filename, revision = null, scope = "global") {
  try {
    const result = await window.brainstemBeta.readAgentFile(
      filename,
      scope,
    );
    currentAgentFile = result.filename;
    currentAgentScope = scope;
    currentAgentRevision = revision;
    agentViewerTab.textContent = `🐍 ${
      String(scope).startsWith("stack:") ? "agent_stacks" : "agents"
    }/${result.filename} · read-only`;
    agentSource.textContent = result.content;
    agentSource.hidden = false;
    agentViewerEmpty.hidden = true;
    agentTreeSignature = null;
    await refreshAgentExplorer();
  } catch (cause) {
    explorerStatus.textContent = `Could not read ${filename}: ${String(cause?.message || cause)}`;
  }
}

const SURGEON_STARTERS = [
  { label: "Build and test an agent for this customer use case" },
  { label: "Inspect OpenRappter and tell me what it can do" },
  { label: "Check for beta updates while I watch" },
  { label: "Record a short autopilot demo of the current workflow" },
  { label: "Show Mode: click-through preview", className: "show-mode-preview", tour: true },
  {
    label: "Deploy loaded agents to Copilot Studio",
    className: "deploy-copilot-studio",
    prompt: [
      "Run the beta one-click Copilot Studio deployment loop.",
      "First call ensure_copilot_studio_deploy_agents,",
      "copilot_studio_deployment_defaults, copilot_studio_auth_status,",
      "and list_active_agent_files.",
      "Record the protected parity_cases_path and industry_matrix_path",
      "returned by ensure_copilot_studio_deploy_agents.",
      "Present a concise numbered list of",
      "currently loaded business/industry agents that can be selected.",
      "Exclude BasicAgent, memory, RAR, UI-driver, Factory, Parity Deploy,",
      "and other infrastructure-only agents from the general list. Also offer",
      "a clearly labeled hello-world parity preset: HackerNews + ContextMemory",
      "+ ManageMemory. The memory pair is allowed only for that preset and its",
      "storage/infrastructure requirements must remain explicit. Ask me in this Rappter Surgeon",
      "chat which agents I want, the Copilot Studio display name, publisher",
      "prefix, and target environment/profile. Do not continue until I answer.",
      "If the selected user PAC profile is not authenticated to that exact",
      "environment, call start_copilot_studio_login and show me the device",
      "login instructions; poll only after I say sign-in is complete. Never",
      "read, return, or use a client secret from local.settings.json.",
      "After selection and login, use the visible Brainstem chat to drive",
      "RappCopilotStudioFactoryBeta and CopilotStudioDeployBeta through",
      "doctor, plan, build/deploy and provision. Copy the protected",
      "parity_cases_path to",
      "the deployment run as parity-cases.json before parity, then run",
      "parity and finalize. Keep working autonomously and visibly until the",
      "Draft is proven.",
      "As soon as AgentId and EnvironmentId are known, call",
      "show_copilot_studio_agent_link so this chat contains a clickable",
      "Copilot Studio card for the exact agent. The beta is Draft-only:",
      "never call release or publish. Show the exact AgentId, environment,",
      "Draft parity evidence, and warning that live publication is a manual",
      "user action in the linked Copilot Studio UI. Record the evidence and",
      "return the Copilot Studio agent ID and URL. Do not stop at",
      "instructions or stack work to VS Code.",
    ].join(" "),
  },
];

// ── Multi-chat Rappter Surgeon ─────────────────────────────────────────────
// Several independent GitHub Copilot conversations over the one visible
// Brainstem: a tab per chat plus a herd grid to see them at once. Each session
// owns its transcript node (.surgeon-session); in the dock only the active one
// shows, in the herd each node is moved into its tile — it renders identically
// either way. Every main-process event carries a sessionId so it lands in the
// right chat. Ported from the vBrainstem Rappter Surgeon (surgeon.js).

function saveSurgeonSessions() {
  try {
    const data = surgeonSessions.map((s) => ({
      id: s.id,
      title: s.title,
      history: (s.history || []).slice(-80),
    }));
    localStorage.setItem(
      surgeonHistoryKey,
      JSON.stringify({ active: surgeonActiveId, sessions: data }),
    );
  } catch {
    // Over quota — keep the last few chats, trimmed.
    try {
      const data = surgeonSessions.slice(-4).map((s) => ({
        id: s.id,
        title: s.title,
        history: (s.history || []).slice(-24),
      }));
      localStorage.setItem(
        surgeonHistoryKey,
        JSON.stringify({ active: surgeonActiveId, sessions: data }),
      );
    } catch {
      // give up silently
    }
  }
}

function activeSurgeon() {
  return surgeonSessions.find((s) => s.id === surgeonActiveId) || null;
}

// ── per-session transcript rendering (scoped to session.logEl) ──
function surgeonScroller(session) {
  return session.logEl.closest(".htrans") || surgeonLog;
}

function createSurgeonTailFollower(session) {
  return createTailFollower({
    distanceFromBottom: () => {
      const scroller = surgeonScroller(session);
      return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    },
    pinToBottom: () => {
      const scroller = surgeonScroller(session);
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
    },
    thresholdPx: 80,
  });
}

function markSurgeonUserIntent(session, duration = 320) {
  session.userIntentUntil = performance.now() + duration;
}

function handleSurgeonUserScroll(session) {
  session.streamFollower?.handleScroll({
    userInitiated: performance.now() <= session.userIntentUntil,
  });
}

function prepareSurgeonStreaming(session) {
  session.userIntentUntil = 0;
  session.streamFollower = createSurgeonTailFollower(session);
  session.streamResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => session.streamFollower.contentChanged())
    : null;
  session.logEl.addEventListener(
    "wheel",
    () => markSurgeonUserIntent(session),
    { passive: true },
  );
  session.logEl.addEventListener(
    "touchstart",
    () => markSurgeonUserIntent(session, 500),
    { passive: true },
  );
}

function surgeonPlace(session, node) {
  if (session.thinkEl && session.thinkEl.parentNode === session.logEl) {
    session.logEl.insertBefore(node, session.thinkEl);
  } else {
    session.logEl.appendChild(node);
  }
  syncSurgeonMessageGroups(session);
  scrollSurgeon(session);
}

function scrollSurgeon(session) {
  const scroller = surgeonScroller(session);
  if (session.id === surgeonActiveId || session.tileEl) {
    if (
      chatStreamMode === "smooth"
      && session.streamFollower?.state().active
    ) {
      session.streamFollower.contentChanged();
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }
}

function createSurgeonBubble(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `surgeon-message ${role}`;
  bubble.textContent = text || "";
  return bubble;
}

function addSurgeonBubble(session, role, text, persist = true) {
  removeSurgeonEmpty(session);
  const bubble = createSurgeonBubble(role, text);
  surgeonPlace(session, bubble);
  if (persist && ["user", "assistant"].includes(role)) {
    session.history.push({ role, content: text || "" });
    saveSurgeonSessions();
  }
  return bubble;
}

function replaceSurgeonBubble(session, current, role, text) {
  removeSurgeonEmpty(session);
  const bubble = createSurgeonBubble(role, text);
  if (currentChatLook === "messages" && role === "assistant") {
    markArrived(bubble);
  }
  if (current?.parentNode === session.logEl) {
    current.replaceWith(bubble);
    syncSurgeonMessageGroups(session);
    scrollSurgeon(session);
  } else {
    surgeonPlace(session, bubble);
  }
  return bubble;
}

function addSurgeonTypingBubble(session) {
  const bubble = createSurgeonBubble("assistant", "");
  bubble.classList.add("typing");
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  bubble.setAttribute("aria-label", "Rappter Surgeon is typing…");
  const dots = document.createElement("span");
  dots.className = "surgeon-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(
    document.createElement("span"),
    document.createElement("span"),
    document.createElement("span"),
  );
  bubble.appendChild(dots);
  removeSurgeonEmpty(session);
  surgeonPlace(session, bubble);
  return bubble;
}

function createSurgeonDelivery(session) {
  return createDelivery({
    onTyping: () => {
      hideSurgeonThinking(session);
      session.streamEl = addSurgeonTypingBubble(session);
    },
    onDeliver: (fullText) => {
      hideSurgeonThinking(session);
      const bubble = replaceSurgeonBubble(
        session,
        session.streamEl,
        "assistant",
        fullText,
      );
      session.streamEl = null;
      session.history.push({ role: "assistant", content: bubble.textContent });
      saveSurgeonSessions();
    },
    onError: (cause) => {
      hideSurgeonThinking(session);
      replaceSurgeonBubble(
        session,
        session.streamEl,
        "error",
        String(cause?.message || cause || "Rappter Surgeon failed."),
      );
      session.streamEl = null;
    },
  });
}

function createSurgeonPacer(session) {
  return createStreamPacer({
    onText: (text) => {
      hideSurgeonThinking(session);
      if (!session.streamEl) {
        session.streamEl = addSurgeonBubble(session, "assistant", "", false);
        setStreamArriving(session.streamEl, true);
        session.streamResizeObserver?.disconnect();
        session.streamResizeObserver?.observe(session.streamEl);
        session.streamFollower.start();
      }
      session.streamEl.textContent += text;
      session.streamFollower.contentChanged();
      scrollSurgeon(session);
    },
  });
}

function stopSurgeonPacer(session, { flush = false } = {}) {
  if (flush) session.pacer?.finish();
  else session.pacer?.abort();
  session.pacer = null;
  setStreamArriving(session.streamEl, false);
  session.streamResizeObserver?.disconnect();
  session.streamFollower?.stop();
}

function finishSurgeonStream(session, finalText) {
  session.pacer?.finish();
  session.pacer = null;
  if (!session.streamEl) {
    session.streamEl = addSurgeonBubble(
      session,
      "assistant",
      finalText || "(done)",
      false,
    );
  } else if (finalText) {
    session.streamEl.textContent = finalText;
  }
  setStreamArriving(session.streamEl, false);
  session.streamResizeObserver?.disconnect();
  session.history.push({
    role: "assistant",
    content: session.streamEl.textContent,
  });
  session.streamFollower?.complete();
  session.streamEl = null;
  saveSurgeonSessions();
}

function showSurgeonThinking(session) {
  if (session.thinkEl) return;
  const think = document.createElement("div");
  think.className = "surgeon-thinking";
  think.innerHTML = `
    <span class="surgeon-dots"><span></span><span></span><span></span></span>
    <span>Copilot is working</span>
  `;
  session.logEl.appendChild(think);
  session.thinkEl = think;
  scrollSurgeon(session);
}

function hideSurgeonThinking(session) {
  session.thinkEl?.remove();
  session.thinkEl = null;
}

function addSurgeonTool(session, toolName, toolCallId) {
  const tool = document.createElement("div");
  tool.className = "surgeon-tool";
  tool.dataset.toolName = toolName;
  if (toolCallId) tool.dataset.toolCallId = toolCallId;
  tool.dataset.drive = `tool[${
    driveKey(toolCallId || `${session.id}:${session.tools.length}:${toolName}`)
  }].row`;
  tool.dataset.active = "true";
  const head = document.createElement("div");
  head.className = "surgeon-tool-head";
  const name = document.createElement("strong");
  name.textContent = toolName;
  const status = document.createElement("span");
  status.className = "surgeon-tool-status";
  status.textContent = "running";
  head.append("⚙", name, status);
  tool.appendChild(head);
  surgeonPlace(session, tool);
  session.tools.push(tool);
}

function finishSurgeonTool(session, toolName, toolCallId, success, summary = null) {
  const tool = [...session.tools].reverse().find(
    (candidate) => (
      candidate.dataset.active === "true"
      && (
        (toolCallId && candidate.dataset.toolCallId === toolCallId)
        || (!toolCallId && candidate.dataset.toolName === toolName)
      )
    ),
  );
  if (!tool) return;
  tool.dataset.active = "false";
  const name = tool.querySelector("strong");
  const status = tool.querySelector(".surgeon-tool-status");
  if (summary) name.textContent = summary;
  status.textContent = summary && success ? "" : (success ? "done" : "failed");
  status.style.color = success ? "#5cc271" : "#ff7b72";
}

function addSurgeonArtifact(session, artifact) {
  if (!artifact?.url) return;
  const tile = document.createElement("div");
  tile.className = "surgeon-artifact";
  if (artifact.kind === "link") {
    tile.classList.add("link");
  } else if (artifact.kind === "video") {
    const video = document.createElement("video");
    video.src = artifact.url;
    video.controls = true;
    video.preload = "metadata";
    tile.appendChild(video);
  } else {
    const image = document.createElement("img");
    image.src = artifact.url;
    image.alt = artifact.alt || "Rappter Surgeon result";
    tile.appendChild(image);
  }
  const link = document.createElement("a");
  link.href = artifact.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = artifact.alt || "Open artifact";
  tile.appendChild(link);
  surgeonPlace(session, tile);
}

// ── empty-state + starters (per session) ──
function removeSurgeonEmpty(session) {
  session.logEl.querySelector(".surgeon-empty")?.remove();
}

function renderSurgeonEmpty(session) {
  if (session.history.length || session.logEl.querySelector(".surgeon-message, .surgeon-tool")) return;
  const empty = document.createElement("div");
  empty.className = "surgeon-empty";
  empty.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c-2.3 0-3.6.9-4.3 2.1-.5-.1-1-.1-1.5-.1C3.4 4 2 5.6 2 8.2v.3C1 9 .5 9.9.5 11.2v2.1c0 2 1 3.4 2.8 4.2C5.1 18.9 8.2 20 12 20s6.9-1.1 8.7-2.5c1.8-.8 2.8-2.2 2.8-4.2v-2.1c0-1.3-.5-2.2-1.5-2.7v-.3C22 5.6 20.6 4 17.8 4c-.5 0-1 0-1.5.1C15.6 2.9 14.3 2 12 2Z"/>
    </svg>
    <h2>GitHub Copilot in OpenRappter</h2>
    The full Copilot agent loop: files, shell, tests, one-chat capability
    injection, visible UI control, screenshots, and recorded demos. Open more
    chats with <b>+</b> to build several agents at once in the same OpenRappter workspace.
    <div class="surgeon-caps">
      <span>run commands</span><span>read/write files</span><span>test OpenRappter</span>
    </div>
    <div class="surgeon-starters"></div>
  `;
  const list = empty.querySelector(".surgeon-starters");
  for (const starter of SURGEON_STARTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = starter.label;
    if (starter.className) button.classList.add(starter.className);
    if (starter.tour) button.dataset.showModeTour = "true";
    button.addEventListener("click", () => {
      if (starter.tour) {
        window.dispatchEvent(new CustomEvent("rapp-beta:show-mode-tour"));
        return;
      }
      runSurgeon(session, starter.prompt || starter.label);
    });
    list.appendChild(button);
  }
  session.logEl.appendChild(empty);
}

// ── session lifecycle ──
function newSurgeonSession(activate = true) {
  const id = ++surgeonSeq;
  const log = document.createElement("div");
  log.className = "surgeon-session";
  log.dataset.drive = `surgeon[${driveKey(id)}].session`;
  surgeonLog.appendChild(log);
  const session = {
    id,
    defaultTitle: "New chat",
    title: "New chat",
    history: [],
    running: false,
    logEl: log,
    tileEl: null,
    streamEl: null,
    delivery: null,
    pacer: null,
    errorShown: false,
    thinkEl: null,
    tools: [],
  };
  prepareSurgeonStreaming(session);
  surgeonSessions.push(session);
  renderSurgeonEmpty(session);
  if (surgeonHerd) {
    addSurgeonTile(session);
    renderSurgeonTabs();
  } else if (activate) {
    setActiveSurgeon(id);
    surgeonInput?.focus();
  }
  saveSurgeonSessions();
  return session;
}

function restoreSurgeonSession(data) {
  const log = document.createElement("div");
  log.className = "surgeon-session";
  log.dataset.drive = `surgeon[${driveKey(data.id)}].session`;
  surgeonLog.appendChild(log);
  const session = {
    id: data.id,
    defaultTitle: "New chat",
    title: data.title || "New chat",
    history: Array.isArray(data.history) ? data.history : [],
    running: false,
    logEl: log,
    tileEl: null,
    streamEl: null,
    delivery: null,
    pacer: null,
    errorShown: false,
    thinkEl: null,
    tools: [],
  };
  prepareSurgeonStreaming(session);
  surgeonSessions.push(session);
  if (surgeonSeq < session.id) surgeonSeq = session.id;
  for (const message of session.history) {
    if (["user", "assistant"].includes(message.role)) {
      const bubble = document.createElement("div");
      bubble.className = `surgeon-message ${message.role}`;
      bubble.textContent = String(message.content || "");
      log.appendChild(bubble);
    }
  }
  syncSurgeonMessageGroups(session);
  if (!session.history.length) renderSurgeonEmpty(session);
  return session;
}

function setActiveSurgeon(id) {
  surgeonActiveId = id;
  for (const s of surgeonSessions) {
    s.logEl.style.display = s.id === id ? "" : "none";
  }
  renderSurgeonTabs();
  syncSurgeonComposer();
  const active = activeSurgeon();
  if (active) scrollSurgeon(active);
}

function closeSurgeonSession(id) {
  const index = surgeonSessions.findIndex((s) => s.id === id);
  if (index < 0) return;
  const session = surgeonSessions[index];
  session.delivery?.abort();
  session.pacer?.abort();
  session.streamResizeObserver?.disconnect();
  session.streamFollower?.stop();
  session.tileEl?.remove();
  session.logEl.remove();
  surgeonSessions.splice(index, 1);
  void window.brainstemBeta.surgeonClose(id);
  if (!surgeonSessions.length) {
    newSurgeonSession();
    return;
  }
  const fallback = surgeonSessions[Math.max(0, index - 1)].id;
  if (surgeonHerd) {
    if (surgeonActiveId === id) surgeonActiveId = fallback;
    renderSurgeonTabs();
  } else if (surgeonActiveId === id) {
    setActiveSurgeon(fallback);
  } else {
    renderSurgeonTabs();
  }
  saveSurgeonSessions();
}

function refreshSurgeon(session) {
  renderSurgeonTabs();
  updateSurgeonTile(session);
  if (session.id === surgeonActiveId) syncSurgeonComposer();
  saveSurgeonSessions();
}

function renderSurgeonTabs() {
  if (!surgeonTabs) return;
  surgeonTabs.replaceChildren();
  for (const s of surgeonSessions) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `surgeon-tab${s.id === surgeonActiveId ? " active" : ""}`;
    tab.dataset.drive = `surgeon[${driveKey(s.id)}].tab`;
    const title = s.title.length > 22 ? `${s.title.slice(0, 22)}…` : s.title;
    tab.innerHTML = (s.running ? '<span class="sp"></span>' : "")
      + `<span class="tt">${escapeHtml(title)}</span>`
      + (surgeonSessions.length > 1 ? '<span class="cl" title="Close chat">×</span>' : "");
    tab.addEventListener("click", (event) => {
      if (event.target.classList.contains("cl")) {
        event.stopPropagation();
        closeSurgeonSession(s.id);
      } else {
        setActiveSurgeon(s.id);
      }
    });
    surgeonTabs.appendChild(tab);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "surgeon-new";
  add.dataset.drive = "shell.surgeonNewTab";
  add.textContent = "+";
  add.title = "New Copilot chat (same OpenRappter workspace)";
  add.addEventListener("click", () => newSurgeonSession());
  surgeonTabs.appendChild(add);
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

// ── herd view: every session as a live tile in a grid ──
function ensureSurgeonHerdDom() {
  if (surgeonHerdEl) return;
  const herd = document.createElement("aside");
  herd.id = "surgeon-herd";
  herd.setAttribute("aria-label", "GitHub Copilot herd — several chats at once");
  herd.innerHTML = `
    <div class="hbar">
      <span class="surgeon-badge">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M12 2c-2.3 0-3.6.9-4.3 2.1-.5-.1-1-.1-1.5-.1C3.4 4 2 5.6 2 8.2v.3C1 9 .5 9.9.5 11.2v2.1c0 2 1 3.4 2.8 4.2C5.1 18.9 8.2 20 12 20s6.9-1.1 8.7-2.5c1.8-.8 2.8-2.2 2.8-4.2v-2.1c0-1.3-.5-2.2-1.5-2.7v-.3C22 5.6 20.6 4 17.8 4c-.5 0-1 0-1.5.1C15.6 2.9 14.3 2 12 2Z"/>
        </svg>
      </span>
      <span class="t">GitHub Copilot · Herd</span>
      <span class="sub">several agents, one OpenRappter</span>
      <button class="hstore" type="button" title="Hatch a rapplication from the RAPP Store">◈ Hatch a rapplication…</button>
      <button class="hnew" type="button">+ New chat</button>
      <button class="hclose" type="button">Dock ▸</button>
    </div>
    <div class="herd-grid"></div>
  `;
  document.body.appendChild(herd);
  herd.dataset.drive = "shell.surgeonHerdPanel";
  surgeonHerdEl = herd;
  surgeonGridEl = herd.querySelector(".herd-grid");
  herd.querySelector(".hnew").addEventListener("click", () => newSurgeonSession());
  herd.querySelector(".hclose").addEventListener("click", exitSurgeonHerd);
  const store = herd.querySelector(".hstore");
  store.dataset.drive = "shell.storeOpen";
  herd.querySelector(".hnew").dataset.drive = "shell.surgeonHerdNew";
  herd.querySelector(".hclose").dataset.drive = "shell.surgeonHerdDock";
  store.addEventListener("click", () => toggleStorePicker(herd));
}

// A clickable (AI-drivable) list of rapplications from the store, so hatching
// can be done by the user OR autonomously by the AI clicking an entry.
let storePickerEl = null;
async function toggleStorePicker(herd) {
  if (storePickerEl) { storePickerEl.remove(); storePickerEl = null; return; }
  const panel = document.createElement("div");
  panel.className = "store-picker";
  herd.appendChild(panel);
  storePickerEl = panel;
  await renderStorePicker(panel, herd);
}

// The RAR library browser: a source toggle (AIBAST RAR by default → public
// RAR → any custom RAR-compliant catalog URL) over a list of sha-pinned
// agents. Each row hatches as a twin, or installs straight into the running
// Brainstem (hot-loaded by the kernel — usable on the very next message).
async function renderStorePicker(panel, herd) {
  panel.textContent = "Loading the RAR library…";
  let source = { key: "aibast", url: "", sources: [] };
  try { source = await window.brainstemBeta.storeSource(); } catch { /* defaults */ }
  const head = document.createElement("div");
  head.className = "store-sources";
  const mkTab = (label, active, onPick, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "store-source-tab" + (active ? " active" : "");
    b.textContent = label;
    b.dataset.drive = `storeSource[${driveKey(label)}].tab`;
    if (title) b.title = title;
    b.addEventListener("click", onPick);
    head.appendChild(b);
  };
  for (const src of (source.sources || [])) {
    mkTab(src.label, source.key === src.key, async () => {
      try { await window.brainstemBeta.storeSource({ key: src.key }); await renderStorePicker(panel, herd); }
      catch (cause) { flashHerdError(herd, `Couldn't switch source: ${cause?.message || cause}`); }
    }, src.url);
  }
  // Custom source: an in-DOM input row (window.prompt() is unsupported in
  // Electron renderers — it throws — so a dialog can never be the mechanism).
  const customRow = document.createElement("div");
  customRow.className = "store-custom-row";
  customRow.style.display = "none";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.dataset.drive = "shell.storeCustomSource";
  customInput.placeholder = "https://… RAR catalog (rapp-store index.json, or a sha-pinned registry.json)";
  customInput.value = source.key === "custom" ? source.url : "";
  const customGo = document.createElement("button");
  customGo.type = "button";
  customGo.dataset.drive = "shell.storeCustomUse";
  customGo.textContent = "Use";
  const applyCustom = async () => {
    const url = customInput.value.trim();
    if (!url) return;
    try { await window.brainstemBeta.storeSource({ key: "custom", url }); await renderStorePicker(panel, herd); }
    catch (cause) { flashHerdError(herd, `Couldn't use that source: ${cause?.message || cause}`); }
  };
  customGo.addEventListener("click", applyCustom);
  customInput.addEventListener("keydown", (event) => { if (event.key === "Enter") applyCustom(); });
  customRow.append(customInput, customGo);
  mkTab(source.key === "custom" ? "Custom ✓" : "Custom…", source.key === "custom", () => {
    customRow.style.display = customRow.style.display === "none" ? "flex" : "none";
    if (customRow.style.display === "flex") customInput.focus();
  }, source.key === "custom" ? source.url : "Point the browser at your own RAR catalog");

  try {
    const list = await window.brainstemBeta.storeList();
    panel.replaceChildren(head, customRow);
    // A yanked rapplication is pulled from the shelf without a code release —
    // the client drops it so nobody can hatch/install a recalled entry.
    const live = list.filter((entry) => !entry.yanked);
    if (!live.length) { panel.append("This RAR source lists no agents."); return; }
    for (const entry of live) {
      const row = document.createElement("div");
      row.className = "store-row";
      row.dataset.storeId = entry.id;
      row.dataset.drive = `store[${driveKey(entry.id)}].row`;
      const hatch = document.createElement("button");
      hatch.type = "button";
      hatch.className = "store-hatch";
      hatch.dataset.drive = `store[${driveKey(entry.id)}].hatch`;
      hatch.textContent = `◈ ${entry.name}${entry.gated ? " (gated)" : ""} — ${entry.category || entry.license || ""}`;
      hatch.title = "Hatch as a twin (its own worker + tile)";
      hatch.disabled = entry.gated;
      hatch.addEventListener("click", async () => {
        panel.remove(); storePickerEl = null;
        try { await window.brainstemBeta.twinHatch(entry.id); }
        catch (cause) { flashHerdError(herd, `Couldn't hatch ${entry.name}: ${cause?.message || cause}`); }
      });
      const install = document.createElement("button");
      install.type = "button";
      install.className = "store-install";
      install.dataset.drive = `store[${driveKey(entry.id)}].install`;
      install.textContent = "⇣ Install";
      install.title = "Install this agent.py into the running Brainstem (hot-loaded, usable immediately)";
      install.disabled = entry.gated;
      install.addEventListener("click", async () => {
        install.disabled = true; install.textContent = "…";
        try {
          const r = await window.brainstemBeta.storeInstallAgent(entry.id);
          install.textContent = "✓ Installed";
          flashHerdError(herd, `${entry.name} installed into the Brainstem as ${r.filename} — ready on your next message.`);
        } catch (cause) {
          install.disabled = false; install.textContent = "⇣ Install";
          flashHerdError(herd, `Couldn't install ${entry.name}: ${cause?.message || cause}`);
        }
      });
      row.append(hatch, install);
      panel.appendChild(row);
    }
  } catch (cause) {
    panel.replaceChildren(head, customRow);
    panel.append(`This RAR source is unavailable: ${cause?.message || cause}`);
  }
}

// A transient, dismissable error banner in the herd — so a swallowed hatch
// failure (maxTwins cap, sha256 mismatch, HTTP error) is actually seen.
function flashHerdError(herd, message) {
  const el = document.createElement("div");
  el.className = "herd-error";
  el.textContent = message;
  el.addEventListener("click", () => el.remove());
  herd.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

function surgeonTileFor(session) {
  const tile = document.createElement("div");
  tile.className = "herd-tile";
  tile.dataset.drive = `surgeon[${driveKey(session.id)}].tile`;
  tile.dataset.sessionId = String(session.id);
  tile.innerHTML = `
    <div class="hh">
      <span class="tt"></span>
      <span class="hst">ready</span>
      <span class="cl" title="Close chat">×</span>
    </div>
    <div class="htrans"></div>
    <div class="hcomp">
      <textarea rows="1" placeholder="Message this Copilot…"></textarea>
      <button type="button" title="Send">➤</button>
    </div>
  `;
  const transcript = tile.querySelector(".htrans");
  transcript.appendChild(session.logEl);
  transcript.addEventListener(
    "scroll",
    () => handleSurgeonUserScroll(session),
    { passive: true },
  );
  session.logEl.style.display = "";
  const textarea = tile.querySelector(".hcomp textarea");
  const button = tile.querySelector(".hcomp button");
  textarea.dataset.drive = `surgeon[${driveKey(session.id)}].composer`;
  button.dataset.drive = `surgeon[${driveKey(session.id)}].send`;
  tile.querySelector(".cl").dataset.drive = `surgeon[${driveKey(session.id)}].close`;
  const send = () => {
    const text = textarea.value.trim();
    if (!text || session.running) return;
    textarea.value = "";
    textarea.style.height = "auto";
    runSurgeon(session, text);
  };
  button.addEventListener("click", send);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 90)}px`;
  });
  tile.querySelector(".cl").addEventListener("click", () => closeSurgeonSession(session.id));
  session.tileEl = tile;
  updateSurgeonTile(session);
  return tile;
}

function updateSurgeonTile(session) {
  if (!session.tileEl) return;
  session.tileEl.querySelector(".tt").textContent = session.title;
  const status = session.tileEl.querySelector(".hst");
  const state = session.running ? "working" : (session.history.length ? "done" : "ready");
  status.textContent = state;
  status.className = `hst ${state}`;
  const button = session.tileEl.querySelector(".hcomp button");
  if (button) button.disabled = session.running;
}

function addSurgeonTile(session) {
  ensureSurgeonHerdDom();
  surgeonGridEl.appendChild(surgeonTileFor(session));
}

function enterSurgeonHerd() {
  ensureSurgeonHerdDom();
  surgeonGridEl.replaceChildren();
  for (const s of surgeonSessions) {
    s.tileEl = null;
    surgeonGridEl.appendChild(surgeonTileFor(s));
  }
  syncTwinTiles();
  surgeonHerdEl.classList.add("open");
  document.body.classList.add("surgeon-herd-open");
  surgeonHerd = true;
  surgeonHerdBtn?.classList.add("on");
}

function exitSurgeonHerd() {
  surgeonHerd = false;
  surgeonHerdEl?.classList.remove("open");
  document.body.classList.remove("surgeon-herd-open");
  surgeonHerdBtn?.classList.remove("on");
  for (const s of surgeonSessions) {
    s.tileEl = null;
    surgeonLog.appendChild(s.logEl);
  }
  setActiveSurgeon(surgeonActiveId);
}

function destroySurgeonHerdDom() {
  if (!surgeonHerdEl) return;
  if (surgeonHerd) exitSurgeonHerd();
  storePickerEl?.remove();
  storePickerEl = null;
  surgeonHerdEl.remove();
  surgeonHerdEl = null;
  surgeonGridEl = null;
  for (const twin of twins.values()) twin.tileEl = null;
}

function toggleSurgeonHerd() {
  if (surgeonHerd) exitSurgeonHerd();
  else enterSurgeonHerd();
}

// ── rapplication twin tiles in the herd ─────────────────────────────────
// A twin is a real Brainstem worker on its own port; its tile renders that
// worker's own steerable chat (iframe of its loopback UI) plus a live loop log.
// Per-twin UI mode: "app" = the rapplication's own UI (via its proxy),
// "chat" = the default Grail chat (the twin directly). Remembered per twin so a
// user can always fall back to Grail.
function twinTileFor(twin) {
  const tile = document.createElement("div");
  tile.className = "herd-tile twin";
  tile.dataset.twinId = twin.id;
  tile.dataset.drive = `twin[${driveKey(twin.id)}].tile`;
  tile.innerHTML = `
    <div class="hh">
      <span class="twin-badge" title="rapplication twin — its own port &amp; loop">◈</span>
      <span class="tt"></span>
      <span class="hst">ready</span>
      <button class="tw-loop" type="button" title="Have the Brainstem loop with this twin toward a goal">⟳ Loop</button>
      <button class="tw-pop" type="button" title="Open the full rapplication UI">⤢ App</button>
      <span class="cl" title="Close twin">×</span>
    </div>
    <div class="twin-meta"></div>
    <div class="twin-chat" aria-live="polite"></div>
    <button class="twin-signin" type="button" hidden>Sign in to continue →</button>
    <div class="twin-comp">
      <textarea rows="1" placeholder="Message this twin to steer it…"></textarea>
      <button type="button" class="tw-send" title="Send">➤</button>
    </div>
  `;
  tile.querySelector(".twin-signin").addEventListener("click", () => {
    void window.brainstemBeta.openAuth({ id: twin.id });
  });
  tile.querySelector(".cl").addEventListener("click", () => {
    void window.brainstemBeta.twinClose(twin.id);
  });
  // ⤢ opens the full custom rapplication UI in a pop-out window.
  tile.querySelector(".tw-pop").addEventListener("click", () => {
    void window.brainstemBeta.twinPopOut(twin.id);
  });
  // ⟳ Loop hands the twin to the Brainstem: it plans each instruction, the twin
  // executes, and the exchange streams into this transcript hands-off. The goal
  // is whatever is in the composer (or a sensible default if it's empty).
  tile.querySelector(".tw-loop").addEventListener("click", () => {
    const box = tile.querySelector(".twin-comp textarea");
    const goal = box.value.trim() || `Work autonomously toward what ${twin.name || "this rapplication"} is for, and tell me when it's done.`;
    box.value = "";
    box.style.height = "auto";
    void window.brainstemBeta.twinLoop(twin.id, goal);
  });
  const textarea = tile.querySelector(".twin-comp textarea");
  tile.querySelector(".twin-signin").dataset.drive = `twin[${driveKey(twin.id)}].signin`;
  tile.querySelector(".cl").dataset.drive = `twin[${driveKey(twin.id)}].close`;
  tile.querySelector(".tw-pop").dataset.drive = `twin[${driveKey(twin.id)}].app`;
  tile.querySelector(".tw-loop").dataset.drive = `twin[${driveKey(twin.id)}].loop`;
  textarea.dataset.drive = `twin[${driveKey(twin.id)}].composer`;
  tile.querySelector(".tw-send").dataset.drive = `twin[${driveKey(twin.id)}].send`;
  const send = () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    textarea.style.height = "auto";
    void sendTwinMessage(twin.id, text);
  };
  tile.querySelector(".tw-send").addEventListener("click", send);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  });
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 80)}px`;
  });
  updateTwinTile(tile, twin);
  return tile;
}

// Small view = a Brain-Surgeon-style work log over the twin's /chat: the
// autonomous loop's activity plus any messages the person (or the AI) sends to
// steer it. The full custom rapplication UI opens on ⤢ (pop-out). Both drive the
// same twin /chat — the small view is just a lighter, always-reliable surface.
function renderTwinChat(tile, twin) {
  const chatEl = tile.querySelector(".twin-chat");
  if (!chatEl) return;
  const entry = twins.get(twin.id);
  const messages = [];
  for (const line of (twin.loopLog || [])) {
    messages.push({ role: "activity", content: String(line.line || line) });
  }
  for (const message of (entry?.chat || [])) messages.push(message);
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
  chatEl.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "tw-empty";
    empty.textContent = "Hatching…";
    chatEl.appendChild(empty);
  }
  // A multiplayer transcript: the Brainstem loop, the Rappter Surgeon, and you all
  // talking to the same rapplication, each turn labeled by who sent it.
  for (const message of messages.slice(-60)) {
    if (message.role === "activity") {
      const line = document.createElement("div");
      line.className = "tw-msg activity";
      line.textContent = message.content;
      chatEl.appendChild(line);
      continue;
    }
    // Align by WHO spoke, not the wire role: only the human ("You") is self
    // (right, blue). The Brainstem/Surgeon are drivers — distinct, left-aligned —
    // so a loop reads as a conversation, not the user talking to themselves.
    const author = message.author || "";
    const self = author.toLowerCase() === "you";
    const driver = !self && /brainstem|surgeon/i.test(author);
    const wrap = document.createElement("div");
    wrap.className = `tw-turn ${self ? "self" : ""} ${driver ? "driver" : ""}`.replace(/\s+/g, " ").trim();
    if (message.author) {
      const who = document.createElement("div");
      who.className = "tw-who";
      who.textContent = message.author;
      wrap.appendChild(who);
    }
    const bubble = document.createElement("div");
    const kind = message.role === "error" ? "error" : self ? "user" : driver ? "driver" : "assistant";
    bubble.className = `tw-msg ${kind}`;
    bubble.textContent = message.content;
    wrap.appendChild(bubble);
    if (currentChatLook === "messages" && message.arrived) {
      markArrived(wrap);
      message.arrived = false;
    }
    chatEl.appendChild(wrap);
  }
  syncTwinMessageGroups(tile);
  if (nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

async function sendTwinMessage(id, text) {
  // The exchange (your message + the twin's reply) arrives back as twin-message
  // events and renders in the shared transcript — no local echo needed.
  try { await window.brainstemBeta.twinChat(id, text); }
  catch { /* surfaced as a twin-message error event */ }
}

function updateTwinTile(tile, twin) {
  tile.querySelector(".tt").textContent = twin.name || twin.storeId || twin.id;
  const status = tile.querySelector(".hst");
  const needsAuth = twin.status === "needs-auth";
  status.textContent = needsAuth ? "sign in" : (twin.status || "");
  status.className = `hst ${twin.status === "working" ? "working" : needsAuth ? "auth" : twin.status === "ready" ? "done" : ""}`;
  tile.classList.toggle("looping", twin.status === "working");   // ⟳ Loop lit while the Brainstem drives it
  const loopBtn = tile.querySelector(".tw-loop");
  if (loopBtn) loopBtn.disabled = twin.status === "working";
  const meta = tile.querySelector(".twin-meta");
  meta.textContent = `:${twin.port} · ${twin.license || "unlicensed"}${twin.rappid ? " · " + twin.rappid.slice(0, 22) + "…" : ""}`;
  tile.querySelector(".twin-signin").hidden = !needsAuth;
  renderTwinChat(tile, twin);
}

function syncTwinTiles() {
  if (!surgeonGridEl) return;
  for (const twin of twins.values()) {
    if (!twin.tileEl || twin.tileEl.parentNode !== surgeonGridEl) {
      twin.tileEl = twinTileFor(twin.descriptor);
      surgeonGridEl.appendChild(twin.tileEl);
    } else {
      updateTwinTile(twin.tileEl, twin.descriptor);
    }
  }
}

function upsertTwin(descriptor) {
  const existing = twins.get(descriptor.id);
  if (existing) {
    existing.descriptor = { ...existing.descriptor, ...descriptor };
    if (existing.tileEl) updateTwinTile(existing.tileEl, existing.descriptor);
  } else {
    twins.set(descriptor.id, { descriptor, tileEl: null });
  }
}

function handleTwinEvent(event) {
  if (!event) return;
  if (event.type === "twin-hatched") {
    upsertTwin(event.twin);
    if (!surgeonHerd) enterSurgeonHerd();   // twins live in the herd — show it
    else syncTwinTiles();
  } else if (event.type === "twin-status") {
    // Only UPDATE a twin we already know — never let a late status (e.g. from a
    // loop's finally after close()) resurrect a dismissed tile. Creation is
    // reserved for twin-hatched.
    if (twins.has(event.id)) upsertTwin(event.twin || { id: event.id, status: event.status });
  } else if (event.type === "twin-log") {
    const twin = twins.get(event.id);
    if (twin) {
      const log = (twin.descriptor.loopLog || []).concat([{ line: event.line }]).slice(-40);
      twin.descriptor = { ...twin.descriptor, loopLog: log, status: event.status || twin.descriptor.status };
      if (twin.tileEl) updateTwinTile(twin.tileEl, twin.descriptor);
    }
  } else if (event.type === "twin-message") {
    const entry = twins.get(event.id);
    if (entry) {
      entry.chat = entry.chat || [];
      entry.chat.push({
        author: event.author,
        role: event.role,
        content: event.text,
        arrived: currentChatLook === "messages" && event.role === "assistant",
      });
      if (entry.chat.length > 200) entry.chat.splice(0, entry.chat.length - 200);   // bound long-lived memory
      if (entry.tileEl) renderTwinChat(entry.tileEl, entry.descriptor);
    }
  } else if (event.type === "twin-closed") {
    const twin = twins.get(event.id);
    twin?.tileEl?.remove();
    twins.delete(event.id);
  }
}

async function refreshTwins() {
  try {
    const list = await window.brainstemBeta.twinList();
    for (const twin of list) upsertTwin(twin);
    if (surgeonHerd) syncTwinTiles();
  } catch {
    // twins unavailable — ignore
  }
}

// ── running a turn (per session, parallel across sessions) ──
async function runSurgeon(session, prompt) {
  const text = String(prompt || "").trim();
  if (!text || session.running) return;
  removeSurgeonEmpty(session);
  if (session.title === session.defaultTitle) session.title = text.slice(0, 40);
  session.running = true;
  session.streamEl = null;
  session.delivery?.abort();
  session.pacer?.abort();
  session.streamResizeObserver?.disconnect();
  session.streamFollower?.stop();
  session.delivery = chatTypingEnabled ? createSurgeonDelivery(session) : null;
  session.pacer = chatStreamMode === "smooth"
    ? createSurgeonPacer(session)
    : null;
  session.errorShown = false;
  addSurgeonBubble(session, "user", text);
  showSurgeonThinking(session);
  refreshSurgeon(session);
  try {
    await window.brainstemBeta.surgeonSend(session.id, text);
  } catch (cause) {
    hideSurgeonThinking(session);
    if (session.errorShown) {
      // The event handler already rendered the failure.
    } else if (chatTypingEnabled) {
      session.delivery?.fail(cause);
    } else {
      stopSurgeonPacer(session, { flush: true });
      addSurgeonBubble(session, "error", String(cause?.message || cause || "Rappter Surgeon failed."), false);
      session.streamFollower?.complete();
    }
  } finally {
    session.running = false;
    session.delivery?.abort();
    session.pacer?.abort();
    session.streamResizeObserver?.disconnect();
    session.streamFollower?.stop();
    session.delivery = null;
    session.pacer = null;
    session.streamEl = null;
    refreshSurgeon(session);
  }
}

function submitSurgeon() {
  const prompt = surgeonInput.value.trim();
  if (!prompt) return;
  const session = activeSurgeon() || newSurgeonSession();
  if (session.running) return;   // this chat is busy — open a new tab (+) to run in parallel
  surgeonInput.value = "";
  surgeonInput.style.height = "auto";
  runSurgeon(session, prompt);
}

function syncSurgeonComposer() {
  const session = activeSurgeon();
  const busy = !!(session && session.running);
  if (surgeonSend) {
    surgeonSend.disabled = busy;
    surgeonSend.textContent = busy ? "Working" : "Build";
  }
}

// Reset the ACTIVE chat's transcript and its main-process session.
function clearSurgeonUi() {
  const session = activeSurgeon();
  if (!session) return;
  hideSurgeonThinking(session);
  session.delivery?.abort();
  session.pacer?.abort();
  session.streamResizeObserver?.disconnect();
  session.streamFollower?.stop();
  session.delivery = null;
  session.pacer = null;
  session.logEl.replaceChildren();
  session.history = [];
  session.title = session.defaultTitle;
  session.streamEl = null;
  session.tools = [];
  session.running = false;
  surgeonInput.value = "";
  surgeonInput.style.height = "auto";
  renderSurgeonEmpty(session);
  refreshSurgeon(session);
}

function handleSurgeonEvent(event) {
  if (!event) return;
  const session = surgeonSessions.find((s) => s.id === event.sessionId)
    || surgeonSessions.find((s) => s.id === surgeonActiveId);
  if (!session) return;
  if (event.type === "response-start") {
    showSurgeonThinking(session);
  } else if (event.type === "delta") {
    if (chatTypingEnabled) {
      session.delivery?.push(event.text || "");
    } else if (chatStreamMode === "smooth") {
      session.pacer?.push(event.text || "");
    } else {
      hideSurgeonThinking(session);
      if (!session.streamEl) session.streamEl = addSurgeonBubble(session, "assistant", "", false);
      session.streamEl.textContent += event.text || "";
      scrollSurgeon(session);
    }
  } else if (event.type === "tool-start") {
    session.delivery?.tool(event);
    session.pacer?.flush();
    hideSurgeonThinking(session);
    addSurgeonTool(session, event.toolName || "tool", event.toolCallId);
    showSurgeonThinking(session);
  } else if (event.type === "tool-complete") {
    session.delivery?.tool(event);
    finishSurgeonTool(
      session,
      event.toolName || "tool",
      event.toolCallId,
      event.success !== false,
      event.summary || null,
    );
    void refreshAgentExplorer();
  } else if (event.type === "artifact") {
    session.pacer?.flush();
    addSurgeonArtifact(session, event.artifact);
  } else if (event.type === "lease") {
    session.pacer?.flush();
    addSurgeonBubble(session, "assistant", event.message || "Temporary capability leased.", false);
  } else if (event.type === "done") {
    hideSurgeonThinking(session);
    const finalText = String(event.content || "").trim();
    if (chatTypingEnabled) {
      session.delivery?.finish(finalText || (session.streamEl ? undefined : "(done)"));
    } else if (chatStreamMode === "smooth") {
      finishSurgeonStream(session, finalText);
    } else {
      if (!session.streamEl) {
        session.streamEl = addSurgeonBubble(session, "assistant", finalText || "(done)", false);
      } else if (finalText) {
        session.streamEl.textContent = finalText;
      }
      session.history.push({ role: "assistant", content: session.streamEl.textContent });
      session.streamEl = null;
      saveSurgeonSessions();
    }
  } else if (event.type === "error") {
    session.errorShown = true;
    if (chatTypingEnabled) {
      session.delivery?.fail(event.message || "Rappter Surgeon failed.");
    } else {
      hideSurgeonThinking(session);
      stopSurgeonPacer(session, { flush: true });
      addSurgeonBubble(session, "error", event.message || "Rappter Surgeon failed.", false);
      session.streamFollower?.complete();
    }
  } else if (event.type === "reset") {
    // A main-process reset for this session — already cleared in clearSurgeonUi.
  }
}

function initSurgeonSessions() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(surgeonHistoryKey) || "null");
  } catch {
    saved = null;
  }
  if (saved && Array.isArray(saved.sessions) && saved.sessions.length) {
    saved.sessions.forEach(restoreSurgeonSession);
    const active = surgeonSessions.some((s) => s.id === saved.active) ? saved.active : surgeonSessions[0].id;
    setActiveSurgeon(active);
  } else {
    newSurgeonSession();
  }
}

function betaUrl(raw) {
  const url = new URL(raw);
  url.searchParams.set("beta", "1");
  return url.href;
}

function syncBetaUpdate(update, openPanel = false) {
  const value = update || {
    phase: "idle",
    message: "Check GitHub for the latest OpenRappter.",
  };
  frame.contentWindow?.postMessage({
    type: "rapp-beta:update-state",
    update: value,
    openPanel,
  }, "*");
}

function render(state) {
  latestState = state;
  const neighborhoodIdentity = document.getElementById("neighborhood-identity");
  if (neighborhoodIdentity && state.neighborhood) {
    const name = neighborhoodIdentity.querySelector("strong");
    const detail = neighborhoodIdentity.querySelector("small");
    if (name) name.textContent = state.neighborhood.app_name;
    if (detail) {
      detail.textContent = `Good AI Estate · ${
        state.neighborhood.instance
      } · ${state.estate?.neighborhood_count || 1} neighborhoods`;
    }
    neighborhoodIdentity.dataset.neighborhoodId =
      state.neighborhood.neighborhood_id;
    document.title = state.neighborhood.app_name;
  }
  applyShellChatLook(state.chatLook, state.chatTypingEnabled);
  const tilesWereRequested = dimensionTilesRequested;
  dimensionTilesRequested = state.viewMode?.mode === "arena";
  const tilesGeneration = ++dimensionTilesGeneration;
  if (dimensionTilesRequested) {
    void syncDimensionTiles(state, tilesGeneration).catch((cause) => {
      if (
        tilesGeneration !== dimensionTilesGeneration
        || !dimensionTilesRequested
      ) return;
      window.alert(
        `Could not show Agent Arena: ${String(cause?.message || cause)}`,
      );
    });
  } else if (
    tilesWereRequested
    || dimensionTilesLoader
    || window.RappDimensionTiles
  ) {
    frame.contentWindow?.postMessage({
      type: "rapp-beta:view-mode-state",
      viewMode: state.viewMode,
    }, "*");
    window.RappDimensionTiles?.disable();
  }
  const surgeonState = state.surgeon || state.copilot;
  document.getElementById("surgeon-model").textContent =
    surgeonState?.phase === "ready" ? "Agent" : (surgeonState?.phase || "starting");
  if (state.brainstem.phase === "ready") {
    if (loadedUrl !== state.url) {
      loadedUrl = state.url;
      loadedFrameUrl = null;
      frame.src = betaUrl(state.url);
    }
    frame.classList.add("ready");
    splash.classList.add("hidden");
    error.textContent = "";
    syncBetaUpdate(state.update);
    void refreshAgentExplorer();
    return;
  }

  frame.classList.remove("ready");
  splash.classList.remove("hidden");
  error.textContent = state.brainstem.phase === "error"
    ? state.brainstem.message
    : "";
}

function setupSurgeonTailFollowing() {
  if (chatStreamMode !== "smooth") return null;
  const composer = document.querySelector(".surgeon-composer");
  if (!composer) return null;
  const root = document.documentElement;
  function measureComposer() {
    const height = composer.getBoundingClientRect().height;
    root.style.setProperty(
      "--rapp-surgeon-composer-clearance",
      Math.max(0, height) + "px",
    );
    return height;
  }
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      measureComposer();
      activeSurgeon()?.streamFollower?.contentChanged();
    })
    : null;
  resizeObserver?.observe(composer);
  window.addEventListener("resize", measureComposer);
  const installed = {
    measureComposer,
    measuredComposerHeight: measureComposer(),
    resizeObserver,
  };
  window.__rappSurgeonTailFollow = installed;
  return installed;
}

document.getElementById("enter").addEventListener("click", () => {
  localStorage.setItem(introStorageKey, "seen");
  intro.classList.add("hidden");
  setSurgeonOpen(true);
});

document.getElementById("surgeon-tab").addEventListener(
  "click",
  () => setSurgeonOpen(true),
);
document.getElementById("explorer-close").addEventListener(
  "click",
  () => setExplorerOpen(false),
);
document.getElementById("explorer-refresh").addEventListener(
  "click",
  () => {
    agentTreeSignature = null;
    void refreshAgentExplorer();
  },
);
document.getElementById("surgeon-close").addEventListener(
  "click",
  () => setSurgeonOpen(false),
);
document.getElementById("surgeon-new").addEventListener("click", async () => {
  const session = activeSurgeon();
  clearSurgeonUi();
  try {
    await window.brainstemBeta.surgeonReset(session ? session.id : 1);
  } catch (cause) {
    if (session) {
      addSurgeonBubble(
        session,
        "error",
        `Could not reset Rappter Surgeon: ${String(cause?.message || cause)}`,
        false,
      );
    }
  }
});
document.getElementById("ambient-settings-close").addEventListener(
  "click",
  () => ambientDialog.close(),
);
document.getElementById("ambient-settings-save").addEventListener(
  "click",
  () => void saveAmbientSettings().then((value) => {
    if (
      value?.deviceEnabled
      && !value.settings?.userLocation
      && value.settings?.granularity !== "off"
    ) void requestDeviceLocation();
  }),
);
document.getElementById("ambient-use-device").addEventListener(
  "click",
  () => void requestDeviceLocation({ clearSaved: true }),
);
document.getElementById("ambient-clear-location").addEventListener(
  "click",
  () => {
    ambientLocationLabel.value = "";
    ambientLocationLat.value = "";
    ambientLocationLon.value = "";
    void saveAmbientSettings({ userLocation: null }).then((value) => {
      if (value?.deviceEnabled && value.settings?.granularity !== "off") {
        void requestDeviceLocation();
      }
    });
  },
);
surgeonHerdBtn.addEventListener("click", toggleSurgeonHerd);
surgeonSend.addEventListener("click", () => void submitSurgeon());
surgeonInput.addEventListener("input", () => {
  surgeonInput.style.height = "auto";
  surgeonInput.style.height = `${Math.min(surgeonInput.scrollHeight, 150)}px`;
});
surgeonInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submitSurgeon();
  }
});
surgeonLog.addEventListener(
  "scroll",
  () => {
    const session = activeSurgeon();
    if (session) handleSurgeonUserScroll(session);
  },
  { passive: true },
);
window.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName?.toLowerCase();
  if (["input", "textarea", "select"].includes(tag)
      || event.target?.isContentEditable) return;
  if ([
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
    " ",
  ].includes(event.key)) {
    const session = activeSurgeon();
    if (session) markSurgeonUserIntent(session);
  }
});
surgeonLog.addEventListener("scroll", () => {
  const session = activeSurgeon();
  if (session && !session.tileEl) handleSurgeonUserScroll(session);
}, { passive: true });

if (localStorage.getItem(introStorageKey) === "seen") {
  intro.classList.add("hidden");
}

initSurgeonSessions();
setupSurgeonTailFollowing();
applyShellChatLook(currentChatLook, chatTypingEnabled);
setSurgeonOpen(localStorage.getItem(surgeonOpenKey) !== "closed");
setExplorerOpen(localStorage.getItem(explorerOpenKey) === "open");
setInterval(() => void refreshAgentExplorer(), 2000);
window.brainstemBeta.onSurgeonEvent(handleSurgeonEvent);
window.brainstemBeta.onTwinEvent(handleTwinEvent);
window.brainstemBeta.onTwinFocus?.(({ id }) => {
  if (!surgeonHerd) enterSurgeonHerd(); else syncTwinTiles();
  const twin = twins.get(id);
  twin?.tileEl?.scrollIntoView({ behavior: "smooth", block: "center" });
});
void refreshTwins();
window.brainstemBeta.onOpenUpdate(() => {
  openBetaMenuOnNextSync = true;
  syncBetaUpdate(latestState?.update, true);
});
window.brainstemBeta.onState(render);
window.brainstemBeta.getState().then(render);
void maintainAmbientContext();
setInterval(() => void maintainAmbientContext(), 240000);

// ---- This local OpenRappter is a portable, content-addressed self tile -----
(() => {
  const exportButton = document.getElementById("openrappter-tile-export");
  const importButton = document.getElementById("openrappter-tile-import");
  const backupButton = document.getElementById("openrappter-tile-backup");
  const status = document.getElementById("openrappter-tile-status");
  if (!exportButton || !importButton || !backupButton || !status) return;

  const describe = async () => {
    try {
      const tile = await window.brainstemBeta.openrappterTileDescribe();
      status.textContent = `${tile.rappid} · ${tile.files} files · ${tile.bytes} bytes · ${tile.backups} backups`;
    } catch (error) {
      status.textContent = `Could not read this OpenRappter tile: ${error?.message || error}`;
    }
  };
  const run = async (button, action) => {
    button.disabled = true;
    try {
      const result = await action();
      if (result?.canceled) return;
      status.textContent = result.restartRequired
        ? `Imported ${result.imported} files. Restart OpenRappter to activate the restored tile. Backup: ${result.backup}`
        : `Saved OpenRappter tile: ${result.file}`;
      await describe();
    } catch (error) {
      status.textContent = `OpenRappter tile action failed: ${error?.message || error}`;
    } finally {
      button.disabled = false;
    }
  };

  exportButton.addEventListener("click", () => {
    void run(exportButton, () => window.brainstemBeta.openrappterTileExport());
  });
  importButton.addEventListener("click", () => {
    void run(importButton, () => window.brainstemBeta.openrappterTileImport());
  });
  backupButton.addEventListener("click", () => {
    void run(backupButton, () => window.brainstemBeta.openrappterTileBackup());
  });
  void describe();
})();

// ---- Quantum RAPPID organism eggs: RAPP/1 export, sealed backup, restore ----
(() => {
  const portable = document.getElementById("organism-egg-portable");
  const sealed = document.getElementById("organism-egg-sealed");
  const previewButton = document.getElementById("organism-egg-preview");
  const passphrase = document.getElementById("organism-egg-passphrase");
  const status = document.getElementById("organism-egg-status");
  const detail = document.getElementById("organism-egg-detail");
  if (
    !portable || !sealed || !previewButton || !passphrase || !status || !detail
  ) return;

  let pending = null;
  const busy = (value) => {
    portable.disabled = value;
    sealed.disabled = value;
    previewButton.disabled = value;
  };
  const describe = (inspection, preview) => {
    const header = inspection.header;
    const dimensions = header.dimensions || {};
    const changed = preview?.preview?.entries?.filter(
      (entry) => entry.change !== "unchanged",
    ) || [];
    const lines = [
      `${header.mode} · ${header.organismRappid}`,
      `${dimensions.files || 0} files · ${dimensions.bytes || 0} bytes · ${dimensions.agents || 0} agents · ${dimensions.skills || 0} skills`,
      `${dimensions.media || 0} sounds · ${dimensions.midi || 0} MIDI · ${dimensions.sessions || 0} sessions`,
      `root ${header.rootDigest}`,
      inspection.decrypted ? "payload hashes verified" : "sealed payload remains encrypted",
    ];
    if (preview?.preview) {
      lines.push(
        `${preview.preview.compatible ? "compatible" : "identity mismatch"} · ${changed.length} changes · ${preview.preview.semantics}`,
        `base ${preview.preview.baseStateDigest}`,
        `reauth: ${(preview.preview.reauthentication || []).join(", ") || "none"}`,
      );
      for (const entry of changed.slice(0, 20)) {
        lines.push(`${entry.change.padEnd(7)} ${entry.path} (${entry.sizeDelta >= 0 ? "+" : ""}${entry.sizeDelta} B)`);
      }
      if (changed.length > 20) lines.push(`…and ${changed.length - 20} more changes`);
    }
    for (const exclusion of header.privacy?.exclusions || []) {
      lines.push(`excluded: ${exclusion}`);
    }
    detail.textContent = lines.join("\n");
  };

  const runExport = async (mode) => {
    if (mode === "sealed-backup" && String(passphrase.value).length < 12) {
      status.textContent = "A sealed backup needs a passphrase of at least 12 characters.";
      passphrase.focus();
      return;
    }
    busy(true);
    try {
      const result = await window.brainstemBeta.organismEggExport({
        mode,
        // A desktop backup is complete; a portable sharing artifact is lean.
        // Fine-grained overrides remain available in the installed CLI.
        includeHistory: mode === "sealed-backup",
        includeMedia: mode === "sealed-backup",
        passphrase: mode === "sealed-backup" ? passphrase.value : "",
      });
      if (result?.canceled) return;
      status.textContent = `Saved ${result.output}. The egg remains private until you intentionally share it.`;
      describe({ header: {
        mode: result.manifest.mode,
        organismRappid: result.manifest.organismRappid,
        dimensions: result.manifest.dimensions,
        rootDigest: result.manifest.rootDigest,
        privacy: result.manifest.privacy,
      }, decrypted: true });
    } catch (error) {
      status.textContent = `Egg export failed: ${error?.message || error}`;
    } finally {
      if (mode === "sealed-backup") passphrase.value = "";
      busy(false);
    }
  };
  portable.addEventListener("click", () => void runExport("portable"));
  sealed.addEventListener("click", () => void runExport("sealed-backup"));
  const applyPending = async () => {
    if (!pending) return;
    if (String(passphrase.value).length < 12) {
      status.textContent = "Apply needs a passphrase to encrypt the automatic rollback egg.";
      passphrase.focus();
      return;
    }
    busy(true);
    try {
      const preview = pending.preview.preview;
      const changed = preview.entries.filter((entry) => entry.change !== "unchanged").length;
      const result = await window.brainstemBeta.organismEggApply({
        file: pending.file,
        passphrase: passphrase.value,
        semantics: preview.semantics,
        approval: preview.approvalBinding,
        eggDigest: preview.eggDigest,
        targetRappid: preview.targetRappid,
        changed,
      });
      if (result?.canceled) return;
      status.textContent = `Restore committed and healthy. Rollback: ${result.rollbackEgg}. Restart to awaken restored agents.`;
      pending = null;
      previewButton.textContent = "Inspect / preview import";
      detail.textContent = "Import applied through the organism transaction. No imported code executed during preview.";
    } catch (error) {
      status.textContent = `Egg apply failed and was rolled back: ${error?.message || error}`;
    } finally {
      passphrase.value = "";
      busy(false);
    }
  };
  previewButton.addEventListener("click", async () => {
    if (pending) {
      await applyPending();
      return;
    }
    busy(true);
    try {
      const result = await window.brainstemBeta.organismEggPreview({
        passphrase: passphrase.value,
        semantics: "restore",
      });
      if (result?.canceled) return;
      describe(result.inspection, result.preview);
      if (!result.inspection.decrypted) {
        status.textContent = "Header verified. Enter the passphrase to decrypt and produce a read-only diff.";
        return;
      }
      pending = result;
      previewButton.textContent = "Apply verified restore";
      const changed = result.preview.preview.entries.filter(
        (entry) => entry.change !== "unchanged",
      ).length;
      status.textContent = `Preview complete: ${changed} changes. Content stayed inert; nothing was applied.`;
    } catch (error) {
      status.textContent = `Egg preview failed: ${error?.message || error}`;
    } finally {
      busy(false);
    }
  });
})();

// ---- Rappter Pack Sentinel: mixed nodes, deterministic acceptance ----------
(() => {
  const runButton = document.getElementById("rappter-pack-run");
  const status = document.getElementById("rappter-pack-status");
  if (!runButton || !status) return;

  const refresh = async () => {
    try {
      const pack = await window.brainstemBeta.rappterPackStatus();
      if (!pack.configured) {
        status.textContent = `${pack.guidance} (${pack.config})`;
        runButton.disabled = true;
        return;
      }
      const healthy = pack.nodes.filter((node) => node.ok).length;
      status.textContent = `${pack.pack_id} · ${healthy}/${pack.nodes.length} nodes reachable · `
        + pack.nodes.map((node) => `${node.id}:${node.ok ? "ready" : "down"}`).join(" · ");
      runButton.disabled = false;
    } catch (error) {
      status.textContent = `Could not read Rappter Pack: ${error?.message || error}`;
      runButton.disabled = true;
    }
  };

  runButton.addEventListener("click", async () => {
    runButton.disabled = true;
    status.textContent = "Running expected-vs-observed pack matrix…";
    try {
      const { file, report } = await window.brainstemBeta.rappterPackRun();
      status.textContent = `${report.summary.pass}/${report.summary.total} cases passed · ${file}`;
    } catch (error) {
      status.textContent = `Rappter Pack matrix failed: ${error?.message || error}`;
    } finally {
      await refresh();
    }
  });
  void refresh();
})();


// ---- Drag a .egg anywhere over the window to hatch it as a twin ------------
// The egg is read in the renderer (bytes only, no path trust) and verified
// fail-closed in the main process (rapp/1-egg verifier) before hatching.
(() => {
  if (!window.brainstemBeta?.twinHatchEgg) return;
  let veil = null;
  const showVeil = () => {
    if (veil) return;
    veil = document.createElement("div");
    veil.style.cssText = "position:fixed;inset:0;z-index:9999;display:grid;place-items:center;"
      + "background:rgba(13,17,23,.82);border:2px dashed #58a6ff;pointer-events:none;"
      + "color:#e6edf3;font:600 15px Inter,system-ui,sans-serif;letter-spacing:.02em";
    veil.textContent = "Drop the .egg to hatch a rapplication twin";
    document.body.appendChild(veil);
  };
  let veilTimer = null;
  const hideVeil = () => { clearTimeout(veilTimer); veilTimer = null; veil?.remove(); veil = null; };
  const isEggDrag = (event) => Array.from(event.dataTransfer?.items || [])
    .some((item) => item.kind === "file");
  window.addEventListener("dragover", (event) => {
    if (!isEggDrag(event)) return;
    event.preventDefault();
    showVeil();
    // Self-healing: dragover stops firing the instant the drag moves onto the
    // full-window cross-origin Brainstem iframe or the drag ends, and in both
    // cases dragleave's relatedTarget is unreliable — a short quiet period is
    // the only trustworthy end-of-drag signal, so the veil can never wedge.
    clearTimeout(veilTimer);
    veilTimer = setTimeout(hideVeil, 400);
  });
  window.addEventListener("dragleave", (event) => {
    if (event.target === document.documentElement || !event.relatedTarget) hideVeil();
  });
  window.addEventListener("dragend", hideVeil);
  window.addEventListener("drop", async (event) => {
    hideVeil();
    const file = Array.from(event.dataTransfer?.files || [])
      .find((f) => /\.egg$/i.test(f.name));
    if (!file) return;                       // not an egg — let other handlers live
    event.preventDefault();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await window.brainstemBeta.twinHatchEgg({ bytes, filename: file.name });
    } catch (error) {
      // Never alert(): modal dialogs block the renderer. A dismissable toast.
      const toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;"
        + "background:#2a1618;color:#ff9a9a;border:1px solid #5b2a2e;border-radius:9px;"
        + "padding:10px 16px;font:600 13px Inter,system-ui,sans-serif;max-width:80%;cursor:pointer";
      toastEl.textContent = `Could not hatch ${file.name}: ${error?.message || error}`;
      toastEl.addEventListener("click", () => toastEl.remove());
      document.body.appendChild(toastEl);
      setTimeout(() => toastEl.remove(), 9000);
    }
  });
})();
