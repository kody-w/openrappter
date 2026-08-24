const { contextBridge, ipcRenderer } = require("electron");

const streamArgument = process.argv.find((value) => (
  value.startsWith("--rapp-chat-stream=")
));
const requestedStreamMode = streamArgument?.split("=", 2)[1];
const chatStreamMode = ["smooth", "raw", "hold"].includes(requestedStreamMode)
  ? requestedStreamMode
  : "smooth";
const chatLookArgument = process.argv.find((value) => (
  value.startsWith("--rapp-chat-look=")
));
const chatLook = chatLookArgument?.split("=", 2)[1] === "business"
  ? "business"
  : "messages";
const viewModeArgument = process.argv.find((value) => (
  value.startsWith("--rapp-view-mode=")
));
// Must stay equal to DEFAULT_VIEW_MODE in arena-layouts.mjs — preload is CommonJS
// and cannot import it, so arena-layouts.test.mjs pins the two together.
let viewMode = {
  mode: "herd",
  surface: "herd",
  layout: "ring",
  customLayoutPath: null,
};
try {
  viewMode = JSON.parse(Buffer.from(
    viewModeArgument?.split("=", 2)[1] || "",
    "base64url",
  ).toString("utf8"));
} catch {
  // Invalid startup arguments retain the safe herd-mode default.
}
const chatTypingEnabled = chatStreamMode === "hold";

