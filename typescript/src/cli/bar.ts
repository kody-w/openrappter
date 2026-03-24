/**
 * CLI command: `openrappter bar`
 *
 * Bootstraps the OpenRappter Bar (macOS menu bar app) from the command line.
 * Also supports `--tui` for a terminal-based bar experience.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMOJI = '🦖';

/** Resolve the macOS app path */
function resolveAppPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../macos/dist/OpenRappter Bar.app'),
    '/Applications/OpenRappter Bar.app',
    path.join(os.homedir(), 'Applications/OpenRappter Bar.app'),
    process.env.OPENRAPPTER_BAR_PATH,
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Check if the bar app is already running */
async function isBarRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('pgrep -f "OpenRappter Bar" 2>/dev/null');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if gateway is running on the default port */
async function isGatewayRunning(port = 18790): Promise<boolean> {
  const net = await import('net');
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

export interface BarOptions {
  tui?: boolean;
  build?: boolean;
  gateway?: boolean;
  port?: string;
}

/**
 * Main entry point for the `openrappter bar` command.
 */
export async function launchBar(options: BarOptions): Promise<void> {
  const port = parseInt(options.port || '18790', 10);

  if (options.tui) {
    const { startTuiBar } = await import('../tui/bar.js');
    await startTuiBar({ port });
    return;
  }

  if (options.build) {
    await buildMacApp();
    return;
  }

  await launchMacBar(port, options.gateway !== false);
}

async function launchMacBar(port: number, autoStartGateway: boolean): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log(`${EMOJI} macOS Bar is only available on macOS. Use --tui for the terminal version.`);
    console.log('  openrappter bar --tui');
    return;
  }

  const appPath = resolveAppPath();
  if (!appPath) {
    console.log(`${EMOJI} OpenRappter Bar not found. Options:`);
    console.log('  1. Build from source:  openrappter bar --build');
    console.log('  2. Use the TUI:        openrappter bar --tui');
    console.log('  3. Set custom path:    OPENRAPPTER_BAR_PATH=/path/to/app openrappter bar');
    return;
  }

  if (await isBarRunning()) {
    console.log(`${EMOJI} OpenRappter Bar is already running.`);
    return;
  }

  // Auto-start gateway if needed
  if (autoStartGateway && !(await isGatewayRunning(port))) {
    console.log(`${EMOJI} Starting gateway daemon on port ${port}…`);
    const { spawn } = await import('child_process');
    const nodeBin = process.execPath;
    const indexPath = path.join(__dirname, 'index.js');

    const child = spawn(nodeBin, [indexPath, '--daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OPENRAPPTER_PORT: String(port) },
    });
    child.unref();

    await new Promise(r => setTimeout(r, 2000));
    console.log(`${EMOJI} Gateway started.`);
  }

  console.log(`${EMOJI} Launching OpenRappter Bar…`);
  try {
    await execAsync(`open "${appPath}"`);
    console.log(`${EMOJI} OpenRappter Bar is running in your menu bar.`);
  } catch (err) {
    console.error(`${EMOJI} Failed to launch: ${(err as Error).message}`);
  }
}

async function buildMacApp(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(`${EMOJI} Building the macOS app requires macOS.`);
    return;
  }

  const scriptPath = path.resolve(__dirname, '../../../macos/scripts/build-mac-app.sh');
  if (!fs.existsSync(scriptPath)) {
    console.error(`${EMOJI} Build script not found at ${scriptPath}`);
    return;
  }

  console.log(`${EMOJI} Building OpenRappter Bar…`);
  try {
    const { stdout, stderr } = await execAsync(`bash "${scriptPath}"`, {
      cwd: path.resolve(__dirname, '../../../macos'),
      timeout: 300000,
    });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log(`${EMOJI} Build complete! Run 'openrappter bar' to launch.`);
  } catch (err) {
    console.error(`${EMOJI} Build failed: ${(err as Error).message}`);
  }
}
