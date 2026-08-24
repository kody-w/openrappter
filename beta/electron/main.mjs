import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  session,
  shell,
} from "electron";

import {
  resolveBrainstemConfig,
} from "./brainstem-process.mjs";
import {
  lookupApproximateLocation,
  openAmbient,
} from "./ambient.mjs";
import { createActivityViewInstallationSource } from "./activity-view.mjs";
import {
  resolveChatStreamMode,
} from "./chat-stream-mode.mjs";
import { humanizeAgentName } from "./agent-display.mjs";
import { RappterSurgeon } from "./rappter-surgeon.mjs";
import {
  changeChatLook,
  readAmbientSettings,
  readChatLookSettings,
  writeAmbientSettings,
} from "./chat-look-settings.mjs";
import {
  DimensionTileStore,
  changeViewModeSettings,
  composeDimensionTilesFrameBridgeSource,
  parseViewModeCommand,
  readViewModeSettings,
  registerDimensionTileIpc,
} from "./dimension-tiles.mjs";
import {
  readCustomLayout,
  resolveCustomLayout,
} from "./arena-layouts.mjs";
import { CopilotStudioAuthManager } from "./copilot-studio-auth.mjs";
import { CopilotRuntime } from "./copilot-runtime.mjs";
import { executeLineageCommand } from "./lineage-control.mjs";
import { summonDoggNeighborhood } from "./dogg-summon.mjs";
import {
  openLedger,
  recordCompletedTurn,
} from "./ledger.mjs";
import {
  createNeighborhoodIdentity,
  ensureNeighborhoodManifest,
} from "./neighborhood-identity.mjs";
import {
  OPENRAPPTER_TILE_EXTENSION,
  OpenRappterTileStore,
} from "./openrappter-tile.mjs";
import { OrganismEggAdapter } from "./organism-egg-adapter.mjs";
import { startOpenRappterChatEndpoint } from "./openrappter-chat-endpoint.mjs";
import {
  dispatchPackNode,
  packNodeReady,
  runPackMatrix,
  validatePackConfig,
  validatePackMatrix,
  writePackReport,
} from "./rappter-pack.mjs";
import { assertOpenRappterSpeciesIsolation } from "./species-isolation.mjs";
import {
  createExportRedactionScript,
  redactSensitiveValue,
} from "./log-redaction.mjs";
import { BetaRouteManager } from "./route-manager.mjs";
import { isAllowedStoreSourceUrl, RappStoreClient, STORE_SOURCES } from "./rapp-store.mjs";
import { createTwinLedgerBridgeSource } from "./twin-ledger-bridge.mjs";
import { TwinManager } from "./twin-manager.mjs";
import {
  allowsUiDriverMediaPermission,
  startUiDriverServer,
} from "./ui-driver-server.mjs";
import {
  createAutopilotInstallationSource,
  createFrameBridgeInstallationSource,
  createOpenRappterBrandingSource,
  createViewToggle,
  instrumentRappUi as createInstrumentedRappUi,
} from "./injection-sources.mjs";
import {
  checkForUpdates,
  consumeUpdateResult,
  prepareUpdate,
} from "./update-manager.mjs";
import {
  betaSourceFingerprint,
  runtimeDirectoryFingerprint,
} from "../scripts/walkthrough-provenance.mjs";
import "../ui/stream-follow.js";
import "../ui/stream-render-pacing.js";
import "../ui/chat-look.js";

const neighborhood = createNeighborhoodIdentity(
  process.env.OPENRAPPTER_INSTANCE,
  {
    generation: Number.parseInt(
      process.env.OPENRAPPTER_NEIGHBORHOOD_GENERATION || "0",
      10,
    ),
    neighborhoodId: process.env.OPENRAPPTER_NEIGHBORHOOD_ID,
    parentNeighborhoodId:
      process.env.OPENRAPPTER_PARENT_NEIGHBORHOOD_ID || null,
  },
);
const openRappterInstance = neighborhood.instance;
const openRappterWindowTitle = neighborhood.app_name;
app.setName(neighborhood.app_name);
app.setAppUserModelId(neighborhood.app_user_model_id);

const hasLock = app.requestSingleInstanceLock();
const {
  createTailFollower,
} = globalThis.RappStreamFollow;
const {
  createAdaptiveRenderPacer,
  splitRenderPieces,
} = globalThis.RappStreamRenderPacing;
const {
  applyLookStyles,
  grailFrameCss,
  inferMessageSide,
  markArrived,
  markGroupLast,
  normalizeChatLook,
} = globalThis.RappChatLook;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(dirname, "..");
// The OpenRappter dinosaur icon (build/icon.png), used for the window, dock, and
// the taskbar so the running app never shows the default Electron icon. Packaged
// builds pick up build/icon.icns / .ico / icons/ via package.json.
const appIconFile = path.join(packageDir, "build", "icon.png");
const appIcon = existsSync(appIconFile) ? nativeImage.createFromPath(appIconFile) : null;
const uiFile = path.join(dirname, "..", "ui", "index.html");
const uiUrl = pathToFileURL(uiFile).href;
const autopilotSource = readFileSync(
  path.join(packageDir, "ui", "autopilot.js"),
  "utf8",
);
const autopilotClassicSource = autopilotSource.replace(
  "export function createAutopilot",
  "function createAutopilot",
);
const autopilotCapability = randomUUID();
const activityViewInstallationSource = createActivityViewInstallationSource();
const openRappterBrandingSource = createOpenRappterBrandingSource();
const config = resolveBrainstemConfig();
const openRappterHome = path.resolve(
  process.env.OPENRAPPTER_HOME || path.join(homedir(), ".openrappter"),
);
const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(openRappterHome, "desktop");
assertOpenRappterSpeciesIsolation({
  home: homedir(),
  openRappterHome,
  betaHome,
  brainstemHome: config.brainstemHome,
  brainstemDir: config.brainstemDir,
});
ensureNeighborhoodManifest(betaHome, neighborhood);
const chatStreamMode = resolveChatStreamMode(process.env);
const smoothStreamCss = `
html[data-rapp-stream="smooth"] .msg.assistant .bubble.stream-mask {
  -webkit-mask-image: none !important;
  mask-image: none !important;
}
html[data-rapp-stream="smooth"] .msg.assistant .bubble.stream-revealing {
  animation: none !important;
}
html[data-rapp-stream="smooth"] .rapp-provisional-hidden {
  display: none !important;
}
html[data-rapp-stream="smooth"]
  .response-slot[data-rapp-provisional-active="1"]
  .msg.assistant:not([data-rapp-provisional="1"]) {
  display: none !important;
}
html[data-rapp-stream="smooth"] .msg.assistant.rapp-final-handoff {
  animation: none !important;
}
html[data-rapp-stream="smooth"] #chat {
  padding-bottom: var(--rapp-stream-footer-clearance, 24px) !important;
  scroll-padding-bottom: var(--rapp-stream-footer-clearance, 24px);
}
html[data-rapp-stream="smooth"] .msg.assistant.stream-arriving {
  animation: rappArrive 160ms ease-out both;
}
html[data-rapp-stream="smooth"] .msg,
html[data-rapp-stream="smooth"] .msg .bubble {
  transition: max-width 240ms ease;
}
html[data-rapp-stream="smooth"] .msg.assistant.stream-arriving .bubble::after {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 3px;
  background: currentColor;
  content: "";
  vertical-align: -.14em;
  animation: rappCaret 1s steps(1) infinite;
}
html[data-rapp-stream="smooth"] .typing span {
  width: 8px;
  height: 8px;
  opacity: .25;
  transform: none !important;
  animation: rappPulse 1.4s ease-in-out infinite;
  animation-delay: 0s;
}
html[data-rapp-stream="smooth"] .typing span:nth-child(2) {
  animation-delay: .2s;
}
html[data-rapp-stream="smooth"] .typing span:nth-child(3) {
  animation-delay: .4s;
}
@keyframes rappArrive {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes rappCaret {
  0%, 49% { opacity: .72; }
  50%, 100% { opacity: 0; }
}
@keyframes rappPulse {
  0%, 100% { opacity: .25; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  html[data-rapp-stream="smooth"] .msg.assistant.stream-arriving,
  html[data-rapp-stream="smooth"] .msg.assistant .bubble.stream-revealing,
  html[data-rapp-stream="smooth"] .msg.assistant.stream-arriving .bubble::after,
  html[data-rapp-stream="smooth"] .typing span {
    animation: none !important;
    transform: none !important;
  }
  html[data-rapp-stream="smooth"] .typing span {
    opacity: .6;
  }
}
`;
const ledger = hasLock ? openLedger(betaHome) : null;
const ambient = hasLock
  ? openAmbient(betaHome, {
      deviceEnabled: process.env.RAPP_AMBIENT_DEVICE !== "0",
    })
  : null;
const initialChatLook = readChatLookSettings({
  betaHome,
  env: process.env,
});
const initialViewMode = readViewModeSettings({
  betaHome,
  env: process.env,
});
let chatLook = initialChatLook.chatLook;
let chatLookOverridden = initialChatLook.chatLookOverridden;
let chatTypingEnabled = chatStreamMode === "hold";
let viewMode = initialViewMode.viewMode;
let viewModeOverridden = initialViewMode.viewModeOverridden;
let arenaLayoutState = resolveCustomLayout(viewMode);
const dimensionTileStore = new DimensionTileStore({ betaHome });
const openRappterTileStore = new OpenRappterTileStore({
  betaHome,
  brainstemDir: config.brainstemDir,
});
const organismEggAdapter = new OrganismEggAdapter({
  openRappterHome,
  packageDir,
});
const rappterPackConfigPath = process.env.RAPPTER_PACK_CONFIG
  || path.join(openRappterHome, "pack.json");
const rappterPackMatrixPath = process.env.RAPPTER_PACK_MATRIX
  || path.join(packageDir, "resources", "rappter-pack", "default-matrix.json");
