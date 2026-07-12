import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_NATIVE_INPUT = 1_000_000;

function isSafeNativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= MAX_NATIVE_INPUT
  );
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ComputerUseAgent extends BasicAgent {
  private screenshotCounter = 0;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'ComputerUse',
      description:
        'Controls the computer like a person — takes screenshots, moves the mouse, clicks, types, scrolls, and launches apps. Uses macOS native APIs (CoreGraphics, AppleScript, Accessibility).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'screenshot',
              'click',
              'double_click',
              'right_click',
              'type',
              'key',
              'move',
              'scroll',
              'drag',
              'open_app',
              'activate_app',
              'list_windows',
              'get_frontmost',
              'read_screen',
              'find_element',
            ],
            description: 'The computer action to perform',
          },
          x: {
            type: 'integer',
            description: 'X coordinate for mouse actions',
          },
          y: {
            type: 'integer',
            description: 'Y coordinate for mouse actions',
          },
          text: {
            type: 'string',
            description: 'Text to type, key combo to press, or app name to open',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Scroll direction',
          },
          amount: {
            type: 'integer',
            description: 'Scroll amount in pixels (default 5)',
          },
          end_x: {
            type: 'integer',
            description: 'End X coordinate for drag action',
          },
          end_y: {
            type: 'integer',
            description: 'End Y coordinate for drag action',
          },
          query: {
            type: 'string',
            description: 'Natural language description of what to do or find on screen',
          },
        },
        required: [],
      },
    };
    super('ComputerUse', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || this.inferAction(kwargs.query as string);

    try {
      switch (action) {
        case 'screenshot':
          return await this.takeScreenshot();
        case 'click':
          return await this.click(kwargs.x as number, kwargs.y as number);
        case 'double_click':
          return await this.doubleClick(kwargs.x as number, kwargs.y as number);
        case 'right_click':
          return await this.rightClick(kwargs.x as number, kwargs.y as number);
        case 'type':
          return await this.typeText(kwargs.text as string);
        case 'key':
          return await this.pressKey(kwargs.text as string);
        case 'move':
          return await this.moveMouse(kwargs.x as number, kwargs.y as number);
        case 'scroll':
          return await this.scroll(
            (kwargs.direction as string) || 'down',
            kwargs.amount == null ? 5 : (kwargs.amount as number)
          );
        case 'drag':
          return await this.drag(
            kwargs.x as number,
            kwargs.y as number,
            kwargs.end_x as number,
            kwargs.end_y as number
          );
        case 'open_app':
          return await this.openApp(kwargs.text as string);
        case 'activate_app':
          return await this.activateApp(kwargs.text as string);
        case 'list_windows':
          return await this.listWindows();
        case 'get_frontmost':
          return await this.getFrontmostApp();
        case 'read_screen':
          return await this.readScreen();
        case 'find_element':
          return await this.findElement(kwargs.text as string);
        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}. Available: screenshot, click, double_click, right_click, type, key, move, scroll, drag, open_app, activate_app, list_windows, get_frontmost, read_screen, find_element`,
          });
      }
    } catch (e) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (e as Error).message,
      });
    }
  }

  private inferAction(query?: string): string {
    if (!query) return 'screenshot';
    const q = query.toLowerCase();
    if (q.includes('screenshot') || q.includes('screen') || q.includes('see')) return 'screenshot';
    if (q.includes('click')) return 'click';
    if (q.includes('type') || q.includes('write') || q.includes('enter')) return 'type';
    if (q.includes('scroll')) return 'scroll';
    if (q.includes('open') || q.includes('launch')) return 'open_app';
    if (q.includes('window')) return 'list_windows';
    if (q.includes('find') || q.includes('locate')) return 'find_element';
    if (q.includes('read')) return 'read_screen';
    return 'screenshot';
  }

  protected async runFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(file, args, { encoding: 'utf8' });
  }

  private async takeScreenshot(): Promise<string> {
    const filename = `screenshot_${Date.now()}_${this.screenshotCounter++}.png`;
    const filepath = join(tmpdir(), filename);

    await execAsync(`/usr/sbin/screencapture -x -C ${filepath}`);

    // Get screen dimensions
    const { stdout: dimOut } = await execAsync(
      `system_profiler SPDisplaysDataType | grep Resolution | head -1`
    );
    const resolution = dimOut.trim();

    return JSON.stringify({
      status: 'success',
      action: 'screenshot',
      path: filepath,
      resolution,
      data_slush: {
        source_agent: 'ComputerUse',
        screenshot_path: filepath,
        timestamp: new Date().toISOString(),
      },
    });
  }

  private async click(x: number, y: number): Promise<string> {
    if (!isSafeNativeInteger(x) || !isSafeNativeInteger(y)) {
      return JSON.stringify({
        status: 'error',
        message: 'x and y must be finite integers within the supported coordinate range',
      });
    }
    await this.runCG(`
      CGEventRef click = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake(${x}, ${y}), kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, click);
      usleep(100000);
      CGEventSetType(click, kCGEventLeftMouseUp);
      CGEventPost(kCGHIDEventTap, click);
      CFRelease(click);
    `);
    return JSON.stringify({
      status: 'success',
      action: 'click',
      x,
      y,
      data_slush: { source_agent: 'ComputerUse', clicked: { x, y } },
    });
  }

  private async doubleClick(x: number, y: number): Promise<string> {
    if (!isSafeNativeInteger(x) || !isSafeNativeInteger(y)) {
      return JSON.stringify({
        status: 'error',
        message: 'x and y must be finite integers within the supported coordinate range',
      });
    }
    await this.runCG(`
      CGEventRef click1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake(${x}, ${y}), kCGMouseButtonLeft);
      CGEventSetIntegerValueField(click1, kCGMouseEventClickState, 2);
      CGEventPost(kCGHIDEventTap, click1);
      usleep(50000);
      CGEventSetType(click1, kCGEventLeftMouseUp);
      CGEventSetIntegerValueField(click1, kCGMouseEventClickState, 2);
      CGEventPost(kCGHIDEventTap, click1);
      CFRelease(click1);
    `);
    return JSON.stringify({
      status: 'success',
      action: 'double_click',
      x,
      y,
    });
  }

  private async rightClick(x: number, y: number): Promise<string> {
    if (!isSafeNativeInteger(x) || !isSafeNativeInteger(y)) {
      return JSON.stringify({
        status: 'error',
        message: 'x and y must be finite integers within the supported coordinate range',
      });
    }
    await this.runCG(`
      CGEventRef click = CGEventCreateMouseEvent(NULL, kCGEventRightMouseDown, CGPointMake(${x}, ${y}), kCGMouseButtonRight);
      CGEventPost(kCGHIDEventTap, click);
      usleep(100000);
      CGEventSetType(click, kCGEventRightMouseUp);
      CGEventPost(kCGHIDEventTap, click);
      CFRelease(click);
    `);
    return JSON.stringify({
      status: 'success',
      action: 'right_click',
      x,
      y,
    });
  }

  private async typeText(text: string): Promise<string> {
    if (!text) {
      return JSON.stringify({ status: 'error', message: 'text required for type action' });
    }

    // Use AppleScript for reliable text input including special chars
    const escaped = escapeAppleScriptString(text);
    await this.runFile('/usr/bin/osascript', [
      '-e',
      `tell application "System Events" to keystroke "${escaped}"`,
    ]);

    return JSON.stringify({
      status: 'success',
      action: 'type',
      text,
      data_slush: { source_agent: 'ComputerUse', typed: text },
    });
  }

  private async pressKey(key: string): Promise<string> {
    if (!key) {
      return JSON.stringify({ status: 'error', message: 'key required for key action' });
    }

    // Parse modifiers and key name
    const parts = key.toLowerCase().split('+').map((p) => p.trim());
    const modifiers: string[] = [];
    const keyName = parts[parts.length - 1];

    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i];
      if (mod === 'cmd' || mod === 'command') modifiers.push('command down');
      else if (mod === 'ctrl' || mod === 'control') modifiers.push('control down');
      else if (mod === 'alt' || mod === 'option') modifiers.push('option down');
      else if (mod === 'shift') modifiers.push('shift down');
    }

    // Map common key names to AppleScript key codes
    const keyCodeMap: Record<string, number> = {
      return: 36, enter: 36, tab: 48, space: 49, delete: 51,
      escape: 53, esc: 53, up: 126, down: 125, left: 123, right: 124,
      f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
      f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
      home: 115, end: 119, pageup: 116, pagedown: 121,
    };

    const modString = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';

    if (keyCodeMap[keyName] !== undefined) {
      await this.runFile('/usr/bin/osascript', [
        '-e',
        `tell application "System Events" to key code ${keyCodeMap[keyName]}${modString}`,
      ]);
    } else {
      const escaped = escapeAppleScriptString(keyName);
      await this.runFile('/usr/bin/osascript', [
        '-e',
        `tell application "System Events" to keystroke "${escaped}"${modString}`,
      ]);
    }

    return JSON.stringify({
      status: 'success',
      action: 'key',
      key,
    });
  }

  private async moveMouse(x: number, y: number): Promise<string> {
    if (!isSafeNativeInteger(x) || !isSafeNativeInteger(y)) {
      return JSON.stringify({
        status: 'error',
        message: 'x and y must be finite integers within the supported coordinate range',
      });
    }
    await this.runCG(`
      CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(${x}, ${y}), kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, move);
      CFRelease(move);
    `);
    return JSON.stringify({
      status: 'success',
      action: 'move',
      x,
      y,
    });
  }

  private async scroll(direction: string, amount: number): Promise<string> {
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      return JSON.stringify({ status: 'error', message: 'invalid scroll direction' });
    }
    if (!isSafeNativeInteger(amount)) {
      return JSON.stringify({
        status: 'error',
        message: 'amount must be a finite integer within the supported scroll range',
      });
    }

    let dx = 0,
      dy = 0;
    switch (direction) {
      case 'up':
        dy = amount;
        break;
      case 'down':
        dy = -amount;
        break;
      case 'left':
        dx = amount;
        break;
      case 'right':
        dx = -amount;
        break;
    }

    await this.runCG(`
      CGEventRef scroll = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, ${dy}, ${dx});
      CGEventPost(kCGHIDEventTap, scroll);
      CFRelease(scroll);
    `);

    return JSON.stringify({
      status: 'success',
      action: 'scroll',
      direction,
      amount,
    });
  }

  private async drag(x: number, y: number, endX: number, endY: number): Promise<string> {
    if (
      !isSafeNativeInteger(x) ||
      !isSafeNativeInteger(y) ||
      !isSafeNativeInteger(endX) ||
      !isSafeNativeInteger(endY)
    ) {
      return JSON.stringify({
        status: 'error',
        message: 'drag coordinates must be finite integers within the supported coordinate range',
      });
    }
    await this.runCG(`
      CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake(${x}, ${y}), kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, down);
      usleep(100000);
      CGEventRef drag = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, CGPointMake(${endX}, ${endY}), kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, drag);
      usleep(100000);
      CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, CGPointMake(${endX}, ${endY}), kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(down);
      CFRelease(drag);
      CFRelease(up);
    `);

    return JSON.stringify({
      status: 'success',
      action: 'drag',
      from: { x, y },
      to: { x: endX, y: endY },
    });
  }

  private async openApp(appName: string): Promise<string> {
    if (!appName) {
      return JSON.stringify({ status: 'error', message: 'app name required for open_app' });
    }
    await this.runFile('/usr/bin/open', ['-a', appName]);
    // Give it a moment to launch
    await new Promise((r) => setTimeout(r, 1000));

    return JSON.stringify({
      status: 'success',
      action: 'open_app',
      app: appName,
      data_slush: { source_agent: 'ComputerUse', opened_app: appName },
    });
  }

  private async activateApp(appName: string): Promise<string> {
    if (!appName) {
      return JSON.stringify({ status: 'error', message: 'app name required for activate_app' });
    }
    const escaped = escapeAppleScriptString(appName);
    await this.runFile('/usr/bin/osascript', [
      '-e',
      `tell application "${escaped}" to activate`,
    ]);
    return JSON.stringify({
      status: 'success',
      action: 'activate_app',
      app: appName,
    });
  }

  private async listWindows(): Promise<string> {
    const { stdout } = await execAsync(`osascript -e '
      set windowList to {}
      tell application "System Events"
        set procs to every process whose visible is true
        repeat with p in procs
          set appName to name of p
          try
            set wins to every window of p
            repeat with w in wins
              set winName to name of w
              set winPos to position of w
              set winSize to size of w
              set end of windowList to appName & " | " & winName & " | pos:" & (item 1 of winPos) & "," & (item 2 of winPos) & " | size:" & (item 1 of winSize) & "," & (item 2 of winSize)
            end repeat
          end try
        end repeat
      end tell
      set text item delimiters to linefeed
      return windowList as text
    '`);

    const windows = stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => {
        const parts = line.split(' | ');
        return {
          app: parts[0]?.trim(),
          title: parts[1]?.trim(),
          position: parts[2]?.replace('pos:', '').trim(),
          size: parts[3]?.replace('size:', '').trim(),
        };
      });

    return JSON.stringify({
      status: 'success',
      action: 'list_windows',
      windows,
      count: windows.length,
      data_slush: {
        source_agent: 'ComputerUse',
        window_count: windows.length,
        visible_apps: [...new Set(windows.map((w) => w.app))],
      },
    });
  }

  private async getFrontmostApp(): Promise<string> {
    const { stdout } = await execAsync(`osascript -e '
      tell application "System Events"
        set frontApp to first process whose frontmost is true
        set appName to name of frontApp
        try
          set winName to name of front window of frontApp
        on error
          set winName to "none"
        end try
      end tell
      return appName & "|" & winName
    '`);

    const [app, window] = stdout.trim().split('|');

    return JSON.stringify({
      status: 'success',
      action: 'get_frontmost',
      app: app?.trim(),
      window: window?.trim(),
      data_slush: { source_agent: 'ComputerUse', frontmost_app: app?.trim() },
    });
  }

  private async readScreen(): Promise<string> {
    // Take a screenshot and try to extract text via macOS Vision framework
    const screenshotPath = join(tmpdir(), `ocr_${Date.now()}.png`);
    await execAsync(`/usr/sbin/screencapture -x -C ${screenshotPath}`);

    // Use shortcuts or python with Vision framework for OCR
    try {
      const { stdout } = await execAsync(
        `python3 -c "
import Quartz
from Foundation import NSURL
import Vision

url = NSURL.fileURLWithPath_('${screenshotPath}')
request = Vision.VNRecognizeTextRequest.alloc().init()
request.setRecognitionLevel_(1)
handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)
handler.performRequests_error_([request], None)
results = request.results()
texts = []
for obs in results:
    candidate = obs.topCandidates_(1)[0]
    texts.append(candidate.string())
print('\\n'.join(texts))
"`,
        { timeout: 15000 }
      );

      // Clean up screenshot
      try {
        unlinkSync(screenshotPath);
      } catch {
        /* ignore */
      }

      return JSON.stringify({
        status: 'success',
        action: 'read_screen',
        text: stdout.trim(),
        line_count: stdout.trim().split('\n').length,
        data_slush: {
          source_agent: 'ComputerUse',
          screen_text: stdout.trim().substring(0, 500),
        },
      });
    } catch {
      // Fallback: return screenshot path for visual inspection
      return JSON.stringify({
        status: 'success',
        action: 'read_screen',
        screenshot_path: screenshotPath,
        message: 'OCR unavailable — screenshot saved for visual inspection',
        data_slush: {
          source_agent: 'ComputerUse',
          screenshot_path: screenshotPath,
        },
      });
    }
  }

  private async findElement(description: string): Promise<string> {
    if (!description) {
      return JSON.stringify({
        status: 'error',
        message: 'description required for find_element',
      });
    }

    const escaped = escapeAppleScriptString(description);

    // Use Accessibility API to find UI elements
    const { stdout } = await this.runFile('/usr/bin/osascript', ['-e', `
      tell application "System Events"
        set frontProc to first process whose frontmost is true
        set appName to name of frontProc
        set foundElements to {}

        try
          set allButtons to every button of front window of frontProc
          repeat with b in allButtons
            try
              set btnName to name of b
              if btnName contains "${escaped}" then
                set btnPos to position of b
                set btnSize to size of b
                set end of foundElements to "button|" & btnName & "|" & (item 1 of btnPos) & "," & (item 2 of btnPos) & "|" & (item 1 of btnSize) & "," & (item 2 of btnSize)
              end if
            end try
          end repeat
        end try

        try
          set allFields to every text field of front window of frontProc
          repeat with f in allFields
            try
              set fDesc to description of f
              if fDesc contains "${escaped}" then
                set fPos to position of f
                set fSize to size of f
                set end of foundElements to "text_field|" & fDesc & "|" & (item 1 of fPos) & "," & (item 2 of fPos) & "|" & (item 1 of fSize) & "," & (item 2 of fSize)
              end if
            end try
          end repeat
        end try

        try
          set allStatic to every static text of front window of frontProc
          repeat with s in allStatic
            try
              set sVal to value of s
              if sVal contains "${escaped}" then
                set sPos to position of s
                set sSize to size of s
                set end of foundElements to "static_text|" & sVal & "|" & (item 1 of sPos) & "," & (item 2 of sPos) & "|" & (item 1 of sSize) & "," & (item 2 of sSize)
              end if
            end try
          end repeat
        end try

      end tell
      set text item delimiters to linefeed
      return foundElements as text
    `]);

    const elements = stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => {
        const parts = line.split('|');
        const pos = parts[2]?.split(',');
        const size = parts[3]?.split(',');
        return {
          type: parts[0],
          label: parts[1],
          x: parseInt(pos?.[0] || '0'),
          y: parseInt(pos?.[1] || '0'),
          width: parseInt(size?.[0] || '0'),
          height: parseInt(size?.[1] || '0'),
          center_x: parseInt(pos?.[0] || '0') + Math.floor(parseInt(size?.[0] || '0') / 2),
          center_y: parseInt(pos?.[1] || '0') + Math.floor(parseInt(size?.[1] || '0') / 2),
        };
      });

    return JSON.stringify({
      status: 'success',
      action: 'find_element',
      query: description,
      elements,
      count: elements.length,
      data_slush: {
        source_agent: 'ComputerUse',
        found_elements: elements.length,
        query: description,
      },
    });
  }

  /**
   * Compile and run a CoreGraphics C snippet for low-level mouse/keyboard control.
   */
  private async runCG(body: string): Promise<void> {
    const src = `
#include <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
int main() {
  ${body}
  return 0;
}
`;
    const srcPath = join(tmpdir(), `cg_${Date.now()}.c`);
    const binPath = join(tmpdir(), `cg_${Date.now()}`);
    writeFileSync(srcPath, src);
    try {
      await this.runFile('/usr/bin/cc', [
        '-framework',
        'ApplicationServices',
        '-o',
        binPath,
        srcPath,
      ]);
      await this.runFile(binPath, []);
    } finally {
      try {
        unlinkSync(srcPath);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(binPath);
      } catch {
        /* ignore */
      }
    }
  }
}
