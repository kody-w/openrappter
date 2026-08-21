import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Scratch removal is best-effort and retried: on Windows an SQLite handle that
// a later after-hook closes still locks ledger.sqlite while this hook runs, and
// a leftover temp directory must not fail the test that already passed.
function removeScratch(directory) {
  try {
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  } catch (error) {
    if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

import {
  lookupApproximateLocation,
  openAmbient,
} from "../electron/ambient.mjs";
import { openLedger } from "../electron/ledger.mjs";


function scratch(t) {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-ambient-"));
  t.after(() => removeScratch(betaHome));
  return betaHome;
}

test("ambient writes private device, ledger, and manifest provider documents", (t) => {
  const betaHome = scratch(t);
  const ambient = openAmbient(betaHome, {
    locale: "en-US",
    now: () => "2026-08-20T20:12:00.000Z",
    platform: "darwin",
    timeZone: "America/New_York",
  });
  const device = ambient.refreshDevice({
    navigatorLocation: {
      accuracy_m: 12,
      at: "2026-08-20T20:12:00.000Z",
      label: "device",
      lat: 47.6062,
      lon: -122.3321,
    },
    settings: {
      approximateFallback: false,
      granularity: "precise",
      userLocation: {
        accuracy_m: 0,
        label: "home",
        lat: 40.7128,
        lon: -74.006,
      },
    },
  });
  const ledger = ambient.refreshLedger({
    query_lines: ["sqlite3 ledger.sqlite \"select * from agents\""],
    recent_agents: [{ event: "installed", tool_name: "WeatherAgent" }],
  });

  assert.equal(device.provider, "device");
  assert.equal(device.data.location.source, "user-set");
  assert.equal(device.data.location.label, "home");
  assert.equal(device.data.timezone, "America/New_York");
  assert.equal(ledger.data.recent_events[0].tool_name, "WeatherAgent");
  const manifest = ambient.readProvider("manifest");
  assert.deepEqual(
    manifest.data.providers.map(({ provider }) => provider),
    ["device", "ledger"],
  );
  for (const file of ["device.json", "ledger.json", "manifest.json"]) {
    const filePath = path.join(betaHome, "ambient", file);
    assert.ok(JSON.parse(readFileSync(filePath, "utf8")));
    if (process.platform !== "win32") {
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    }
  }
});

test("ambient applies honest location fallback, granularity, and device kill switch", (t) => {
  const betaHome = scratch(t);
  const ambient = openAmbient(betaHome, {
    now: () => "2026-08-20T20:12:00.000Z",
  });
  const unavailable = ambient.refreshDevice({
    settings: {
      approximateFallback: false,
      granularity: "precise",
    },
    unavailableReason: "provider key absent",
  });
  assert.equal(unavailable.data.location.source, "unavailable");
  assert.equal(unavailable.data.location.lat, null);

  const approximate = ambient.refreshDevice({
    approximateLocation: {
      accuracy_m: 50000,
      at: "2026-08-20T20:12:00.000Z",
      label: "Seattle, WA",
      lat: 47.6062,
      lon: -122.3321,
    },
    settings: {
      approximateFallback: true,
      granularity: "precise",
    },
  });
  assert.equal(approximate.data.location.source, "ip-approximate");
  assert.equal(approximate.data.location.granularity, "city");
  assert.equal(approximate.data.location.lat, 47.5);
  assert.equal(approximate.data.location.lon, -122.5);

  const cityPrivate = ambient.refreshDevice({
    settings: {
      approximateFallback: false,
      granularity: "city",
      userLocation: {
        accuracy_m: 0,
        label: "123 Main Street, Seattle",
        lat: 47.6062,
        lon: -122.3321,
      },
    },
  });
  assert.equal(cityPrivate.data.location.label, null);
  assert.equal(cityPrivate.data.location.accuracy_m, 50000);
  assert.equal(cityPrivate.data.location.lat, 47.5);
  assert.equal(cityPrivate.data.location.lon, -122.5);

  const off = ambient.refreshDevice({
    settings: {
      approximateFallback: true,
      granularity: "off",
    },
  });
  assert.equal(off.data.location.source, "off");
  assert.equal(off.data.location.lat, null);

  const disabled = openAmbient(betaHome, {
    deviceEnabled: false,
    now: () => "2026-08-20T20:13:00.000Z",
  });
  assert.equal(disabled.refreshDevice(), null);
  assert.equal(disabled.readProvider("device"), null);
});

test("city-level location uses a coordinate cell no finer than its 50 km accuracy", (t) => {
  const ambient = openAmbient(scratch(t), {
    now: () => "2026-08-20T20:12:00.000Z",
  });
  const device = ambient.refreshDevice({
    navigatorLocation: {
      accuracy_m: 8,
      at: "2026-08-20T20:12:00.000Z",
      lat: 47.6062,
      lon: -122.3321,
    },
    settings: {
      approximateFallback: false,
      granularity: "city",
    },
  });

  assert.deepEqual(
    {
      accuracy_m: device.data.location.accuracy_m,
      lat: device.data.location.lat,
      lon: device.data.location.lon,
    },
    { accuracy_m: 50000, lat: 47.5, lon: -122.5 },
  );
});

test("city-level unavailable location keeps its reason without fabricated accuracy", (t) => {
  const ambient = openAmbient(scratch(t), {
    now: () => "2026-08-20T20:12:00.000Z",
  });
  const device = ambient.refreshDevice({
    settings: {
      approximateFallback: false,
      granularity: "city",
    },
    unavailableReason: "User denied Geolocation",
  });

  assert.deepEqual(device.data.location, {
    accuracy_m: null,
    granularity: "city",
    label: "unavailable: User denied Geolocation",
    lat: null,
    lon: null,
    source: "unavailable",
  });
});

test("ambient never renews stale cached coordinates as a fresh fix", (t) => {
  const betaHome = scratch(t);
  const ambient = openAmbient(betaHome, {
    now: () => "2026-08-20T20:20:00.000Z",
  });
  const device = ambient.refreshDevice({
    navigatorLocation: {
      accuracy_m: 10,
      at: "2026-08-20T20:12:00.000Z",
      lat: 47.6062,
      lon: -122.3321,
    },
    settings: {
      approximateFallback: false,
      granularity: "precise",
    },
  });
  assert.equal(device.data.location.source, "unavailable");
  assert.equal(device.data.location.lat, null);
});

test("manifest lists valid third-party providers without rewriting them", (t) => {
  const betaHome = scratch(t);
  const ambient = openAmbient(betaHome, {
    now: () => "2026-08-20T20:12:00.000Z",
  });

  test("structured redaction always leaves ambient JSON parseable", (t) => {
    const betaHome = scratch(t);
    const ambient = openAmbient(betaHome, {
      now: () => "2026-08-20T20:12:00.000Z",
    });
    ambient.refreshDevice({
      settings: {
        granularity: "precise",
        userLocation: {
          label: "password: precise-address",
          lat: 47.6062,
          lon: -122.3321,
        },
      },
    });
    const device = ambient.readProvider("device");
    assert.ok(device);
    assert.match(device.data.location.label, /\[redacted:password\]/);
    assert.doesNotMatch(device.data.location.label, /precise-address/);
  });
  const thirdPartyPath = path.join(betaHome, "ambient", "calendar.json");
  const thirdParty = JSON.stringify({
    provider: "calendar",
    at: "2026-08-20T20:11:00.000Z",
    ttl_s: 60,
    data: { next: "customer call" },
  });
  writeFileSync(thirdPartyPath, thirdParty, { mode: 0o600 });
  ambient.refreshLedger({ query_lines: [], recent_agents: [] });

  assert.equal(readFileSync(thirdPartyPath, "utf8"), thirdParty);
  const providers = ambient.readProvider("manifest").data.providers;
  assert.deepEqual(
    providers.map(({ owned, provider }) => ({ owned, provider })),
    [
      { owned: false, provider: "calendar" },
      { owned: true, provider: "ledger" },
    ],
  );
});

test("ambient write failures are isolated and reported once", (t) => {
  const betaHome = scratch(t);
  const blocked = path.join(betaHome, "blocked");
  writeFileSync(blocked, "occupied");
  const messages = [];
  let ambient;
  assert.doesNotThrow(() => {
    ambient = openAmbient(blocked, {
      logger: { error: (message) => messages.push(message) },
    });
  });
  assert.doesNotThrow(() => {
    ambient.refreshDevice();
    ambient.refreshLedger();
    ambient.refreshManifest();
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[ambient\] /);
});

test("approximate location lookup is explicit, validated, and city-level", async () => {
  const calls = [];
  const location = await lookupApproximateLocation({
    fetchImpl: async (url, options) => {
      calls.push({ options, url });
      return new Response(JSON.stringify({
        success: true,
        city: "Seattle",
        region: "Washington",
        country: "United States",
        latitude: 47.6062,
        longitude: -122.3321,
      }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ipwho.is/");
  assert.equal(location.label, "Seattle, Washington, United States");
  assert.equal(location.accuracy_m, 50000);
  await assert.rejects(
    () => lookupApproximateLocation({
      fetchImpl: async () => new Response("{}", { status: 503 }),
    }),
    /HTTP 503/,
  );
});

test("ledger writes refresh ambient ledger and device context in real time", (t) => {
  const betaHome = scratch(t);
  const ambient = openAmbient(betaHome, {
    locale: "en-US",
    now: () => "2026-08-20T20:12:00.000Z",
    timeZone: "UTC",
  });
  const ledger = openLedger(betaHome, {
    now: () => "2026-08-20T20:12:00.000Z",
  });
  t.after(() => ledger.close());
  ledger.setOnWrite((row, currentLedger) => {
    ambient.refreshLedger(currentLedger.describe());
    if (row.table === "turns" && row.role === "assistant") {
      ambient.refreshDevice({
        settings: {
          granularity: "precise",
          userLocation: {
            label: "home",
            lat: 47.6062,
            lon: -122.3321,
          },
        },
      });
    }
  });

  ledger.recordAgent({
    event: "installed",
    filename: "weather_agent.py",
    toolName: "WeatherAgent",
  });
  assert.equal(
    ambient.readProvider("ledger").data.recent_events[0].tool_name,
    "WeatherAgent",
  );
  ledger.recordTurn({
    content: "sunny",
    role: "assistant",
    sessionId: "weather-session",
    surface: "brainstem",
  });
  assert.equal(
    ambient.readProvider("device").data.location.source,
    "user-set",
  );
});

test("main, preload, and renderer expose the honest ambient settings ladder", () => {
  const main = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  );
  const preload = readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  const renderer = readFileSync(
    new URL("../ui/renderer.js", import.meta.url),
    "utf8",
  );
  const ui = readFileSync(
    new URL("../ui/index.html", import.meta.url),
    "utf8",
  );
  const packageManifest = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  assert.match(main, /ledger\?\.setOnWrite/);
  assert.ok(
    main.indexOf("app.requestSingleInstanceLock()")
      < main.indexOf("openAmbient(betaHome"),
    "the losing instance must not touch ambient files",
  );
  assert.match(main, /requestAmbientRefresh/);
  assert.match(main, /refreshAmbientBeforeTurn/);
  assert.match(main, /permission === "geolocation"/);
  assert.match(main, /allowsAmbientGeolocation/);
  assert.match(main, /lookupApproximateLocation/);
  assert.match(main, /Date\.parse\(payload\.at/);
  assert.match(main, /return \{ ok: true \}/);
  assert.match(main, /rapp-beta:open-ambient-settings/);
  assert.match(preload, /getAmbientSettings:/);
  assert.match(preload, /setAmbientSettings:/);
  assert.match(preload, /updateGeolocation:/);
  assert.match(renderer, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(renderer, /position\.timestamp/);
  assert.match(renderer, /result: \{ ok: Boolean\(result\) \}/);
  assert.match(renderer, /maximumAge: 0/);
  assert.match(renderer, /setInterval\(\(\) => void maintainAmbientContext\(\), 240000\)/);
  assert.match(main, /ambient\.?ManifestTimer = setInterval/);
  assert.match(ui, /id="ambient-settings"/);
  assert.match(ui, /id="ambient-approximate"/);
  assert.equal(
    [...ui.matchAll(/data-drive="shell\.ambient[^"]+"/g)].length,
    9,
  );
  assert.match(ui, /Approximate IP location is city-level,\s*opt-in, and off by default/);
  assert.match(packageManifest, /NSLocationUsageDescription/);
});
