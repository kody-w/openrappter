import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-scratch', 'work-browser');
const profile = path.join(output, `chrome-${process.pid}`);
const chrome = process.env.CHROME_BIN
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
await access(path.join(root, 'dist/index.html'));
await mkdir(profile, { recursive: true });

let scenario = 'unavailable';
let vmState = 'stopped';
let approvalPending = true;
const mutations = [];
const exceptions = [];
const requests = new Set();
const sockets = new Set();
const fixtureWorkspace = {
  id: 'fixture-ops', agentId: 'FixtureOps', name: 'Browser fixture workspace',
  rootPath: '/fixture/ops/files', memoryPath: '/fixture/ops/memory',
  isolation: 'dedicated', status: 'idle',
};

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture-viewer') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('BROWSER TEST DISPLAY — NOT A REAL VM');
      return;
    }
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const filename = path.resolve(root, 'dist', relative);
    if (!filename.startsWith(`${path.join(root, 'dist')}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.css': 'text/css' }[path.extname(filename)];
    const content = await readFile(filename);
    res.writeHead(200, { 'Content-Type': type ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (scenario === 'offline') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function fixtureRpc(method, params = {}) {
    let payload;
    const live = scenario === 'live' || scenario === 'unverified';
    switch (method) {
      case 'connect': payload = { server: { connId: 'browser-fixture-only' } }; break;
      case 'subscribe': payload = {}; break;
      case 'status': payload = { uptime: 12, connections: 1 }; break;
      case 'agents.list': payload = live ? [
        { id: 'FixtureOps', description: 'BROWSER FIXTURE — not real work' },
        ...Array.from({ length: 20 }, (_, index) => ({ id: `FixtureAgent${index}`, description: 'BROWSER FIXTURE — not real work' })),
      ] : []; break;
      case 'chat.list': payload = live ? [{
        id: 'fixture-thread', agentId: 'FixtureOps', title: 'Browser verification fixture', messageCount: 1,
        createdAt: '2026-09-11T12:00:00Z', updatedAt: '2026-09-11T12:01:00Z',
      }] : []; break;
      case 'chat.messages': payload = [{
        id: 'fixture-message', role: 'assistant', content: 'BROWSER FIXTURE — not an executed task.',
        timestamp: '2026-09-11T12:01:00Z',
        citations: [{ id: 'fixture-citation', title: 'Fixture source', source: '/fixture/source.csv', excerpt: 'Test data only.' }],
      }]; break;
      case 'exec.pending': payload = live && approvalPending
        ? [{ id: 'fixture-approval', command: 'TEST ONLY — no command executed', description: 'Browser fixture approval', status: 'pending' }] : []; break;
      case 'exec.respond':
        mutations.push(method);
        approvalPending = false;
        payload = { ok: true, approvalId: params.approvalId, approved: params.approved, status: params.approved ? 'approved' : 'denied' };
        break;
      case 'workspace.list': if (live) payload = { workspaces: [fixtureWorkspace] }; break;
      case 'workspace.get': if (live) payload = { workspace: fixtureWorkspace }; break;
      case 'vm.status': if (live) payload = { state: vmState, local: true, viewerUrl: `${origin}/fixture-viewer`, message: 'BROWSER FIXTURE — not a real VM.' }; break;
      case 'vm.start':
      case 'vm.stop':
        if (live) {
          mutations.push(method);
          vmState = method === 'vm.start' ? 'starting' : 'stopped';
          payload = { state: vmState, local: true };
        }
        break;
    }
    if (payload === undefined) throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    return payload;
}

let dispatch = fixtureRpc;
wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', async (raw) => {
    const { method, params = {}, id } = JSON.parse(String(raw));
    try {
      if (scenario === 'unverified' && method === 'work.rapp.verify') {
        throw Object.assign(new Error('Method not found: work.rapp.verify'), { code: -32601 });
      }
      const payload = await dispatch(method, params);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
        type: 'res', id, ok: false,
        error: { code: typeof error.code === 'number' ? error.code : -32603, message: error.message },
      }));
    }
  });
});

let browser;
let fixtureLoader;
let cdp;
let sessionId;
let sequence = 0;
const pending = new Map();
const report = { browser: chrome, profile: 'isolated; no personal cookies or tabs', scenarios: [], screenshots: [] };

async function waitFor(check, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${description}`);
}

function call(method, params = {}, targetSession = sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    cdp.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }));
  });
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