const startupFingerprint = betaSourceFingerprint(path.resolve(packageDir, ".."));
const brainstemRuntimeFingerprint = runtimeDirectoryFingerprint(
  config.brainstemDir,
);
const exportRedactionSource = createExportRedactionScript({
  roots: [
    config.brainstemDir,
    config.brainstemHome,
    homedir(),
    tmpdir(),
  ],
});
const BETA_FRAME_BRIDGE_SOURCE = `(() => {
  const requestedChatLook = window.__rappBetaChatLookConfig?.chatLook || "messages";
  const requestedChatTyping = window.__rappBetaChatLookConfig?.chatTypingEnabled !== false;
  if (window.__rappBetaFrameBridge) {
    window.__rappBetaApplyChatLook?.(requestedChatLook, requestedChatTyping);
    return true;
  }
  window.__rappBetaFrameBridge = true;
  ${exportRedactionSource}
  const humanizeAgentName = ${humanizeAgentName.toString()};
  const chatStreamMode = ${JSON.stringify(chatStreamMode)};
  const createTailFollower = ${createTailFollower.toString()};
  const splitRenderPieces = ${splitRenderPieces.toString()};
  const createAdaptiveRenderPacer = ${createAdaptiveRenderPacer.toString()};
  document.documentElement.dataset.rappStream = chatStreamMode;
  if (chatStreamMode === "smooth") {
    const streamStyle = document.createElement("style");
    streamStyle.id = "__rappStreamStyle";
    streamStyle.textContent = ${JSON.stringify(smoothStreamCss)};
    document.head.appendChild(streamStyle);
  }
  function installSmoothTailFollow() {
    const chat = document.getElementById("chat");
    const footer = document.querySelector("footer");
    if (!chat || !footer) return null;
    const root = document.documentElement;
    const follower = createTailFollower({
      distanceFromBottom: () => (
        chat.scrollHeight - chat.clientHeight - chat.scrollTop
      ),
      pinToBottom: () => {
        chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight);
      },
      thresholdPx: 80,
    });
    let arriving = null;
    let userIntentUntil = 0;
    const bubbleObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => follower.contentChanged())
      : null;

    function measureFooter() {
      const height = footer.getBoundingClientRect().height;
      root.style.setProperty(
        "--rapp-stream-footer-clearance",
        Math.max(0, height) + "px",
      );
      return height;
    }

    function syncStreamingBubble() {
      const next = chat.querySelector(".msg.assistant.stream-arriving");
      if (next !== arriving) {
        bubbleObserver?.disconnect();
        if (next) {
          arriving = next;
          bubbleObserver?.observe(next);
          follower.start();
        } else if (arriving) {
          arriving = null;
          follower.complete();
        }
      }
      if (next) follower.contentChanged();
    }

    function markUserIntent(duration = 320) {
      userIntentUntil = performance.now() + duration;
    }

    const mutationObserver = new MutationObserver(syncStreamingBubble);
    mutationObserver.observe(chat, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    const footerObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
        measureFooter();
        follower.contentChanged();
      })
      : null;
    footerObserver?.observe(footer);
    chat.addEventListener("wheel", () => markUserIntent(), { passive: true });
    chat.addEventListener("touchstart", () => markUserIntent(500), {
      passive: true,
    });
    chat.addEventListener("scroll", () => {
      follower.handleScroll({
        userInitiated: performance.now() <= userIntentUntil,
      });
    }, { passive: true });
    document.addEventListener("keydown", (event) => {
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
        markUserIntent();
      }
    });
    window.addEventListener("resize", measureFooter);
    const measuredFooterHeight = measureFooter();
    syncStreamingBubble();
    const installed = {
      follower,
      footerObserver,
      measuredFooterHeight,
      mutationObserver,
    };
    window.__rappSmoothTailFollow = installed;
    return installed;
  }
  if (chatStreamMode === "smooth") installSmoothTailFollow();
  const normalizeChatLook = ${normalizeChatLook.toString()};
  const applyLookStyles = ${applyLookStyles.toString()};
  const inferMessageSide = ${inferMessageSide.toString()};
  const markArrived = ${markArrived.toString()};
  const markGroupLast = ${markGroupLast.toString()};
  const grailFrameCss = ${JSON.stringify(grailFrameCss)};
  const style = document.createElement("style");
  style.textContent = [
    ".beta-agent-icon-button{display:grid!important;place-items:center;",
    "width:32px;height:30px;padding:0!important}",
    ".beta-agent-icon-button svg{width:16px;height:16px;pointer-events:none}",
    "header .logo[data-beta-explorer-toggle]{cursor:pointer}",
    "header .logo[data-beta-explorer-toggle]:focus-visible{outline:2px solid #58a6ff;",
    "outline-offset:3px}",
    ".beta-frame-menu{position:relative}",
    ".beta-frame-menu #beta-app-panel{display:none;position:absolute;",
    "top:calc(100% + 10px);right:0;width:min(340px,calc(100vw - 32px));",
    "padding:14px;border:1px solid #30363d;border-radius:10px;",
    "background:#161b22;box-shadow:0 16px 48px rgba(0,0,0,.5);z-index:80}",
    ".beta-frame-menu #beta-app-panel.open{display:block}",
    ".beta-frame-menu #beta-app-panel h3{margin:0 0 5px;font-size:14px}",
    ".beta-frame-menu .beta-app-copy{margin:0 0 12px;color:#8b949e;",
    "font-size:11px;line-height:1.45}",
    ".beta-frame-menu .beta-panel-btn{width:100%;padding:8px 10px;",
    "border:1px solid #30363d;border-radius:6px;background:#21262d;",
    "color:#e6edf3;cursor:pointer;font:inherit;font-size:12px;font-weight:700}",
    ".beta-frame-menu .beta-panel-btn:hover{border-color:#58a6ff;",
    "background:#30363d}",
    ".beta-frame-menu .beta-panel-btn.primary{margin-top:9px;",
    "border-color:#238636;background:#238636}",
    ".beta-frame-menu .beta-panel-btn[hidden]{display:none}",
    ".beta-frame-menu .beta-chat-look{display:flex;align-items:center;gap:8px;",
    "margin:0 0 12px;padding:8px;border:1px solid #30363d;border-radius:8px;",
    "background:#0d1117;color:#8b949e;font-size:11px}",
    ".beta-frame-menu .beta-chat-look-options{display:flex;gap:4px;margin-left:auto}",
    ".beta-frame-menu .beta-chat-look button{padding:4px 7px;border:1px solid #30363d;",
    "border-radius:999px;background:#21262d;color:#8b949e;font:inherit;cursor:pointer}",
    ".beta-frame-menu .beta-chat-look button[aria-pressed=true]{border-color:#58a6ff;",
    "background:#1f6feb;color:#fff}",
    ".beta-frame-menu #beta-update-status{margin-top:10px;padding:9px;",
    "border:1px solid #30363d;border-radius:8px;background:#0d1117;",
    "color:#8b949e;font-size:11px;line-height:1.4;white-space:pre-wrap}",
    ".beta-frame-menu #beta-update-status[data-phase=checking],",
    ".beta-frame-menu #beta-update-status[data-phase=applying]",
    "{border-color:#9e6a03;color:#d29922}",
    ".beta-frame-menu #beta-update-status[data-phase=current],",
    ".beta-frame-menu #beta-update-status[data-phase=success]",
    "{border-color:#238636;color:#3fb950}",
    ".beta-frame-menu #beta-update-status[data-phase=available]",
    "{border-color:#1f6feb;color:#58a6ff}",
    ".beta-frame-menu #beta-update-status[data-phase=blocked],",
    ".beta-frame-menu #beta-update-status[data-phase=error]",
    "{border-color:#da3633;color:#ff7b72}",
    ".beta-drive-feed{position:fixed;right:14px;bottom:14px;z-index:2147483644;",
    "display:flex;flex-direction:column;align-items:flex-end;gap:6px;",
    "max-width:min(420px,42vw);pointer-events:none}",
    ".beta-drive-step-tile{max-width:min(760px,92%);overflow:hidden;",
    "padding:5px 9px;border:1px solid #30363d;border-radius:999px;",
    "background:#161b22;color:#8b949e;font:600 11px/1.25 ui-monospace,monospace;",
    "text-overflow:ellipsis;white-space:nowrap}",
    ".beta-drive-media-tile{width:min(560px,92%);overflow:hidden;",
    "border:1px solid #30363d;border-radius:10px;background:#0d1117}",
    ".beta-drive-media-tile img,.beta-drive-media-tile video{display:block;",
    "width:100%;max-height:320px;object-fit:contain}",
    ".beta-drive-media-tile a{display:block;padding:7px 9px;color:#58a6ff;",
    "font-size:11px;text-decoration:none}",
  ].join("");
  document.head.appendChild(style);
  let chatTypingEnabled = requestedChatTyping;
  let currentChatLook = normalizeChatLook(requestedChatLook);
  const chatRoot = document.getElementById("chat");
  function frameMessages() {
    return document.querySelectorAll("#chat .msg.user, #chat .msg.assistant");
  }
  function syncMessageGroups() {
    markGroupLast(frameMessages(), inferMessageSide);
  }
  function clearMessageMarkers() {
    for (const message of frameMessages()) {
      message.removeAttribute("data-group-last");
      message.removeAttribute("data-rapp-arrived");
      message.classList.remove("rapp-group-last", "rapp-message-arrived");
    }
  }
  function renderFrameChatLookControls() {
    for (const look of ["messages", "business"]) {
      document.getElementById("beta-chat-look-" + look)?.setAttribute(
        "aria-pressed",
        String(currentChatLook === look),
      );
    }
  }
  function applyFrameChatLook(look, typingEnabled) {
    currentChatLook = normalizeChatLook(look);
    chatTypingEnabled = Boolean(typingEnabled);
    applyLookStyles(
      document,
      currentChatLook,
      grailFrameCss,
      "__rappChatLook",
    );
    if (currentChatLook === "messages") syncMessageGroups();
    else clearMessageMarkers();
    renderFrameChatLookControls();
    return {
      chatLook: currentChatLook,
      chatTypingEnabled,
    };
  }
  window.__rappBetaApplyChatLook = applyFrameChatLook;
  if (chatRoot) {
    new MutationObserver((records) => {
      if (currentChatLook !== "messages") return;
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (node?.nodeType !== 1) continue;
          const arrivals = [];
          if (node.matches?.(".msg.assistant:not(.typing-indicator)")) {
            arrivals.push(node);
          }
          const descendants = node.querySelectorAll?.(
            ".msg.assistant:not(.typing-indicator)",
          ) || [];
          arrivals.push(
            ...descendants,
          );
          for (const arrival of arrivals) markArrived(arrival);
        }
      }
      syncMessageGroups();
    }).observe(chatRoot, { childList: true, subtree: true });
  }
  applyFrameChatLook(requestedChatLook, requestedChatTyping);
  const downloadIcon = '<svg viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/>'
    + '<path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  const trashIcon = '<svg viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/>'
    + '<path d="M8 6V4h8v2"/><path d="m19 6-1 15H6L5 6"/>'
    + '<path d="M10 11v6M14 11v6"/></svg>';
  function decorateAgentRows(root = document) {
    root.querySelectorAll(".agent-title").forEach((title) => {
      if (title.dataset.betaAgentDisplay) return;
      title.dataset.betaAgentDisplay = "1";
      title.textContent = humanizeAgentName(title.textContent);
    });
    root.querySelectorAll(".export-btn").forEach((button) => {
      const deleting = button.classList.contains("del-btn");
      const iconKind = deleting ? "delete" : "download";
      if (button.dataset.betaAgentIcon === iconKind) return;
      button.dataset.betaAgentIcon = iconKind;
      button.classList.add("beta-agent-icon-button");
      button.innerHTML = deleting ? trashIcon : downloadIcon;
      button.title = deleting ? "Delete agent" : "Download agent.py";
      button.setAttribute(
        "aria-label",
        deleting ? "Delete agent" : "Download agent.py",
      );
    });
  }
  const driveHandlesById = {
    "agents-btn": "brainstem.agents",
    "beta-app-btn": "brainstem.menu",
    "beta-app-panel": "brainstem.menuPanel",
    "beta-check-updates": "brainstem.checkUpdates",
    "beta-install-update": "brainstem.installUpdate",
    "chat": "brainstem.chat",
    "dev-toggle": "brainstem.devMode",
    "input": "brainstem.composer",
    "model-select": "brainstem.model",
    "registry-btn": "brainstem.registry",
    "send": "brainstem.send",
    "session-id": "brainstem.session",
    "theme-btn": "brainstem.theme",
    "version-tag": "brainstem.version",
    "voice-btn": "brainstem.voice",
    "voice-settings-btn": "brainstem.voiceSettings",
    "vscode-link": "brainstem.vscode",
  };
  function stampChatMessageHandles() {
    document.querySelectorAll("#chat .response-slot[data-request-id]").forEach((slot) => {
      const messages = slot.querySelectorAll(
        ".msg.assistant:not(.typing-indicator),.msg.system",
      );
      const message = messages[messages.length - 1];
      if (!message) return;
      const requestId = String(slot.dataset.requestId || "");
      if (!requestId) return;
      message.dataset.drive = "brainstem.chat.msg[r-" + requestId + "]";
      message.dataset.driveOutline = "true";
      message.dataset.driveRole = "article";
      message.dataset.driveName = message.classList.contains("assistant")
        ? "assistant"
        : "system";
      message.dataset.driveState = (
        message.classList.contains("stream-arriving")
        || message.classList.contains("typing-indicator")
      ) ? "streaming" : "complete";
    });
  }
  function stampDriveHandles() {
    for (const [id, handle] of Object.entries(driveHandlesById)) {
      const element = document.getElementById(id);
      if (element) element.dataset.drive = handle;
    }
    const logo = document.querySelector("header .logo");
    if (logo) logo.dataset.drive = "brainstem.explorer";
    const footerHandles = new Map([
      ["Export", "brainstem.export"],
      ["Import", "brainstem.import"],
      ["Clear", "brainstem.clear"],
      ["Tutorial", "brainstem.tutorial"],
      ["Get Help", "brainstem.help"],
      ["Dev", "brainstem.devMode"],
    ]);
    document.querySelectorAll("footer button,footer a").forEach((control) => {
      const text = String(control.textContent || "")
        .replace(/[^\p{L}\p{N}\s?]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
      if (control.closest("#starter-prompts")) {
        control.dataset.drive = "brainstem.prompt["
          + encodeURIComponent(text.toLowerCase()) + "].button";
        return;
      }
      const handle = footerHandles.get(text);
      if (handle) control.dataset.drive = handle;
    });
    document.querySelectorAll("#agent-list-ul li").forEach((row) => {
      const filename = row.querySelector(".agent-name")?.getAttribute("title");
      if (!filename) return;
      row.dataset.drive = "brainstem.agent[" + encodeURIComponent(filename) + "].row";
    });
    stampChatMessageHandles();
  }
  // Driver steps are not conversation. The activity view is delivered as one
  // independently executable payload so its real mounting behavior is testable.
  ${activityViewInstallationSource}
  decorateAgentRows();
  const agentList = document.getElementById("agent-list-ul");
  if (agentList) {
    new MutationObserver(() => decorateAgentRows(agentList)).observe(
      agentList,
      { childList: true, subtree: true },
    );
  }
  function setBetaMenuOpen(open) {
    const panel = document.getElementById("beta-app-panel");
    const button = document.getElementById("beta-app-btn");
    if (!panel || !button) return;
    panel.classList.toggle("open", Boolean(open));
    button.setAttribute("aria-expanded", String(Boolean(open)));
  }
  function renderBetaUpdate(update, openPanel = false) {
    if (!update) return;
    const phase = update.phase || "idle";
    const status = document.getElementById("beta-update-status");
    if (!status) return;
    status.dataset.phase = phase;
    const lines = [
      update.message || "Check GitHub for the latest OpenRappter.",
      update.detail,
      update.source ? "Source: " + update.source : "",
      update.guidance,
    ].filter(Boolean);
    const message = document.getElementById("beta-update-message");
    if (message) {
      message.textContent = lines[0] || "";
      const detail = document.getElementById("beta-update-detail");
      const source = document.getElementById("beta-update-source");
      const guidance = document.getElementById("beta-update-guidance");
      if (detail) detail.textContent = update.detail || "";
      if (source) source.textContent = update.source
        ? "Source: " + update.source
        : "";
      if (guidance) guidance.textContent = update.guidance || "";
    } else {
      status.textContent = lines.join("\\n");
    }
    const busy = phase === "checking" || phase === "applying";
    const checkButton = document.getElementById("beta-check-updates");
    if (checkButton) {
      checkButton.disabled = busy;
      checkButton.textContent = phase === "checking"
        ? "Checking GitHub..."
        : "Check for updates";
    }
    const installButton = document.getElementById("beta-install-update");
    if (installButton) {
      installButton.hidden = phase !== "available";
      installButton.disabled = busy;
    }
    if (openPanel) setBetaMenuOpen(true);
  }
  function installBetaMenu() {
    const brainLogo = document.querySelector("header .logo");
    if (brainLogo) {
      brainLogo.title = "Toggle live agents";
      brainLogo.setAttribute(
        "aria-label",
        "Toggle live agents",
      );
      brainLogo.setAttribute("role", "button");
      brainLogo.setAttribute("aria-expanded", "false");
      brainLogo.tabIndex = 0;
      if (!brainLogo.dataset.betaExplorerToggle) {
        brainLogo.dataset.betaExplorerToggle = "1";
        const toggleExplorer = () => {
          window.parent.postMessage({ type: "rapp-beta:toggle-explorer" }, "*");
        };
        brainLogo.addEventListener("click", toggleExplorer);
        brainLogo.addEventListener("keydown", (event) => {
          if (!["Enter", " "].includes(event.key)) return;
          event.preventDefault();
          toggleExplorer();
        });
      }
    }
    let wrapper = document.querySelector(".beta-app-wrapper");
    let button = document.getElementById("beta-app-btn");
    let panel = document.getElementById("beta-app-panel");
    if (!wrapper || !button || !panel) {
      const controls = document.querySelector("header .controls");
      if (!controls) return false;
      wrapper = document.createElement("div");
      wrapper.className = "beta-app-wrapper beta-frame-menu";
      wrapper.innerHTML = '<button class="icon-btn" id="beta-app-btn" '
        + 'type="button" title="OpenRappter menu" aria-haspopup="true" '
        + 'aria-expanded="false"><span class="icon"><svg viewBox="0 0 24 24" '
        + 'fill="currentColor" aria-hidden="true"><path d="M6 10a2 2 0 1 0 0 4 '
        + '2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 '
        + '0 4 2 2 0 0 0 0-4Z"/></svg></span></button>'
        + '<div id="beta-app-panel"><h3>OpenRappter</h3>'
        + '<p class="beta-app-copy">Chat is the control surface. Agents can add '
        + 'capabilities and visibly operate this workspace while you watch.</p>'
        + '<div class="beta-chat-look" role="group" aria-label="Chat look">'
        + '<span>Chat look ▸</span><div class="beta-chat-look-options">'
        + '<button id="beta-chat-look-messages" type="button" data-look="messages">'
        + 'Messages</button><button id="beta-chat-look-business" type="button" '
        + 'data-look="business">Business</button></div></div>'
        + '<button class="beta-panel-btn" id="beta-location-settings" type="button">'
        + 'My location and ambient context</button>'
        + '<button class="beta-panel-btn" id="beta-check-updates" type="button">'
        + 'Check for updates</button><div id="beta-update-status" '
        + 'data-phase="idle" role="status" aria-live="polite">Check GitHub for '
        + 'the latest OpenRappter.</div><button class="beta-panel-btn '
        + 'primary" id="beta-install-update" type="button" hidden>'
        + 'Update and Restart</button></div>';
      const vscode = document.getElementById("vscode-link");
      controls.insertBefore(wrapper, vscode || null);
      button = document.getElementById("beta-app-btn");
      panel = document.getElementById("beta-app-panel");
    }
    button.title = "OpenRappter menu";
    button.setAttribute("aria-label", "OpenRappter menu");
    const menuHeading = panel.querySelector("h3");
    if (menuHeading) menuHeading.textContent = "OpenRappter";
    document.body.classList.add("beta-app");
    button.removeAttribute("onclick");
    const checkButton = document.getElementById("beta-check-updates");
    const installButton = document.getElementById("beta-install-update");
    const locationButton = document.getElementById("beta-location-settings");
    checkButton?.removeAttribute("onclick");
    installButton?.removeAttribute("onclick");
    locationButton?.removeAttribute("onclick");
    if (!button.dataset.betaFrameBridge) {
      button.dataset.betaFrameBridge = "1";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setBetaMenuOpen(!panel.classList.contains("open"));
      });
      checkButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        renderBetaUpdate({
          phase: "checking",
          message: "Checking GitHub for updates...",
        }, true);
        window.parent.postMessage({ type: "rapp-beta:check-updates" }, "*");
      });
      installButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        renderBetaUpdate({
          phase: "applying",
          message: "Preparing the update and restart...",
        }, true);
        window.parent.postMessage({ type: "rapp-beta:install-update" }, "*");
      });
      locationButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        setBetaMenuOpen(false);
        window.parent.postMessage({
          type: "rapp-beta:open-ambient-settings",
        }, "*");
      });
      for (const look of ["messages", "business"]) {
        document.getElementById("beta-chat-look-" + look)?.addEventListener(
          "click",
          (event) => {
            event.stopPropagation();
            window.parent.postMessage({
              type: "rapp-beta:set-chat-look",
              look,
            }, "*");
          },
        );
      }
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".beta-app-wrapper")) setBetaMenuOpen(false);
      });
    }
    renderFrameChatLookControls();
    return true;
  }
  installBetaMenu();
  stampDriveHandles();
  new MutationObserver(stampDriveHandles).observe(document.body, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "rapp-beta:open-update") {
      setBetaMenuOpen(true);
    } else if (event.data.type === "rapp-beta:update-state") {
      renderBetaUpdate(event.data.update, event.data.openPanel);
    } else if (event.data.type === "rapp-beta:explorer-state") {
      document.querySelector("header .logo")
        ?.setAttribute("aria-expanded", String(Boolean(event.data.open)));
    } else if (event.data.type === "rapp-beta:lineage-confirmation") {
      const reply = String(event.data.reply || "");
      let rendered = false;
      if (reply && typeof appendMsg === "function") {
        appendMsg("assistant", reply);
        rendered = true;
      } else if (reply) {
        const chat = document.getElementById("chat");
        if (chat) {
          const wrap = document.createElement("div");
          wrap.className = "msg assistant";
          const bubble = document.createElement("div");
          bubble.className = "bubble";
          bubble.textContent = reply;
          wrap.appendChild(bubble);
          chat.appendChild(wrap);
          chat.classList.add("has-messages");
          chat.scrollTop = chat.scrollHeight;
          rendered = true;
        }
      }
      if (rendered) {
        window.parent.postMessage({
          type: "rapp-beta:lineage-confirmation-ack",
          confirmationId: event.data.confirmationId,
        }, "*");
      }
    }
  });
  const nativeFetch = window.fetch.bind(window);
  function holdChatStreamResponse(response, signal) {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let stopped = false;
    let abortHandler = null;

    const body = new ReadableStream({
      start(controller) {
        abortHandler = () => {
          if (stopped) return;
          stopped = true;
          const reason = signal?.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            });
          void reader.cancel(reason).catch((cause) => {
            console.warn("OpenRappter could not cancel the upstream chat stream.", cause);
          });
          controller.error(reason);
        };
        if (signal?.aborted) {
          abortHandler();
          return;
        }
        signal?.addEventListener("abort", abortHandler, { once: true });

        void (async () => {
          const chunks = [];
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
            if (stopped) return;
            stopped = true;
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          } catch (cause) {
            if (stopped || signal?.aborted) return;
            stopped = true;
            for (const chunk of chunks) controller.enqueue(chunk);
            const message = String(
              cause?.message || cause || "Response stream interrupted.",
            );
            controller.enqueue(new TextEncoder().encode(
              "\\n\\ndata: " + JSON.stringify({
                type: "error",
                error: message,
              }) + "\\n\\n",
            ));
            controller.close();
          } finally {
            signal?.removeEventListener("abort", abortHandler);
            reader.releaseLock();
          }
        })();
      },
      cancel(reason) {
        if (stopped) return undefined;
        stopped = true;
        signal?.removeEventListener("abort", abortHandler);
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  function parseSseEvent(frame) {
    const data = String(frame)
      .split(/\\r?\\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\\n");
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  function postCompletedChat(request, result) {
    const response = String(
      result?.response || result?.assistant_response || result?.result || "",
    );
    if (!response) return;
    window.parent.postMessage({
      type: "rapp-beta:ledger-turn",
      turn: {
        agentLogs: result?.agent_logs || "",
        model: result?.model || null,
        requestId: request.requestId,
        response,
        sessionId: result?.session_id || request.body.session_id || null,
        userInput: request.body.user_input,
      },
    }, "*");
  }
  function createChatCapture(request) {
    const decoder = new TextDecoder();
    let buffer = "";
    let reported = false;
    let terminal = null;
    return {
      abort() {
        terminal = null;
      },
      finish() {
        if (reported || !terminal) return;
        reported = true;
        postCompletedChat(request, terminal);
      },
      push(value) {
        if (reported || terminal || !value) return;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const separator = /\\r?\\n\\r?\\n/.exec(buffer);
          if (!separator) return;
          const end = separator.index + separator[0].length;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end);
          const event = parseSseEvent(frame);
          if (event?.type !== "done") continue;
          terminal = event;
          return;
        }
      },
    };
  }
  function instrumentChatResponse(response, request) {
    if (!response.ok) return response;
    if (request.pathname === "/chat/stream" && response.body) {
      const capture = createChatCapture(request);
      const nativeGetReader = response.body.getReader.bind(response.body);
      response.body.getReader = function frontierLedgerReader(...args) {
        const reader = nativeGetReader(...args);
        const nativeRead = reader.read.bind(reader);
        const nativeCancel = reader.cancel.bind(reader);
        reader.read = async function frontierLedgerRead() {
          try {
            const result = await nativeRead();
            if (result.done) capture.finish();
            else capture.push(result.value);
            return result;
          } catch (cause) {
            capture.abort();
            throw cause;
          }
        };
        reader.cancel = function frontierLedgerCancel(reason) {
          capture.abort();
          return nativeCancel(reason);
        };
        return reader;
      };
      return response;
    }
    let reported = false;
    const report = (result) => {
      if (reported) return;
      reported = true;
      postCompletedChat(request, result);
    };
    const nativeJson = response.json.bind(response);
    response.json = async function frontierLedgerJson() {
      const result = await nativeJson();
      report(result);
      return result;
    };
    const nativeText = response.text.bind(response);
    response.text = async function frontierLedgerText() {
      const result = await nativeText();
      try {
        report(JSON.parse(result));
      } catch {
        // The native response remains authoritative when text is not JSON.
      }
      return result;
    };
    return response;
  }
  function errorSseFrame(cause) {
    return "\\n\\ndata: " + JSON.stringify({
      type: "error",
      error: String(cause?.message || cause || "Response stream interrupted."),
    }) + "\\n\\n";
  }
  function normalizeProvisionalMarkdown(text) {
    return String(text || "").replace(
      /^([ \\t]*)[\\u2022\\u2023\\u25AA\\u25CF]\\s+/gm,
      "$1- ",
    );
  }

  function bridgeSanitizeMarkdown(html) {
    const allowedTags = new Set([
      "A", "BLOCKQUOTE", "BR", "CODE", "COL", "COLGROUP", "DEL", "EM",
      "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE",
      "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
    ]);
    const forbiddenSubtrees = new Set([
      "APPLET", "AUDIO", "BASE", "CANVAS", "EMBED", "FORM", "FRAME",
      "FRAMESET", "IFRAME", "INPUT", "LINK", "META", "OBJECT", "PORTAL",
      "SCRIPT", "SOURCE", "STYLE", "SVG", "TEMPLATE", "TEXTAREA", "TRACK",
      "VIDEO",
    ]);
    const allowedAttributes = {
      A: ["href", "title"],
      COL: ["span"],
      COLGROUP: ["span"],
      OL: ["start"],
      TD: ["align"],
      TH: ["align", "scope"],
    };
    const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
    const fragment = document.createDocumentFragment();

    function safeUrl(value) {
      const stripped = String(value || "")
        .replace(/[\\u0000-\\u0020\\u007F-\\u00A0]/g, "")
        .toLowerCase();
      const match = stripped.match(/^([a-z][a-z0-9+.\\-]*):/);
      return !match || ["http", "https", "mailto", "tel"].includes(match[1]);
    }

    function clean(node) {
      if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
      if (node.nodeType !== 1) return null;
      const tag = String(node.tagName || "").toUpperCase();
      if (forbiddenSubtrees.has(tag)) return null;
      if (!allowedTags.has(tag)) {
        const unwrapped = document.createDocumentFragment();
        for (const child of node.childNodes || []) {
          const cleaned = clean(child);
          if (cleaned) unwrapped.appendChild(cleaned);
        }
        return unwrapped;
      }
      const element = document.createElement(tag);
      const allowed = allowedAttributes[tag] || [];
      for (const attribute of node.attributes || []) {
        const name = String(attribute.name || "").toLowerCase();
        if (!allowed.includes(name)) continue;
        if (name === "href" && !safeUrl(attribute.value)) continue;
        element.setAttribute(name, attribute.value);
      }
      if (tag === "A" && element.getAttribute("href")) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
      for (const child of node.childNodes || []) {
        const cleaned = clean(child);
        if (cleaned) element.appendChild(cleaned);
      }
      return element;
    }

    for (const child of parsed.body.childNodes || []) {
      const cleaned = clean(child);
      if (cleaned) fragment.appendChild(cleaned);
    }
    return fragment;
  }

  function createProvisionalScreenRenderer({ typingIndicator: claimedIndicator = null } = {}) {
    const stats = {
      finalHeight: null,
      handoffCount: 0,
      heightDelta: null,
      provisionalHeight: null,
      removeCount: 0,
      renderCount: 0,
      shownText: "",
    };
    window.__rappSmoothScreenStats = stats;
    let bubble = null;
    let handoffObserver = null;
    let provisional = null;
    let removed = false;
    let responseSlot = null;
    // The indicator is claimed when the REQUEST is made (the kernel creates a
    // slot + indicator synchronously before it calls fetch), not when the
    // first delta lands — with two requests in flight, "newest unclaimed at
    // first delta" is the OTHER request's slot.
    let typingIndicator = claimedIndicator && claimedIndicator.isConnected !== false
      ? claimedIndicator
      : null;

    window.__rappSmoothMarkdownCapabilities = {
      marked: typeof window.marked?.parse === "function",
      normalizeMd: typeof window.normalizeMd === "function",
      sanitizer: typeof window.sanitizeMarkdownFragment === "function",
    };

    function availableTypingIndicator() {
      const candidates = [
        ...document.querySelectorAll("#chat .typing-indicator"),
      ].reverse();
      return candidates.find(
        (candidate) => candidate.dataset.rappProvisionalClaimed !== "1",
      ) || null;
    }

    function removeProvisional({ restoreTyping = true } = {}) {
      if (removed) return false;
      removed = true;
      handoffObserver?.disconnect();
      handoffObserver = null;
      responseSlot?.removeAttribute("data-rapp-provisional-active");
      if (typingIndicator) {
        typingIndicator.classList.remove("rapp-provisional-hidden");
        if (restoreTyping) {
          delete typingIndicator.dataset.rappProvisionalClaimed;
        }
      }
      if (provisional?.parentNode) provisional.remove();
      stats.removeCount += provisional ? 1 : 0;
      return true;
    }

    function findFinalBubble() {
      if (!responseSlot) return null;
      const candidates = responseSlot.querySelectorAll(
        '.msg.assistant:not([data-rapp-provisional="1"])'
          + ":not(.typing-indicator):not(.stream-arriving)",
      );
      return candidates[candidates.length - 1] || null;
    }

    function completeHandoff() {
      if (removed) return;
      const finalBubble = findFinalBubble();
      if (!finalBubble) return;
      stats.provisionalHeight = provisional?.getBoundingClientRect().height || 0;
      finalBubble.classList.add("rapp-final-handoff");
      finalBubble.classList.remove("rapp-message-arrived");
      finalBubble.removeAttribute("data-rapp-arrived");
      responseSlot.removeAttribute("data-rapp-provisional-active");
      stats.finalHeight = finalBubble.getBoundingClientRect().height || 0;
      stats.heightDelta = stats.finalHeight - stats.provisionalHeight;
      stats.handoffCount += 1;
      removeProvisional({ restoreTyping: false });
    }

    function ensureProvisional() {
      if (provisional || removed) return provisional;
      if (!typingIndicator || typingIndicator.isConnected === false) {
        typingIndicator = availableTypingIndicator();
      }
      if (!typingIndicator) return null;
      responseSlot = typingIndicator.closest(".response-slot")
        || typingIndicator.parentElement;
      if (!responseSlot) return null;
      typingIndicator.dataset.rappProvisionalClaimed = "1";
      typingIndicator.classList.add("rapp-provisional-hidden");
      responseSlot.dataset.rappProvisionalActive = "1";

      provisional = document.createElement("div");
      provisional.className = "msg assistant stream-arriving";
      provisional.dataset.rappProvisional = "1";
      const avatar = typingIndicator.querySelector(".avatar")?.cloneNode(true);
      if (avatar) provisional.appendChild(avatar);
      const right = document.createElement("div");
      bubble = document.createElement("div");
      bubble.className = "bubble";
      right.appendChild(bubble);
      provisional.appendChild(right);
      responseSlot.insertBefore(provisional, typingIndicator.nextSibling);

      handoffObserver = new MutationObserver(completeHandoff);
      handoffObserver.observe(responseSlot, { childList: true, subtree: true });
      return provisional;
    }

    function render(text) {
      const wrap = ensureProvisional();
      if (!wrap || !bubble) return;
      stats.renderCount += 1;
      stats.shownText = text;
      wrap.classList.toggle("wide", text.length > 1200);
      const normalizer = typeof window.normalizeMd === "function"
        ? window.normalizeMd
        : normalizeProvisionalMarkdown;
      const normalized = normalizer(text);
      const markdown = typeof window.marked?.parse === "function"
        ? window.marked.parse(normalized)
        : null;
      if (markdown === null) {
        bubble.textContent = text;
      } else {
        const pageSanitizer = typeof window.sanitizeMarkdownFragment === "function"
          ? window.sanitizeMarkdownFragment
          : null;
        bubble.replaceChildren(
          pageSanitizer
            ? pageSanitizer(markdown)
            : bridgeSanitizeMarkdown(markdown),
        );
      }
    }

    const pacer = createAdaptiveRenderPacer({ onRender: render });
    return Object.freeze({
      abort: () => {
        pacer.abort();
        removeProvisional();
      },
      fail: () => {
        pacer.abort();
        removeProvisional();
      },
      finish: () => pacer.finish(),
      metrics: pacer.metrics,
      push: pacer.push,
      stats,
    });
  }

  function claimTypingIndicatorForRequest() {
    const candidates = [
      ...document.querySelectorAll("#chat .typing-indicator"),
    ].reverse();
    const indicator = candidates.find(
      (candidate) => candidate.dataset?.rappProvisionalClaimed !== "1",
    ) || null;
    if (indicator?.dataset) indicator.dataset.rappProvisionalClaimed = "1";
    return indicator;
  }

  function smoothChatStreamResponse(response, signal, { typingIndicator = null } = {}) {
    if (!response.body) {
      if (typingIndicator) delete typingIndicator.dataset.rappProvisionalClaimed;
      return response;
    }
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const rawChunks = [];
    const screen = createProvisionalScreenRenderer({ typingIndicator });
    let stopped = false;
    let released = false;
    let abortHandler = null;

    const body = new ReadableStream({
      start(controller) {
        function releaseKernelWire() {
          if (released) return;
          released = true;
          for (const chunk of rawChunks.splice(0)) controller.enqueue(chunk);
        }

        abortHandler = () => {
          if (stopped) return;
          stopped = true;
          const reason = signal?.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            });
          screen.abort();
          void reader.cancel(reason).catch((cause) => {
            console.warn("OpenRappter could not cancel the upstream chat stream.", cause);
          });
          controller.error(reason);
        };
        if (signal?.aborted) {
          abortHandler();
          return;
        }
        signal?.addEventListener("abort", abortHandler, { once: true });

        void (async () => {
          let buffer = "";
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (released) {
                controller.enqueue(value);
                continue;
              }
              rawChunks.push(value);
              buffer += decoder.decode(value, { stream: true });
              while (true) {
                const separator = /\\r?\\n\\r?\\n/.exec(buffer);
                if (!separator) break;
                const end = separator.index + separator[0].length;
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end);
                const event = parseSseEvent(frame);
                if (event?.type === "delta" && typeof event.text === "string") {
                  screen.push(event.text);
                  continue;
                }
                if (event?.type === "error") {
                  screen.fail();
                  releaseKernelWire();
                  continue;
                }
                if (event?.type === "done") {
                  await screen.finish();
                  releaseKernelWire();
                }
              }
            }
            buffer += decoder.decode();
            if (!released) {
              screen.fail();
              releaseKernelWire();
            }
            if (stopped) return;
            stopped = true;
            controller.close();
          } catch (cause) {
            if (stopped || signal?.aborted) return;
            screen.fail();
            rawChunks.push(encoder.encode(errorSseFrame(cause)));
            releaseKernelWire();
            stopped = true;
            controller.close();
          } finally {
            signal?.removeEventListener("abort", abortHandler);
            try {
              reader.releaseLock();
            } catch {
              // Cancellation may release the reader first.
            }
          }
        })();
      },
      cancel(reason) {
        if (stopped) return undefined;
        stopped = true;
        screen.abort();
        signal?.removeEventListener("abort", abortHandler);
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  async function requestLineageCommand(message, requestId = window.crypto.randomUUID()) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("Molt Lineage control timed out."));
      }, 120000);
      function receive(event) {
        if (
          event.source !== window.parent
          || event.data?.type !== "rapp-beta:lineage-chat-result"
          || event.data?.requestId !== requestId
        ) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", receive);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error || "Molt Lineage control failed."));
      }
      window.addEventListener("message", receive);
      window.parent.postMessage({
        type: "rapp-beta:lineage-chat",
        requestId,
        message,
      }, "*");
    });
  }
  async function requestAmbientRefresh() {
    const requestId = window.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("Ambient context refresh timed out."));
      }, 3000);
      function receive(event) {
        if (
          event.source !== window.parent
          || event.data?.type !== "rapp-beta:refresh-ambient-result"
          || event.data?.requestId !== requestId
        ) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", receive);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(
          event.data.error || "Ambient context refresh failed.",
        ));
      }
      window.addEventListener("message", receive);
      window.parent.postMessage({
        type: "rapp-beta:refresh-ambient",
        requestId,
      }, "*");
    });
  }
  window.fetch = async function frontierFetch(resource, options = {}) {
    let target;
    try {
      const raw = resource instanceof Request ? resource.url : String(resource);
      target = new URL(raw, window.location.href);
    } catch {
      return nativeFetch(resource, options);
    }
    const method = String(
      options.method || (resource instanceof Request ? resource.method : "GET"),
    ).toUpperCase();
    const isChat = method === "POST"
      && (target.pathname === "/chat" || target.pathname === "/chat/stream");
    const shouldWrapChatStream = chatStreamMode !== "raw"
      && method === "POST"
      && target.pathname === "/chat/stream";
    const requestSignal = options.signal
      || (resource instanceof Request ? resource.signal : null);
    const claimed = shouldWrapChatStream && chatStreamMode !== "hold"
      ? claimTypingIndicatorForRequest()
      : null;
    let completion = null;
    const fetchNative = async () => {
      let nativeResponse;
      try {
        nativeResponse = await nativeFetch(resource, options);
      } catch (error) {
        if (claimed) delete claimed.dataset.rappProvisionalClaimed;
        throw error;
      }
      let response = nativeResponse;
      if (completion) {
        try {
          response = instrumentChatResponse(nativeResponse, completion);
        } catch {
          response = nativeResponse;
        }
      }
      if (!shouldWrapChatStream) return response;
      return chatStreamMode === "hold"
        ? holdChatStreamResponse(response, requestSignal)
        : smoothChatStreamResponse(response, requestSignal, { typingIndicator: claimed });
    };
    if (!isChat || typeof options.body !== "string") {
      return fetchNative();
    }
    let body;
    try {
      body = JSON.parse(options.body);
    } catch {
      return fetchNative();
    }
    if (typeof body.user_input !== "string") {
      return fetchNative();
    }
    completion = {
      body,
      pathname: target.pathname,
      requestId: window.crypto.randomUUID(),
    };
    try {
      await requestAmbientRefresh();
    } catch {
      // Ambient context is additive; chat must remain fail-open.
    }
    // Fail OPEN, always. This interceptor sits in front of every chat message,
    // so a lineage-control failure (main busy, handler throw, window teardown,
    // timeout) must never take the user's ordinary chat down with it — the layer
    // may substitute, never subtract. On any error we fall through to Grail.
    let result;
    try {
      result = await requestLineageCommand(
        body.user_input,
        completion.requestId,
      );
    } catch {
      return fetchNative();
    }
    if (!result?.intercepted) {
      return fetchNative();
    }
    if (claimed) delete claimed.dataset.rappProvisionalClaimed;
    if (target.pathname === "/chat/stream") {
      const frame = "data: " + JSON.stringify({
        type: "done",
        response: result.reply,
        agent_logs: "",
        streamed: false,
      }) + "\\n\\n";
      return instrumentChatResponse(new Response(frame, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }), completion);
    }
    return instrumentChatResponse(new Response(JSON.stringify({
      response: result.reply,
      agent_logs: "",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }), completion);
  };
  async function requestParent(type, filename) {
    const requestId = window.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("OpenRappter agent action timed out."));
      }, 30000);
      function receive(message) {
        if (
          message.source !== window.parent
          || message.data?.type !== type + "-result"
          || message.data?.requestId !== requestId
        ) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", receive);
        resolve(message.data);
      }
      window.addEventListener("message", receive);
      window.parent.postMessage({ type, requestId, filename }, "*");
    });
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.(".export-btn");
    if (!button) return;
    const deleting = button.classList.contains("del-btn");
    const filename = button.closest("li")
      ?.querySelector(".agent-name")?.getAttribute("title");
    if (!filename) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (
      deleting
      && !window.confirm(\`Are you sure you want to remove \${filename}?\`)
    ) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = deleting ? "Deleting..." : "Exporting...";
    try {
      const type = deleting
        ? "rapp-beta-delete-agent"
        : "rapp-beta-export-agent";
      const response = await requestParent(type, filename);
      if (!response.ok) throw new Error(response.error || "Agent action failed.");
      if (deleting) {
        await loadAgentsList();
      } else if (!response.result?.canceled) {
        window.alert(\`Exported \${filename} to \${response.result.path}\`);
      }
    } catch (error) {
      window.alert(
        (deleting ? "Delete failed: " : "Export failed: ")
        + String(error?.message || error)
      );
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }, true);
  return true;
})()`;

