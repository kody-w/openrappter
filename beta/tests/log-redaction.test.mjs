import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import vm from "node:vm";

import { BrainstemProcess } from "../electron/brainstem-process.mjs";
import {
  createExportRedactionScript,
  installProcessOutputRedaction,
  openPrivateAppendFile,
  redactCredentialText,
  RedactingLineTransform,
  rotateLogIfLarge,
  scrubDiagnosticValue,
} from "../electron/log-redaction.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";
import { testPython } from "./_python.mjs";


const GITHUB_TOKENS = [
  "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  "ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
];
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_123";
const BURST_LINE_COUNT = 5 * 1024;
const BURST_FILL = "x".repeat(1011);

async function transformChunks(chunks) {
  const transform = new RedactingLineTransform();
  const output = [];
  transform.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const completion = finished(transform, { cleanup: true });
  for (const chunk of chunks) transform.write(chunk);
  transform.end();
  await completion;
  return Buffer.concat(output);
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address
        ? address.port
        : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Could not allocate a fake-kernel port."));
      });
    });
  });
}

function resolvePython() {
  const candidates = [
    testPython(),
    process.env.PYTHON,
    process.platform === "win32" ? "python" : "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-c", "import sys; print(sys.executable)"],
      { encoding: "utf8", windowsHide: true },
    );
    const executable = String(result.stdout || "").trim();
    if (result.status === 0 && executable && existsSync(executable)) {
      return executable;
    }
  }
  throw new Error("A Python interpreter is required for the fake kernel test.");
}

function fakeKernelSource(lines) {
  return [
    "import json",
    "import os",
    "import threading",
    "import time",
    "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
    "",
    `LINES = ${JSON.stringify(lines)}`,
    `BURST_COUNT = ${BURST_LINE_COUNT}`,
    `BURST_FILL = ${JSON.stringify(BURST_FILL)}`,
    "",
    "class Handler(BaseHTTPRequestHandler):",
    "    def log_message(self, format, *args):",
    "        pass",
    "",
    "    def do_GET(self):",
    "        if self.path != '/health':",
    "            self.send_response(404)",
    "            self.end_headers()",
    "            return",
    "        payload = json.dumps({",
    "            'status': 'unauthenticated',",
    "            'version': 'fake-log-redaction-kernel',",
    "            'agents': [],",
    "        }).encode('utf-8')",
    "        self.send_response(200)",
    "        self.send_header('Content-Type', 'application/json')",
    "        self.send_header('Content-Length', str(len(payload)))",
    "        self.end_headers()",
    "        self.wfile.write(payload)",
    "",
    "server = ThreadingHTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler)",
    "threading.Thread(target=server.serve_forever, daemon=True).start()",
    "for line in LINES:",
    "    os.write(1, (line + '\\n').encode('utf-8'))",
    "os.write(2, b'stderr password=stderrPasswordValue tail\\n')",
    "os.write(1, b'partial api_')",
    "time.sleep(0.02)",
    "os.write(1, b'key=splitSecretValue tail\\n')",
    "for index in range(BURST_COUNT):",
    "    line = ('burst-%05d-' % index) + BURST_FILL + '\\n'",
    "    os.write(1, line.encode('ascii'))",
    "time.sleep(1.25)",
    "os.write(1, b'final enter LAST-CODE')",
    "server.shutdown()",
    "server.server_close()",
    "",
  ].join("\n");
}

