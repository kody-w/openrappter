#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORTED_FILENAME = 'RappFactory_Showcase_v5rough edit_backup.mp4';
const REPORTED_SIZE = 100 * 1024 * 1024 + 1;
const CHUNK_BYTES = 256 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function hashPath(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK_BYTES })) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { digest: hash.digest('hex'), size };
}

async function writeReportedFixture(template, destination) {
  const base = await readFile(template);
  const freeAtomSize = REPORTED_SIZE - base.length;
  assert(freeAtomSize >= 8 && freeAtomSize < 0x1_0000_0000, 'Invalid MP4 free atom size.');
  const handle = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  try {
    await handle.write(base);
    hash.update(base);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(freeAtomSize, 0);
    header.write('free', 4, 'ascii');
    await handle.write(header);
    hash.update(header);
    let remaining = freeAtomSize - header.length;
    let state = 0x4505_6a1d;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (remaining > 0) {
      const length = Math.min(buffer.length, remaining);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        buffer[index] = state & 0xff;
      }
      const chunk = buffer.subarray(0, length);
      await handle.write(chunk);
      hash.update(chunk);
      remaining -= length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function rpc(ws, method, params = {}) {
  const id = `${method}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'res' || frame.id !== id) return;
      ws.off('message', onMessage);
      if (frame.ok) resolve(frame.payload);
      else reject(new Error(frame.error?.message ?? `${method} failed`));
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

async function connectGateway(WebSocket, port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await rpc(ws, 'connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: 'media-release-smoke',
      version: '1.0.0',
      platform: process.platform,
      mode: 'webchat',
    },
    auth: { token },
  });
  return ws;
}

async function main() {
  const repository = path.resolve(import.meta.dirname, '..');
  const typescript = path.join(repository, 'typescript');
  const runtimePackage = process.env.OPENRAPPTER_MEDIA_RUNTIME_ROOT
    ? path.resolve(process.env.OPENRAPPTER_MEDIA_RUNTIME_ROOT)
    : typescript;
  const requested = process.argv[2] ?? '.media-release-smoke-artifacts';
  const scratch = path.resolve(repository, requested);
  const relative = path.relative(repository, scratch);
  assert(
    relative
      && !relative.startsWith('..')
      && !path.isAbsolute(relative)
      && path.basename(scratch).startsWith('.media-release-smoke'),
    'Smoke output must be a .media-release-smoke* directory inside the repository.',
  );
  const template = path.join(
    typescript,
    'src',
    'media',
    '__fixtures__',
    'one-frame.mp4',
  );
  const runtime = path.join(runtimePackage, 'dist');
  await stat(path.join(runtime, 'media', 'ingest.js'));
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true, mode: 0o700 });

  const source = path.join(scratch, REPORTED_FILENAME);
  const expectedDigest = await writeReportedFixture(template, source);
  assert((await stat(source)).size === REPORTED_SIZE, 'Reported fixture size is not exact.');

  const [
    { MediaIngestService },
    { MediaProcessor },
    { GatewayServer },
    { ShowAndTellAgent },
    { ShowAndTellStore },
  ] = await Promise.all([
    import(pathToFileURL(path.join(runtime, 'media', 'ingest.js')).href),
    import(pathToFileURL(path.join(runtime, 'media', 'processor.js')).href),
    import(pathToFileURL(path.join(runtime, 'gateway', 'server.js')).href),
    import(pathToFileURL(path.join(runtime, 'agents', 'ShowAndTellAgent.js')).href),
    import(pathToFileURL(path.join(runtime, 'show-and-tell', 'store.js')).href),
  ]);
  const requireFromRuntime = createRequire(path.join(runtimePackage, 'package.json'));
  const WebSocket = requireFromRuntime('ws');

  const media = new MediaIngestService({
    root: path.join(scratch, 'media'),
  });
  await media.initialize();
  const phases = [];
  const asset = await media.ingestLocalFile({
    sourcePath: source,
    sessionId: 'release-smoke-session',
    filename: REPORTED_FILENAME,
    mimeType: 'video/mp4',
    expectedSize: REPORTED_SIZE,
    expectedDigest,
    onProgress: (status) => {
      if (phases.at(-1) !== status.phase) phases.push(status.phase);
    },
  });
  assert(asset.size === REPORTED_SIZE, 'Final asset size changed.');
  assert(asset.digest === expectedDigest, 'Final asset digest changed.');
  assert(asset.probe?.probe === 'magic+ffprobe', 'Real ffprobe validation did not run.');
  assert(asset.probe?.width === 16 && asset.probe?.height === 16, 'Video dimensions changed.');
  const finalized = await hashPath(asset.privatePath);
  assert(finalized.size === REPORTED_SIZE, 'Finalized blob size changed.');
  assert(finalized.digest === expectedDigest, 'Finalized blob bytes changed.');

  const processed = await new MediaProcessor().processVerifiedAsset(asset);
  assert(processed.metadata.privatePath === asset.privatePath, 'Media processor lost verified path.');

  const showStore = new ShowAndTellStore(path.join(scratch, 'show-and-tell'));
  await showStore.initialize();
  const showSession = await showStore.createSession({
    title: 'Large media release smoke',
    intentHint: 'Consume a verified local video fixture',
  });
  const showAgent = new ShowAndTellAgent({
    store: showStore,
    localSurface: true,
    resolveMediaAsset: (assetId) => media.resolveAsset(assetId),
  });
  const showResult = JSON.parse(await showAgent.perform({
    action: 'media',
    session_id: showSession.id,
    asset_id: asset.id,
  }));
  assert(showResult.status === 'success', 'Show-and-Tell rejected the verified asset.');
  const showEvent = (await showStore.events(showSession.id))
    .find((event) => event.type === 'media.attached');
  assert(
    showEvent?.data?.verifiedPrivatePath === asset.privatePath,
    'Show-and-Tell did not consume the verified private path.',
  );

  const token = 'media-release-smoke-token';
  const gateway = new GatewayServer({
    port: 0,
    bind: 'loopback',
    auth: { mode: 'token', tokens: [token] },
    dataDir: scratch,
    heartbeatInterval: 60_000,
  });
  let resolveConsumed;
  const consumed = new Promise((resolve) => { resolveConsumed = resolve; });
  gateway.setAgentHandler(async (request) => {
    const attachment = request.attachments?.[0];
    assert(attachment?.path === asset.privatePath, 'Gateway did not resolve the private path.');
    const observed = await hashPath(attachment.path);
    resolveConsumed(observed);
    return {
      sessionId: request.sessionId ?? 'release-smoke-session',
      content: `verified:${observed.digest}`,
      finishReason: 'stop',
    };
  });
  await gateway.start();
  let ws;
  let gatewayObserved;
  try {
    ws = await connectGateway(WebSocket, gateway.port, token);
    const accepted = await rpc(ws, 'chat.send', {
      sessionKey: 'release-smoke-session',
      message: 'Consume the exact reported RappFactory video.',
      attachments: [{
        type: 'file',
        assetId: asset.id,
        digest: asset.digest,
        size: asset.size,
        mimeType: asset.mimeType,
        filename: REPORTED_FILENAME,
      }],
    });
    assert(accepted.status === 'accepted', 'Gateway did not accept verified Chat media.');
    gatewayObserved = await Promise.race([
      consumed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Gateway media consumer timed out.')),
        15_000,
      )),
    ]);
  } finally {
    ws?.close();
    await gateway.stop();
    showStore.close();
  }
  assert(gatewayObserved.size === REPORTED_SIZE, 'Gateway consumer saw the wrong size.');
  assert(gatewayObserved.digest === expectedDigest, 'Gateway consumer saw the wrong digest.');

  console.log(JSON.stringify({
    schema: 'openrappter-media-release-smoke/1.0',
    reportedFilename: REPORTED_FILENAME,
    reportedSize: REPORTED_SIZE,
    sha256: expectedDigest,
    phases,
    probe: asset.probe,
    finalizedPath: asset.privatePath,
    showAndTellEvent: showEvent.type,
    gatewayConsumedBytes: gatewayObserved.size,
    gatewayConsumedSha256: gatewayObserved.digest,
    runtimePackage,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
