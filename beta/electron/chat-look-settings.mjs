import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { redactSensitiveValue } from "./log-redaction.mjs";

export const CHAT_LOOKS = Object.freeze(["messages", "business"]);
export const LOCATION_GRANULARITIES = Object.freeze([
  "precise",
  "city",
  "off",
]);

export function validChatLook(value) {
  const normalized = String(value || "").toLowerCase();
  return CHAT_LOOKS.includes(normalized) ? normalized : null;
}

export function validLocationGranularity(value) {
  const normalized = String(value || "").toLowerCase();
  return LOCATION_GRANULARITIES.includes(normalized) ? normalized : null;
}

function coordinate(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function normalizeUserLocation(value, { strict = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const label = String(value.label || "").trim().slice(0, 160);
  const lat = coordinate(value.lat, -90, 90);
  const lon = coordinate(value.lon, -180, 180);
  const suppliedCoordinate = ![null, undefined, ""].includes(value.lat)
    || ![null, undefined, ""].includes(value.lon);
  if (strict && suppliedCoordinate && (lat === null || lon === null)) {
    throw new Error(
      "My location needs both a valid latitude (-90 to 90) and longitude (-180 to 180).",
    );
  }
  if (lat === null || lon === null) {
    if (strict && label) {
      throw new Error(
        "My location needs latitude and longitude; OpenRappter does not send labels or addresses to a geocoder.",
      );
    }
    return null;
  }
  return {
    accuracy_m: 0,
    label: label || null,
    lat,
    lon,
  };
}

function settingsPath(betaHome) {
  if (!betaHome) throw new Error("A beta home is required for chat look settings.");
  return path.join(betaHome, "settings.json");
}

function readSettings(betaHome) {
  const file = settingsPath(betaHome);
  if (!existsSync(file)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid OpenRappter settings at ${file}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid OpenRappter settings at ${file}.`);
  }
  return value;
}

function writeSettings(betaHome, value) {
  const file = settingsPath(betaHome);
  mkdirSync(betaHome, { recursive: true, mode: 0o700 });
  try {
    chmodSync(betaHome, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes.
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX file modes.
  }
  return file;
}

export function resolveChatTypingEnabled(_chatLook, env = process.env) {
  if (env.RAPP_CHAT_TYPING === "1") return true;
  return String(env.RAPP_CHAT_STREAM || "").toLowerCase() === "hold";
}

export function readChatLookSettings({
  betaHome,
  env = process.env,
} = {}) {
  const settings = readSettings(betaHome);
  const storedChatLook = validChatLook(settings.chatLook) || "messages";
  const override = validChatLook(env.RAPP_CHAT_LOOK);
  const chatLook = override || storedChatLook;
  return {
    chatLook,
    chatLookOverridden: Boolean(override),
    chatTypingEnabled: resolveChatTypingEnabled(chatLook, env),
    file: settingsPath(betaHome),
    storedChatLook,
  };
}

export function writeChatLookSettings({
  betaHome,
  chatLook,
} = {}) {
  const normalized = validChatLook(chatLook);
  if (!normalized) {
    throw new Error('Chat look must be either "messages" or "business".');
  }
  const settings = readSettings(betaHome);
  settings.chatLook = normalized;
  const file = writeSettings(betaHome, settings);
  return { chatLook: normalized, file };
}

export function changeChatLook({
  apply,
  betaHome,
  chatLook,
  env = process.env,
} = {}) {
  writeChatLookSettings({ betaHome, chatLook });
  const effective = readChatLookSettings({ betaHome, env });
  apply?.(effective);
  return effective;
}

export function readAmbientSettings({
  betaHome,
} = {}) {
  const settings = readSettings(betaHome);
  const ambient = settings.ambient
    && typeof settings.ambient === "object"
    && !Array.isArray(settings.ambient)
    ? settings.ambient
    : {};
  return {
    approximateFallback: ambient.approximateFallback === true,
    file: settingsPath(betaHome),
    granularity: validLocationGranularity(ambient.granularity) || "precise",
    userLocation: normalizeUserLocation(ambient.userLocation),
  };
}

export function writeAmbientSettings({
  approximateFallback = false,
  betaHome,
  granularity = "precise",
  userLocation = null,
} = {}) {
  const normalizedGranularity = validLocationGranularity(granularity);
  if (!normalizedGranularity) {
    throw new Error('Location granularity must be "precise", "city", or "off".');
  }
  const normalizedLocation = normalizeUserLocation(userLocation, {
    strict: true,
  });
  const settings = readSettings(betaHome);
  settings.ambient = redactSensitiveValue({
    approximateFallback: approximateFallback === true,
    granularity: normalizedGranularity,
    userLocation: normalizedLocation,
  });
  const file = writeSettings(betaHome, settings);
  return {
    ...settings.ambient,
    file,
  };
}