test("credential-shaped text is replaced in place with typed markers", () => {
  const input = [
    `github ${GITHUB_TOKENS.join(" ")} tail`,
    "Authorization: Bearer authorizationSecretValue, request=kept",
    "proxy Bearer standaloneBearerValue after",
    "api_key=apiKeyValue api-key:'dashKeyValue'",
    'access_token=accessTokenValue refresh_token="refreshTokenValue" '
      + "id_token='idTokenValue'",
    '{"secret":"jsonSecretValue","token":"jsonTokenValue",'
      + '"password":"jsonPasswordValue","passwd":"jsonPasswdValue",'
      + '"client_secret":"jsonClientSecretValue"}',
    `jwt ${JWT} tail`,
    "function https://example.test/run?code=azureFunctionKeyValue&name=kept",
    "Device code login started: ABCD-EFGH",
    "WXYZ-1234 is the login code",
  ].join("\n");
  const output = redactCredentialText(input);

  for (const original of [
    ...GITHUB_TOKENS,
    "authorizationSecretValue",
    "standaloneBearerValue",
    "apiKeyValue",
    "dashKeyValue",
    "accessTokenValue",
    "refreshTokenValue",
    "idTokenValue",
    "jsonSecretValue",
    "jsonTokenValue",
    "jsonPasswordValue",
    "jsonPasswdValue",
    "jsonClientSecretValue",
    JWT,
    "azureFunctionKeyValue",
    "ABCD-EFGH",
    "WXYZ-1234",
  ]) {
    assert.doesNotMatch(output, new RegExp(original.replaceAll(".", "\\.")));
  }
  for (const marker of [
    "[redacted:github-token]",
    "[redacted:authorization]",
    "[redacted:bearer]",
    "[redacted:api-key]",
    "[redacted:secret]",
    "[redacted:token]",
    "[redacted:password]",
    "[redacted:jwt]",
    "[redacted:function-key]",
    "[redacted:device-code]",
  ]) {
    assert.match(output, new RegExp(marker.replaceAll("[", "\\[")));
  }
  assert.match(output, /request=kept/);
  assert.match(output, /name=kept/);
  assert.equal(redactCredentialText(output), output);
});

test("line transform preserves ordinary bytes and joins partial sensitive lines", async () => {
  const ordinary = Buffer.from(
    [
      "ordinary line remains exactly: [] {} 0123456789",
      "requests.exceptions.ConnectionError: failed",
      "GET https://login.microsoftonline.com/common/oauth2",
      "loaded module rapp_brainstem.agents.registry",
      "werkzeug.serving.WSGIRequestHandler ready",
      "exit code = 1; response code=404 for /agents",
      "user-agent: Mozilla/5.0",
      "starting multi-agent copilot; enter build-agent",
    ].join("\n") + "\r\n",
    "utf8",
  );
  const output = await transformChunks([
    ordinary.subarray(0, 13),
    ordinary.subarray(13),
    Buffer.from("partial api_"),
    Buffer.from("key=splitSecretValue tail\nfinal enter LAST-CODE"),
  ]);
  const expected = Buffer.concat([
    ordinary,
    Buffer.from(
      "partial api_key=[redacted:api-key] tail\n"
        + "final enter [redacted:device-code]",
    ),
  ]);
  assert.deepEqual(output, expected);
});