contextBridge.exposeInMainWorld("brainstemBeta", {
  viewMode,
  chatLook,
  chatStreamMode,
  chatTypingEnabled,
  checkForUpdates: () => ipcRenderer.invoke("beta:check-for-updates"),
  tilesComplete: (id, completion) => (
    ipcRenderer.invoke("beta:tiles-complete", id, completion || {})
  ),
  tilesBunch: (sourceId, targetId) => (
    ipcRenderer.invoke("beta:tiles-bunch", sourceId, targetId)
  ),
  tilesDeactivate: () => ipcRenderer.invoke("beta:tiles-deactivate"),
  tilesFold: (id) => ipcRenderer.invoke("beta:tiles-fold", id),
  tilesList: () => ipcRenderer.invoke("beta:tiles-list"),
  tilesLoadCustomLayout: () => (
    ipcRenderer.invoke("beta:tiles-load-custom-layout")
  ),
  tilesPark: (tile) => ipcRenderer.invoke("beta:tiles-park", tile),
  tilesParkExisting: (id) => (
    ipcRenderer.invoke("beta:tiles-park-existing", id)
  ),
  tilesMove: (id, surface) => (
    ipcRenderer.invoke("beta:tiles-move", id, surface)
  ),
  tilesRace: (id) => ipcRenderer.invoke("beta:tiles-race", id),
  tilesUndo: (id) => ipcRenderer.invoke("beta:tiles-undo", id),
  tilesWake: (id) => ipcRenderer.invoke("beta:tiles-wake", id),
  getState: () => ipcRenderer.invoke("beta:get-state"),
  getAmbientSettings: () => ipcRenderer.invoke("beta:get-ambient-settings"),
  installUpdate: () => ipcRenderer.invoke("beta:install-update"),
  openrappterTileDescribe: () => (
    ipcRenderer.invoke("beta:openrappter-tile-describe")
  ),
  openrappterTileExport: () => (
    ipcRenderer.invoke("beta:openrappter-tile-export")
  ),
  openrappterTileImport: () => (
    ipcRenderer.invoke("beta:openrappter-tile-import")
  ),
  openrappterTileBackup: () => (
    ipcRenderer.invoke("beta:openrappter-tile-backup")
  ),
  organismEggExport: (request) => (
    ipcRenderer.invoke("beta:organism-egg-export", request)
  ),
  organismEggPreview: (request) => (
    ipcRenderer.invoke("beta:organism-egg-preview", request)
  ),
  organismEggApply: (request) => (
    ipcRenderer.invoke("beta:organism-egg-apply", request)
  ),
  rappterPackStatus: () => ipcRenderer.invoke("beta:rappter-pack-status"),
  rappterPackRun: () => ipcRenderer.invoke("beta:rappter-pack-run"),
  deleteAgent: (filename) => ipcRenderer.invoke("beta:delete-agent", filename),
  exportAgent: (filename) => ipcRenderer.invoke("beta:export-agent", filename),
  installFrameBridge: () => (
    ipcRenderer.invoke("beta:install-frame-bridge")
  ),
  lineageCommand: (message) => (
    ipcRenderer.invoke("beta:lineage-command", message)
  ),
  lineageEnvironments: () => (
    ipcRenderer.invoke("beta:lineage-environments")
  ),
  lineagePromote: (options) => (
    ipcRenderer.invoke("beta:lineage-promote", options || {})
  ),
  lineageDrift: (env) => (
    ipcRenderer.invoke("beta:lineage-drift", env)
  ),
  listAgentFiles: () => ipcRenderer.invoke("beta:list-agent-files"),
  readAgentFile: (filename, scope) => (
    ipcRenderer.invoke("beta:read-agent-file", filename, scope)
  ),
  recordBrainstemTurn: (payload) => (
    ipcRenderer.invoke("beta:record-brainstem-turn", payload)
  ),
  recordTwinTurn: (twinId, payload) => (
    ipcRenderer.invoke("beta:record-twin-turn", twinId, payload)
  ),
  refreshAmbient: () => ipcRenderer.invoke("beta:refresh-ambient"),
  setChatLook: (look) => ipcRenderer.invoke("beta:set-chat-look", look),
  setAmbientSettings: (settings) => (
    ipcRenderer.invoke("beta:set-ambient-settings", settings)
  ),
  updateGeolocation: (location) => (
    ipcRenderer.invoke("beta:update-geolocation", location)
  ),
  setViewMode: (next) => ipcRenderer.invoke("beta:set-view-mode", next || {}),
  surgeonReset: (sessionId = 1) => ipcRenderer.invoke("beta:surgeon-reset", sessionId),
  surgeonSend: (sessionId, prompt) => ipcRenderer.invoke("beta:surgeon-send", sessionId, prompt),
  surgeonClose: (sessionId) => ipcRenderer.invoke("beta:surgeon-close", sessionId),
  storeList: () => ipcRenderer.invoke("beta:store-list"),
  storeSource: (next) => ipcRenderer.invoke("beta:store-source", next || null),
  storeInstallAgent: (id) => ipcRenderer.invoke("beta:store-install-agent", id),
  twinList: () => ipcRenderer.invoke("beta:twin-list"),
  twinHatch: (storeId, instruction) => ipcRenderer.invoke("beta:twin-hatch", storeId, instruction),
  twinHatchEgg: (payload) => ipcRenderer.invoke("beta:twin-hatch-egg", payload),
  twinChat: (id, prompt) => ipcRenderer.invoke("beta:twin-chat", id, prompt),
  twinRun: (id, instruction) => ipcRenderer.invoke("beta:twin-run", id, instruction),
  twinLoop: (id, goal) => ipcRenderer.invoke("beta:twin-loop", id, goal),
  twinClose: (id) => ipcRenderer.invoke("beta:twin-close", id),
  twinDeployCopilotStudio: (options) => ipcRenderer.invoke("beta:twin-deploy-copilot-studio", options),
  twinPopOut: (id) => ipcRenderer.invoke("beta:twin-popout", id),
  twinInjectUi: (id) => ipcRenderer.invoke("beta:twin-inject-ui", id),
  openAuth: (options) => ipcRenderer.invoke("beta:open-auth", options),
  onTwinFocus: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("beta:twin-focus", wrapped);
    return () => ipcRenderer.removeListener("beta:twin-focus", wrapped);
  },
  onTwinEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("beta:twin-event", wrapped);
    return () => ipcRenderer.removeListener("beta:twin-event", wrapped);
  },
  onSurgeonEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("beta:surgeon-event", wrapped);
    return () => ipcRenderer.removeListener("beta:surgeon-event", wrapped);
  },
  onOpenUpdate: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("beta:open-update", wrapped);
    return () => ipcRenderer.removeListener("beta:open-update", wrapped);
  },
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("beta:state", wrapped);
    return () => ipcRenderer.removeListener("beta:state", wrapped);
  },
});
