export const CHAT_STREAM_MODES = Object.freeze(["smooth", "raw", "hold"]);

export function normalizeChatStreamMode(value) {
  const normalized = String(value || "").toLowerCase();
  return CHAT_STREAM_MODES.includes(normalized) ? normalized : null;
}

export function resolveChatStreamMode(env = process.env) {
  if (env.RAPP_CHAT_TYPING === "1") return "hold";
  return normalizeChatStreamMode(env.RAPP_CHAT_STREAM) || "smooth";
}
