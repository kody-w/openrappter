"""
Reminders — Lists, adds and ticks off your Apple Reminders through OpenRappter.

A device agent: it does its work through OpenRappter's doors/1 (contracts/doors.md), so macOS asks about
the one signed app, never about this script. Every call carries a one-line WHY that the notch shows Kody
the first time this agent knocks. Standalone: python reminders_agent.py '{"action": "list"}'
"""

import json
import os
import socket
import sys

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@kody-w/reminders_agent",
    "version": "1.0.0",
    "display_name": "Reminders",
    "description": "Lists, adds and ticks off your Apple Reminders through OpenRappter.",
    "author": "Kody Wildfeuer",
    "tags": ["device", "macos", "doors", "openrappter", "reminders"],
    "category": "productivity",
    "quality_tier": "community",
    "requires_env": [],
    "dependencies": ["@rapp/basic_agent"],
}

try:
    from agents.basic_agent import BasicAgent
except ModuleNotFoundError:
    try:
        from openrappter.agents.basic_agent import BasicAgent
    except ModuleNotFoundError:
        class BasicAgent:
            def __init__(self, name=None, metadata=None):
                self.name = name
                self.metadata = metadata


# ── doors/1, vendored from app/doors/rappter_doors.py (one file, stdlib only) ──
DOORS_SOCK = os.environ.get("OPENRAPPTER_DOORS_SOCK") or os.path.expanduser("~/.openrappter/doors.sock")


class DoorProblem(Exception):
    pass


def door(name, why, caller, timeout=180, **args):
    """Ask OpenRappter to open one door. Returns the result, or raises DoorProblem with plain words."""
    msg = {"door": name, "args": args, "caller": caller, "why": why}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)  # the first call may wait for Kody's click in the notch
    try:
        s.connect(DOORS_SOCK)
    except OSError:
        s.close()
        raise DoorProblem("OpenRappter is not running, so I can't reach Reminders on this Mac. Open OpenRappter and try again.")
    try:
        s.sendall((json.dumps(msg) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except socket.timeout:
        raise DoorProblem("OpenRappter did not answer in time (is the approval card still waiting in the notch?)")
    finally:
        s.close()
    if not buf.strip():
        raise DoorProblem("OpenRappter closed the door without an answer")
    r = json.loads(buf.split(b"\n", 1)[0])
    if not r.get("ok"):
        raise DoorProblem(r.get("error") or "the door said no")
    return r.get("result")


WHY = {
    "list": "To read your open reminders so I can tell you what's on your list",
    "add": "To add the reminder you asked for",
    "complete": "To tick off the reminder you said is done",
}


class Reminders(BasicAgent):
    def __init__(self):
        self.name = "Reminders"
        self.metadata = {
            "name": self.name,
            "description": "Your Apple Reminders: list what's open, add one, or tick one off. Uses OpenRappter, so it works from any script or job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "complete"], "description": "list, add or complete."},
                    "list": {"type": "string", "description": "Reminders list name (default: Reminders)."},
                    "title": {"type": "string", "description": "For add: the reminder. For complete: its title (or use id)."},
                    "id": {"type": "string", "description": "For complete: the reminder id from list."},
                    "note": {"type": "string", "description": "Optional note to keep with it."},
                    "why": {"type": "string", "description": "One line on why, shown to the person the first time."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = (kwargs.get("action") or "list").lower()
        lst = kwargs.get("list") or "Reminders"
        why = kwargs.get("why") or WHY.get(action, "To help with your reminders")
        try:
            if action == "list":
                items = door("reminders.open", why, self.name, list=lst)
                if not items:
                    return "Nothing open in {}.".format(lst)
                return "Open in {} ({}):\n".format(lst, len(items)) + "\n".join("- " + i["title"] for i in items)
            if action == "add":
                title = (kwargs.get("title") or "").strip()
                if not title:
                    return "Tell me what the reminder should say."
                r = door("reminders.add", why, self.name, list=lst, title=title, note=kwargs.get("note") or "")
                return "Added to {}: {}".format(lst, r["title"])
            if action == "complete":
                rid = kwargs.get("id")
                if not rid:
                    want = (kwargs.get("title") or "").strip().lower()
                    match = [i for i in door("reminders.open", why, self.name, list=lst) if i["title"].strip().lower() == want]
                    if not match:
                        return "I couldn't find an open reminder called \"{}\" in {}.".format(kwargs.get("title"), lst)
                    rid = match[0]["id"]
                door("reminders.done", why, self.name, id=rid, list=lst, note=kwargs.get("note") or "Done")
                return "Ticked off."
            return "I can list, add or complete reminders."
        except DoorProblem as e:
            return str(e)


if __name__ == "__main__":
    kw = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(Reminders().perform(**kw))
