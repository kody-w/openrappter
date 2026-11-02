"""
Notes — Publishes to and reads your Apple Notes through OpenRappter.

A device agent: it does its work through OpenRappter's doors/1 (contracts/doors.md), so macOS asks about
the one signed app, never about this script. Every call carries a one-line WHY that the notch shows Kody
the first time this agent knocks. Standalone: python notes_agent.py '{"action": "read", "title": "Beam · Errands"}'
"""

import json
import os
import socket
import sys

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@kody-w/notes_agent",
    "version": "1.0.0",
    "display_name": "Notes",
    "description": "Publishes to and reads your Apple Notes through OpenRappter.",
    "author": "Kody Wildfeuer",
    "tags": ["device", "macos", "doors", "openrappter", "notes"],
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
        raise DoorProblem("OpenRappter is not running, so I can't reach Notes on this Mac. Open OpenRappter and try again.")
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
    "publish": "To write the update you asked for into Notes",
    "read": "To read the note you asked about",
}


class Notes(BasicAgent):
    def __init__(self):
        self.name = "Notes"
        self.metadata = {
            "name": self.name,
            "description": "Your Apple Notes: publish a dated entry to a topic note (newest first) or read a note. Uses OpenRappter.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["publish", "read"], "description": "publish or read."},
                    "topic": {"type": "string", "description": "For publish: the topic; the note is called 'Beam · <topic>'."},
                    "headline": {"type": "string", "description": "For publish: one line at the top of the entry."},
                    "body": {"type": "string", "description": "For publish: the rest of the entry."},
                    "title": {"type": "string", "description": "For read: the note's title."},
                    "folder": {"type": "string", "description": "Notes folder (default: Beam)."},
                    "why": {"type": "string", "description": "One line on why, shown to the person the first time."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = (kwargs.get("action") or "read").lower()
        why = kwargs.get("why") or WHY.get(action, "To help with your notes")
        folder = kwargs.get("folder") or "Beam"
        try:
            if action == "publish":
                topic, headline = kwargs.get("topic"), kwargs.get("headline")
                if not topic or not headline:
                    return "Give me a topic and a headline to publish."
                r = door("notes.publish", why, self.name, topic=topic, headline=headline, body=kwargs.get("body") or "", folder=folder)
                return "Published to \"Beam · {}\".".format(topic) + (" Link: " + r["link"] if r.get("link") else "")
            if action == "read":
                title = kwargs.get("title")
                if not title:
                    return "Which note? Give me its title."
                r = door("notes.read", why, self.name, title=title, folder=folder)
                return "{}:\n{}".format(r["title"], _plain(r["body"]))
            return "I can publish or read a note."
        except DoorProblem as e:
            return str(e)


def _plain(html):
    import re
    text = re.sub(r"<br\s*/?>|</div>|</p>|</li>", "\n", html or "")
    text = re.sub(r"<[^>]+>", "", text)
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&amp;", "&")):
        text = text.replace(a, b)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


if __name__ == "__main__":
    kw = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(Notes().perform(**kw))