function frameBridgeInstallationSource() {
  const checkpointSource = `window.__rappBetaChatLookConfig = ${JSON.stringify({
    chatLook,
    chatTypingEnabled,
  })};\n${BETA_FRAME_BRIDGE_SOURCE}`;
  const bridgeSource = composeDimensionTilesFrameBridgeSource(checkpointSource, viewMode);
  return createFrameBridgeInstallationSource({
    autopilotSource: autopilotInstallationSource(),
    brandingSource: openRappterBrandingSource,
    bridgeSource,
  });
}
const copilot = new CopilotRuntime({
  tokenFile: path.join(config.brainstemDir, ".copilot_token"),
  workingDirectory: config.brainstemDir,
});
const copilotStudioAuth = new CopilotStudioAuthManager();

let mainWindow = null;
let shutdownStarted = false;
let shutdownComplete = false;
let updateCheckInFlight = false;
let updateMenuItem = null;
let availableUpdate = null;
let uiDriver = null;
let openRappterChatEndpoint = null;
let e2eStopTimer = null;
// One GitHub Copilot Rappter Surgeon SDK session per chat tab, keyed by the id the
// renderer assigns. All share one runtime, one route manager, and one visible
// Brainstem — "several agents, one brainstem" — and every event they emit is
// tagged with its sessionId so the renderer routes it to the right tab/tile.
const rappterSurgeons = new Map();
const completedBrainstemRequests = new Set();
const completedBrainstemRequestOrder = [];
const chatLeaseRegistry = new Set();
const MAX_BRAIN_SURGEONS = 12;