test("launcher process output is redacted across split writes", () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const installed = installProcessOutputRedaction({ stdout, stderr });

  stdout.write("partial api_");
  stdout.write("key=launcherSecretValue tail\n");
  stderr.write("final enter LAST-CODE");
  installed.flush();
  installed.restore();

  const text = Buffer.concat(output).toString("utf8");
  assert.doesNotMatch(text, /launcherSecretValue|LAST-CODE/);
  assert.match(text, /\[redacted:api-key\]/);
  assert.match(text, /\[redacted:device-code\]/);
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const bootstrap = readFileSync(
    new URL("../electron/bootstrap.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(manifest.main, "electron/bootstrap.mjs");
  assert.match(bootstrap, /installProcessOutputRedaction\(\)/);
  assert.match(bootstrap, /await import\("\.\/main\.mjs"\)/);
});

test("diagnostic scrub mirrors report privacy protections recursively", () => {
  const original = {
    access_token: GITHUB_TOKENS[0],
    nested: {
      user_code: "ABCD-EFGH",
      note: `contact learner@example.com from 192.168.10.20 at /Users/learner/project using ${JWT}`,
      url: "https://example.test/run?code=azureFunctionKeyValue&user=learner",
    },
  };
  const scrubbed = scrubDiagnosticValue(original, {
    roots: ["/Users/learner/project"],
  });

  assert.equal(scrubbed.access_token, "[redacted:token]");
  assert.equal(scrubbed.nested.user_code, "[redacted:device-code]");
  assert.doesNotMatch(JSON.stringify(scrubbed), /learner@example\.com/);
  assert.doesNotMatch(JSON.stringify(scrubbed), /192\.168\.10\.20/);
  assert.doesNotMatch(JSON.stringify(scrubbed), /\/Users\/learner/);
  assert.doesNotMatch(JSON.stringify(scrubbed), /azureFunctionKeyValue/);
  assert.doesNotMatch(JSON.stringify(scrubbed), /signature_123/);
  assert.match(scrubbed.nested.note, /<REDACTED_EMAIL>/);
  assert.match(scrubbed.nested.note, /<REDACTED_IP>/);
  assert.match(scrubbed.nested.note, /<REDACTED_PATH>/);
  assert.match(scrubbed.nested.url, /<REDACTED_QUERY>/);
});

test("Frontier JSON Blob exports are scrubbed before download", async () => {
  const context = vm.createContext({
    Blob,
    window: { Blob },
  });
  vm.runInContext(
    createExportRedactionScript({ roots: ["/Users/learner"] }),
    context,
  );
  const blob = new context.window.Blob([
    JSON.stringify({
      session_id: "session-private-value",
      transcript: [{
        role: "user",
        content: `remember token=${GITHUB_TOKENS[1]} from learner@example.com`,
      }],
    }, null, 2),
  ], { type: "application/json" });
  const exported = JSON.parse(await blob.text());

  assert.equal(exported.session_id, "[redacted:private]");
  assert.doesNotMatch(JSON.stringify(exported), /session-private-value/);
  assert.doesNotMatch(JSON.stringify(exported), /gho_/);
  assert.doesNotMatch(JSON.stringify(exported), /learner@example\.com/);
  assert.match(exported.transcript[0].content, /\[redacted:token\]/);
  assert.match(exported.transcript[0].content, /<REDACTED_EMAIL>/);
});

test("route telemetry redacts device codes and credential-bearing previews", () => {
  const manager = Object.create(BetaRouteManager.prototype);
  manager.telemetry = [];
  manager.telemetrySequence = 0;
  const event = manager.recordTelemetry("login-forwarded", {
    response_preview: "Enter code ABCD-EFGH and api_key=telemetrySecret",
    token: GITHUB_TOKENS[2],
  });

  assert.equal(event.token, "[redacted:token]");
  assert.equal(
    event.response_preview,
    "Enter code [redacted:device-code] and api_key=[redacted:api-key]",
  );
  assert.doesNotMatch(JSON.stringify(manager.telemetry), /ABCD-EFGH/);
  assert.doesNotMatch(JSON.stringify(manager.telemetry), /telemetrySecret/);
  assert.doesNotMatch(JSON.stringify(manager.telemetry), /ghu_/);
});

test("log shutdown is bounded when an inherited pipe never reaches EOF", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-log-flush-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logFile = path.join(root, "logs", "worker.log");
  const worker = new BrainstemProcess({
    logFile,
    logFlushTimeoutMs: 25,
  });
  worker.logFd = openPrivateAppendFile(logFile);
  worker.logStream = createWriteStream(logFile, {
    fd: worker.logFd,
    autoClose: false,
  });
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
  worker.captureOutput(child);
  child.stdout.write("ordinary before inherited pipe\n");

  const startedAt = Date.now();
  await assert.rejects(
    worker.closeLog(child),
    /Timed out flushing Brainstem output/,
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.match(readFileSync(logFile, "utf8"), /ordinary before inherited pipe/);
});

test("BrainstemProcess redacts both fake-kernel streams without burst loss", async (t) => {
  const artifactRoot = process.env.LOG_REDACTION_TEST_ROOT;
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(path.join(
    artifactRoot || tmpdir(),
    "rapp-log-redaction-",
  ));
  if (!artifactRoot) {
    t.after(() => rmSync(root, { recursive: true, force: true }));
  }
  const brainstemDir = path.join(root, "brainstem");
  const logDirectory = path.join(root, "logs", "workers");
  const logFile = path.join(logDirectory, "fake-worker.log");
  mkdirSync(brainstemDir, { recursive: true });
  mkdirSync(logDirectory, { recursive: true, mode: 0o755 });
  const ordinaryLines = [
    "legacy ordinary line",
    "ordinary line remains exactly: [] {} 0123456789",
    "ordinary CRLF bytes\r",
    "requests.exceptions.ConnectionError at login.microsoftonline.com; exit code = 1; response code=404; user-agent unchanged",
  ];
  const emittedLines = [
    `github ${GITHUB_TOKENS.join(" ")}`,
    "Authorization: Bearer authorizationSecretValue, request=kept",
    "proxy Bearer standaloneBearerValue after",
    "api_key=apiKeyValue api-key='dashKeyValue'",
    'access_token=accessTokenValue refresh_token="refreshTokenValue" '
      + "id_token='idTokenValue'",
    '{"secret":"jsonSecretValue","token":"jsonTokenValue",'
      + '"password":"jsonPasswordValue","passwd":"jsonPasswdValue",'
      + '"client_secret":"jsonClientSecretValue"}',
    `jwt ${JWT} tail`,
    "function https://example.test/run?code=azureFunctionKeyValue&name=kept",
    "Device code login started: ABCD-EFGH",
    ordinaryLines[1],
    ordinaryLines[2],
    ordinaryLines[3],
  ];
  writeFileSync(
    path.join(brainstemDir, "brainstem.py"),
    fakeKernelSource(emittedLines),
    { mode: 0o600 },
  );
  writeFileSync(logFile, `${ordinaryLines[0]}\n`, { mode: 0o644 });
  if (process.platform !== "win32") {
    chmodSync(logDirectory, 0o755);
    chmodSync(logFile, 0o644);
  }

  const port = await allocatePort();
  const worker = new BrainstemProcess({
    brainstemDir,
    brainstemHome: root,
    env: { PYTHONUNBUFFERED: "1" },
    logFile,
    port,
    python: resolvePython(),
    url: `http://127.0.0.1:${port}`,
  });
  t.after(() => worker.stop());

  await worker.start();
  const child = worker.child;
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "close");
  }
  await worker.stop();

  const logBytes = readFileSync(logFile);
  const logText = logBytes.toString("utf8");
  for (const original of [
    ...GITHUB_TOKENS,
    "authorizationSecretValue",
    "standaloneBearerValue",
    "apiKeyValue",
    "dashKeyValue",
    "accessTokenValue",
    "refreshTokenValue",
    "idTokenValue",
    "jsonSecretValue",
    "jsonTokenValue",
    "jsonPasswordValue",
    "jsonPasswdValue",
    "jsonClientSecretValue",
    JWT,
    "azureFunctionKeyValue",
    "ABCD-EFGH",
    "stderrPasswordValue",
    "splitSecretValue",
    "LAST-CODE",
  ]) {
    assert.equal(logText.includes(original), false, `log retained ${original}`);
  }
  for (const marker of [
    "[redacted:github-token]",
    "[redacted:authorization]",
    "[redacted:bearer]",
    "[redacted:api-key]",
    "[redacted:secret]",
    "[redacted:token]",
    "[redacted:password]",
    "[redacted:jwt]",
    "[redacted:function-key]",
    "[redacted:device-code]",
  ]) {
    assert.equal(logText.includes(marker), true, `log omitted ${marker}`);
  }
  assert.equal(
    logBytes.includes(Buffer.from(`${ordinaryLines[0]}\n`)),
    true,
  );
  assert.equal(
    logBytes.includes(Buffer.from(`${ordinaryLines[1]}\n`)),
    true,
  );
  assert.equal(
    logBytes.includes(Buffer.from(`${ordinaryLines[2]}\n`)),
    true,
  );
  assert.equal(
    logBytes.includes(Buffer.from(`${ordinaryLines[3]}\n`)),
    true,
  );
  assert.match(
    logText,
    /partial api_key=\[redacted:api-key\] tail/,
  );
  assert.match(logText, /final enter \[redacted:device-code\]$/);

  const burstLines = logText
    .split("\n")
    .filter((line) => line.startsWith("burst-"));
  assert.equal(burstLines.length, BURST_LINE_COUNT);
  assert.equal(burstLines[0], `burst-00000-${BURST_FILL}`);
  assert.equal(
    burstLines.at(-1),
    `burst-${String(BURST_LINE_COUNT - 1).padStart(5, "0")}-${BURST_FILL}`,
  );

  if (process.platform !== "win32") {
    assert.equal(statSync(logDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
  }
  if (artifactRoot) console.log(`LOG_REDACTION_TEST_FILE=${logFile}`);
});

test("a log that outgrew its limit rotates into free predecessor slots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-log-rotate-"));
  try {
    const file = path.join(root, "worker.log");
    writeFileSync(file, "x".repeat(2048));
    assert.equal(rotateLogIfLarge(file, { maxBytes: 4096 }), false, "under the limit: untouched");
    assert.equal(readFileSync(file, "utf8").length, 2048);

    writeFileSync(file, "y".repeat(8192));
    assert.equal(rotateLogIfLarge(file, { maxArchives: 2, maxBytes: 4096 }), true);
    assert.ok(!existsSync(file), "the live log is rotated away");
    assert.equal(readFileSync(`${file}.1`, "utf8").length, 8192);

    writeFileSync(file, "z".repeat(8192));
    assert.equal(rotateLogIfLarge(file, { maxArchives: 2, maxBytes: 4096 }), true);
    assert.equal(readFileSync(`${file}.1`, "utf8")[0], "y");
    assert.equal(readFileSync(`${file}.2`, "utf8")[0], "z");

    assert.equal(rotateLogIfLarge(path.join(root, "absent.log")), false, "a missing log is not an error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated rotation preserves every live writer inode in a new slot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-log-live-rotate-"));
  let firstFd = null;
  let secondFd = null;
  try {
    const file = path.join(root, "shared.log");
    writeFileSync(file, "first\n");
    firstFd = openPrivateAppendFile(file);
    assert.equal(rotateLogIfLarge(file, { maxBytes: 1 }), true);

    writeFileSync(file, "second\n");
    secondFd = openPrivateAppendFile(file);
    assert.equal(
      rotateLogIfLarge(file, { maxBytes: 1 }),
      true,
      "an occupied predecessor must move the next inode into a new slot",
    );
    writeSync(firstFd, "first-after-second-rotation\n");
    writeSync(secondFd, "second-after-rotation\n");
    if (process.platform !== "win32") {
      assert.ok(fstatSync(firstFd).nlink > 0);
      assert.ok(fstatSync(secondFd).nlink > 0);
    }

    const archives = readdirSync(root)
      .filter((name) => name.startsWith("shared.log."));
    assert.deepEqual(archives, ["shared.log.1", "shared.log.2"]);
    assert.match(readFileSync(`${file}.1`, "utf8"), /first-after-second-rotation/);
    assert.match(readFileSync(`${file}.2`, "utf8"), /second-after-rotation/);

    const failed = path.join(root, "failed.log");
    writeFileSync(failed, "too large");
    assert.equal(
      rotateLogIfLarge(failed, {
        link: () => {
          throw new Error("simulated link failure");
        },
        maxBytes: 1,
      }),
      false,
    );
    assert.ok(existsSync(failed));
  } finally {
    if (firstFd !== null) closeSync(firstFd);
    if (secondFd !== null) closeSync(secondFd);
    rmSync(root, { recursive: true, force: true });
  }
});
