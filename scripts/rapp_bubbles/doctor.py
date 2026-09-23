"""Read-only diagnosis of a stuck iMessage stack.

Messages depends on per-user daemons that make synchronous XPC calls to each other and to
root services. When one link stops answering, everything above it hangs, and restarting
the processes above it cannot help. This samples only same-user iMessage processes (no
root access, no message data), recognizes known blocking calls, and names the lowest
unresponsive link together with the fix it needs.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

PROCESSES = (
    "Messages", "imagent", "identityservicesd", "transparencyd",
    "syncdefaultsd", "callservicesd", "accountsd",
)
# Evidence in a blocked thread (queue name or frame) -> the service it is waiting on.
SIGNATURES = (
    ("_DASScheduler", "dasd"),
    ("BGSystemTaskScheduler", "dasd"),
    ("TransparencyXPCConnection", "transparencyd"),
    ("KTOptInManager", "transparencyd"),
    ("SYDClientToDaemonConnection", "syncdefaultsd"),
    ("com.apple.kvs.client", "syncdefaultsd"),
    ("IDSDaemonController", "identityservicesd"),
    ("IMDaemonController", "imagent"),
    ("IMCore.DaemonConnectionSetup", "imagent"),
    ("callcapabilitiesxpcclient", "callservicesd"),
)
WAIT_FRAMES = ("xpc_connection_send_message_with_reply_sync", "_dispatch_sync_f_slow")
ROOT_FIXES = {
    "dasd": "sudo launchctl kickstart -k system/com.apple.dasd",
}
THREAD = re.compile(r"^\s*(\d+)\s+Thread_\S+(.*)$")
FRAME = re.compile(r"^[\s+!:|]*(\d+)\s+(.*)$")
QUEUE = re.compile(r"DispatchQueue_\d+:\s*(\S+)")


def processes() -> dict[str, int]:
    listing = subprocess.run(
        ["/bin/ps", "-U", str(os.getuid()), "-o", "pid=,comm="],
        capture_output=True, text=True, timeout=10, check=True,
    ).stdout
    found = {}
    for line in listing.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        name = Path(fields[1]).name
        if name == "Messages" and not fields[1].endswith("/Messages.app/Contents/MacOS/Messages"):
            continue
        if name in PROCESSES and name not in found:
            found[name] = int(fields[0])
    return found


def blocked_waits(report: str) -> list[dict]:
    """Threads that spent the whole sample inside a synchronous wait, with what they wait on."""
    graph = report.split("Call graph:", 1)[-1].split("Total number in stack", 1)[0]
    threads, current = [], None
    for line in graph.splitlines():
        header = THREAD.match(line)
        if header:
            current = {"count": int(header.group(1)), "lines": [header.group(2)]}
            threads.append(current)
        elif current is not None and line.strip():
            current["lines"].append(line)
    waits = []
    for thread in threads:
        full = False
        for line in thread["lines"][1:]:
            frame = FRAME.match(line)
            if frame and int(frame.group(1)) == thread["count"] and any(w in frame.group(2) for w in WAIT_FRAMES):
                full = True
                break
        if not full:
            continue
        text = "\n".join(thread["lines"])
        service = next((target for marker, target in SIGNATURES if marker in text), None)
        if service:
            queue = QUEUE.search(thread["lines"][0])
            waits.append({"service": service, "queue": queue.group(1) if queue else None})
    return waits


def sample_all(pids: dict[str, int], seconds: int = 1) -> dict[str, str]:
    reports = {}
    with tempfile.TemporaryDirectory(prefix="imessage-doctor-") as scratch:
        running = {
            name: subprocess.Popen(
                ["/usr/bin/sample", str(pid), str(seconds), "-mayDie", "-file", str(Path(scratch) / name)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            for name, pid in pids.items()
        }
        for name, process in running.items():
            try:
                process.wait(timeout=60)
                reports[name] = (Path(scratch) / name).read_text(errors="replace")
            except (subprocess.TimeoutExpired, OSError):
                process.kill()
    return reports


def account_probe(timeout: float = 6) -> str:
    try:
        done = subprocess.run(
            ["/usr/bin/osascript", "-e",
             'tell application "Messages" to get connection status of (first account whose service type = iMessage)'],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "timeout"
    if done.returncode != 0:
        return "error"
    return done.stdout.strip() or "error"


def diagnose(pids: dict[str, int], reports: dict[str, str], account: str | None = None) -> dict:
    edges = []
    for name, report in sorted(reports.items()):
        for wait in blocked_waits(report):
            edge = {"from": name, "to": wait["service"], "queue": wait["queue"]}
            if wait["service"] != name and edge not in edges:
                edges.append(edge)
    blocked = {edge["from"] for edge in edges}
    roots = sorted({
        edge["to"] for edge in edges
        if edge["to"] in ROOT_FIXES or edge["to"] not in blocked
    })
    result = {"processes": pids, "account": account, "edges": edges, "roots": roots}
    if "dasd" in roots:
        result.update(
            verdict="dasd_unresponsive", fix=ROOT_FIXES["dasd"],
            explanation=(
                "The root background-task scheduler (dasd) is not answering, so every iMessage "
                "daemon that registers background work hangs. User-level restarts cannot fix it; "
                "restart dasd as an administrator (or reboot)."
            ),
        )
    elif roots:
        missing = [root for root in roots if root not in pids]
        result.update(
            verdict="blocked_on_" + "_".join(roots),
            explanation=(
                "iMessage daemons are waiting on " + ", ".join(roots)
                + (" which is not running." if missing else " which is not answering.")
            ),
        )
    elif "Messages" not in pids:
        result.update(verdict="messages_not_running", explanation="Messages is not running.")
    elif account == "connected":
        result.update(verdict="healthy", explanation="No blocked iMessage calls; the iMessage account is connected.")
    else:
        result.update(
            verdict="no_blocking_seen",
            explanation="No known blocking call was sampled; the iMessage account reports "
                        + (account or "an unknown state") + ".",
        )
    result["ok"] = result["verdict"] == "healthy"
    return result


def run(*, probe_account: bool = True) -> dict:
    pids = processes()
    reports = sample_all(pids)
    return diagnose(pids, reports, account_probe() if probe_account and "Messages" in pids else None)


if __name__ == "__main__":
    report = run(probe_account="--no-account" not in sys.argv[1:])
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["ok"] else 1)
