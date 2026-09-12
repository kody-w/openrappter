import { z } from "zod";
import { createLocalServices } from "./local.js";
import { createHost, type RunningHost } from "./server.js";

type ParentPort = {
  on(event: "message", callback: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const bootstrapSchema = z.strictObject({
  type: z.literal("bootstrap"), protocolVersion: z.literal(1),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43,256}$/),
  dataDirectory: z.string().min(1).max(4096),
});
const shutdownSchema = z.strictObject({ type: z.literal("shutdown") });
let started = false;
let stopping = false;
let host: RunningHost | undefined;
const post = (message: unknown) => {
  if (parent) parent.postMessage(message);
  else if (process.send) process.send(message);
};
async function stop() {
  if (stopping) return;
  stopping = true;
  await host?.close();
  process.exit(0);
}
async function receive(raw: unknown) {
  if (shutdownSchema.safeParse(raw).success) { await stop(); return; }
  if (started || stopping) return;
  const bootstrap = bootstrapSchema.safeParse(raw);
  if (!bootstrap.success) { post({ type: "failed", code: "INVALID_BOOTSTRAP" }); return; }
  started = true;
  clearTimeout(bootstrapTimeout);
  try {
    host = await createHost(createLocalServices({
      directory: bootstrap.data.dataDirectory, token: bootstrap.data.token,
    }));
    if (stopping) { await host.close(); return; }
    post({ type: "ready", protocolVersion: 1, port: host.port, instanceId: host.instanceId });
  } catch {
    post({ type: "failed", code: "HOST_START_FAILED" });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50).unref();
  }
}
const bootstrapTimeout = setTimeout(() => {
  post({ type: "failed", code: "BOOTSTRAP_TIMEOUT" });
  process.exit(1);
}, 15000);
if (parent) parent.on("message", (event) => { void receive(event.data).catch(() => process.exit(1)); });
else if (process.send) process.on("message", (message) => { void receive(message).catch(() => process.exit(1)); });
else {
  clearTimeout(bootstrapTimeout);
  console.error("RAPP Work host must be started by its owning desktop process or an injected composition.");
  process.exitCode = 1;
}
process.on("disconnect", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
