import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';

import {
  isPrivateContext,
  privacyReducedUrl,
  sanitizeShowAndTellText,
} from './privacy.js';
import type { ActiveContext } from './types.js';

const execFileAsync = promisify(execFile);

export async function assertContextCaptureAvailable(): Promise<void> {
  if (process.env.OPENRAPPTER_SHOW_TEST_MODE === '1') return;
  if (process.platform === 'darwin') {
    if (!existsExecutable('/usr/bin/osascript') || !existsExecutable('/usr/sbin/screencapture')) {
      throw new Error('macOS Show-and-Tell requires osascript and screencapture.');
    }
    return;
  }
  if (process.platform === 'win32') return;
  if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    throw new Error(
      'Show-and-Tell desktop context capture currently requires an X11 session; Wayland-only capture is not yet supported.',
    );
  }
  try {
    await execFileAsync('xdotool', ['--version'], { timeout: 3_000 });
  } catch {
    throw new Error(
      'Show-and-Tell on Linux requires xdotool for active-window context capture.',
    );
  }
}

function existsExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function macContext(): Promise<ActiveContext> {
  const script = `
tell application "System Events"
  set frontApp to first process whose frontmost is true
  set appName to name of frontApp
  try
    set frontWindow to front window of frontApp
    set winName to name of frontWindow
    set winPosition to position of frontWindow
    set winSize to size of frontWindow
  on error
    set winName to ""
    set winPosition to {0, 0}
    set winSize to {0, 0}
  end try
end tell
return appName & linefeed & winName & linefeed & (item 1 of winPosition) & linefeed & (item 2 of winPosition) & linefeed & (item 1 of winSize) & linefeed & (item 2 of winSize)
`;
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const [
    rawApp = '',
    rawWindow = '',
    rawX = '0',
    rawY = '0',
    rawWidth = '0',
    rawHeight = '0',
  ] = stdout.trim().split(/\r?\n/);
  const app = sanitizeShowAndTellText(rawApp, 120);
  const window = sanitizeShowAndTellText(rawWindow, 240);
  const bounds = {
    x: Number.parseInt(rawX, 10) || 0,
    y: Number.parseInt(rawY, 10) || 0,
    width: Number.parseInt(rawWidth, 10) || 0,
    height: Number.parseInt(rawHeight, 10) || 0,
  };
  const privateContext = isPrivateContext(app, window);
  if (privateContext) {
    return {
      app,
      window: '[private context]',
      privateContext: true,
      windowId: `${app}:${window}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`,
      ...bounds,
    };
  }

  const browserScript = browserUrlScript(app);
  let url = '';
  if (browserScript) {
    try {
      const result = await execFileAsync('/usr/bin/osascript', ['-e', browserScript], {
        encoding: 'utf8',
        timeout: 3_000,
      });
      url = privacyReducedUrl(result.stdout);
    } catch {
      // Browser URL access is optional and permission-dependent.
    }
  }
  if (isPrivateContext(app, window, url)) {
    return {
      app,
      window: '[private context]',
      privateContext: true,
      windowId: `${app}:${window}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`,
      ...bounds,
    };
  }
  return {
    app,
    window,
    ...(url ? { url } : {}),
    windowId: `${app}:${window}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`,
    ...bounds,
  };
}

function browserUrlScript(app: string): string | null {
  if (app === 'Safari') {
    return 'tell application "Safari" to return URL of front document';
  }
  if (['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'].includes(app)) {
    return `tell application "${app}" to return URL of active tab of front window`;
  }
  if (app === 'Arc') {
    return 'tell application "Arc" to return URL of active tab of front window';
  }
  return null;
}

async function windowsContext(): Promise<ActiveContext> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$handle = [ForegroundWindow]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 1024
[void][ForegroundWindow]::GetWindowText($handle, $builder, $builder.Capacity)
$processId = 0
[void][ForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
$rect = New-Object ForegroundWindow+RECT
[void][ForegroundWindow]::GetWindowRect($handle, [ref]$rect)
@{
  app = $process.ProcessName
  window = $builder.ToString()
  windowId = $handle.ToInt64().ToString()
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
} | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 8_000 },
  );
  const parsed = JSON.parse(stdout.trim()) as {
    app?: unknown;
    window?: unknown;
    windowId?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
  };
  const app = sanitizeShowAndTellText(parsed.app, 120);
  const window = sanitizeShowAndTellText(parsed.window, 240);
  const privateContext = isPrivateContext(app, window);
  const details = {
    windowId: sanitizeShowAndTellText(parsed.windowId, 80),
    x: Number(parsed.x) || 0,
    y: Number(parsed.y) || 0,
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
  };
  return privateContext
    ? { app, window: '[private context]', privateContext: true, ...details }
    : { app, window, ...details };
}

