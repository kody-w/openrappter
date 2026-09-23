"""Bounded argv/JSON subprocesses. No shell, framework discovery, or network server."""

from __future__ import annotations

import json
import os
import re
import selectors
import select
import subprocess
import time
from datetime import datetime, timezone

from .config import Config, IMSG_VERSION, PortalError, private_json


class NotSubmitted(PortalError):
    """The request is known not to have reached the send operation."""


class SubmissionUnknown(PortalError):
    """The send might have reached Messages; automatic resend is prohibited."""


class NativeRemoteError(PortalError):
    def __init__(self, code: int | None):
        super().__init__("native_remote_error", "Native Messages returned an error.")
        self.rpc_code = code


def exchange(
    argv: list[str],
    payload: bytes,
    timeout: float,
    *,
    rpc: bool = False,
    mutating: bool = False,
    plain: bool = False,
) -> dict | str:
    try:
        process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise NotSubmitted("helper_unavailable", "The configured local helper could not start.") from error
    attempted = False
    selector = selectors.DefaultSelector()
    output = bytearray()
    diagnostic_bytes = 0
    try:
        deadline = time.monotonic() + timeout
        if payload:
            attempted = True
            os.set_blocking(process.stdin.fileno(), False)
            position = 0
            while position < len(payload):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                _, writable, _ = select.select([], [process.stdin], [], min(remaining, 0.2))
                if writable:
                    try:
                        position += os.write(process.stdin.fileno(), payload[position:position + 16384])
                    except BlockingIOError:
                        continue
        if not rpc:
            process.stdin.close()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        pending = bytearray()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            for key, _ in selector.select(min(remaining, 0.2)):
                block = os.read(key.fd, 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == "stderr":
                    diagnostic_bytes += len(block)
                    if diagnostic_bytes > 256 * 1024:
                        raise ValueError("excess diagnostics")
                    continue
                output.extend(block)
                if len(output) > 4 * 1024 * 1024:
                    raise ValueError("excess output")
                if rpc:
                    pending.extend(block)
                    while b"\n" in pending:
                        line, _, pending = pending.partition(b"\n")
                        value = json.loads(line)
                        if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
                            raise ValueError("invalid native envelope")
                        if value.get("id") != 1:
                            continue
                        if "error" in value:
                            error = value["error"]
                            raise NativeRemoteError(error.get("code") if isinstance(error, dict) else None)
                        result = value.get("result")
                        if not isinstance(result, dict):
                            raise ValueError("invalid native result")
                        return result
        returncode = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        text = output.decode("utf-8")
        if plain:
            if returncode != 0:
                raise ValueError("helper exit")
            return text.strip()
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ValueError("invalid adapter envelope")
        if returncode != 0 and value.get("ok") is not False:
            raise ValueError("helper exit without a structured rejection")
        return value
    except NativeRemoteError:
        raise
    except (OSError, ValueError, TimeoutError, subprocess.TimeoutExpired) as error:
        if mutating and attempted:
            raise SubmissionUnknown("submission_unknown", "Submission outcome is unknown; it was not retried.") from error
        raise NotSubmitted("helper_protocol_error", "Local helper timed out or returned an invalid response.") from error
    finally:
        selector.close()
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)


class RuntimeClient:
    def __init__(self, config: Config):
        self.config = config

    def profile_policy(self, profile: str) -> dict:
        configured = private_json(self.config.runtime_argv[3]).get("profiles")
        policy = configured.get(profile) if isinstance(configured, dict) else None
        keys = {"available_tools", "allow_tools", "deny_tools", "add_dirs", "allow_urls"}
        if (
            not isinstance(policy, dict) or "available_tools" not in policy
            or set(policy) - keys
            or any(
                not isinstance(value, list) or len(value) > 100
                or any(not isinstance(item, str) or len(item) > 4096 for item in value)
                for value in policy.values()
            )
        ):
            raise PortalError("policy_denied", "The locally configured capability profile cannot be safely previewed.")
        return policy

    def request(self, request: dict) -> dict:
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        if len(payload) > 256 * 1024:
            raise PortalError("request_too_large", "This task exceeds the local adapter request limit.")
        return exchange(
            list(self.config.runtime_argv), payload, self.config.runtime_timeout,
            mutating=request.get("op") in ("submit", "approve", "cancel", "recover"),
        )


