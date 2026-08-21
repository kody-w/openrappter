"""Hot-loadable agent that operates the visible RAPP Brainstem Frontier frontend."""

import json
import os
import urllib.error
import urllib.request

from agents.basic_agent import BasicAgent


def _driver_file():
    explicit = os.getenv("BRAINSTEM_BETA_UI_DRIVER_FILE")
    if explicit:
        return os.path.expanduser(explicit)
    brainstem_home = os.getenv(
        "BRAINSTEM_HOME",
        os.path.join(os.path.expanduser("~"), ".brainstem"),
    )
    return os.path.join(brainstem_home, "beta-launcher", "ui-driver.json")


def _camelize(value):
    key_map = {
        "alt_key": "altKey",
        "ctrl_key": "ctrlKey",
        "duration_ms": "durationMs",
        "meta_key": "metaKey",
        "include_text": "includeText",
        "max_duration_ms": "maxDurationMs",
        "settle_ms": "settleMs",
        "shift_key": "shiftKey",
        "snapshot_changed": "snapshotChanged",
        "target_text": "targetText",
        "timeout_ms": "timeoutMs",
        "typing_delay_ms": "typingDelayMs",
        "force_mode": "forceMode",
        "byte_budget": "byteBudget",
    }
    if isinstance(value, list):
        return [_camelize(item) for item in value]
    if isinstance(value, dict):
        return {
            key_map.get(key, key): _camelize(item)
            for key, item in value.items()
            if item is not None
        }
    return value


def _budget_text(value, limit=6000, handle="@page"):
    maximum = max(512, min(65536, int(limit or 6000)))
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value
    marker = f"…(+{len(encoded) - maximum} bytes — read handle:{handle})"
    room = max(0, maximum - len(marker.encode("utf-8")))
    preview = encoded[:room].decode("utf-8", errors="ignore")
    omitted = len(encoded) - len(preview.encode("utf-8"))
    marker = f"…(+{omitted} bytes — read handle:{handle})"
    room = max(0, maximum - len(marker.encode("utf-8")))
    preview = encoded[:room].decode("utf-8", errors="ignore")
    return preview + marker


HELP_TEXT = """UI Driver v2 operates the actual visible RAPP Brainstem Frontier frontend with an animated AI cursor.
- Prefer handle over selector/target_text. Handles are stable: @area.name or @list[key].part.
- inspect returns {snapshot,frame,rows}; pass since to receive only changed rows (60 default, 80 max).
- run accepts up to 40 steps. Steps support action, handle, selector, target_text, text, value, key, target, optional, tail, limit, and timing fields.
- click/type/press return effect. Add until={handle,state}, until={handle,text}, or until={snapshot_changed:true} to verify inside the same call.
- expect with handle plus state or text returns {ok,actual}. read is capped at 4000; wait returns {matched,h}.
- screenshot returns a 300-character caption; include_text=true adds at most 2000 characters. Captures and recordings render as media tiles.
- target is brainstem by default or shell for Frontier chrome. AI force mode is hidden until asked for; use it only when explicitly requested.
- Results use a 6000-byte budget by default; a truncation marker names the handle to read for more."""


class BrainstemUiDriver(BasicAgent):
    def __init__(self):
        self.name = "BrainstemUiDriver"
        self.metadata = {
            "name": self.name,
            "description": "Operate the visible Frontier UI; call help once for the compact v2 contract.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "announce",
                            "click",
                            "expect",
                            "force_mode",
                            "help",
                            "inspect",
                            "press",
                            "read",
                            "recording_status",
                            "route_telemetry",
                            "run",
                            "screenshot",
                            "start_recording",
                            "stop_recording",
                            "tour",
                            "type",
                            "wait",
                        ],
                    },
                    "handle": {"type": "string"},
                    "include_text": {"type": "boolean"},
                    "key": {"type": "string"},
                    "limit": {"type": "integer"},
                    "selector": {"type": "string"},
                    "since": {"type": "string"},
                    "state": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {"type": "object"},
                        "maxItems": 40,
                        "minItems": 1,
                    },
                    "tail": {"type": "boolean"},
                    "target": {"type": "string", "enum": ["brainstem", "shell"]},
                    "target_text": {"type": "string"},
                    "text": {"type": "string"},
                    "until": {"type": "object"},
                    "value": {"type": "string"},
                },
                "required": ["action"],
            },
        }
        super().__init__()

    def system_context(self):
        return (
            "Use BrainstemUiDriver for visible Frontier UI work. Call action=help once "
            "for handles, effects, conditions, and capture syntax. Prefer one run and "
            "trust only effect or expect."
        )

    def perform(self, action="", **kwargs):
        if action == "help":
            return HELP_TEXT
        metadata_path = _driver_file()
        try:
            with open(metadata_path, "r", encoding="utf-8") as handle:
                metadata = json.load(handle)
        except (OSError, ValueError) as error:
            return (
                "The RAPP Brainstem Frontier UI driver is unavailable. "
                f"Expected a running Frontier client at {metadata_path}: {error}"
            )

        command = _camelize({"action": action, **kwargs})
        request = urllib.request.Request(
            f"http://{metadata['host']}:{metadata['port']}/v1/command",
            data=json.dumps(command).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {metadata['token']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=130) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            return f"Visible UI action failed: HTTP {error.code}: {body}"
        except (OSError, ValueError) as error:
            return f"Visible UI action failed: {error}"

        if not payload.get("ok"):
            return f"Visible UI action failed: {payload.get('error', 'unknown error')}"
        result = payload.get("result")
        if (
            action == "screenshot"
            and isinstance(result, dict)
            and isinstance(result.get("recording"), dict)
        ):
            action = "stop_recording"
        if action == "stop_recording" and isinstance(result, dict):
            recording = result.get("recording") or {}
            screenshot = result.get("screenshot") or {}
            screenshot.pop("dataUrl", "")
            visible_text = screenshot.pop("visibleText", "")
            content = (
                f"Recording saved: {recording.get('path', 'unknown path')}. "
                "Final capture attached."
            )
            if visible_text:
                content += f" {visible_text}"
            content = _budget_text(content)
            structured = {
                "content": content,
                "log": content,
                "captures": [{
                    "url": screenshot.get("captureUrl"),
                    "path": screenshot.get("path"),
                    "alt": "Final RAPP Brainstem Frontier state after the recording",
                }],
                "recordings": [{
                    "url": recording.get("url"),
                    "path": recording.get("path"),
                    "mime_type": recording.get("mimeType"),
                    "duration_ms": recording.get("durationMs"),
                    "alt": "Autopilot demonstration recorded by the Brainstem",
                }],
            }
            return structured
        if action == "screenshot" and isinstance(result, dict):
            result.pop("dataUrl", "")
            visible_text = result.pop("visibleText", "")
            capture_url = result.get("captureUrl", "")
            content = (
                f"Capture saved: {result.get('path', 'unknown path')}."
            )
            if visible_text:
                content += f" {visible_text}"
            content = _budget_text(content)
            structured = {
                "content": content,
                "log": content,
                "captures": [{
                    "url": capture_url,
                    "path": result.get("path"),
                    "alt": "RAPP Brainstem Frontier after the agent action",
                }],
            }
            return structured
        handle = kwargs.get("handle") or "@page"
        for step in reversed(kwargs.get("steps") or []):
            if isinstance(step, dict) and step.get("handle"):
                handle = step["handle"]
                break
        encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=True)
        return _budget_text(encoded, kwargs.get("byte_budget", 6000), handle)