const state = {
  neighborhood,
  estate: {
    estate_id: neighborhood.estate_id,
    neighborhood_count: 1,
  },
  viewMode,
  viewModeOverridden,
  arenaLayout: arenaLayoutState.layout,
  arenaLayoutError: arenaLayoutState.error,
  chatLook,
  chatLookOverridden,
  chatTypingEnabled,
  brainstem: { phase: "starting", message: "Starting shared Brainstem..." },
  copilot: { phase: "starting", message: "Connecting bundled Copilot CLI..." },
  surgeon: {
    phase: "starting",
    message: "Preparing GitHub Copilot Agent mode...",
  },
  uiDriver: { phase: "starting", message: "Preparing visible AI controls..." },
  update: {
    phase: "idle",
    message: "Check GitHub for the latest OpenRappter.",
  },
  url: config.url,
};
let navigatorLocation = null;
let approximateLocation = null;
let locationUnavailableReason = null;
let locationLookupRevision = 0;
let ambientDeviceTimer = null;
let ambientManifestTimer = null;

function refreshAmbientDevice() {
  return ambient?.refreshDevice({
    approximateLocation,
    navigatorLocation,
    settings: readAmbientSettings({ betaHome }),
    unavailableReason: locationUnavailableReason,
  });
}

function ambientState() {
  return {
    device: ambient?.readProvider("device") || null,
    deviceEnabled: ambient?.deviceEnabled === true,
    settings: readAmbientSettings({ betaHome }),
  };
}

async function handleGeolocationUpdate(payload = {}) {
  const revision = ++locationLookupRevision;
  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  const validFix = Number.isFinite(lat)
    && lat >= -90
    && lat <= 90
    && Number.isFinite(lon)
    && lon >= -180
    && lon <= 180;
  if (validFix) {
    const reportedAt = Date.parse(payload.at || "");
    const now = Date.now();
    navigatorLocation = {
      accuracy_m: Number.isFinite(Number(payload.accuracy_m))
        ? Math.max(0, Number(payload.accuracy_m))
        : null,
      at: Number.isFinite(reportedAt) && reportedAt <= now + 60000
        ? new Date(reportedAt).toISOString()
        : new Date(now).toISOString(),
      label: payload.label ? String(payload.label).slice(0, 160) : null,
      lat,
      lon,
    };
    approximateLocation = null;
    locationUnavailableReason = null;
    return ambientStateAfterRefresh();
  }

  navigatorLocation = null;
  locationUnavailableReason = String(
    payload.reason || "navigator.geolocation unavailable",
  ).slice(0, 160);
  const settings = readAmbientSettings({ betaHome });
  if (
    ambient?.deviceEnabled === true
    && settings.granularity !== "off"
    && !settings.userLocation
    && settings.approximateFallback
  ) {
    try {
      const resolved = await lookupApproximateLocation({
        fetchImpl: typeof net?.fetch === "function"
          ? (url, options) => net.fetch(url, options)
          : globalThis.fetch,
        signal: AbortSignal.timeout(5000),
      });
      if (revision === locationLookupRevision) {
        approximateLocation = {
          ...resolved,
          at: new Date().toISOString(),
        };
      }
    } catch (error) {
      if (revision === locationLookupRevision) {
        approximateLocation = null;
        locationUnavailableReason += `; approximate fallback failed: ${
          String(error?.message || error).slice(0, 100)
        }`;
      }
    }
  }
  return ambientStateAfterRefresh();
}

function ambientStateAfterRefresh() {
  refreshAmbientDevice();
  return ambientState();
}

function refreshAmbientBeforeTurn() {
  const device = refreshAmbientDevice();
  if (!device) ambient?.refreshManifest();
  return ambientState();
}

