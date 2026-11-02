"""doors/1 SDK: ask OpenRappter (the notch app) to do the macOS-guarded work. One file, stdlib only.

    import rappter_doors as doors
    doors.call("reminders.open")                 # -> [{"id":..., "title":...}]
    doors.notes_publish("Errands", "Done", "body")  # -> {"note_id":..., "link":...}

Contract: contracts/doors.md. Raises DoorUnavailable when the app is not running (callers fall back),
DoorRefused when the door answered ok:false.
"""
import json, os, socket

CONTRACT = "doors/1"
SOCK = os.environ.get("OPENRAPPTER_DOORS_SOCK") or os.path.expanduser("~/.openrappter/doors.sock")


class DoorError(Exception):
    pass


class DoorUnavailable(DoorError):
    """No app behind the socket: fall back to your old path."""


class DoorRefused(DoorError):
    """The door answered with ok:false (plain words in str(e))."""


def available(path=None):
    return os.path.exists(path or SOCK)


def raw(door, args=None, caller=None, timeout=180, path=None):
    """One request, the whole reply dict ({"ok":..., "result"|"error":...})."""
    path = path or SOCK
    msg = {"door": door, "args": args or {}}
    caller = caller or os.environ.get("RAPPTER_DOOR_CALLER")
    if caller:
        msg["caller"] = caller
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)  # the first call may wait for Kody's click in the notch
    try:
        s.connect(path)
    except (FileNotFoundError, ConnectionRefusedError, OSError) as e:
        s.close()
        raise DoorUnavailable("OpenRappter is not answering at {} ({})".format(path, e))
    try:
        s.sendall((json.dumps(msg) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except socket.timeout:
        raise DoorRefused("no answer from OpenRappter in {}s".format(timeout))
    finally:
        s.close()
    if not buf.strip():
        raise DoorUnavailable("OpenRappter closed the door without a reply")
    return json.loads(buf.split(b"\n", 1)[0])


def call(door, caller=None, timeout=180, **args):
    r = raw(door, args, caller=caller, timeout=timeout)
    if not r.get("ok"):
        raise DoorRefused(r.get("error") or "the door said no")
    return r.get("result")


# Typed helpers (one per door in doors/1).
def hello(**kw): return call("doors.hello", **kw)
def reminders_open(list="Beam", **kw): return call("reminders.open", list=list, **kw)
def reminders_done(id, note="", **kw): return call("reminders.done", id=id, note=note, **kw)
def notes_publish(topic, headline, body="", **kw): return call("notes.publish", topic=topic, headline=headline, body=body, **kw)
def notes_read(title, **kw): return call("notes.read", title=title, **kw)
def messages_send(to, text, **kw): return call("messages.send", to=to, text=text, **kw)
def messages_recent(since_rowid=0, **kw): return call("messages.recent", since_rowid=since_rowid, **kw)