const app = "document.querySelector('openrappter-app')";
const work = `${app}?.shadowRoot?.querySelector('rapp-work')`;
const shadow = `${work}?.shadowRoot`;
const button = (label) => `[...${shadow}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;

async function navigate(theme, width) {
  await call('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1040, deviceScaleFactor: 1, mobile: width < 600 });
  await call('Page.navigate', { url: `${origin}/?scoutTheme=${theme}` });
  await waitFor(() => evaluate(`${shadow}?.querySelector('[data-demo]') !== null && !!${shadow}?.querySelector('[data-demo]')`), 'labeled demo');
}

async function screenshot(name) {
  const metrics = await call('Page.getLayoutMetrics');
  const size = metrics.cssContentSize;
  const result = await call('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
  });
  const filename = path.join(output, name);
  await writeFile(filename, Buffer.from(result.data, 'base64'));
  report.screenshots.push(path.relative(root, filename));
}

try {
  fixtureLoader = await createViteServer({
    root, configFile: false, appType: 'custom', cacheDir: path.join(output, 'vite-cache'),
    server: { middlewareMode: true, watch: null, fs: { allow: [path.resolve(root, '..')] } },
  });
  const fixtures = await fixtureLoader.ssrLoadModule('/src/__tests__/fixtures/work-rapp-fixture.ts');
  dispatch = fixtures.framedGateway(fixtureRpc);
  browser = spawn(chrome, [
    '--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-extensions', '--disable-breakpad', '--disable-crash-reporter',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--disk-cache-dir=${path.join(profile, 'cache')}`,
    `--crash-dumps-dir=${profile}`, 'about:blank',
  ], { cwd: root, env: { ...process.env, TMPDIR: output }, stdio: 'ignore' });
  let launchError;
  browser.on('error', (error) => { launchError = error; });
  let debugAddress;
  await waitFor(async () => {
    if (launchError) throw launchError;
    try {
      const [port, endpoint] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      debugAddress = `ws://127.0.0.1:${port}${endpoint}`;
      return true;
    } catch { return false; }
  }, 'isolated Chrome debugging endpoint');
  cdp = new WebSocket(debugAddress);
  cdp.on('message', (raw) => {
    const response = JSON.parse(String(raw));
    if (response.id) {
      const request = pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    }
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails);
    if (response.method === 'Network.requestWillBeSent') requests.add(response.params.request.url);
  });
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
  const target = await call('Target.createTarget', { url: 'about:blank' }, null);
  sessionId = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  report.version = (await call('Browser.getVersion', {}, null)).product;
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Network.enable');
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });

  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      await navigate(theme, width);
      assert.equal(await evaluate("document.documentElement.dataset.theme"), theme);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme}/${width}: no page overflow`);
      if (width < 600) {
        assert.equal(await evaluate(`[...${shadow}.querySelector('.inspector').children].every(panel =>
          Math.abs(panel.getBoundingClientRect().width - ${shadow}.querySelector('.inspector').getBoundingClientRect().width) < 1)`),
        true, `${theme}/${width}: mobile inspector panels fill the column`);
      }
      assert.equal(await evaluate(`${shadow}.querySelectorAll('.agent').length`), 3);
      assert.equal(await evaluate(`${button('Approve (demo)')}.disabled`), true);
      assert.equal(await evaluate(`${button('Start VM')}.disabled`), true);
      assert.equal(await evaluate(`${shadow}.querySelector('iframe') === null`), true);
      assert.equal(await evaluate(`[...${shadow}.querySelectorAll('rapp-verification')].some(badge =>
        badge.shadowRoot?.querySelector('[data-rapp-status="verified"]'))`), false, 'Demo never claims RAPP/1 verification');
      await screenshot(`work-${width < 600 ? 'mobile' : 'desktop'}-${theme}.png`);
      for (let repeat = 0; repeat < 2; repeat++) {
        await evaluate(`${shadow}.querySelector('[data-agent-id="example-operations"]').click()`);
        await waitFor(() => evaluate(`${shadow}.textContent.includes('Client handoff checklist')`), 'Operations thread');
        await evaluate(`${shadow}.querySelector('[data-agent-id="example-finance"]').click()`);
        await waitFor(() => evaluate(`${shadow}.textContent.includes('September operating review')`), 'Finance thread');
      }
      await evaluate(`${shadow}.querySelector('.evidence-item summary').focus()`);
      assert.equal(await evaluate(`${shadow}.activeElement?.tagName`), 'SUMMARY', 'Evidence has keyboard focus');
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitFor(() => evaluate(`${shadow}.querySelector('.evidence-item').open`), 'Evidence opens by keyboard');
      report.scenarios.push(`demo/${theme}/${width}: roster, disabled mutations, keyboard evidence, no overflow`);
    }
  }

  await evaluate(`${button('Compatibility Chat ↗')}.click()`);
  await waitFor(() => evaluate(`!!${app}.shadowRoot.querySelector('openrappter-chat')`), 'New work routes to Chat');
  await evaluate(`${app}.shadowRoot.querySelector('.back').click()`);
  await waitFor(() => evaluate(`!!${shadow}?.querySelector('[data-demo]')`), 'Back to Work');
  await evaluate(`${button('Use gateway data')}.click()`);
  await waitFor(() => evaluate(`${shadow}.querySelector('[data-demo]') === null`), 'Live data toggle');
  await evaluate(`${button('Preview local demo')}.click()`);
  await waitFor(() => evaluate(`!!${shadow}.querySelector('[data-demo]')`), 'Demo toggle');
  const sidebar = `${app}.shadowRoot.querySelector('openrappter-sidebar').shadowRoot`;
  await evaluate(`${sidebar}.querySelector('summary').click()`);
  await evaluate(`${sidebar}.querySelector('[data-view="agents"]').click()`);
  await waitFor(() => evaluate(`!!${app}.shadowRoot.querySelector('openrappter-agents')`), 'Compatibility route');
  await evaluate(`${app}.shadowRoot.querySelector('.back').click()`);
  await waitFor(() => evaluate(`!!${shadow}?.querySelector('[data-demo]')`), 'Return from compatibility');
  assert.deepEqual(mutations, [], 'No mutations were sent by demo interactions');
  report.scenarios.push('explicitly unverified compatibility Chat / Work return, compatibility route, live/demo toggle');

  scenario = 'live';
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/?scoutTheme=light` });
  await waitFor(() => evaluate(`${shadow}?.textContent.includes('Browser verification fixture')`), 'Live fixture thread');
  await waitFor(() => evaluate(`${button('Approve')} && !${button('Approve')}.disabled`), 'Verified approval frame evidence');
  assert.equal(await evaluate(`${shadow}.querySelector('.agent-list').scrollHeight > ${shadow}.querySelector('.agent-list').clientHeight`),
    true, 'Large workforce has an independently scrolling roster');
  await evaluate(`${button('Approve')}.click()`);
  await waitFor(() => evaluate(`${shadow}.textContent.includes('Gateway confirmed: approved.')`), 'Approval acknowledgment');
  await evaluate(`${button('Start VM')}.click()`);
  await waitFor(() => evaluate(`${shadow}.textContent.includes('starting · Shared screen')`), 'VM starting acknowledgment');
  assert.equal(await evaluate(`${button('Stop VM')}.disabled`), true);
  vmState = 'running';
  await evaluate(`${button('Refresh status')}.click()`);
  await waitFor(() => evaluate(`!!${shadow}.querySelector('iframe')`), 'Confirmed-local display fixture');
  assert.equal(await evaluate(`${shadow}.querySelector('iframe').title`), 'Live local Omarchy desktop');
  await evaluate(`${button('Stop VM')}.click()`);
  await waitFor(() => evaluate(`${shadow}.textContent.includes('Your local computer is stopped')`), 'VM stopped acknowledgment');
  assert.deepEqual(mutations, ['exec.respond', 'vm.start', 'vm.stop']);
  report.scenarios.push('real canonical fixture scans and browser hash checks; framed intent/result approvals and VM states; no actual VM commands');

  scenario = 'unverified';
  await call('Page.navigate', { url: `${origin}/?scoutTheme=light` });
  await waitFor(() => evaluate(`${shadow}?.textContent.includes('VM mutations are blocked')`), 'Missing RAPP adapter');
  assert.equal(await evaluate(`${button('Start VM')}.disabled`), true);
  assert.equal(await evaluate(`[...${shadow}.querySelectorAll('rapp-verification')].some(badge =>
    badge.shadowRoot?.querySelector('[data-rapp-status="verified"]'))`), false);
  report.scenarios.push('missing RAPP adapter: live projections unverified; mutations fail closed');

  scenario = 'offline';
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const socket of sockets) socket.close();
  await waitFor(() => evaluate(`${app}.shadowRoot.textContent.includes('RAPP Work is waiting for your gateway.')`), 'Disconnected shell');
  assert.equal(await evaluate(`${shadow}.querySelector('[data-demo]') === null`), true);
  assert.equal(await evaluate(`${button('Start VM')}.disabled`), true);
  assert.equal(await evaluate(`${shadow}.textContent.includes('Gateway confirmed: approved.')`), false);
  await screenshot('work-offline-mobile.png');
  report.scenarios.push('gateway offline: Work remains mounted, no replacement demo, controls disabled');
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions');
  assert.deepEqual([...requests].filter((url) => !url.startsWith(origin) && !url.startsWith('data:')), [], 'No external resource requests');
  report.exceptions = exceptions.length;
  report.externalRequests = 0;
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  cdp?.close();
  if (browser && browser.exitCode === null && !browser.signalCode) {
    browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => browser.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (browser.exitCode === null && !browser.signalCode) {
      browser.kill('SIGKILL');
      await new Promise((resolve) => browser.once('exit', resolve));
    }
  }
  for (const socket of sockets) socket.terminate();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  await fixtureLoader?.close();
  await rm(profile, { recursive: true, force: true });
}