function allowsAmbientGeolocation(webContents) {
  const settings = readAmbientSettings({ betaHome });
  return ambient?.deviceEnabled === true
    && settings.granularity !== "off"
    && webContents === mainWindow?.webContents;
}

function handleAmbientSettingsUpdate(payload = {}) {
  const settings = writeAmbientSettings({
    approximateFallback: payload.approximateFallback === true,
    betaHome,
    granularity: payload.granularity,
    userLocation: payload.userLocation || null,
  });
  if (
    settings.granularity === "off"
    || settings.userLocation
  ) {
    locationLookupRevision += 1;
    navigatorLocation = null;
    approximateLocation = null;
    locationUnavailableReason = settings.granularity === "off"
      ? "location disabled"
      : null;
  } else if (!settings.approximateFallback) {
    approximateLocation = null;
  }
  return ambientStateAfterRefresh();
}

ledger?.setOnWrite((_row, currentLedger) => {
  ambient?.refreshLedger(currentLedger.describe());
});
ambient?.refreshLedger(ledger?.describe() || {});
refreshAmbientBeforeTurn();

const routeManager = new BetaRouteManager({
  betaHome,
  brainstemConfig: config,
  ledger,
  onActivate: async (route) => {
    state.url = route.url;
    state.brainstem = {
      phase: "ready",
      message: `Routed Brainstem v${route.health.version}`,
      callerRappid: route.callerRappid,
      memoryGuid: route.memoryGuid,
      stackRappid: route.stackRappid,
      compositionHash: route.transientCompositionHash || route.compositionHash,
    };
    emitState();
  },
});

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("beta:state", structuredClone(state));
  }
}

function syncChatLookMenu() {
  const menu = Menu.getApplicationMenu();
  for (const look of ["messages", "business"]) {
    const item = menu?.getMenuItemById(`chat-look-${look}`);
    if (item) item.checked = chatLook === look;
  }
}

function syncAgentArenaMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById(
    "agent-arena",
  );
  if (item) item.checked = viewMode.mode === "arena";
}

function applyEffectiveChatLook(value) {
  chatLook = value.chatLook;
  chatLookOverridden = value.chatLookOverridden;
  chatTypingEnabled = chatStreamMode === "hold";
  state.chatLook = chatLook;
  state.chatLookOverridden = chatLookOverridden;
  state.chatTypingEnabled = chatTypingEnabled;
  syncChatLookMenu();
  emitState();
}

async function applyChatLookToFrame() {
  const frame = mainWindow?.webContents.mainFrame.framesInSubtree.find(
    (candidate) => loopbackUrl(candidate.url),
  );
  if (!frame) return { installed: false };
  await frame.executeJavaScript(frameBridgeInstallationSource(), true);
  return { installed: true };
}

async function handleChatLookChange(nextLook) {
  const value = changeChatLook({
    apply: applyEffectiveChatLook,
    betaHome,
    chatLook: nextLook,
    env: process.env,
  });
  await applyChatLookToFrame();
  return structuredClone(value);
}

function requestChatLookChange(nextLook) {
  void handleChatLookChange(nextLook).catch((error) => {
    console.error(`Could not change chat look to ${nextLook}:`, error);
  });
}

function applyEffectiveViewMode(value) {
  arenaLayoutState = resolveCustomLayout(value.viewMode);
  viewMode = value.viewMode;
  viewModeOverridden = value.viewModeOverridden;
  state.viewMode = viewMode;
  state.viewModeOverridden = viewModeOverridden;
  state.arenaLayout = arenaLayoutState.layout;
  state.arenaLayoutError = arenaLayoutState.error;
  syncAgentArenaMenu();
  emitState();
}

async function handleCustomArenaLayoutLoad() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Load a custom Agent Arena layout",
    buttonLabel: "Load layout",
    filters: [{ name: "Agent Arena layout JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (selection.canceled || !selection.filePaths[0]) {
    return { canceled: true };
  }
  const loaded = readCustomLayout(selection.filePaths[0]);
  const settings = await handleViewModeChange({
    layout: "custom",
    customLayoutPath: loaded.file,
  });
  return {
    canceled: false,
    ...settings,
    arenaLayout: loaded.layout,
  };
}

async function handleViewModeChange(next) {
  const leavingTileView = viewMode.mode === "arena" && next?.mode === "herd";
  if (leavingTileView) {
    const primary = dimensionTileStore.list().find((tile) => (
      tile.status === "primary"
    ));
    if (primary) dimensionTileStore.parkExisting(primary.id);
  }
  const value = changeViewModeSettings({
    apply: applyEffectiveViewMode,
    viewMode: next,
    betaHome,
    env: process.env,
  });
  await applyChatLookToFrame();
  if (leavingTileView) await routeManager.startBlank();
  return structuredClone(value);
}

function requestViewModeChange(next) {
  void handleViewModeChange(next).catch((error) => {
    console.error("Could not change the herd view mode:", error);
  });
}

async function executeComposerControl(message) {
  const command = parseViewModeCommand(message);
  if (command) {
    await handleViewModeChange({ mode: command.mode });
    return {
      action: command.action,
      intercepted: true,
      reply: command.mode === "arena"
        ? "Agent Arena — parked conversations compete side by side."
        : "Herd mode is on.",
      url: state.url,
    };
  }
  return executeLineageCommand({
    message,
    routeManager,
    env: process.env,
  });
}

function emitSurgeonEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("beta:surgeon-event", structuredClone(event));
  }
}

// rapplication twins — specialized rapplications hatched from the RAPP Store as
// concurrent long-lived workers on their own loopback ports, beside the
// Brainstem chats in the herd. Kernel unchanged; driven only over /chat.
// RAR library source selection: AIBAST (default) / public RAR / a custom
// RAR-compliant catalog URL. Persisted per install; the active client backs
// BOTH the store browser and twin hatching. `rappStore` is a stable facade so
// everything that holds a reference follows the toggle.
const storeSourceFile = path.join(betaHome, "store-source.json");
function loadStoreSource() {
  try {
    const saved = JSON.parse(readFileSync(storeSourceFile, "utf8"));
    if (saved && isAllowedStoreSourceUrl(saved.url)) return saved;
  } catch { /* first run */ }
  return { key: "aibast", url: STORE_SOURCES.aibast.url };
}
let storeSource = loadStoreSource();
// Chromium's network stack (net.fetch) honors the system / enterprise proxy
// configuration the way the rest of the desktop does; Node's global fetch
// does not read HTTP(S)_PROXY at all, which made Store browsing, acquisition,
// and hatching fail on proxy-only networks where the installer had succeeded.
const storeFetch = typeof net?.fetch === "function"
  ? (url, init) => net.fetch(url, init)
  : globalThis.fetch;
let activeStoreClient = new RappStoreClient({ url: storeSource.url, fetchImpl: storeFetch });
function setStoreSource({ key, url }) {
  const target = STORE_SOURCES[key]?.url || url;
  // https everywhere — with a loopback exception so a local-first / air-gapped
  // RAR served on this machine works (never plain http to another host).
  if (!isAllowedStoreSourceUrl(target)) {
    throw new Error("A RAR source must be an https catalog URL (or http on this machine's loopback).");
  }
  storeSource = { key: STORE_SOURCES[key] ? key : "custom", url: target };
  activeStoreClient = new RappStoreClient({ url: target, fetchImpl: storeFetch });
  try { writeFileSync(storeSourceFile, JSON.stringify(storeSource, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  return { ...storeSource };
}
const rappStore = {
  list: (...a) => activeStoreClient.list(...a),
  load: (...a) => activeStoreClient.load(...a),
  resolve: (...a) => activeStoreClient.resolve(...a),
  download: (...a) => activeStoreClient.download(...a),
};

// Install a sha-verified agent.py through the routed composition gate. The
// candidate must dry-load before the stack changes, then startDefault swaps the
// worker atomically so a rejected store artifact never lands in AGENTS_PATH.
async function installAgentToBrainstem(storeId) {
  const cartridge = await rappStore.download(storeId);   // fail-closed sha256
  const filename = cartridge.filename && cartridge.filename.endsWith(".py")
    ? cartridge.filename
    : `${String(storeId).replace(/[^a-z0-9_]+/gi, "_")}_agent.py`;
  const installed = await routeManager.installScopedAgent({
    filename,
    origin: "store",
    source: cartridge.source,
  });
  const route = await routeManager.startDefault();
  const savedName = installed.agent.filename;
  return {
    ok: true,
    filename: savedName,
    requested: filename,
    agent: savedName,
    sha256: cartridge.sha256,
    persisted: "active stack (scoped install)",
    active_route: route,
  };
}
const twinManager = new TwinManager({
  brainstemConfig: config,
  betaHome,
  ledger,
  refreshAmbient: refreshAmbientBeforeTurn,
  routeManager,
  storeClient: rappStore,
  // The Brainstem that plans a two-brain loop is whichever one is live now
  // (config URL, or a routed Brainstem once a route activates).
  brainstemUrl: () => state.url,
  onEvent: (event) => {
    if (event.type === "twin-needs-auth") notifyTwinNeedsAuth(event);
    queueMicrotask(() => syncNeighborhoodEstate());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "beta:twin-event",
        structuredClone(redactSensitiveValue(event)),
      );
    }
  },
});

function syncNeighborhoodEstate() {
  const neighborhoods = [{
    kind: "root",
    neighborhood_id: neighborhood.root_neighborhood_id,
    name: neighborhood.instance_name,
    rappid: null,
  }, ...twinManager.list().map((twin) => ({
    kind: "resident",
    neighborhood_id: `${neighborhood.estate_id}:resident:${twin.rappid}`,
    name: twin.name,
    rappid: twin.rappid,
    status: twin.status,
  }))];
  ensureNeighborhoodManifest(betaHome, neighborhood, { neighborhoods });
  state.estate = {
    estate_id: neighborhood.estate_id,
    neighborhood_count: neighborhoods.length,
  };
  emitState();
}

// Twins pause at the one user-owned auth step (e.g. PAC device login). If the
// user is multitasking off the window they must still know a twin needs them —
// so we raise a native OS notification, and clicking it focuses the window and
// pops open the auth page in the user's own browser (identity auth is completed
// in their real session; the app never captures credentials).
const twinAuthPrompts = new Map();   // twinId -> { url, code, note }
const twinPopoutOwners = new Map();  // webContents.id -> twinId

function parseAuthPrompt(message) {
  const text = String(message || "");
  const url = (text.match(/https?:\/\/[^\s"')]+/) || [])[0]
    || (/devicelogin|device code|microsoft/i.test(text) ? "https://microsoft.com/devicelogin" : null);
  const code = (text.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/) || [])[0] || null;
  return { url, code };
}

function openExternalUrl(url) {
  const value = String(url || "");
  if (!/^https?:\/\//i.test(value)) throw new Error("Refusing to open a non-http(s) URL.");
  return shell.openExternal(value);
}

function notifyTwinNeedsAuth(event) {
  const twin = twinManager.list().find((t) => t.id === event.id);
  const name = twin?.name || event.id || "A rapplication twin";
  const { url, code } = parseAuthPrompt(event.message);
  twinAuthPrompts.set(event.id, { url, code, note: event.message });
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "A RAPP twin needs you to sign in",
    body: `${name} paused for authentication${code ? ` — code ${code}` : ""}. Click to continue.`,
    silent: false,
  });
  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send("beta:twin-focus", { id: event.id });
    }
    if (url) openExternalUrl(url).catch(() => {});
  });
  notification.show();
}

