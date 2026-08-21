import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  BrainstemProcess,
  isBrainstemHealth,
  resolveBrainstemConfig,
  waitForHealth,
} from "../electron/brainstem-process.mjs";
import { testPython } from "./_python.mjs";

test("beta launcher resolves the shared global Brainstem", () => {
  const config = resolveBrainstemConfig({
    env: {},
    platform: "linux",
    home: "/tmp/example-home",
  });
  assert.equal(config.brainstemHome, "/tmp/example-home/.brainstem");
  assert.equal(
    config.brainstemDir,
    path.posix.join("/tmp/example-home/.brainstem", "src", "rapp_brainstem"),
  );
  assert.equal(
    config.python,
    path.posix.join("/tmp/example-home/.brainstem", "venv", "bin", "python"),
  );
  assert.equal(
    config.logFile,
    path.posix.join("/tmp/example-home/.brainstem", "logs", "beta-brainstem.log"),
  );
  assert.equal(config.port, 7071);
});

test("beta launcher resolves Windows Brainstem paths on every host", () => {
  const home = String.raw`C:\Users\example`;
  const brainstemHome = path.win32.join(home, ".brainstem");
  const config = resolveBrainstemConfig({
    env: {},
    platform: "win32",
    home,
  });
  assert.equal(config.brainstemHome, brainstemHome);
  assert.equal(
    config.brainstemDir,
    path.win32.join(brainstemHome, "src", "rapp_brainstem"),
  );
  assert.equal(
    config.python,
    path.win32.join(brainstemHome, "venv", "Scripts", "python.exe"),
  );
  assert.equal(
    config.logFile,
    path.win32.join(brainstemHome, "logs", "beta-brainstem.log"),
  );
});

test("beta launcher accepts authenticated and unauthenticated health", () => {
  const base = { version: "0.6.16", agents: [] };
  assert.equal(isBrainstemHealth({ ...base, status: "ok" }), true);
  assert.equal(isBrainstemHealth({ ...base, status: "unauthenticated" }), true);
  assert.equal(isBrainstemHealth({ status: "ok", version: "0.6.16" }), false);
  assert.equal(isBrainstemHealth({ status: "other", ...base }), false);
});

test("health wait stops when the child exits", async () => {
  let calls = 0;
  const result = await waitForHealth("http://127.0.0.1:7071", {
    timeoutMs: 5_000,
    intervalMs: 1,
    probe: async () => {
      calls += 1;
      return null;
    },
    exited: () => calls >= 2,
  });
  assert.equal(result, null);
  assert.equal(calls, 2);
});

test("health wait stops when the child exits from a signal", async () => {
  const brainstem = new BrainstemProcess({});
  brainstem.child = { exitCode: null, signalCode: "SIGKILL" };
  let calls = 0;

  const result = await waitForHealth("http://127.0.0.1:7071", {
    timeoutMs: 5_000,
    intervalMs: 1,
    probe: async () => {
      calls += 1;
      return null;
    },
    exited: () => brainstem.hasExited(),
  });

  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("an asynchronous spawn error rejects start without crashing", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "frontier-spawn-error-"));
  const sourceDir = path.join(root, "rapp_brainstem");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "brainstem.py"), "print('never runs')\n");
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  const failure = Object.assign(new Error("spawn fake-python EACCES"), {
    code: "EACCES",
  });
  const brainstem = new BrainstemProcess({
    brainstemDir: sourceDir,
    logFile: path.join(root, "worker.log"),
    ownPort: true,
    port: 1,
    portPreallocated: true,
    python: process.execPath,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.exitCode = -13;
        child.stdout.end();
        child.stderr.end();
        child.emit("error", failure);
      });
      return child;
    },
    url: "http://127.0.0.1:1",
  });
  t.after(async () => {
    await brainstem.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const startedAt = Date.now();

  await assert.rejects(brainstem.start(), /EACCES/);

  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(brainstem.owned, false);
});

test("health wait returns the first valid response", async () => {
  const health = { status: "unauthenticated", version: "0.6.16", agents: [] };
  let calls = 0;
  const result = await waitForHealth("http://127.0.0.1:7071", {
    timeoutMs: 100,
    intervalMs: 1,
    probe: async () => {
      calls += 1;
      return calls === 2 ? health : null;
    },
  });
  assert.deepEqual(result, health);
});

test("owned-port launch ignores a listener on the configured port", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "frontier-own-port-"));
  const sourceDir = path.join(root, "rapp_brainstem");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "brainstem.py"), String.raw`
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({
            "status": "ok",
            "version": "e2e-fake",
            "agents": [],
            "brainstem_dir": os.path.dirname(os.path.abspath(__file__)),
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

ThreadingHTTPServer(
    ("127.0.0.1", int(os.environ["PORT"])),
    Handler,
).serve_forever()
`);

  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert(address && typeof address !== "string");

  const config = resolveBrainstemConfig({
    env: {
      BRAINSTEM_BETA_OWN_PORT: "1",
      BRAINSTEM_BETA_PORT: String(address.port),
      BRAINSTEM_BETA_PYTHON: testPython(),
      BRAINSTEM_BETA_SOURCE_DIR: sourceDir,
      BRAINSTEM_HOME: path.join(root, "home"),
    },
    home: root,
  });
  const brainstem = new BrainstemProcess(config);
  t.after(async () => {
    await brainstem.stop();
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const result = await brainstem.start();
  assert.equal(result.reused, false);
  assert.equal(brainstem.owned, true);
  assert.notEqual(result.port, address.port);
  assert.equal(result.health.version, "e2e-fake");
});

test("owned-port launch rejects health from a foreign listener", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "frontier-foreign-port-"));
  const sourceDir = path.join(root, "rapp_brainstem");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "brainstem.py"), "raise SystemExit(3)\n");

  const foreign = createHttpServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.stringify({
      agents: [],
      brainstem_dir: path.join(root, "foreign"),
      status: "ok",
      version: "foreign",
    });
    response.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(0, "127.0.0.1", resolve);
  });
  const address = foreign.address();
  assert(address && typeof address !== "string");

  const brainstem = new BrainstemProcess({
    ...resolveBrainstemConfig({
      env: {
        BRAINSTEM_BETA_OWN_PORT: "1",
        BRAINSTEM_BETA_PORT: String(address.port),
        BRAINSTEM_BETA_PYTHON: testPython(),
        BRAINSTEM_BETA_SOURCE_DIR: sourceDir,
        BRAINSTEM_HOME: path.join(root, "home"),
      },
      home: root,
    }),
    portPreallocated: true,
  });
  t.after(async () => {
    await brainstem.stop();
    await new Promise((resolve) => {
      foreign.close(resolve);
      foreign.closeAllConnections?.();
    });
    rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    brainstem.start(),
    /did not identify the owned source/,
  );
  assert.equal(brainstem.owned, false);
});
