const { ipcRenderer } = require("electron");

const hosts = new Set(["teams.microsoft.com", "teams.live.com"]);
let lastErrorAt = 0;

function rejectPacket(message) {
  if (Date.now() - lastErrorAt < 1000) return;
  lastErrorAt = Date.now();
  ipcRenderer.send("beta:teams-media", {
    type: "error",
    payload: { message },
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin
      || location.protocol !== "https:" || !hosts.has(location.hostname)
      || event.data?.source !== "rapp-teams-media") return;
  const { type, payload } = event.data;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    rejectPacket("Invalid virtual-media packet.");
    return;
  }
  if (type === "audio") {
    if (typeof payload.wavBase64 !== "string" || payload.wavBase64.length > 350000
        || payload.mimeType !== "audio/wav" || payload.sampleRate !== 16000
        || !Number.isFinite(payload.durationMs) || payload.durationMs > 8000
        || payload.durationMs <= 0 || !Number.isFinite(payload.rms)) {
      rejectPacket("Incoming virtual audio exceeded its boundary.");
      return;
    }
    ipcRenderer.send("beta:teams-media", {
      type,
      payload: {
        wavBase64: payload.wavBase64,
        mimeType: "audio/wav",
        sampleRate: 16000,
        durationMs: payload.durationMs,
        rms: payload.rms,
        forced: payload.forced === true,
      },
    });
  } else if (type === "video") {
    if (typeof payload.jpegBase64 !== "string" || payload.jpegBase64.length > 131072
        || !Number.isInteger(payload.width) || !Number.isInteger(payload.height)
        || payload.width < 1 || payload.height < 1 || payload.width > 1280 || payload.height > 720) {
      rejectPacket("Incoming virtual video exceeded its boundary.");
      return;
    }
    ipcRenderer.send("beta:teams-media", {
      type,
      payload: {
        jpegBase64: payload.jpegBase64,
        width: payload.width,
        height: payload.height,
        at: Date.now(),
      },
    });
  } else if (type === "status") {
    const summary = {};
    for (const [key, value] of Object.entries(payload).slice(0, 40)) {
      if (key.length > 60) continue;
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        summary[key] = value;
      } else if (typeof value === "string" && value.length <= 120) {
        summary[key] = value;
      }
    }
    ipcRenderer.send("beta:teams-media", { type, payload: summary });
  } else if (type === "error") {
    rejectPacket(String(payload.message || "The virtual media adapter reported an error.").slice(0, 300));
  }
});
