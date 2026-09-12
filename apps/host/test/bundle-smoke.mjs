import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanChain, selectChainTrust } from "../../../packages/rapp1/dist/index.js";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(hostRoot, ".test-scratch", `bundle-${randomUUID()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
let child;
let exit;
async function start() {
  const token = randomBytes(48).toString("base64url");
  child = fork(join(hostRoot, "dist", "host.cjs"), [], {
    cwd: directory, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { HOME: directory, PATH: "/usr/bin:/bin", TMPDIR: directory, NODE_ENV: "production" },
  });
  child.stderr.resume();
  exit = new Promise((resolve) => child.once("exit", resolve));
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Bundled host startup timed out.")), 15000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Bundled host exited during startup.")); });
    child.once("message", (message) => {
      clearTimeout(timeout);
      message.type === "ready" ? resolve(message) : reject(new Error("Bundled host rejected its bootstrap."));
    });
    child.send({ type: "bootstrap", protocolVersion: 1, token, dataDirectory: join(directory, "data") });
  });
  return async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}/rpc`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    });
    const envelope = await response.json();
    assert.equal(envelope.error, undefined, `Bundled RPC failed: ${method}`);
    return envelope.result;
  };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.send({ type: "shutdown" });
  let timer;
  try {
    await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Bundled host shutdown timed out.")); }, 6000);
    })]);
    assert.equal(child.exitCode, 0);
  } finally { clearTimeout(timer); }
}
try {
  let rpc = await start();
  const initial = await rpc("work.snapshot");
  const provider = (await rpc("providers.list"))[0];
  assert.ok(["ready", "unavailable"].includes(provider.availability));
  assert.ok(["authenticated", "required", "unverified"].includes(provider.authentication));
  const agent = await rpc("agents.save", {
    id: "bundle-worker", name: "Bundle worker", role: "Validation", instructions: "Only perform assigned work.",
    providerId: null, model: "", enabled: false, computerPolicy: "none", approvalPolicy: "always",
  });
  const task = await rpc("work.createTask", {
    requestId: randomUUID(), title: "Durable bundle work", instructions: "Retain this assigned task without executing it.",
    agentId: agent.id, priority: "normal",
  });
  assert.notEqual(agent.id, agent.workspaceId);
  assert.equal(task.workspaceId, agent.workspaceId);
  assert.equal((await rpc("computer.inspect")).state, "unavailable");
  const workspace = join(directory, "data", "workspaces", agent.workspaceId);
  const manifest = JSON.parse(await readFile(join(workspace, "manifest.json"), "utf8"));
  const frames = await Promise.all((await readdir(join(workspace, "frames", "body"))).sort()
    .map(async (file) => JSON.parse(await readFile(join(workspace, "frames", "body", file), "utf8"))));
  const { genesis, head } = manifest.streams.body;
  const scan = scanChain(frames, selectChainTrust({
    genesis: { stream_id: genesis.stream_id, payload_hash: genesis.payload_hash, frame_hash: genesis.frame_hash },
    persistedHead: head, requireCommittedHead: true,
  }));
  assert.equal(scan.ok, true);
  assert.ok(frames.length >= 9);
  assert.equal((await stat(join(workspace, "identity.json"))).mode & 0o777, 0o600);
  await stop();
  rpc = await start();
  const restored = await rpc("work.snapshot");
  assert.equal(restored.ownerId, initial.ownerId);
  assert.equal(restored.agents[0].workspaceId, agent.workspaceId);
  assert.equal(restored.tasks[0].id, task.id);
  assert.equal(restored.runs.length, 0);
  await stop();
  console.log(JSON.stringify({
    status: "passed", bundledHost: true, restartPersistence: true, canonicalFramesScanned: frames.length,
    copilot: { availability: provider.availability, authentication: provider.authentication, modelRequests: 0 },
  }));
} finally {
  if (child && child.exitCode === null) { child.kill("SIGKILL"); await exit; }
  await rm(directory, { recursive: true, force: true });
}
