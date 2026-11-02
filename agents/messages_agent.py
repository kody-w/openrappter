"""
Messages — Sends a text and reads recent texts through OpenRappter (iMessage on this Mac).

A device agent: it does its work through OpenRappter's doors/1 (contracts/doors.md), so macOS asks about
the one signed app, never about this script. Every call carries a one-line WHY that the notch shows Kody
the first time this agent knocks. Standalone: python messages_agent.py '{"action": "recent", "limit": 5}'
"""

import json
import os
import socket
import sys

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@kody-w/messages_agent",
    "version": "1.0.0",
    "display_name": "Messages",
    "description": "Sends a text and reads recent texts through OpenRappter (iMessage on this Mac).",
    "author": "Kody Wildfeuer",
    "tags": ["device", "macos", "doors", "openrappter", "messages"],
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
        raise DoorProblem("OpenRappter is not running, so I can't reach Messages on this Mac. Open OpenRappter and try again.")
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
    "send": "To send the text you asked me to send",
    "recent": "To read your recent texts so I can answer you",
}


class Messages(BasicAgent):
    def __init__(self):
        self.name = "Messages"
        self.metadata = {
            "name": self.name,
            "description": "Your Messages: send a text over iMessage, or read your most recent texts. Uses OpenRappter.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["send", "recent"], "description": "send or recent."},
                    "to": {"type": "string", "description": "For send: phone number or email of the person."},
                    "text": {"type": "string", "description": "For send: what to say."},
                    "limit": {"type": "integer", "description": "For recent: how many (default 10, max 50)."},
                    "why": {"type": "string", "description": "One line on why, shown to the person the first time."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = (kwargs.get("action") or "recent").lower()
        why = kwargs.get("why") or WHY.get(action, "To help with your messages")
        try:
            if action == "send":
                to, text = (kwargs.get("to") or "").strip(), (kwargs.get("text") or "").strip()
                if not to or not text:
                    return "Tell me who to text and what to say."
                door("messages.send", why, self.name, to=to, text=text)
                return "Sent."
            if action == "recent":
                n = max(1, min(int(kwargs.get("limit") or 10), 50))
                rows = door("messages.recent", why, self.name, since_rowid=0, limit=n, newest=True)
                if not rows:
                    return "No texts found."
                return "\n".join("{} {}: {}".format("me" if r["from_me"] else "them", r["handle"] or "?", r["text"]) for r in rows)
            return "I can send a text or read recent ones."
        except DoorProblem as e:
            return str(e)


if __name__ == "__main__":
    kw = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(Messages().perform(**kw))