class NativeClient:
    def __init__(self, config: Config):
        self.config = config
        self.checked = False

    def request(self, method: str, params: dict) -> dict:
        if not self.checked:
            version = exchange([str(self.config.imsg_path), "--version"], b"", 5, plain=True)
            if version != IMSG_VERSION:
                raise NotSubmitted("native_version", f"The native helper must be pinned to {IMSG_VERSION}.")
            self.checked = True
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            separators=(",", ":"),
        ).encode() + b"\n"
        try:
            return exchange(
                [str(self.config.imsg_path), "rpc", "--db", str(self.config.messages_db), "--json"],
                payload, self.config.native_timeout, rpc=True, mutating=method == "send",
            )
        except NativeRemoteError as error:
            if method == "send" and error.rpc_code == -32602:
                raise NotSubmitted("native_invalid_params", "Native send parameters were rejected.") from error
            if method == "send":
                raise SubmissionUnknown("native_send_unknown", "Messages reported an error; delivery is uncertain.") from error
            raise

    def send(self, chat_id: int, *, text: str = "", file: str = "") -> dict:
        result = self.request("send", {
            "chat_id": chat_id, "text": text, "file": file,
            "service": "imessage", "transport": "applescript",
        })
        if result.get("ok") is not True:
            raise SubmissionUnknown("native_send_unknown", "Native send did not confirm submission.")
        return result

    def history(self, chat_id: int, since: float, until: float) -> list[dict]:
        result = self.request("messages.history", {
            "chat_id": chat_id, "limit": 200, "attachments": True,
            "start": datetime.fromtimestamp(since, timezone.utc).isoformat(),
            "end": datetime.fromtimestamp(until, timezone.utc).isoformat(),
        })
        messages = result.get("messages")
        if (
            not isinstance(messages, list) or len(messages) > 200
            or any(not isinstance(message, dict) for message in messages)
        ):
            raise PortalError("native_protocol", "Native receipt history was malformed.")
        return messages

    def status(self, guid: str) -> dict:
        return self.request("message.send_status", {"guid": guid})

    def decode_text(self, event: dict, actor: dict) -> str:
        try:
            created = datetime.fromisoformat(event["created_at"].replace("Z", "+00:00")).timestamp()
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise PortalError("text_decode_unavailable", "Native message time is unavailable.") from error
        result = self.request("messages.history", {
            "chat_id": event["chat_id"], "participants": [actor["sender"]],
            "attachments": False, "limit": 32,
            "start": datetime.fromtimestamp(created - 1, timezone.utc).isoformat(),
            "end": datetime.fromtimestamp(created + 1, timezone.utc).isoformat(),
        })
        messages = result.get("messages")
        if not isinstance(messages, list) or len(messages) > 32:
            raise PortalError("text_decode_unavailable", "The native text decoder returned an invalid page.")
        matches = [
            item for item in messages if isinstance(item, dict)
            and item.get("guid") == event["guid"] and item.get("id") == event["id"]
            and item.get("chat_id") == event["chat_id"] and item.get("chat_guid") == actor["chat"]
        ]
        if len(matches) != 1 or not isinstance(matches[0].get("text"), str):
            raise PortalError("text_decode_unavailable", "The native message text is not ready.")
        text = matches[0]["text"]
        if not text.strip() and not event.get("has_attachments"):
            raise PortalError("text_decode_unavailable", "The native message body is not ready.")
        return text

    def health(self, state: dict, now: float) -> bool:
        """Gate native sends on a working Messages stack; relaunch Messages if it died.

        Sending into a dead or wedged stack lets Apple Events succeed without ever creating
        chat rows, stranding parts as unknown, so parts stay queued instead. Only positive
        evidence holds sends; a probe that cannot run (for example, missing Automation
        consent) fails open to the ungated behavior.
        """
        age = now - state.get("checked_at", float("-inf"))
        if 0 <= age < (HEALTH_OK_SECONDS if state.get("ok") else HEALTH_RETRY_SECONDS):
            return bool(state.get("ok"))
        try:
            return self._probe(state, now)
        except (OSError, ValueError, subprocess.SubprocessError):
            return _verdict(state, now, True, "health_unverified")

    def _probe(self, state: dict, now: float) -> bool:
        pid = messages_pid()
        if pid is None:
            launch_messages()
            _restarted(state, now, "relaunched_messages")
            return _verdict(state, now, False, "messages_relaunched")
        outcome, _ = osascript('tell application "Messages" to get name', 5)
        if outcome == "unresponsive":
            since = state.setdefault("unresponsive_since", now)
            backoff = min(RESTART_BACKOFF_SECONDS * 2 ** state.get("restart_streak", 0), RESTART_BACKOFF_MAX)
            if now - since >= UNRESPONSIVE_SECONDS and now - state.get("last_restart", float("-inf")) >= backoff:
                restart_messages(pid)
                _restarted(state, now, "restarted_unresponsive_messages")
                state["restart_streak"] = state.get("restart_streak", 0) + 1
                state.pop("unresponsive_since", None)
                return _verdict(state, now, False, "messages_restarted")
            return _verdict(state, now, False, "messages_unresponsive")
        state.pop("unresponsive_since", None)
        if outcome == "error":
            return _verdict(state, now, True, "health_unverified")
        outcome, status = osascript(
            'tell application "Messages" to get connection status of '
            '(first account whose service type = iMessage)', 6,
        )
        if outcome == "unresponsive":
            return _verdict(state, now, False, "imessage_account_blocked", hint=BLOCKED_HINT)
        if outcome == "missing":
            return _verdict(state, now, False, "imessage_account_missing")
        if outcome == "error":
            return _verdict(state, now, True, "health_unverified")
        if status.casefold() != "connected":
            return _verdict(state, now, False, "imessage_" + re.sub(r"[^a-z]+", "_", status.casefold()).strip("_")[:32])
        state["restart_streak"] = 0
        return _verdict(state, now, True, "connected")


