import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  redactCredentialText,
  redactSensitiveValue,
} from "./log-redaction.mjs";


const DEVICE_TTL_SECONDS = 300;
const CITY_ACCURACY_METERS = 50_000;
const CITY_GRID_STEPS_PER_DEGREE = 2;
const LEDGER_TTL_SECONDS = 3600;
const MANIFEST_TTL_SECONDS = 60;
const OWNED_PROVIDERS = new Set(["device", "ledger"]);

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function atomicPrivateJson(filePath, value) {
  privateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(redactSensitiveValue(value), null, 2)}\n`;
  JSON.parse(serialized);
  writeFileSync(temporary, serialized, { mode: 0o600 });
  renameSync(temporary, filePath);
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
  return value;
}

function finiteCoordinate(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

function normalizedLocation(value, {
  granularity,
  source,
} = {}) {
  const requestedGranularity = ["precise", "city", "off"].includes(granularity)
    ? granularity
    : "precise";
  if (requestedGranularity === "off") {
    return {
      accuracy_m: null,
      granularity: "off",
      label: null,
      lat: null,
      lon: null,
      source: "off",
    };
  }
  let lat = finiteCoordinate(value?.lat, -90, 90);
  let lon = finiteCoordinate(value?.lon, -180, 180);
  const hasCoordinates = lat !== null && lon !== null;
  if (!hasCoordinates) {
    lat = null;
    lon = null;
  }
  if (requestedGranularity === "city") {
    lat = lat === null
      ? null
      : Math.round(lat * CITY_GRID_STEPS_PER_DEGREE)
        / CITY_GRID_STEPS_PER_DEGREE;
    lon = lon === null
      ? null
      : Math.round(lon * CITY_GRID_STEPS_PER_DEGREE)
        / CITY_GRID_STEPS_PER_DEGREE;
  }
  const cityLevel = requestedGranularity === "city";
  const accuracy = hasCoordinates
    ? cityLevel
      ? Math.max(CITY_ACCURACY_METERS, Number(value?.accuracy_m) || 0)
      : Number.isFinite(Number(value?.accuracy_m))
        ? Math.max(0, Number(value.accuracy_m))
        : null
    : null;
  return {
    accuracy_m: accuracy,
    granularity: requestedGranularity,
    label: cityLevel
      ? (["ip-approximate", "unavailable"].includes(source) && value?.label
          ? String(value.label).slice(0, 160)
          : null)
      : value?.label
        ? String(value.label).slice(0, 160)
      : null,
    lat,
    lon,
    source,
  };
}

function freshLocation(value, now, ttlSeconds = DEVICE_TTL_SECONDS) {
  if (!value) return null;
  const acquiredAt = Date.parse(value.at || "");
  const currentAt = Date.parse(now || "");
  if (
    !Number.isFinite(acquiredAt)
    || !Number.isFinite(currentAt)
    || currentAt - acquiredAt < 0
    || currentAt - acquiredAt > ttlSeconds * 1000
  ) return null;
  return value;
}

function validProviderDocument(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.provider === "string"
    && value.provider
    && typeof value.at === "string"
    && Number.isFinite(Number(value.ttl_s))
    && Number(value.ttl_s) > 0
    && value.data
    && typeof value.data === "object"
    && !Array.isArray(value.data),
  );
}

export class AmbientProvider {
  constructor(betaHome, {
    deviceEnabled = process.env.RAPP_AMBIENT_DEVICE !== "0",
    locale = null,
    logger = console,
    now = () => new Date().toISOString(),
    platform = process.platform,
    timeZone = null,
  } = {}) {
    this.betaHome = path.resolve(betaHome);
    this.directory = path.join(this.betaHome, "ambient");
    this.deviceEnabled = deviceEnabled !== false;
    this.locale = locale;
    this.logger = logger;
    this.now = now;
    this.platform = platform;
    this.timeZone = timeZone;
    this.errorReported = false;
    try {
      privateDirectory(this.directory);
      if (!this.deviceEnabled) {
        rmSync(path.join(this.directory, "device.json"), { force: true });
      }
      this.refreshManifest();
    } catch (error) {
      this.#reportOnce(error);
    }
  }

  providerPath(provider) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(provider || ""))) {
      throw new Error("Ambient provider names must be safe file stems.");
    }
    return path.join(this.directory, `${provider}.json`);
  }

  readProvider(provider) {
    try {
      const file = this.providerPath(provider);
      if (!existsSync(file)) return null;
      const value = JSON.parse(readFileSync(file, "utf8"));
      return validProviderDocument(value) ? value : null;
    } catch (error) {
      this.#reportOnce(error);
      return null;
    }
  }

  refreshDevice({
    approximateLocation = null,
    navigatorLocation = null,
    settings = {},
    unavailableReason = null,
  } = {}) {
    if (!this.deviceEnabled) return null;
    try {
      const at = this.now();
      const date = new Date(at);
      const locale = this.locale
        || Intl.DateTimeFormat().resolvedOptions().locale
        || "en-US";
      const timeZone = this.timeZone
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || "UTC";
      const granularity = ["precise", "city", "off"].includes(
        settings.granularity,
      )
        ? settings.granularity
        : "precise";
      const freshNavigatorLocation = freshLocation(navigatorLocation, at);
      const freshApproximateLocation = freshLocation(approximateLocation, at);
      let location;
      if (granularity === "off") {
        location = normalizedLocation(null, {
          granularity,
          source: "off",
        });
      } else if (settings.userLocation) {
        location = normalizedLocation(settings.userLocation, {
          granularity,
          source: "user-set",
        });
      } else if (freshNavigatorLocation) {
        location = normalizedLocation(freshNavigatorLocation, {
          granularity,
          source: "navigator.geolocation",
        });
      } else if (settings.approximateFallback && freshApproximateLocation) {
        location = normalizedLocation(freshApproximateLocation, {
          granularity: "city",
          source: "ip-approximate",
        });
      } else {
        location = normalizedLocation({
          label: unavailableReason
            ? `unavailable: ${String(unavailableReason).slice(0, 100)}`
            : "unavailable",
        }, {
          granularity,
          source: "unavailable",
        });
      }
      const document = {
        provider: "device",
        at,
        ttl_s: DEVICE_TTL_SECONDS,
        data: {
          local_time: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "long",
            timeZone,
          }).format(date),
          timezone: timeZone,
          locale,
          platform: this.platform,
          location,
        },
      };
      this.#writeProvider("device", document);
      return document;
    } catch (error) {
      this.#reportOnce(error);
      return null;
    }
  }

  refreshLedger(description = {}) {
    try {
      const document = {
        provider: "ledger",
        at: this.now(),
        ttl_s: LEDGER_TTL_SECONDS,
        data: {
          recent_events: Array.isArray(description.recent_agents)
            ? description.recent_agents.slice(0, 10)
            : [],
          query_lines: Array.isArray(description.query_lines)
            ? description.query_lines.slice(0, 4)
            : [],
        },
      };
      this.#writeProvider("ledger", document);
      return document;
    } catch (error) {
      this.#reportOnce(error);
      return null;
    }
  }

  refreshManifest() {
    try {
      const providers = [];
      for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
        if (
          !entry.isFile()
          || !entry.name.endsWith(".json")
          || entry.name === "manifest.json"
        ) continue;
        const filePath = path.join(this.directory, entry.name);
        let document;
        try {
          document = JSON.parse(readFileSync(filePath, "utf8"));
        } catch {
          continue;
        }
        if (!validProviderDocument(document)) continue;
        providers.push({
          at: document.at,
          file: entry.name,
          owned: OWNED_PROVIDERS.has(document.provider)
            && entry.name === `${document.provider}.json`,
          provider: document.provider,
          ttl_s: document.ttl_s,
        });
      }
      providers.sort((left, right) => (
        left.provider.localeCompare(right.provider)
        || left.file.localeCompare(right.file)
      ));
      return atomicPrivateJson(path.join(this.directory, "manifest.json"), {
        provider: "manifest",
        at: this.now(),
        ttl_s: MANIFEST_TTL_SECONDS,
        data: { providers },
      });
    } catch (error) {
      this.#reportOnce(error);
      return null;
    }
  }

  #writeProvider(provider, document) {
    atomicPrivateJson(this.providerPath(provider), document);
    this.refreshManifest();
  }

  #reportOnce(error) {
    if (this.errorReported) return;
    this.errorReported = true;
    this.logger?.error?.(
      `[ambient] ${redactCredentialText(error?.message || String(error))}`,
    );
  }
}

export function openAmbient(betaHome, options = {}) {
  return new AmbientProvider(betaHome, options);
}

export async function lookupApproximateLocation({
  fetchImpl = globalThis.fetch,
  signal = null,
  url = "https://ipwho.is/",
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Approximate location lookup has no network transport.");
  }
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Approximate location lookup returned HTTP ${response.status}.`,
    );
  }
  const data = await response.json();
  if (data?.success === false) {
    throw new Error(
      `Approximate location lookup failed: ${data.message || "unknown error"}.`,
    );
  }
  const lat = finiteCoordinate(data?.latitude, -90, 90);
  const lon = finiteCoordinate(data?.longitude, -180, 180);
  if (lat === null || lon === null) {
    throw new Error("Approximate location lookup returned invalid coordinates.");
  }
  return {
    accuracy_m: 50000,
    label: [
      data.city,
      data.region,
      data.country,
    ].filter(Boolean).join(", ") || "approximate city",
    lat,
    lon,
  };
}

export const ambientInternals = {
  CITY_ACCURACY_METERS,
  CITY_GRID_STEPS_PER_DEGREE,
  DEVICE_TTL_SECONDS,
  LEDGER_TTL_SECONDS,
  MANIFEST_TTL_SECONDS,
  normalizedLocation,
  freshLocation,
  validProviderDocument,
};
