import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractRuntime, fileDigest } from '../macos/Resources/verified-runtime-bootstrap.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--archive', '--work', '--architecture', '--version'].includes(process.argv[i]));
  assert.ok(process.argv[i + 1] && !Object.hasOwn(options, process.argv[i]));
  options[process.argv[i]] = process.argv[i + 1];
}
assert.equal(Object.keys(options).length, 4);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await fsp.readFile(path.join(repository, 'macos/runtime-node-pins.json')));
const architecture = options['--architecture'];
const pin = pins.variants[architecture];
assert.ok(pin, 'unsupported runtime architecture');
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, architecture === 'x86_64' ? 'x64' : architecture);
assert.equal(process.versions.node, pin.version);
assert.equal(Number(process.versions.modules), pins.node_abi);
assert.equal(await fileDigest(process.execPath), pin.binary_sha256);

const work = path.resolve(options['--work']);
await fsp.mkdir(work, { mode: 0o700 });
const home = path.join(work, 'home');
await fsp.mkdir(home, { mode: 0o700 });
process.env.HOME = home;
process.env.CFFIXED_USER_HOME = home;
process.env.NODE_PATH = '';
const directory = await extractRuntime(
  path.resolve(options['--archive']), path.join(work, 'runtime'), new AbortController().signal,
);
const root = await fsp.realpath(directory);
const packageJSON = JSON.parse(await fsp.readFile(path.join(root, 'package.json')));
assert.equal(packageJSON.name, 'openrappter');
assert.equal(packageJSON.version, options['--version']);
const record = JSON.parse(await fsp.readFile(path.join(root, 'runtime-build.json')));
assert.equal(record.node_abi, Number(process.versions.modules));
const require = createRequire(path.join(root, 'package.json'));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    assert.ok(result.url.startsWith('node:')
      || (result.url.startsWith('file:') && fs.realpathSync(fileURLToPath(result.url)).startsWith(root + path.sep)),
    `dependency escaped the packaged runtime: ${specifier}`);
    return result;
  },
});
let server;
try {
  for (const name of Object.keys(packageJSON.dependencies).filter(name => !name.startsWith('@types/'))) {
    if (name === '@github/copilot') {
      const wrapperRoot = path.join(root, 'node_modules/@github/copilot');
      const wrapper = JSON.parse(await fsp.readFile(path.join(wrapperRoot, 'package.json')));
      assert.ok((await fsp.stat(path.join(wrapperRoot, wrapper.bin.copilot))).isFile(),
        'Copilot is a bin-only package, not an importable module');
      continue;
    }
    assert.ok(require.resolve(name).startsWith(root + path.sep), `missing packaged dependency ${name}`);
  }
  const database = require('better-sqlite3')(':memory:');
  try {
    assert.deepEqual(database.prepare('SELECT 42 AS answer').get(), { answer: 42 });
  } finally { database.close(); }
  const image = await require('sharp')({
    create: { width: 2, height: 2, channels: 4, background: '#00aa66' },
  }).png().toBuffer();
  assert.ok(image.length > 0, 'packaged libvips must execute, not merely resolve');

  const { resolveLocalCopilotCli } = await import(pathToFileURL(path.join(root, 'dist/providers/copilot-cli-local.js')));
  const copilot = resolveLocalCopilotCli();
  assert.ok(copilot.path?.startsWith(root + path.sep), 'Copilot must resolve from the packaged platform dependency');
  const nativeRelative = path.relative(root, copilot.path).split(path.sep).join('/');
  assert.equal(await fileDigest(copilot.path), record.native_files[nativeRelative]);
  const childEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|NODE_OPTIONS|COPILOT_CLI|GITHUB)/i.test(name)));
  const reported = spawnSync(copilot.path, ['--version'], {
    cwd: root, env: { ...childEnv, CI: 'true', NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(reported.status, 0, reported.stderr || reported.error?.message);
  assert.ok(reported.stdout.includes(copilot.version), 'packaged Copilot version must match its installed manifest');
  for (const [tool, binary] of [['ripgrep', 'rg'], ['tgrep', 'tgrep']]) {
    const executable = path.join(path.dirname(copilot.path), tool, 'bin', `darwin-${process.arch}`, binary);
    assert.equal(await fileDigest(executable), record.native_files[path.relative(root, executable).split(path.sep).join('/')]);
    const version = spawnSync(executable, ['--version'], {
      cwd: root, env: childEnv, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(version.status, 0, version.stderr || version.error?.message);
  }

  const { GatewayServer } = await import(pathToFileURL(path.join(root, 'dist/gateway/server.js')));
  server = new GatewayServer({
    port: 0, bind: 'loopback', auth: { mode: 'none' },
    dataDir: path.join(home, '.openrappter'), webRoot: path.join(root, 'ui/dist'),
  });
  let calls = 0;
  server.setAgentHandler(async request => {
    calls += 1;
    return {
      content: `offline producer smoke: ${request.message}`, sessionId: request.sessionId,
      finishReason: 'stop', model: 'producer-fixture',
    };
  });
  server.setBackendStatus({ kind: 'mock', reason: 'offline packaging fixture', model: 'producer-fixture' });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const health = await request(`${base}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.version, packageJSON.version, 'the compiled gateway must report this source version');
  const ui = await request(`${base}/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<html/i);
  const reply = await request(`${base}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_input: 'hello', session_id: 'bar-runtime-smoke' }),
  });
  assert.equal(reply.status, 200);
  assert.match(await reply.text(), /offline producer smoke: hello/);
  assert.equal(calls, 1, 'only the offline mock provider may answer');
  console.log(JSON.stringify({
    smoke: 'passed', architecture, version: packageJSON.version,
    node: process.versions.node, abi: Number(process.versions.modules),
    sqlite: 'executed', sharp: 'executed', copilot: copilot.version,
    gateway: 'healthy', dashboard: 'served', mock_chat: 'answered',
    archive_sha256: await fileDigest(options['--archive']),
  }));
} finally {
  if (server) await server.stop();
  hooks.deregister();
  await fsp.rm(work, { recursive: true, force: true });
}
