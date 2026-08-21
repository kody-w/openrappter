import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { testPython } from "./_python.mjs";


const fixtures = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));
const harness = String.raw`
import importlib.util
import json
import os
import sys
import types

agents = types.ModuleType("agents")
basic = types.ModuleType("agents.basic_agent")
class BasicAgent:
    def __init__(self, name=None, metadata=None):
        self.name = name
        self.metadata = metadata
basic.BasicAgent = BasicAgent
agents.basic_agent = basic
sys.modules["agents"] = agents
sys.modules["agents.basic_agent"] = basic

def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

weather = load(sys.argv[1], "weather_fixture")
pin = load(sys.argv[2], "pin_fixture")
print(json.dumps({
    "ambient_weather": weather.WeatherAgent().perform(),
    "explicit_weather": weather.WeatherAgent().perform(lat=1.25, lon=2.5),
    "pin": pin.PinDropAgent().perform(to="Kody", lat=47.6062, lon=-122.3321),
}))
`;

test("weather and pin fixtures consume sloshed coordinates deterministically", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-sloshing-fixtures-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ambient = path.join(root, "ambient");
  const agentsDir = path.join(root, "agents");
  mkdirSync(ambient);
  mkdirSync(agentsDir);
  const weatherPath = path.join(agentsDir, "weather_agent.py");
  const pinPath = path.join(agentsDir, "pin_drop_agent.py");
  copyFileSync(path.join(fixtures, "weather_agent.py"), weatherPath);
  copyFileSync(path.join(fixtures, "pin_drop_agent.py"), pinPath);
  writeFileSync(path.join(ambient, "device.json"), JSON.stringify({
    provider: "device",
    at: new Date().toISOString(),
    ttl_s: 300,
    data: {
      location: {
        source: "user-set",
        lat: 47.6062,
        lon: -122.3321,
      },
    },
  }));

  const result = spawnSync(
    testPython(),
    ["-c", harness, weatherPath, pinPath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
        RAPP_AMBIENT_DIR: ambient,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(
    output.ambient_weather,
    "DETERMINISTIC_FORECAST lat=47.60620 lon=-122.33210 conditions=clear temperature_c=21",
  );
  assert.equal(
    output.explicit_weather,
    "DETERMINISTIC_FORECAST lat=1.25000 lon=2.50000 conditions=clear temperature_c=21",
  );
  const pinId = output.pin.match(/id=(pin-[a-f0-9]{16})/)?.[1];
  assert.ok(pinId);
  const pins = readdirSync(agentsDir).filter((name) => name.endsWith(".json"));
  assert.deepEqual(pins, [`${pinId}.json`]);
  const pinFile = path.join(agentsDir, pins[0]);
  const payload = JSON.parse(readFileSync(pinFile, "utf8"));
  assert.deepEqual(Object.keys(payload), ["to", "lat", "lon", "at"]);
  assert.equal(payload.to, "Kody");
  assert.equal(payload.lat, 47.6062);
  assert.equal(payload.lon, -122.3321);
  assert.match(payload.at, /^\d{4}-\d{2}-\d{2}T/);
  if (process.platform !== "win32") {
    assert.equal(statSync(pinFile).mode & 0o777, 0o600);
  }
});

test("fixture agents remain test-only and satisfy the one-file tool contract", () => {
  const weather = readFileSync(path.join(fixtures, "weather_agent.py"), "utf8");
  const pin = readFileSync(path.join(fixtures, "pin_drop_agent.py"), "utf8");
  for (const [filename, source] of [
    ["weather_agent.py", weather],
    ["pin_drop_agent.py", pin],
  ]) {
    assert.match(filename, /_agent\.py$/);
    assert.match(source, /class \w+Agent\(BasicAgent\):/);
    assert.match(source, /def perform\([^)]*\*\*kwargs\)/);
    assert.match(source, /"name": self\.name/);
  }
  const packageManifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageManifest.build.files.some((entry) => String(entry).includes("tests")),
    false,
  );
});