HEALTH_OK_SECONDS = 120
HEALTH_RETRY_SECONDS = 45
UNRESPONSIVE_SECONDS = 180
RESTART_BACKOFF_SECONDS = 600
RESTART_BACKOFF_MAX = 7200
MESSAGES_EXECUTABLES = (
    "/System/Applications/Messages.app/Contents/MacOS/Messages",
    "/Applications/Messages.app/Contents/MacOS/Messages",
)
# AppleScript errors that mean Messages cannot answer yet, versus ones that mean the
# probe itself is not possible (for example -1743, Automation consent not granted).
UNRESPONSIVE_ERRORS = {"-600", "-609", "-1712"}
MISSING_ERRORS = {"-1728", "-1719"}
BLOCKED_HINT = (
    "Messages is up but its iMessage account layer is not answering. Run the read-only "
    "doctor (python -m rapp_bubbles.doctor) to name the stuck dependency; after a "
    "disk-full it was the root scheduler dasd: sudo launchctl kickstart -k system/com.apple.dasd"
)


def messages_pid() -> int | None:
    listing = subprocess.run(
        ["/bin/ps", "-U", str(os.getuid()), "-o", "pid=,comm="],
        capture_output=True, text=True, timeout=10,
    ).stdout
    for line in listing.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[1] in MESSAGES_EXECUTABLES:
            return int(fields[0])
    return None


def osascript(script: str, timeout: float) -> tuple[str, str]:
    """Returns (ok|unresponsive|missing|error, output)."""
    try:
        done = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "unresponsive", ""
    if done.returncode == 0:
        return "ok", done.stdout.strip()
    code = re.search(r"\((-?\d+)\)\s*$", done.stderr.strip())
    number = code.group(1) if code else ""
    if number in UNRESPONSIVE_ERRORS:
        return "unresponsive", ""
    return ("missing" if number in MISSING_ERRORS else "error"), ""


def launch_messages() -> None:
    subprocess.run(["/usr/bin/open", "-g", "-a", "Messages"], capture_output=True, timeout=20, check=False)


def restart_messages(pid: int) -> None:
    """Restart one hung Messages process by PID (never by name), then relaunch it."""
    try:
        os.kill(pid, 15)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline and messages_pid() == pid:
            time.sleep(0.25)
        if messages_pid() == pid:
            os.kill(pid, 9)
    except ProcessLookupError:
        pass
    launch_messages()


def _restarted(state: dict, now: float, reason: str) -> None:
    state["last_restart"] = now
    state["restarts"] = (state.get("restarts", []) + [{"at": now, "reason": reason}])[-10:]


def _verdict(state: dict, now: float, ok: bool, code: str, *, hint: str | None = None) -> bool:
    if ok:
        since = state.pop("down_since", None)
        if since is not None and now - since >= 300:
            # Remembered so the portal can tell the owner once that iMessage is back.
            state["outage"] = {"start": since, "end": now, "code": state.get("code"), "reported": False}
    else:
        state.setdefault("down_since", now)
    state.update(ok=ok, code=code, checked_at=now)
    if hint:
        state["hint"] = hint
    else:
        state.pop("hint", None)
    return ok
