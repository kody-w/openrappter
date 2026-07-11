import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent

MAX_NATIVE_INPUT = 1_000_000


class ComputerUseAgent(BasicAgent):
    """Controls the computer like a person — screenshots, mouse, keyboard, app control via macOS native APIs."""

    def __init__(self):
        self.name = 'ComputerUse'
        self.metadata = {
            "name": self.name,
            "description": (
                "Controls the computer like a person — takes screenshots, moves the mouse, "
                "clicks, types, scrolls, and launches apps. Uses macOS native APIs "
                "(CoreGraphics, AppleScript, Accessibility)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "screenshot", "click", "double_click", "right_click",
                            "type", "key", "move", "scroll", "drag",
                            "open_app", "activate_app", "list_windows",
                            "get_frontmost", "read_screen", "find_element",
                        ],
                        "description": "The computer action to perform",
                    },
                    "x": {"type": "integer", "description": "X coordinate for mouse actions"},
                    "y": {"type": "integer", "description": "Y coordinate for mouse actions"},
                    "text": {
                        "type": "string",
                        "description": "Text to type, key combo to press, or app name to open",
                    },
                    "direction": {
                        "type": "string",
                        "enum": ["up", "down", "left", "right"],
                        "description": "Scroll direction",
                    },
                    "amount": {
                        "type": "integer",
                        "description": "Scroll amount in pixels (default 5)",
                    },
                    "end_x": {"type": "integer", "description": "End X for drag"},
                    "end_y": {"type": "integer", "description": "End Y for drag"},
                    "query": {
                        "type": "string",
                        "description": "Natural language description of what to do or find",
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self._screenshot_counter = 0

    def perform(self, **kwargs):
        action = kwargs.get('action') or self._infer_action(kwargs.get('query', ''))

        try:
            handler = {
                'screenshot': self._screenshot,
                'click': self._click,
                'double_click': self._double_click,
                'right_click': self._right_click,
                'type': self._type_text,
                'key': self._press_key,
                'move': self._move_mouse,
                'scroll': self._scroll,
                'drag': self._drag,
                'open_app': self._open_app,
                'activate_app': self._activate_app,
                'list_windows': self._list_windows,
                'get_frontmost': self._get_frontmost,
                'read_screen': self._read_screen,
                'find_element': self._find_element,
            }.get(action)

            if not handler:
                return json.dumps({"status": "error", "message": f"Unknown action: {action}"})

            return handler(**kwargs)
        except Exception as e:
            return json.dumps({"status": "error", "action": action, "message": str(e)})

    def _infer_action(self, query):
        if not query:
            return 'screenshot'
        q = query.lower()
        if any(w in q for w in ('screenshot', 'screen', 'see')):
            return 'screenshot'
        if 'click' in q:
            return 'click'
        if any(w in q for w in ('type', 'write', 'enter')):
            return 'type'
        if 'scroll' in q:
            return 'scroll'
        if any(w in q for w in ('open', 'launch')):
            return 'open_app'
        if 'window' in q:
            return 'list_windows'
        if any(w in q for w in ('find', 'locate')):
            return 'find_element'
        if 'read' in q:
            return 'read_screen'
        return 'screenshot'

    def _screenshot(self, **kwargs):
        self._screenshot_counter += 1
        filepath = os.path.join(
            tempfile.gettempdir(),
            f"screenshot_{int(time.time())}_{self._screenshot_counter}.png",
        )
        subprocess.run(['/usr/sbin/screencapture', '-x', '-C', filepath], check=True)

        resolution = ''
        try:
            out = subprocess.check_output(
                'system_profiler SPDisplaysDataType | grep Resolution | head -1',
                shell=True, text=True,
            )
            resolution = out.strip()
        except Exception:
            pass

        return json.dumps({
            "status": "success",
            "action": "screenshot",
            "path": filepath,
            "resolution": resolution,
            "data_slush": {
                "source_agent": "ComputerUse",
                "screenshot_path": filepath,
            },
        })

    def _click(self, **kwargs):
        x, y = kwargs.get('x'), kwargs.get('y')
        if not self._valid_native_integers(x, y):
            return json.dumps({"status": "error", "message": "x and y must be finite integers"})
        self._run_cg(f"""
            CGEventRef click = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake({x}, {y}), kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, click);
            usleep(100000);
            CGEventSetType(click, kCGEventLeftMouseUp);
            CGEventPost(kCGHIDEventTap, click);
            CFRelease(click);
        """)
        return json.dumps({"status": "success", "action": "click", "x": x, "y": y})

    def _double_click(self, **kwargs):
        x, y = kwargs.get('x'), kwargs.get('y')
        if not self._valid_native_integers(x, y):
            return json.dumps({"status": "error", "message": "x and y must be finite integers"})
        self._run_cg(f"""
            CGEventRef click1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake({x}, {y}), kCGMouseButtonLeft);
            CGEventSetIntegerValueField(click1, kCGMouseEventClickState, 2);
            CGEventPost(kCGHIDEventTap, click1);
            usleep(50000);
            CGEventSetType(click1, kCGEventLeftMouseUp);
            CGEventSetIntegerValueField(click1, kCGMouseEventClickState, 2);
            CGEventPost(kCGHIDEventTap, click1);
            CFRelease(click1);
        """)
        return json.dumps({"status": "success", "action": "double_click", "x": x, "y": y})

    def _right_click(self, **kwargs):
        x, y = kwargs.get('x'), kwargs.get('y')
        if not self._valid_native_integers(x, y):
            return json.dumps({"status": "error", "message": "x and y must be finite integers"})
        self._run_cg(f"""
            CGEventRef click = CGEventCreateMouseEvent(NULL, kCGEventRightMouseDown, CGPointMake({x}, {y}), kCGMouseButtonRight);
            CGEventPost(kCGHIDEventTap, click);
            usleep(100000);
            CGEventSetType(click, kCGEventRightMouseUp);
            CGEventPost(kCGHIDEventTap, click);
            CFRelease(click);
        """)
        return json.dumps({"status": "success", "action": "right_click", "x": x, "y": y})

    def _type_text(self, **kwargs):
        text = kwargs.get('text', '')
        if not text:
            return json.dumps({"status": "error", "message": "text required"})
        escaped = self._escape_apple_script_string(text)
        subprocess.run([
            'osascript', '-e',
            f'tell application "System Events" to keystroke "{escaped}"',
        ], check=True)
        return json.dumps({"status": "success", "action": "type", "text": text})

    def _press_key(self, **kwargs):
        key = kwargs.get('text', '')
        if not key:
            return json.dumps({"status": "error", "message": "key required"})

        parts = [p.strip() for p in key.lower().split('+')]
        modifiers = []
        key_name = parts[-1]

        for mod in parts[:-1]:
            if mod in ('cmd', 'command'):
                modifiers.append('command down')
            elif mod in ('ctrl', 'control'):
                modifiers.append('control down')
            elif mod in ('alt', 'option'):
                modifiers.append('option down')
            elif mod == 'shift':
                modifiers.append('shift down')

        key_code_map = {
            'return': 36, 'enter': 36, 'tab': 48, 'space': 49, 'delete': 51,
            'escape': 53, 'esc': 53, 'up': 126, 'down': 125, 'left': 123,
            'right': 124, 'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118,
            'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101,
            'f10': 109, 'f11': 103, 'f12': 111, 'home': 115, 'end': 119,
            'pageup': 116, 'pagedown': 121,
        }

        mod_string = f' using {{{", ".join(modifiers)}}}' if modifiers else ''

        if key_name in key_code_map:
            cmd = f'tell application "System Events" to key code {key_code_map[key_name]}{mod_string}'
        else:
            escaped_key = self._escape_apple_script_string(key_name)
            cmd = f'tell application "System Events" to keystroke "{escaped_key}"{mod_string}'

        subprocess.run(['osascript', '-e', cmd], check=True)
        return json.dumps({"status": "success", "action": "key", "key": key})

    def _move_mouse(self, **kwargs):
        x, y = kwargs.get('x'), kwargs.get('y')
        if not self._valid_native_integers(x, y):
            return json.dumps({"status": "error", "message": "x and y must be finite integers"})
        self._run_cg(f"""
            CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake({x}, {y}), kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, move);
            CFRelease(move);
        """)
        return json.dumps({"status": "success", "action": "move", "x": x, "y": y})

    def _scroll(self, **kwargs):
        direction = kwargs.get('direction', 'down')
        amount = kwargs.get('amount', 5)
        if direction not in ('up', 'down', 'left', 'right'):
            return json.dumps({"status": "error", "message": "invalid scroll direction"})
        if not self._valid_native_integers(amount):
            return json.dumps({"status": "error", "message": "amount must be a finite integer"})
        dy = amount if direction == 'up' else (-amount if direction == 'down' else 0)
        dx = amount if direction == 'left' else (-amount if direction == 'right' else 0)

        self._run_cg(f"""
            CGEventRef scroll = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, {dy}, {dx});
            CGEventPost(kCGHIDEventTap, scroll);
            CFRelease(scroll);
        """)
        return json.dumps({
            "status": "success", "action": "scroll",
            "direction": direction, "amount": amount,
        })

    def _drag(self, **kwargs):
        x, y = kwargs.get('x'), kwargs.get('y')
        end_x, end_y = kwargs.get('end_x'), kwargs.get('end_y')
        if not self._valid_native_integers(x, y, end_x, end_y):
            return json.dumps({"status": "error", "message": "drag coordinates must be finite integers"})

        self._run_cg(f"""
            CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, CGPointMake({x}, {y}), kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, down);
            usleep(100000);
            CGEventRef drag = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, CGPointMake({end_x}, {end_y}), kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, drag);
            usleep(100000);
            CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, CGPointMake({end_x}, {end_y}), kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, up);
            CFRelease(down);
            CFRelease(drag);
            CFRelease(up);
        """)
        return json.dumps({
            "status": "success", "action": "drag",
            "from": {"x": x, "y": y}, "to": {"x": end_x, "y": end_y},
        })

    def _open_app(self, **kwargs):
        app_name = kwargs.get('text', '')
        if not app_name:
            return json.dumps({"status": "error", "message": "app name required"})
        subprocess.run(['open', '-a', app_name], check=True)
        time.sleep(1)
        return json.dumps({
            "status": "success", "action": "open_app", "app": app_name,
            "data_slush": {"source_agent": "ComputerUse", "opened_app": app_name},
        })

    def _activate_app(self, **kwargs):
        app_name = kwargs.get('text', '')
        if not app_name:
            return json.dumps({"status": "error", "message": "app name required"})
        escaped = self._escape_apple_script_string(app_name)
        subprocess.run([
            'osascript', '-e',
            f'tell application "{escaped}" to activate',
        ], check=True)
        return json.dumps({"status": "success", "action": "activate_app", "app": app_name})

    def _list_windows(self, **kwargs):
        script = '''
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
        '''
        result = subprocess.check_output(['osascript', '-e', script], text=True)

        windows = []
        for line in result.strip().split('\n'):
            if not line.strip():
                continue
            parts = line.split(' | ')
            windows.append({
                "app": parts[0].strip() if len(parts) > 0 else "",
                "title": parts[1].strip() if len(parts) > 1 else "",
                "position": parts[2].replace('pos:', '').strip() if len(parts) > 2 else "",
                "size": parts[3].replace('size:', '').strip() if len(parts) > 3 else "",
            })

        return json.dumps({
            "status": "success", "action": "list_windows",
            "windows": windows, "count": len(windows),
        })

    def _get_frontmost(self, **kwargs):
        script = '''
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
        '''
        result = subprocess.check_output(['osascript', '-e', script], text=True)
        parts = result.strip().split('|')
        app = parts[0].strip() if parts else ""
        window = parts[1].strip() if len(parts) > 1 else ""

        return json.dumps({
            "status": "success", "action": "get_frontmost",
            "app": app, "window": window,
        })

    def _read_screen(self, **kwargs):
        screenshot_path = os.path.join(
            tempfile.gettempdir(), f"ocr_{int(time.time())}.png"
        )
        subprocess.run(['/usr/sbin/screencapture', '-x', '-C', screenshot_path], check=True)

        try:
            ocr_script = f"""
import Quartz
from Foundation import NSURL
import Vision

url = NSURL.fileURLWithPath_('{screenshot_path}')
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
"""
            result = subprocess.check_output(
                ['python3', '-c', ocr_script], text=True, timeout=15
            )
            try:
                os.unlink(screenshot_path)
            except OSError:
                pass

            return json.dumps({
                "status": "success", "action": "read_screen",
                "text": result.strip(),
                "line_count": len(result.strip().split('\n')),
            })
        except Exception:
            return json.dumps({
                "status": "success", "action": "read_screen",
                "screenshot_path": screenshot_path,
                "message": "OCR unavailable — screenshot saved for visual inspection",
            })

    def _find_element(self, **kwargs):
        description = kwargs.get('text', '')
        if not description:
            return json.dumps({"status": "error", "message": "description required"})

        escaped = self._escape_apple_script_string(description)
        script = f'''
        tell application "System Events"
            set frontProc to first process whose frontmost is true
            set foundElements to {{}}

            try
                set allButtons to every button of front window of frontProc
                repeat with b in allButtons
                    try
                        set btnName to name of b
                        if btnName contains "{escaped}" then
                            set btnPos to position of b
                            set btnSize to size of b
                            set end of foundElements to "button|" & btnName & "|" & (item 1 of btnPos) & "," & (item 2 of btnPos) & "|" & (item 1 of btnSize) & "," & (item 2 of btnSize)
                        end if
                    end try
                end repeat
            end try

            try
                set allStatic to every static text of front window of frontProc
                repeat with s in allStatic
                    try
                        set sVal to value of s
                        if sVal contains "{escaped}" then
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
        '''
        result = subprocess.check_output(['osascript', '-e', script], text=True)

        elements = []
        for line in result.strip().split('\n'):
            if not line.strip():
                continue
            parts = line.split('|')
            if len(parts) < 4:
                continue
            pos = parts[2].split(',')
            size = parts[3].split(',')
            x_val = int(pos[0]) if pos else 0
            y_val = int(pos[1]) if len(pos) > 1 else 0
            w_val = int(size[0]) if size else 0
            h_val = int(size[1]) if len(size) > 1 else 0
            elements.append({
                "type": parts[0],
                "label": parts[1],
                "x": x_val, "y": y_val,
                "width": w_val, "height": h_val,
                "center_x": x_val + w_val // 2,
                "center_y": y_val + h_val // 2,
            })

        return json.dumps({
            "status": "success", "action": "find_element",
            "query": description, "elements": elements, "count": len(elements),
        })

    def _run_cg(self, body):
        """Compile and run a CoreGraphics C snippet."""
        src = f"""
#include <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
int main() {{
  {body}
  return 0;
}}
"""
        src_path = os.path.join(tempfile.gettempdir(), f"cg_{int(time.time() * 1000)}.c")
        bin_path = os.path.join(tempfile.gettempdir(), f"cg_{int(time.time() * 1000)}")

        with open(src_path, 'w') as f:
            f.write(src)
        try:
            subprocess.run(
                ['/usr/bin/cc', '-framework', 'ApplicationServices', '-o', bin_path, src_path],
                check=True,
                capture_output=True,
            )
            subprocess.run([bin_path], check=True, capture_output=True)
        finally:
            for p in (src_path, bin_path):
                try:
                    os.unlink(p)
                except OSError:
                    pass

    @staticmethod
    def _valid_native_integers(*values):
        return all(
            isinstance(value, int)
            and not isinstance(value, bool)
            and abs(value) <= MAX_NATIVE_INPUT
            for value in values
        )

    @staticmethod
    def _escape_apple_script_string(value):
        return value.replace('\\', '\\\\').replace('"', '\\"')
