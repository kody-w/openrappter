import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENRAPPTER_TWIN_SCHEMA,
  OpenRappterHatchery,
} from "../electron/openrappter-hatchery.mjs";
import { OpenRappterTileStore } from "../electron/openrappter-tile.mjs";

function fixture(t, {
  instanceControl = async (metadata) => metadata.pid === 4242,
  spawnImpl = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrappter-hatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  const packageDir = path.join(root, "package");
  fs.mkdirSync(path.join(runtime, "agents", "__pycache__"), { recursive: true });
  fs.mkdirSync(path.join(runtime, ".brainstem_data"), { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  const parentVenv = path.join(root, "parent-venv");
  const parentPython = path.join(
    parentVenv,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  fs.mkdirSync(path.dirname(parentPython), { recursive: true });
  fs.writeFileSync(path.join(parentVenv, "pyvenv.cfg"), "home = /usr/bin\n");
  fs.writeFileSync(parentPython, "parent python\n", { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, "brainstem.py"), "# kernel\n");
  fs.writeFileSync(path.join(runtime, "soul.md"), "bare twin soul\n");
  fs.writeFileSync(path.join(runtime, "agents", "hello_agent.py"), "# agent\n");
  fs.writeFileSync(path.join(runtime, "agents", "__pycache__", "hello.pyc"), "compiled");
  fs.writeFileSync(path.join(runtime, ".brainstem_data", "memory.json"), '{"secret":"state"}');
  fs.writeFileSync(path.join(runtime, ".copilot_token"), "token", { mode: 0o600 });
  const launches = [];
  const controlActions = [];
  const hatchery = new OpenRappterHatchery({
    brainstemRuntimeDir: runtime,
    electronPath: "/Applications/Electron.app/Contents/MacOS/Electron",
    openRappterHome: path.join(root, "openrappter"),
    packageDir,
    packConfigPath: path.join(root, "openrappter", "pack.json"),
    pythonPath: parentPython,
    instanceControl: async (metadata, action) => {
      controlActions.push({ metadata, action });
      return instanceControl(metadata, action);
    },
    processAlive: (pid) => pid === 4242,
    spawnImpl: (command, args, options) => {
      launches.push({ command, args, options });
      if (spawnImpl) return spawnImpl(command, args, options);
      return { pid: 4242, unref() {} };
    },
  });
  return {
    controlActions,
    hatchery,
    launches,
    parentPython,
    root,
    runtime,
  };
}

test("hatching OpenRappter creates a separate fully built-out twin", async (t) => {
  const { hatchery, launches, parentPython, root } = fixture(t);
  const twin = await hatchery.hatch("Research Twin");
  assert.equal(twin.schema, OPENRAPPTER_TWIN_SCHEMA);
  assert.equal(twin.name, "research-twin");
  assert.match(
    twin.neighborhood_id,
    /^openrappter:research-twin:[0-9a-f]{64}$/,
  );
  assert.equal(twin.parent_neighborhood_id, "openrappter:alpha");
  assert.equal(twin.generation, 1);
  assert.equal(twin.pid, 4242);
  const estateManifest = JSON.parse(fs.readFileSync(
    path.join(twin.beta_home, "neighborhood.json"),
    "utf8",
  ));
  assert.equal(estateManifest.neighborhood_id, twin.neighborhood_id);
  assert.equal(estateManifest.parent_neighborhood_id, "openrappter:alpha");
  assert.equal(estateManifest.generation, 1);
  assert.equal(estateManifest.neighborhoods.length, 1);
  assert.match(twin.instance_rappid, /^rappid:@openrappter\/research-twin:[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(twin.brainstem_dir, "brainstem.py")));
  assert.ok(fs.existsSync(path.join(twin.brainstem_dir, "agents", "hello_agent.py")));
  const twinToken = path.join(twin.brainstem_dir, ".copilot_token");
  const parentToken = path.join(root, "runtime", ".copilot_token");
  assert.equal(fs.readFileSync(twinToken, "utf8"), "token");
  assert.equal(fs.statSync(twinToken).mode & 0o777, 0o600);
  assert.notEqual(fs.statSync(twinToken).ino, fs.statSync(parentToken).ino);
  assert.equal(fs.existsSync(path.join(twin.brainstem_dir, ".brainstem_data")), false);
  assert.equal(fs.existsSync(path.join(twin.brainstem_dir, "agents", "__pycache__")), false);
  const identityAgent = fs.readFileSync(
    path.join(twin.brainstem_dir, "agents", "openrappter_identity_agent.py"),
    "utf8",
  );
  assert.match(identityAgent, /OpenRappterResearchTwin/);
  assert.ok(identityAgent.includes(twin.instance_rappid));
  assert.match(identityAgent, /os\.path\.join\(/);
  assert.match(identityAgent, /"identity",\s+"openrappter\.json"/s);
  const tileIdentity = JSON.parse(fs.readFileSync(
    path.join(twin.beta_home, "identity", "openrappter.json"),
    "utf8",
  ));
  assert.equal(tileIdentity.rappid, twin.instance_rappid);
  assert.equal(tileIdentity.origin, "hatched-twin");
  assert.equal(
    new OpenRappterTileStore({
      betaHome: twin.beta_home,
      brainstemDir: twin.brainstem_dir,
    }).describe().rappid,
    twin.instance_rappid,
    "identity agent, hatch metadata, and self tile share one authority",
  );
  assert.equal(fs.statSync(twin.metadata_path).mode & 0o777, 0o600);
  assert.notEqual(twin.python, parentPython);
  assert.notEqual(fs.statSync(twin.python).ino, fs.statSync(parentPython).ino);
  fs.writeFileSync(twin.python, "twin python\n");
  assert.equal(fs.readFileSync(parentPython, "utf8"), "parent python\n");
  fs.writeFileSync(
    path.join(twin.brainstem_dir, "agents", "hello_agent.py"),
    "# twin-only hotload\n",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "runtime", "agents", "hello_agent.py"), "utf8"),
    "# agent\n",
    "a twin hotload must not mutate the runtime it hatched from",
  );

  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.equal(launch.command, "/Applications/Electron.app/Contents/MacOS/Electron");
  assert.ok(launch.args.includes(path.join(root, "package")));
  assert.ok(launch.args.some((arg) => arg.startsWith("--user-data-dir=")));
  assert.equal(launch.options.env.OPENRAPPTER_INSTANCE, "research-twin");
  assert.equal(
    launch.options.env.OPENRAPPTER_NEIGHBORHOOD_ID,
    twin.neighborhood_id,
  );
  assert.equal(
    launch.options.env.OPENRAPPTER_PARENT_NEIGHBORHOOD_ID,
    "openrappter:alpha",
  );
  assert.equal(launch.options.env.OPENRAPPTER_NEIGHBORHOOD_GENERATION, "1");
  assert.equal(
    launch.options.env.OPENRAPPTER_INSTANCE_TOKEN,
    twin.instance_token,
  );
  assert.equal(launch.options.env.BRAINSTEM_BETA_OWN_PORT, "1");
  assert.equal(launch.options.env.BRAINSTEM_BETA_SOURCE_DIR, twin.brainstem_dir);
  assert.equal(launch.options.env.BRAINSTEM_BETA_PYTHON, twin.python);
  assert.notEqual(launch.options.env.BRAINSTEM_BETA_HOME, path.join(root, "desktop"));
});

test("hatch names are safe and a live twin cannot be overwritten", async (t) => {
  const { hatchery } = fixture(t);
  await assert.rejects(() => hatchery.hatch("../escape"), /name|safe|slug/i);
  await hatchery.hatch("Research Twin");
  await assert.rejects(
    () => hatchery.hatch("research-twin"),
    /already running/i,
  );
});

test("hatchery lists durable local twin metadata", async (t) => {
  const { hatchery } = fixture(t);
  await hatchery.hatch("Alpha Twin");
  const listed = await hatchery.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "alpha-twin");
  assert.equal(listed[0].running, true);
});

test("hatch stop uses the owned capability and never signals a bare PID", async (t) => {
  const { controlActions, hatchery } = fixture(t);
  const twin = await hatchery.hatch("Safe Stop");
  const stopped = await hatchery.stop("safe-stop");
  assert.deepEqual(stopped, {
    name: "safe-stop",
    stopped: true,
    pid: twin.pid,
  });
  assert.equal(controlActions.at(-1).action, "stop");
  assert.equal(
    controlActions.at(-1).metadata.instance_token,
    twin.instance_token,
  );
});

test("a live PID without the instance capability fails closed", async (t) => {
  const { hatchery } = fixture(t, {
    instanceControl: async () => false,
  });
  const first = await hatchery.hatch("Recycled PID");
  const metadata = JSON.parse(fs.readFileSync(first.metadata_path, "utf8"));
  metadata.launched_at = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(first.metadata_path, `${JSON.stringify(metadata, null, 2)}\n`);
  await assert.rejects(
    () => hatchery.hatch("Recycled PID"),
    /live PID.*cannot be verified|refusing to replace/i,
  );
  const stopped = await hatchery.stop("recycled-pid");
  assert.equal(stopped.stopped, false);
  assert.match(stopped.reason, /capability.*verified/i);
});

test("a failed first spawn reuses its persisted identity on retry", async (t) => {
  let attempts = 0;
  const { hatchery, root } = fixture(t, {
    spawnImpl: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient spawn failure");
      return { pid: 4242, unref() {} };
    },
  });
  await assert.rejects(
    () => hatchery.hatch("Retry Twin"),
    /transient spawn failure/,
  );
  const identityPath = path.join(
    root,
    "openrappter",
    "twins",
    "retry-twin",
    "desktop",
    "identity",
    "openrappter.json",
  );
  const stranded = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const retried = await hatchery.hatch("Retry Twin");
  assert.equal(retried.instance_rappid, stranded.rappid);
  assert.equal(attempts, 2);
});

test("a neighborhood can recursively hatch a bounded child neighborhood", async (t) => {
  const { hatchery, root } = fixture(t);
  const parent = await hatchery.hatch("Parent Hood");
  const childLaunches = [];
  const childHatchery = new OpenRappterHatchery({
    brainstemRuntimeDir: parent.brainstem_dir,
    electronPath: "/Applications/Electron.app/Contents/MacOS/Electron",
    openRappterHome: parent.root,
    packageDir: path.join(root, "package"),
    parentGeneration: parent.generation,
    parentNeighborhoodId: parent.neighborhood_id,
    pythonPath: parent.python,
    processAlive: () => false,
    instanceControl: async () => false,
    spawnImpl: (command, args, options) => {
      childLaunches.push({ command, args, options });
      return { pid: 5252, unref() {} };
    },
  });
  const child = await childHatchery.hatch("Child Hood");
  assert.equal(child.parent_neighborhood_id, parent.neighborhood_id);
  assert.equal(child.generation, 2);
  assert.match(
    child.neighborhood_id,
    /^openrappter:child-hood:[0-9a-f]{64}$/,
  );
  assert.equal(
    child.root.startsWith(`${parent.root}${path.sep}twins${path.sep}`),
    true,
  );
  assert.equal(
    childLaunches[0].options.env.OPENRAPPTER_NEIGHBORHOOD_GENERATION,
    "2",
  );
  const childManifest = JSON.parse(fs.readFileSync(
    path.join(child.beta_home, "neighborhood.json"),
    "utf8",
  ));
  assert.equal(childManifest.estate_id, `estate:${child.neighborhood_id}`);
  assert.equal(childManifest.parent_neighborhood_id, parent.neighborhood_id);
  assert.equal(childManifest.generation, 2);
  childHatchery.parentGeneration = 8;
  await assert.rejects(
    () => childHatchery.hatch("Too Deep"),
    /limited to 8 generations/,
  );
});

test("explicit recovery archives metadata only after its PID is dead", async (t) => {
  const { hatchery } = fixture(t);
  const first = await hatchery.hatch("Recover Twin");
  const metadata = JSON.parse(fs.readFileSync(first.metadata_path, "utf8"));
  metadata.pid = 9999;
  fs.writeFileSync(first.metadata_path, `${JSON.stringify(metadata, null, 2)}\n`);
  const identityPath = path.join(
    first.beta_home,
    "identity",
    "openrappter.json",
  );
  const conflicting = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  conflicting.rappid = `rappid:@openrappter/local:${"a".repeat(64)}`;
  fs.writeFileSync(identityPath, `${JSON.stringify(conflicting, null, 2)}\n`);
  const recovered = hatchery.recover("recover-twin");
  assert.equal(recovered.recovered, true);
  assert.equal(fs.existsSync(first.metadata_path), false);
  assert.equal(fs.existsSync(recovered.archive), true);
  assert.equal(fs.existsSync(recovered.identity_archive), true);
  assert.equal(
    JSON.parse(fs.readFileSync(identityPath, "utf8")).rappid,
    first.instance_rappid,
  );
  const replacement = await hatchery.hatch("Recover Twin");
  assert.equal(replacement.instance_rappid, first.instance_rappid);
});

test("dead recovery recreates a missing identity before archiving authority", async (t) => {
  const { hatchery } = fixture(t);
  const first = await hatchery.hatch("Missing Identity");
  const metadata = JSON.parse(fs.readFileSync(first.metadata_path, "utf8"));
  metadata.pid = 9999;
  fs.writeFileSync(first.metadata_path, `${JSON.stringify(metadata, null, 2)}\n`);
  const identityPath = path.join(
    first.beta_home,
    "identity",
    "openrappter.json",
  );
  fs.rmSync(identityPath);
  const recovered = hatchery.recover("missing-identity");
  assert.equal(recovered.recovered, true);
  assert.equal(
    JSON.parse(fs.readFileSync(identityPath, "utf8")).rappid,
    first.instance_rappid,
  );
  assert.equal(fs.existsSync(first.metadata_path), false);
});

test("dead recovery validates authority before mutating metadata", async (t) => {
  const { hatchery } = fixture(t);
  const first = await hatchery.hatch("Malformed Identity");
  const metadata = JSON.parse(fs.readFileSync(first.metadata_path, "utf8"));
  metadata.pid = 9999;
  metadata.instance_rappid = "not-a-rappid";
  fs.writeFileSync(first.metadata_path, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.throws(
    () => hatchery.recover("malformed-identity"),
    /invalid RAPPID/,
  );
  assert.equal(fs.existsSync(first.metadata_path), true);
});

test("the packaged installer exposes openrappter-hatch", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const unix = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = fs.readFileSync(path.join(root, "install.cmd"), "utf8");
  assert.ok(packageJson.build.files.includes("scripts/openrappter-hatch.mjs"));
  assert.match(packageJson.scripts["twin:list"], /openrappter-hatch\.mjs list/);
  assert.match(unix, /\.local\/bin\/openrappter-hatch/);
  assert.match(windows, /openrappter-hatch\.cmd/);
});