async function linuxContext(): Promise<ActiveContext> {
  const { stdout: windowId } = await execFileAsync(
    'xdotool',
    ['getactivewindow'],
    { encoding: 'utf8', timeout: 3_000 },
  );
  const id = windowId.trim();
  const [{ stdout: rawWindow }, { stdout: rawPid }] = await Promise.all([
    execFileAsync('xdotool', ['getwindowname', id], {
      encoding: 'utf8',
      timeout: 3_000,
    }),
    execFileAsync('xdotool', ['getwindowpid', id], {
      encoding: 'utf8',
      timeout: 3_000,
    }),
  ]);
  const { stdout: rawGeometry } = await execFileAsync(
    'xdotool',
    ['getwindowgeometry', '--shell', id],
    { encoding: 'utf8', timeout: 3_000 },
  );
  const geometry = Object.fromEntries(
    rawGeometry
      .split(/\r?\n/)
      .map((line) => line.split('=', 2))
      .filter((parts) => parts.length === 2),
  );
  let rawApp = '';
  if (rawPid.trim()) {
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['-p', rawPid.trim(), '-o', 'comm='],
        { encoding: 'utf8', timeout: 3_000 },
      );
      rawApp = stdout;
    } catch {
      // A title is still useful if the process disappeared between calls.
    }
  }
  const app = sanitizeShowAndTellText(rawApp.trim(), 120);
  const window = sanitizeShowAndTellText(rawWindow.trim(), 240);
  const privateContext = isPrivateContext(app, window);
  const details = {
    windowId: id,
    x: Number.parseInt(geometry.X ?? '0', 10) || 0,
    y: Number.parseInt(geometry.Y ?? '0', 10) || 0,
    width: Number.parseInt(geometry.WIDTH ?? '0', 10) || 0,
    height: Number.parseInt(geometry.HEIGHT ?? '0', 10) || 0,
  };
  return privateContext
    ? { app, window: '[private context]', privateContext: true, ...details }
    : { app, window, ...details };
}

export async function readActiveContext(): Promise<ActiveContext> {
  if (process.env.OPENRAPPTER_SHOW_TEST_MODE === '1') {
    return {
      app: 'ShowAndTellTestApp',
      window: 'Synthetic collector window',
      url: 'https://example.test/workflow',
      windowId: 'show-and-tell-test-window',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    };
  }
  if (process.platform === 'darwin') return macContext();
  if (process.platform === 'win32') return windowsContext();
  return linuxContext();
}

export async function captureExplicitFrame(
  file: string,
  context: ActiveContext,
): Promise<void> {
  if (process.platform === 'darwin') {
    if (
      context.width === undefined ||
      context.height === undefined ||
      context.width <= 0 ||
      context.height <= 0
    ) {
      throw new Error('The active window bounds are unavailable.');
    }
    await execFileAsync('/usr/sbin/screencapture', [
      '-x',
      `-R${context.x ?? 0},${context.y ?? 0},${context.width},${context.height}`,
      file,
    ], {
      timeout: 15_000,
    });
    return;
  }
  if (process.platform === 'win32') {
    if (
      context.width === undefined ||
      context.height === undefined ||
      context.width <= 0 ||
      context.height <= 0
    ) {
      throw new Error('The active window bounds are unavailable.');
    }
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = $args[0]
$x = [int]$args[1]
$y = [int]$args[2]
$width = [int]$args[3]
$height = [int]$args[4]
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
        file,
        String(context.x ?? 0),
        String(context.y ?? 0),
        String(context.width ?? 0),
        String(context.height ?? 0),
      ],
      { timeout: 20_000 },
    );
    return;
  }
  try {
    if (!context.windowId) throw new Error('The active window id is unavailable.');
    await execFileAsync('import', ['-window', context.windowId, file], {
      timeout: 15_000,
    });
  } catch {
    await execFileAsync('gnome-screenshot', ['-w', '-f', file], {
      timeout: 15_000,
    });
  }
}

export async function showCaptureNotification(message: string): Promise<void> {
  const bounded = sanitizeShowAndTellText(message, 180);
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/osascript', [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 1 of argv) with title "OpenRappter Show-and-Tell"',
        '-e',
        'end run',
        bounded,
      ], { timeout: 5_000 });
    } else if (process.platform === 'linux') {
      await execFileAsync('notify-send', ['OpenRappter Show-and-Tell', bounded], {
        timeout: 5_000,
      });
    }
  } catch {
    // Notifications are informative; capture must not depend on them.
  }
}
