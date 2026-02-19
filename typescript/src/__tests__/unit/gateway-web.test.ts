import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GatewayServer } from '../../gateway/server.js';

describe('Gateway static file serving', () => {
  let tmpDir: string;
  let server: GatewayServer;
  let port: number;

  beforeAll(() => {
    // Create a temp web root with test files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-web-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log("app")');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { color: red; }');
    fs.mkdirSync(path.join(tmpDir, 'assets'));
    fs.writeFileSync(path.join(tmpDir, 'assets', 'icon.svg'), '<svg></svg>');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Use a random high port
    port = 19000 + Math.floor(Math.random() * 1000);
    server = new GatewayServer({ port, bind: 'loopback', webRoot: tmpDir });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('serves index.html at /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const body = await res.text();
    expect(body).toContain('<html>');
  });

  it('serves .js files with correct MIME type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    const body = await res.text();
    expect(body).toContain('console.log');
  });

  it('serves .css files with correct MIME type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css');
  });

  it('serves nested files', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/icon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('SPA fallback: returns index.html for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const body = await res.text();
    expect(body).toContain('<html>');
  });

  it('blocks path traversal', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/../../../etc/passwd`);
    // Should either be 403 (traversal blocked) or serve index.html (SPA fallback)
    // Either way it must NOT serve /etc/passwd
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('/health still works with webRoot set', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string };
    expect(data.status).toBe('ok');
  });

  it('/status still works with webRoot set', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const data = await res.json() as { running: boolean };
    expect(data.running).toBe(true);
  });
});