// Pop a twin's own UI out into a phone-sized window — "mobile-first" literally —
// so a rapplication is comfortable to use at a real small-screen size.
// Walk the main window's frame tree to find the iframe hosting a twin's UI
// (loaded from the twin's own loopback origin).
function findTwinFrame(twinUrl) {
  if (!mainWindow || mainWindow.isDestroyed() || !twinUrl) return null;
  const prefix = String(twinUrl).replace(/\/+$/, "");
  const walk = (frame) => {
    const url = String(frame.url || "");
    if (url === prefix || url.startsWith(prefix + "/") || url.startsWith(prefix + "?")) return frame;
    for (const child of frame.frames || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(mainWindow.webContents.mainFrame);
}

// Wipe the Grail chat in a twin's iframe and inject the rapplication's own
// static UI in its place. The iframe is loaded from the twin's own origin, so
// the injected UI's relative /chat hits the twin directly — no server, no proxy.
function autopilotInstallationSource() {
  return createAutopilotInstallationSource({
    capability: autopilotCapability,
    classicSource: autopilotClassicSource,
  });
}

function instrumentRappUi(html) {
  return createInstrumentedRappUi(html, {
    autopilotSource: autopilotInstallationSource(),
  });
}

const injectedFrames = new WeakSet();   // avoid re-injecting the same frame

async function injectFrameUi(frame, twinId) {
  if (injectedFrames.has(frame)) return { ok: true, already: true };
  const raw = twinManager.uiHtml(twinId);
  if (!raw) return { ok: false, reason: "no custom UI" };
  const html = instrumentRappUi(raw);
  injectedFrames.add(frame);
  await frame.executeJavaScript(
    `(() => { const html = ${JSON.stringify(html)}; document.open(); document.write(html); document.close(); return true; })()`,
    true,
  );
  await frame.executeJavaScript(
    createTwinLedgerBridgeSource({ sink: "parent", twinId }),
    true,
  );
  return { ok: true, instrumented: true };
}

async function injectTwinUi(twinId) {
  const twin = twinManager.list().find((t) => t.id === twinId);
  if (!twin?.url) throw new Error(`No twin ${twinId}.`);
  const frame = findTwinFrame(twin.url);
  if (!frame) throw new Error(`Twin ${twinId} UI frame is not loaded yet.`);
  return injectFrameUi(frame, twinId);
}

// The pop-out opens with full desktop space by default and can be switched to a
// narrow view. The builder carries its own declaration in the delivered bytes.
const VIEW_TOGGLE = createViewToggle;

function popOutTwin(id) {
  const twin = twinManager.list().find((t) => t.id === id);
  if (!twin?.url) throw new Error(`No twin ${id}.`);
  const startMobile = twin.preferredView === "mobile";
  const win = new BrowserWindow({
    // Use the real estate by default; resizable back down to a phone column.
    width: startMobile ? 460 : 1180,
    height: 860,
    minWidth: 380,
    minHeight: 480,
    title: twin.name || "rapplication",
    backgroundColor: "#0d1117",
    // Deliberately NOT a child of mainWindow. A parented window shares the
    // parent's fullscreen space on macOS, so taking the pop-out fullscreen took
    // over the Brainstem window and left it blank. A popped-out rapplication is
    // meant to be worked with on its own screen while the OpenRappter chat carries
    // on beside it, which requires a top-level window.
    webPreferences: {
      additionalArguments: [`--rapp-twin-id=${encodeURIComponent(id)}`],
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(dirname, "twin-preload.cjs"),
      sandbox: true,
    },
  });
  const popoutWebContentsId = win.webContents.id;
  twinPopoutOwners.set(popoutWebContentsId, id);
  win.on("closed", () => twinPopoutOwners.delete(popoutWebContentsId));
  win.setMenuBarVisibility(false);
  const raw = twinManager.uiHtml(id);
  const html = raw ? instrumentRappUi(raw) + VIEW_TOGGLE(startMobile) : null;
  win.webContents.on("did-finish-load", () => {
    void (async () => {
      if (html) {
        await win.webContents.executeJavaScript(
        `(() => { const h = ${JSON.stringify(html)}; document.open(); document.write(h); document.close(); return true; })()`,
        true,
        );
      }
      await win.webContents.executeJavaScript(
        createTwinLedgerBridgeSource({ sink: "preload", twinId: id }),
        true,
      );
    })().catch(() => {});
  });
  win.loadURL(`${twin.url}/?beta=1`);
  return { ok: true };
}

// P2: hatch the Copilot Studio Factory + Deploy pipeline onto its OWN twin, and
// kick its deploy loop asynchronously. The Rappter Surgeon (and the main Brainstem
// chat) stays free for other work while this twin drives PAC / Factory / Deploy
// on its own port — the deploy engine is unchanged, only WHERE it runs and WHO
// drives it (a twin loop, not the visible Brainstem). Draft-only; the one
// visible step is the user-owned PAC device login, which the twin surfaces.
const COPILOT_STUDIO_TWIN_AGENTS = [
  "rar_kody_w_factory_agent.py",
  "rar_kody_w_copilot_studio_parity_deploy_agent.py",
];
const COPILOT_STUDIO_TWIN_RESOURCES = [
  "hacker-news-memory-parity-cases.json",
  "industry-agent-matrix.json",
];

function readCopilotStudioResource(name) {
  const file = path.join(import.meta.dirname, "..", "resources", "copilot-studio", name);
  if (!existsSync(file)) throw new Error(`Bundled Copilot Studio resource is missing: ${file}`);
  return file;
}

async function hatchCopilotStudioTwin({ displayName = "Copilot Studio Draft", environment = null, agents = [] } = {}) {
  const agentSources = [];
  for (const filename of COPILOT_STUDIO_TWIN_AGENTS) {
    agentSources.push({ filename, source: readFileSync(readCopilotStudioResource(filename), "utf8") });
  }
  // Include the selected business/industry agents to deploy (from the active
  // composition), so the twin can build and parity-test them Draft-only.
  const active = routeManager.activeAgentFiles();
  for (const wanted of Array.isArray(agents) ? agents : []) {
    const match = active.find((a) => a.filename === wanted);
    if (match) {
      try {
        agentSources.push({ filename: match.filename, source: routeManager.readActiveAgent(match.filename) });
      } catch {
        // skip unreadable agent
      }
    }
  }
  const resources = COPILOT_STUDIO_TWIN_RESOURCES.map((name) => ({
    name,
    bytes: readFileSync(readCopilotStudioResource(name)),
  }));
  const parityCases = "hacker-news-memory-parity-cases.json";
  const instruction = [
    "You are a Copilot Studio deploy twin running on your own Brainstem worker.",
    "Deploy the loaded business/industry agent(s) to a Draft in Microsoft Copilot Studio",
    "using RappCopilotStudioFactoryBeta and CopilotStudioDeployBeta.",
    `Target display name: ${displayName}.`,
    environment ? `Target environment: ${environment}.` : "Ask which environment only if none is authenticated.",
    "Run doctor, then plan and build. If PAC is NOT authenticated to that environment,",
    "reply with exactly what PAC device login is required and STOP — do not guess credentials.",
    "Otherwise provision, push as DRAFT, run parity against the parity cases",
    `(${parityCases} in your working dir), and finalize.`,
    "DRAFT-ONLY: never call release or publish; publishing is the user's manual action.",
    "Never read or echo any client secret. Report the AgentId, environment, and the Copilot Studio Draft link.",
    "Say DONE when the Draft is ready.",
  ].join(" ");
  // Non-blocking: hatch + kick the loop; return immediately so the Surgeon is free.
  return twinManager.hatchLocal(
    {
      id: "copilot-studio-deploy",
      name: `Copilot Studio Deploy · ${displayName}`,
      agentSources,
      resources,
      license: "beta-bundled",
    },
    { instruction },
  );
}

// The loopback driver owns the one queue per visible frame. Sending every
// caller through that bus prevents Surgeon and hot-loaded Python commands from
// bypassing each other with competing cursors.
async function executeUiCommand(command) {
  if (!uiDriver?.metadataPath) {
    throw new Error("The visible Brainstem control bridge is not ready.");
  }
  const metadata = JSON.parse(readFileSync(uiDriver.metadataPath, "utf8"));
  const response = await fetch(
    `http://${metadata.host}:${metadata.port}/v1/command`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${metadata.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Visible UI command failed with HTTP ${response.status}.`);
  }
  return payload.result;
}

function normalizeSurgeonId(sessionId) {
  const id = Number.parseInt(sessionId, 10);
  return Number.isFinite(id) && id > 0 ? id : 1;
}

function recordBrainstemCompletion(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "A completed turn payload is required." };
  }
  const requestId = payload.requestId ? String(payload.requestId) : null;
  if (requestId && completedBrainstemRequests.has(requestId)) {
    return { duplicate: true, ok: true, tools: 0 };
  }
  const result = recordCompletedTurn(ledger, {
    agentLogs: String(payload.agentLogs || ""),
    model: payload.model ? String(payload.model) : null,
    requestId,
    response: String(payload.response || ""),
    sessionId: payload.sessionId ? String(payload.sessionId) : null,
    surface: "brainstem",
    userInput: String(payload.userInput || ""),
  });
  if (requestId && result.turns.length === 2) {
    completedBrainstemRequests.add(requestId);
    completedBrainstemRequestOrder.push(requestId);
    if (completedBrainstemRequestOrder.length > 1000) {
      completedBrainstemRequests.delete(completedBrainstemRequestOrder.shift());
    }
  }
  return {
    ok: result.turns.length === 2,
    tools: result.tools.length,
  };
}

function recordTwinCompletion(twinId, payload) {
  const twin = twinManager.get(String(twinId || ""));
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "A completed twin turn payload is required." };
  }
  if (payload.settledOnly === true) {
    return {
      molts: twinManager.mirrorMolts(twin).length,
      ok: true,
      settledOnly: true,
      tools: 0,
    };
  }
  const result = recordCompletedTurn(ledger, {
    agentLogs: String(payload.agentLogs || ""),
    model: payload.model ? String(payload.model) : null,
    requestId: payload.requestId ? String(payload.requestId) : null,
    response: String(payload.response || ""),
    sessionId: payload.sessionId
      ? String(payload.sessionId)
      : `twin-ui-${twin.id}`,
    surface: `twin:${twin.id}`,
    userInput: String(payload.userInput || ""),
  });
  const molts = twinManager.mirrorMolts(twin);
  return {
    molts: molts.length,
    ok: result.turns.length === 2,
    tools: result.tools.length,
  };
}

function ownedTwinForSender(event) {
  const ownedTwinId = twinPopoutOwners.get(event.sender.id);
  if (!ownedTwinId) return null;
  const twin = twinManager.get(ownedTwinId);
  if (
    new URL(event.senderFrame.url).origin
    !== new URL(twin.url).origin
  ) {
    throw new Error("Twin sender left its loopback origin.");
  }
  return ownedTwinId;
}

function ensureRappterSurgeon(sessionId = 1) {
  const id = normalizeSurgeonId(sessionId);
  let surgeon = rappterSurgeons.get(id);
  if (!surgeon) {
    if (rappterSurgeons.size >= MAX_BRAIN_SURGEONS) {
      throw new Error(
        `You have ${MAX_BRAIN_SURGEONS} Copilot chats open — close one before opening another.`,
      );
    }

    surgeon = new RappterSurgeon({
      runtime: copilot,
      brainstemUrl: config.url,
      chatLeaseRegistry,
      checkForUpdates: () => handleCheckForUpdates({ openPanel: true }),
      copilotStudioAuth,
      routeManager,
      uiCommand: executeUiCommand,
      twins: {
        hatch: (storeId, instruction) => twinManager.hatch(storeId, { instruction: instruction || null }),
        list: () => twinManager.list(),
        list_store: () => rappStore.list(),
        summon_dogg: (summonsFull, storeId, instruction) => (
          summonDoggNeighborhood({
            instruction,
            storeId,
            summonsFull,
            twinManager,
          })
        ),
        loop: (id, goal) => { twinManager.loop(id, goal).catch(() => {}); return { ok: true, looping: id }; },
        deploy_copilot_studio: (opts) => hatchCopilotStudioTwin(opts || {}),
        open_auth: (opts) => {
          const url = opts?.url || (opts?.id && twinAuthPrompts.get(opts.id)?.url);
          if (!url) throw new Error("No auth URL to open.");
          return openExternalUrl(url).then(() => ({ ok: true, opened: url }));
        },
      },
      onEvent: (event) => emitSurgeonEvent({ ...event, sessionId: id }),
    });
    rappterSurgeons.set(id, surgeon);
  }
  return surgeon;
}

function loopbackUrl(raw) {
  try {
    const url = new URL(raw);
    const allowedHost = ["127.0.0.1", "localhost"].includes(url.hostname);
    const active = new URL(state.url);
    return (
      allowedHost
      && url.protocol === active.protocol
      && url.hostname === active.hostname
      && Number(url.port || 80) === Number(active.port || 80)
    );
  } catch {
    return false;
  }
}

function externalUrl(raw) {
  try {
    const url = new URL(raw);
    return ["https:", "vscode:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function routeMainNavigation(event, raw) {
  if (!raw || raw === "about:blank" || raw === uiUrl) return;
  event.preventDefault();
  if (externalUrl(raw)) void shell.openExternal(raw);
}

// A twin runs its own Brainstem worker on its own loopback port, and its UI is
// shown in a herd-tile iframe — so twin worker URLs are allowed to load in
// (sub)frames, alongside the active Brainstem. Both are loopback-only.
function isTwinFrameUrl(raw) {
  // Twin workers each run on their own loopback port and are shown in herd-tile
  // iframes. The kernel trust boundary and the page CSP already confine
  // everything to loopback, so any 127.0.0.1/localhost subframe is allowed
  // (this covers every twin worker without racing tile creation).
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

// A driven run must not take the screen from the person using this machine. The
// window stays real — a never-shown window makes the renderer behave differently
// and stops the run being a proof — but it is shown WITHOUT activating the app,
// so focus stays wherever the person put it. This is the two-player law applied
// to the whole application: automation works in the window without taking it.
const drivenRun = process.env.BRAINSTEM_BETA_E2E === "1";

function presentWindow(window, { focus = true } = {}) {
  if (!window || window.isDestroyed()) return;
  if (drivenRun) {
    window.showInactive();
    return;
  }
  window.show();
  if (focus) window.focus();
}

function routeFrameNavigation(details) {
  const raw = details?.url;
  if (!raw || raw === "about:blank") return;
  if (details.isMainFrame) {
    if (raw !== uiUrl) {
      details.preventDefault();
      if (externalUrl(raw)) void shell.openExternal(raw);
    }
    return;
  }
  if (loopbackUrl(raw) || isTwinFrameUrl(raw)) return;   // active Brainstem OR a twin worker
  details.preventDefault();
  if (externalUrl(raw)) void shell.openExternal(raw);
}

function assertTrustedIpc(event) {
  if (
    !mainWindow
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || event.senderFrame.url !== uiUrl
  ) {
    throw new Error("Rejected IPC from an untrusted frame.");
  }
}

function createWindow() {
  const headless = process.env.BRAINSTEM_BETA_HEADLESS === "1";
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: openRappterWindowTitle,
    backgroundColor: "#0d1117",
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(dirname, "preload.cjs"),
      additionalArguments: [
        `--rapp-chat-stream=${chatStreamMode}`,
        `--rapp-chat-look=${chatLook}`,
        `--rapp-view-mode=${
          Buffer.from(JSON.stringify(viewMode)).toString("base64url")
        }`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", routeMainNavigation);
  win.webContents.on("will-frame-navigate", routeFrameNavigation);
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    void win.webContents.mainFrame.executeJavaScript(
      autopilotInstallationSource(),
      true,
    ).catch((error) => {
      console.error("Could not install RAPP Autopilot in the shell:", error);
    });
  });
  win.on("closed", () => {
    mainWindow = null;
  });
  void win.loadFile(uiFile);
  if (!headless) presentWindow(win);
  return win;
}

function shortCommit(commit) {
  return commit.slice(0, 8);
}

function openUpdatePanel() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("beta:open-update");
  }
}

function setUpdateState(update) {
  state.update = update;
  emitState();
  return structuredClone(update);
}

async function handleCheckForUpdates({ openPanel = false } = {}) {
  if (openPanel) openUpdatePanel();
  if (updateCheckInFlight) return structuredClone(state.update);
  updateCheckInFlight = true;
  if (updateMenuItem) updateMenuItem.enabled = false;
  availableUpdate = null;
  setUpdateState({
    phase: "checking",
    message: "Checking GitHub for updates...",
  });

  try {
    const update = await checkForUpdates({
      packageDir,
      env: process.env,
    });
    if (!update.published) {
      return setUpdateState({
        phase: "current",
        message: `No OpenRappter update is published on ${update.updateRef} yet.`,
        detail: `This source build remains on ${update.currentVersion} `
          + `(${shortCommit(update.currentCommit)}). The latest repository commit `
          + `(${shortCommit(update.latestCommit)}) has no beta/VERSION manifest.`,
        source: `${update.repository}@${update.updateRef}`,
      });
    }
    if (!update.available) {
      if (update.channelBehind) {
        return setUpdateState({
          phase: "current",
          message: "This build is ahead of its update channel.",
          detail: `Installed ${update.currentVersion} (${shortCommit(update.currentCommit)}); `
            + `the channel serves ${update.latestVersion} (${shortCommit(update.latestCommit)}). `
            + "Nothing to install.",
          source: `${update.repository}@${update.updateRef}`,
        });
      }
      if (!update.releasePublished) {
        return setUpdateState({
          phase: "current",
          message: `OpenRappter ${update.latestVersion} is staged on ${update.updateRef} but not released.`,
          detail: `${update.releaseProblem}\n`
            + `Installed ${update.currentVersion} (${shortCommit(update.currentCommit)}); `
            + `channel head ${shortCommit(update.channelCommit)}.`,
          source: `${update.repository}@${update.updateRef}`,
          guidance: "Only the commit behind the annotated release tag is ever installed "
            + "(RELEASING.md §2). Nothing to do until the release is tagged.",
        });
      }
      return setUpdateState({
        phase: "current",
        message: "OpenRappter is up to date.",
        detail: `Version ${update.currentVersion} (${shortCommit(update.currentCommit)}), `
          + `the released commit behind ${update.releaseTag}.`,
        source: `${update.repository}@${update.updateRef}`,
      });
    }

    if (update.dirty) {
      return setUpdateState({
        phase: "blocked",
        message: "An update is available, but local launcher changes block it.",
        detail: `Installed ${update.currentVersion} (${shortCommit(update.currentCommit)}); `
          + `available ${update.latestVersion} (${shortCommit(update.latestCommit)}).`,
        source: `${update.repository}@${update.updateRef}`,
        guidance: `Preserve or discard the changes in ${update.repoRoot}, then check again.`,
      });
    }

    availableUpdate = update;
    return setUpdateState({
      phase: "available",
      message: update.sameVersion
        ? `OpenRappter ${update.latestVersion} can be re-aligned to its released commit.`
        : `OpenRappter ${update.latestVersion} is available.`,
      detail: `Installed ${update.currentVersion} (${shortCommit(update.currentCommit)}); `
        + `released ${update.latestVersion} (${shortCommit(update.latestCommit)}, ${update.releaseTag}).`,
      source: `${update.repository}@${update.updateRef}`,
      guidance: "Update and Restart refreshes the launcher and shared Brainstem "
        + "from the release tag's exact commit. If the install fails, the "
        + "previous version is restored automatically.",
    });
  } catch (error) {
    return setUpdateState({
      phase: "error",
      message: "OpenRappter could not check for updates.",
      detail: String(error.message || error),
    });
  } finally {
    updateCheckInFlight = false;
    if (updateMenuItem && !shutdownStarted) updateMenuItem.enabled = true;
  }
}

async function handleInstallUpdate() {
  if (!availableUpdate) {
    return setUpdateState({
      phase: "error",
      message: "No ready update is available.",
      detail: "Check for updates again before installing.",
    });
  }
  const update = availableUpdate;
  setUpdateState({
    phase: "applying",
    message: `Installing OpenRappter ${update.latestVersion}...`,
    detail: "The app will close, run the pinned installer, and reopen.",
  });
  try {
    await prepareUpdate({
      update,
      brainstemHome: config.brainstemHome,
      env: process.env,
    });
    app.quit();
    return structuredClone(state.update);
  } catch (error) {
    return setUpdateState({
      phase: "error",
      message: "OpenRappter could not start the update.",
      detail: String(error.message || error),
    });
  }
}

function installApplicationMenu() {
  const checkForUpdatesItem = {
    id: "check-for-updates",
    label: "Check for Updates...",
    accelerator: "CmdOrCtrl+Shift+U",
    click: () => void handleCheckForUpdates({ openPanel: true }),
  };
  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
  const chatLookMenu = {
    label: "Chat Look",
    submenu: [
      {
        id: "chat-look-messages",
        label: "Messages",
        type: "radio",
        checked: chatLook === "messages",
        click: () => requestChatLookChange("messages"),
      },
      {
        id: "chat-look-business",
        label: "Business",
        type: "radio",
        checked: chatLook === "business",
        click: () => requestChatLookChange("business"),
      },
      { type: "separator" },
      {
        id: "agent-arena",
        label: "Agent Arena",
        type: "checkbox",
        checked: viewMode.mode === "arena",
        click: () => requestViewModeChange({
          mode: viewMode.mode === "arena" ? "herd" : "arena",
        }),
      },
    ],
  };
  const viewMenu = {
    label: "View",
    submenu: [
      chatLookMenu,
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const template = process.platform === "darwin"
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            checkForUpdatesItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        editMenu,
        viewMenu,
        { role: "windowMenu" },
      ]
    : [
        { label: "File", submenu: [{ role: "quit" }] },
        editMenu,
        viewMenu,
        { role: "windowMenu" },
        { label: "Help", submenu: [checkForUpdatesItem] },
      ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  updateMenuItem = Menu.getApplicationMenu()?.getMenuItemById(
    "check-for-updates",
  );
  syncChatLookMenu();
  syncAgentArenaMenu();
}

function loadPendingUpdateResult() {
  let result;
  try {
    result = consumeUpdateResult({ packageDir, env: process.env });
  } catch (error) {
    result = {
      success: false,
      error: `The update result could not be read: ${String(error.message || error)}`,
    };
  }
  if (!result) return;

  if (result.success) {
    state.update = {
      phase: "success",
      message: `OpenRappter updated to ${result.latestVersion}.`,
      detail: `Installed commit: ${shortCommit(result.commit)}\n`
        + "The launcher and shared Brainstem source were refreshed.",
    };
    return;
  }

  const rollback = result.rollback || null;
  const restored = Boolean(rollback?.success);
  let rollbackDetail = "No rollback was possible.";
  if (restored) {
    rollbackDetail = `Restored the previous version at ${shortCommit(rollback.commit)}.`;
  } else if (rollback?.attempted) {
    rollbackDetail = `Rolling back to ${shortCommit(rollback.commit)} also failed: ${
      rollback.error || "unknown error"
    }`;
  } else if (rollback?.error) {
    rollbackDetail = rollback.error;
  }
  state.update = {
    phase: "error",
    message: restored
      ? "The update failed; the previous version was restored."
      : "OpenRappter could not finish the update.",
    detail: `${result.error || "Unknown updater error."}\n\n${rollbackDetail}\n\nLog: ${
      result.logPath || "unavailable"
    }`,
    ...(restored
      ? {}
      : { guidance: "Re-run the OpenRappter installer to repair this install." }),
  };
}

function registerIpc() {
  ipcMain.handle("beta:get-state", (event) => {
    assertTrustedIpc(event);
    return structuredClone(state);
  });
  ipcMain.handle("beta:set-chat-look", async (event, nextLook) => {
    assertTrustedIpc(event);
    return handleChatLookChange(nextLook);
  });
  ipcMain.handle("beta:get-ambient-settings", (event) => {
    assertTrustedIpc(event);
    return ambientState();
  });
  ipcMain.handle("beta:refresh-ambient", (event) => {
    const ownedTwinId = ownedTwinForSender(event);
    if (!ownedTwinId) {
      assertTrustedIpc(event);
      return refreshAmbientBeforeTurn();
    }
    refreshAmbientBeforeTurn();
    return { ok: true };
  });
  ipcMain.handle("beta:set-ambient-settings", (event, payload) => {
    assertTrustedIpc(event);
    return handleAmbientSettingsUpdate(payload);
  });
  ipcMain.handle("beta:update-geolocation", async (event, payload) => {
    assertTrustedIpc(event);
    return handleGeolocationUpdate(payload);
  });
  ipcMain.handle("beta:set-view-mode", async (event, next) => {
    assertTrustedIpc(event);
    return handleViewModeChange(next || {});
  });
  ipcMain.handle("beta:openrappter-tile-describe", (event) => {
    assertTrustedIpc(event);
    return openRappterTileStore.describe();
  });
  ipcMain.handle("beta:openrappter-tile-export", async (event) => {
    assertTrustedIpc(event);
    const description = openRappterTileStore.describe();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export this OpenRappter tile",
      defaultPath: `OpenRappter-${description.content_hash.slice(0, 12)}${OPENRAPPTER_TILE_EXTENSION}`,
      filters: [{
        name: "OpenRappter tile",
        extensions: ["tile"],
      }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const target = result.filePath.endsWith(OPENRAPPTER_TILE_EXTENSION)
      ? result.filePath
      : `${result.filePath}${OPENRAPPTER_TILE_EXTENSION}`;
    return {
      canceled: false,
      ...openRappterTileStore.exportTile(target),
    };
  });
  ipcMain.handle("beta:openrappter-tile-import", async (event) => {
    assertTrustedIpc(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import an OpenRappter tile",
      properties: ["openFile"],
      filters: [{
        name: "OpenRappter tile",
        extensions: ["tile"],
      }],
    });
    const file = result.filePaths?.[0];
    if (result.canceled || !file) return { canceled: true };
    return {
      canceled: false,
      ...openRappterTileStore.importTile(file),
    };
  });
  ipcMain.handle("beta:openrappter-tile-backup", (event) => {
    assertTrustedIpc(event);
    return {
      file: openRappterTileStore.backup(),
      ...openRappterTileStore.describe(),
    };
  });
  ipcMain.handle("beta:organism-egg-export", async (event, request = {}) => {
    assertTrustedIpc(event);
    const mode = request.mode === "sealed-backup" ? "sealed-backup" : "portable";
    const result = await dialog.showSaveDialog(mainWindow, {
      title: mode === "sealed-backup"
        ? "Create a sealed OpenRappter backup"
        : "Export a portable OpenRappter organism",
      defaultPath: `OpenRappter-${mode}-${new Date().toISOString().slice(0, 10)}.egg`,
      filters: [{ name: "OpenRappter organism egg", extensions: ["egg"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const file = result.filePath.endsWith(".egg")
      ? result.filePath
      : `${result.filePath}.egg`;
    return {
      canceled: false,
      ...await organismEggAdapter.export(file, {
        mode,
        includeHistory: request.includeHistory === true,
        includeMedia: request.includeMedia === true,
        passphrase: String(request.passphrase || ""),
      }),
    };
  });
  ipcMain.handle("beta:organism-egg-preview", async (event, request = {}) => {
    assertTrustedIpc(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Inspect and preview an OpenRappter organism egg",
      properties: ["openFile"],
      filters: [{ name: "OpenRappter organism egg", extensions: ["egg"] }],
    });
    const file = result.filePaths?.[0];
    if (result.canceled || !file) return { canceled: true };
    const passphrase = String(request.passphrase || "");
    const inspection = await organismEggAdapter.inspect(file, {
      ...(passphrase ? { passphrase } : {}),
    });
    const preview = inspection.decrypted
      ? await organismEggAdapter.preview(file, {
          semantics: request.semantics === "clone" ? "clone" : "restore",
          ...(passphrase ? { passphrase } : {}),
        })
      : null;
    return { canceled: false, file, inspection, preview };
  });
  ipcMain.handle("beta:organism-egg-apply", async (event, request = {}) => {
    assertTrustedIpc(event);
    if (
      !request.file
      || !/^[0-9a-f]{64}$/.test(String(request.approval || ""))
      || !String(request.passphrase || "")
    ) {
      throw new Error("Apply requires a preview-bound approval and rollback passphrase.");
    }
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Apply verified restore"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Apply organism egg?",
      message: `Restore ${request.changed || 0} verified changes to ${request.targetRappid || "this organism"}?`,
      detail: `Egg ${String(request.eggDigest || "").slice(0, 16)}…\nA sealed rollback egg will be created first. Imported agents remain asleep until restart.`,
    });
    if (confirmation.response !== 1) return { canceled: true };
    return {
      canceled: false,
      ...await organismEggAdapter.apply(String(request.file), {
        semantics: request.semantics === "clone" ? "clone" : "restore",
        approval: String(request.approval),
        passphrase: String(request.passphrase),
      }),
    };
  });
  ipcMain.handle("beta:rappter-pack-status", async (event) => {
    assertTrustedIpc(event);
    if (!existsSync(rappterPackConfigPath)) {
      return {
        configured: false,
        config: rappterPackConfigPath,
        guidance: "Copy resources/rappter-pack/config.example.json to ~/.openrappter/pack.json.",
      };
    }
    const pack = validatePackConfig(JSON.parse(
      readFileSync(rappterPackConfigPath, "utf8"),
    ));
    const nodes = await Promise.all(pack.nodes.map(async (node) => {
      try {
        const result = await dispatchPackNode(node, {
          action: "health",
          case_id: "status",
        });
        return {
          id: node.id,
          machine: node.machine,
          kind: node.kind,
          ok: packNodeReady(result),
          http_status: result.http_status,
          refused: result.refused === true,
          duration_ms: result.duration_ms,
        };
      } catch (error) {
        return {
          id: node.id,
          machine: node.machine,
          kind: node.kind,
          ok: false,
          error: String(error?.message || error),
        };
      }
    }));
    return {
      configured: true,
      pack_id: pack.pack_id,
      nodes,
    };
  });
  ipcMain.handle("beta:rappter-pack-run", async (event) => {
    assertTrustedIpc(event);
    if (!existsSync(rappterPackConfigPath)) {
      throw new Error(`Rappter Pack config is missing at ${rappterPackConfigPath}.`);
    }
    const pack = validatePackConfig(JSON.parse(
      readFileSync(rappterPackConfigPath, "utf8"),
    ));
    const matrix = validatePackMatrix(JSON.parse(
      readFileSync(rappterPackMatrixPath, "utf8"),
    ), pack);
    const report = await runPackMatrix({ config: pack, matrix });
    const file = writePackReport(betaHome, report);
    return { file, report };
  });
  registerDimensionTileIpc({
    activateTile: (tile) => routeManager.startTile(tile.agents),
    assertTrustedIpc,
    captureActivePayload: () => {
      const route = routeManager.activeRoute;
      if (!route) throw new Error("No active Brainstem route can be captured.");
      return {
        agents: routeManager.activeTileAgentPayload(),
        route: {
          url: route.url,
          rappid: route.callerRappid,
          compositionHash: route.transientCompositionHash
            || route.compositionHash,
        },
      };
    },
    deactivatePrimary: () => routeManager.startBlank(),
    ipcMain,
    isEnabled: () => viewMode.mode === "arena",
    store: dimensionTileStore,
  });
  ipcMain.handle("beta:tiles-load-custom-layout", async (event) => {
    assertTrustedIpc(event);
    if (viewMode.mode !== "arena") {
      throw new Error("Agent Arena is not active.");
    }
    return handleCustomArenaLayoutLoad();
  });
  ipcMain.handle("beta:list-agent-files", async (event) => {
    assertTrustedIpc(event);
    const identity = routeManager.identity();
    const route = routeManager.activeRoute;
    return {
      caller_rappid: identity.caller_rappid,
      memory_guid: identity.memory_guid,
      active_stack_rappid: route?.stackRappid || identity.active_stack_rappid,
      overlay_stack_rappids: route?.overlayStackRappids
        || identity.overlay_stack_rappids,
      stack_lineage: route?.stackLineage || [],
      stack_tree: routeManager.stackTree(),
      composition_hash: route?.transientCompositionHash
        || route?.compositionHash
        || null,
      files: routeManager.activeAgentFiles().map((agent) => ({
        filename: agent.filename,
        agents: [],
        loadable: true,
        revision: agent.address || agent.filename,
        scope: agent.scope,
      })),
    };
  });
  ipcMain.handle("beta:read-agent-file", async (
    event,
    filename,
    scope,
  ) => {
    assertTrustedIpc(event);
    const safeName = String(filename || "");
    if (
      !/^[A-Za-z0-9_.-]+\.py$/.test(safeName)
      || safeName.startsWith(".")
    ) {
      throw new Error("A safe Python agent filename is required.");
    }
    return {
      filename: safeName,
      scope: String(scope || "global"),
      content: routeManager.readActiveAgent(safeName),
    };
  });
  ipcMain.handle("beta:delete-agent", async (event, filename) => {
    assertTrustedIpc(event);
    const removed = await routeManager.removeActiveAgent({ filename });
    const route = await routeManager.startDefault();
    return { ...removed, active_route: route };
  });
  ipcMain.handle("beta:export-agent", async (event, filename) => {
    assertTrustedIpc(event);
    const safeName = path.basename(String(filename || ""));
    const source = routeManager.readActiveAgent(safeName);
    const downloads = app.getPath("downloads");
    const extension = path.extname(safeName);
    const stem = path.basename(safeName, extension);
    let filePath = path.join(downloads, safeName);
    let suffix = 1;
    while (existsSync(filePath)) {
      filePath = path.join(downloads, `${stem} (${suffix})${extension}`);
      suffix += 1;
    }
    writeFileSync(filePath, source, { mode: 0o600 });
    return {
      canceled: false,
      filename: safeName,
      path: filePath,
    };
  });
  ipcMain.handle("beta:install-frame-bridge", async (event) => {
    assertTrustedIpc(event);
    return applyChatLookToFrame();
  });
  ipcMain.handle("beta:record-brainstem-turn", (event, payload) => {
    assertTrustedIpc(event);
    return recordBrainstemCompletion(payload);
  });
  ipcMain.handle("beta:record-twin-turn", (event, twinId, payload) => {
    const ownedTwinId = ownedTwinForSender(event);
    if (ownedTwinId) {
      if (String(twinId || "") !== ownedTwinId) {
        throw new Error("Twin ledger sender does not own that twin.");
      }
      return recordTwinCompletion(ownedTwinId, payload);
    }
    assertTrustedIpc(event);
    return recordTwinCompletion(twinId, payload);
  });
  ipcMain.handle("beta:lineage-command", async (event, message) => {
    assertTrustedIpc(event);
    return executeComposerControl(message);
  });
  ipcMain.handle("beta:lineage-environments", (event) => {
    assertTrustedIpc(event);
    return routeManager.lineageEnvironments();
  });
  ipcMain.handle("beta:lineage-promote", (event, options) => {
    assertTrustedIpc(event);
    return routeManager.promoteLineage(options || {});
  });
  ipcMain.handle("beta:lineage-drift", (event, env) => {
    assertTrustedIpc(event);
    return routeManager.lineageDrift(env);
  });
  ipcMain.handle(
    "beta:check-for-updates",
    (event) => {
      assertTrustedIpc(event);
      return handleCheckForUpdates();
    },
  );
  ipcMain.handle(
    "beta:install-update",
    (event) => {
      assertTrustedIpc(event);
      return handleInstallUpdate();
    },
  );
  ipcMain.handle("beta:surgeon-send", async (event, sessionId, prompt) => {
    assertTrustedIpc(event);
    refreshAmbientBeforeTurn();
    const id = normalizeSurgeonId(sessionId);
    const requestId = randomUUID();
    const result = await ensureRappterSurgeon(sessionId).send(prompt);
    recordCompletedTurn(ledger, {
      requestId,
      response: result.content,
      sessionId: `surgeon-${id}`,
      surface: "surgeon",
      userInput: String(prompt || ""),
    });
    return result;
  });
  ipcMain.handle("beta:surgeon-reset", async (event, sessionId) => {
    assertTrustedIpc(event);
    const surgeon = rappterSurgeons.get(normalizeSurgeonId(sessionId));
    if (surgeon) await surgeon.reset();
    return { ok: true };
  });
  ipcMain.handle("beta:surgeon-close", async (event, sessionId) => {
    assertTrustedIpc(event);
    const id = normalizeSurgeonId(sessionId);
    const surgeon = rappterSurgeons.get(id);
    if (surgeon) {
      rappterSurgeons.delete(id);
      await surgeon.stop().catch(() => {});
    }
    return { ok: true };
  });
  ipcMain.handle("beta:store-source", async (event, next) => {
    assertTrustedIpc(event);
    if (next) return setStoreSource(next);
    return { ...storeSource, sources: Object.values(STORE_SOURCES).map((s) => ({ key: s.key, label: s.label, url: s.url })) };
  });
  ipcMain.handle("beta:store-install-agent", async (event, storeId) => {
    assertTrustedIpc(event);
    return installAgentToBrainstem(storeId);
  });
  ipcMain.handle("beta:store-list", async (event) => {
    assertTrustedIpc(event);
    return rappStore.list();
  });
  ipcMain.handle("beta:twin-list", async (event) => {
    assertTrustedIpc(event);
    return twinManager.list();
  });
  ipcMain.handle("beta:twin-hatch-egg", async (event, payload) => {
    assertTrustedIpc(event);
    const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload?.bytes || []);
    return twinManager.hatchEgg(
      { bytes, filename: String(payload?.filename || "dropped.egg") },
      { instruction: payload?.instruction || null },
    );
  });
  ipcMain.handle("beta:twin-hatch", async (event, storeId, instruction) => {
    assertTrustedIpc(event);
    return twinManager.hatch(storeId, { instruction: instruction || null });
  });
  ipcMain.handle("beta:twin-chat", async (event, id, prompt) => {
    assertTrustedIpc(event);
    return twinManager.chat(id, prompt, { author: "You" });
  });
  ipcMain.handle("beta:twin-run", async (event, id, instruction) => {
    assertTrustedIpc(event);
    return twinManager.run(id, instruction);
  });
  // The visible Brainstem loops with the twin autonomously (two-brain: Brainstem
  // plans each turn, twin executes). Non-blocking — returns once kicked off; the
  // exchange streams into the twin's tile so the user can watch and interject.
  ipcMain.handle("beta:twin-loop", async (event, id, goal) => {
    assertTrustedIpc(event);
    twinManager.loop(id, goal).catch(() => {});   // errors surface as a twin-message in the room
    return { ok: true, looping: id };
  });
  ipcMain.handle("beta:twin-close", async (event, id) => {
    assertTrustedIpc(event);
    return twinManager.close(id);
  });
  ipcMain.handle("beta:twin-deploy-copilot-studio", async (event, options) => {
    assertTrustedIpc(event);
    return hatchCopilotStudioTwin(options || {});
  });
  ipcMain.handle("beta:twin-popout", async (event, id) => {
    assertTrustedIpc(event);
    return popOutTwin(id);
  });
  ipcMain.handle("beta:twin-inject-ui", async (event, id) => {
    assertTrustedIpc(event);
    return injectTwinUi(id);
  });
  ipcMain.handle("beta:open-auth", async (event, options) => {
    assertTrustedIpc(event);
    const { url, id } = options || {};
    const target = url || (id && twinAuthPrompts.get(id)?.url);
    if (!target) throw new Error("No auth URL to open.");
    await openExternalUrl(target);
    return { ok: true, opened: target };
  });
}

async function startServices() {
  const brainstemStartErrorFile = path.join(
    betaHome,
    "brainstem-start-error.json",
  );
  const brainstemTask = routeManager.startDefault().then((route) => {
    rmSync(brainstemStartErrorFile, { force: true });
    state.url = route.url;
    emitState();
  }).catch((error) => {
    state.brainstem = { phase: "error", message: String(error.message || error) };
    writeFileSync(brainstemStartErrorFile, `${JSON.stringify({
      schema: "openrappter-brainstem-start-error/1.0",
      at: new Date().toISOString(),
      message: String(error.message || error),
      stack: String(error.stack || ""),
    }, null, 2)}\n`, { mode: 0o600 });
    emitState();
  });

  const copilotTask = copilot.start().then((result) => {
    state.copilot = result.authenticated
      ? {
          phase: "ready",
          message: result.login
            ? `Copilot CLI signed in as ${result.login}`
            : "Copilot CLI signed in",
        }
      : {
          phase: "signed-out",
          message: "Copilot CLI is bundled; sign in through Brainstem chat.",
        };
    state.surgeon = result.authenticated
      ? {
          phase: "ready",
          message: "GitHub Copilot Agent mode is ready inside OpenRappter.",
        }
      : {
          phase: "signed-out",
          message: "Sign in to GitHub Copilot before using Rappter Surgeon.",
        };
    emitState();
  }).catch((error) => {
    state.copilot = {
      phase: "warning",
      message: `Copilot CLI status unavailable: ${String(error.message || error)}`,
    };
    state.surgeon = {
      phase: "error",
      message: state.copilot.message,
    };
    emitState();
  });

  await Promise.allSettled([brainstemTask, copilotTask]);
}

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    presentWindow(mainWindow);
  });

  app.whenReady().then(() => {
    if (
      drivenRun
      && process.env.OPENRAPPTER_DOCK_VISIBLE !== "1"
      && process.platform === "darwin"
      && app.setActivationPolicy
    ) {
      app.setActivationPolicy("accessory");
    }
    // One dock creature owns one isolated neighborhood. The common dinosaur
    // stays recognizable while the badge and app name identify its owner.
    if (appIcon && !appIcon.isEmpty() && process.platform === "darwin" && app.dock) {
      app.dock.setIcon(appIcon);
      app.dock.setBadge(neighborhood.dock_badge);
    }
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "geolocation") {
        callback(allowsAmbientGeolocation(webContents));
        return;
      }
      callback(allowsUiDriverMediaPermission(webContents, permission));
    });
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission) => {
        if (permission === "geolocation") {
          return allowsAmbientGeolocation(webContents);
        }
        return allowsUiDriverMediaPermission(webContents, permission);
      },
    );
    ambientManifestTimer = setInterval(
      () => ambient?.refreshManifest(),
      45000,
    );
    ambientDeviceTimer = setInterval(
      () => refreshAmbientDevice(),
      240000,
    );
    registerIpc();
    installApplicationMenu();
    loadPendingUpdateResult();
    mainWindow = createWindow();
    const chatEndpointTask = startOpenRappterChatEndpoint({
      appIdentity: neighborhood,
      betaHome,
      dockVisible: process.platform !== "darwin"
        || app.dock?.isVisible?.() === true,
      neighborhoodId: neighborhood.neighborhood_id,
      ...(process.env.OPENRAPPTER_INSTANCE_TOKEN
        ? { instanceToken: process.env.OPENRAPPTER_INSTANCE_TOKEN }
        : {}),
      requestStop: () => app.quit(),
      resolveTarget: () => routeManager.activeRoute?.url || null,
    }).then((endpoint) => {
      openRappterChatEndpoint = endpoint;
      return endpoint;
    }).catch((error) => {
      console.error(`OpenRappter /chat endpoint unavailable: ${error.message}`);
      if (process.env.BRAINSTEM_BETA_SMOKE_READY_FILE) throw error;
      return null;
    });
    startUiDriverServer({
      resolveTwinUrls: (id) => {
        const twin = twinManager.list().find((t) => t.id === id);
        return twin ? [twin.url].filter(Boolean) : [];
      },
      window: mainWindow,
      brainstemHome: config.brainstemHome,
      loopbackUrl,
      env: process.env,
      routeTelemetry: () => routeManager.telemetrySnapshot(),
      brainstemRuntimeFingerprint,
      runtimeFingerprint: startupFingerprint,
    }).then((driver) => {
      uiDriver = driver;
      state.uiDriver = {
        phase: "ready",
        message: "Chat agents can visibly operate this Brainstem.",
      };
      emitState();
    }).catch((error) => {
      state.uiDriver = {
        phase: "error",
        message: `Visible AI controls unavailable: ${String(error.message || error)}`,
      };
      console.error(state.uiDriver.message);
      emitState();
    });
    const servicesTask = startServices();
    const e2eStopFile = process.env.BRAINSTEM_BETA_E2E_STOP_FILE;
    if (e2eStopFile) {
      e2eStopTimer = setInterval(() => {
        if (!existsSync(e2eStopFile)) return;
        clearInterval(e2eStopTimer);
        e2eStopTimer = null;
        app.quit();
      }, 100);
      e2eStopTimer.unref?.();
    }
    const smokeExitMs = Number.parseInt(
      process.env.BRAINSTEM_BETA_SMOKE_EXIT_MS || "0",
      10,
    );
    const smokeReadyFile = process.env.BRAINSTEM_BETA_SMOKE_READY_FILE;
    if (smokeReadyFile) {
      void Promise.all([chatEndpointTask, servicesTask]).then(([endpoint]) => {
        if (
          !mainWindow
          || mainWindow.isDestroyed()
          || !endpoint?.url
          || !routeManager.activeRoute?.url
        ) {
          throw new Error(`OpenRappter smoke readiness is incomplete: ${
            JSON.stringify({
              active_route: routeManager.activeRoute?.url || null,
              brainstem: state.brainstem,
              endpoint: endpoint?.url || null,
              window_created: Boolean(mainWindow && !mainWindow.isDestroyed()),
            })
          }`);
        }
        writeFileSync(smokeReadyFile, `${JSON.stringify({
          schema: "openrappter-smoke-ready/1.0",
          pid: process.pid,
          window_created: true,
          chat_endpoint: endpoint.url,
          active_route: routeManager.activeRoute.url,
        }, null, 2)}\n`, { mode: 0o600 });
        if (Number.isInteger(smokeExitMs) && smokeExitMs > 0) {
          setTimeout(() => app.quit(), smokeExitMs);
        }
      }).catch((error) => {
        console.error(`OpenRappter smoke readiness failed: ${error.message}`);
        app.exit(1);
      });
    } else if (Number.isInteger(smokeExitMs) && smokeExitMs > 0) {
      setTimeout(() => app.quit(), smokeExitMs);
    }
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    presentWindow(mainWindow, { focus: false });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInterval(ambientManifestTimer);
    clearInterval(ambientDeviceTimer);
    if (e2eStopTimer) {
      clearInterval(e2eStopTimer);
      e2eStopTimer = null;
    }
    Promise.allSettled([
      ...Array.from(rappterSurgeons.values(), (surgeon) => surgeon.stop()),
      twinManager.stopAll(),
      copilot.stop(),
      routeManager.stop(),
      openRappterChatEndpoint?.stop(),
      uiDriver?.stop(),
    ]).finally(() => {
      ledger?.close();
      shutdownComplete = true;
      app.quit();
    });
  });
}
