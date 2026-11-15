#!/usr/bin/env python3
"""openrappter-door/1: ask the owner of a Mac a question, or read and answer what that Mac has left for them.

One file, standard library only. Works from any device on the owner's private network (Tailscale), or on the Mac itself.

    from openrappter_door import Door
    door = Door("rapptertwo")                       # a name or address on the private network
    door.left()                                     # what is waiting, each with its choices
    picked = door.ask("Restart tonight?", ["Yes", "Not now"], wait=600)   # None if nobody answered in time
    door.pick("Not now")                            # answer something that is waiting, by its label

    python3 openrappter_door.py left rapptertwo
    python3 openrappter_door.py ask  rapptertwo "Restart tonight?" "Yes" "Not now"
    python3 openrappter_door.py pick rapptertwo "Not now"

The protocol (five calls, all on port 7466):
    GET  /             the page, a button per choice
    GET  /left.json    {schema, mac, at, held, token, left: [{says, choices: [{offer, label}]}]}
    POST /pick         {"token", "offer"}       takes one choice; a token works once
    POST /ask          {"title", "text", "choices"}   gives {ok, id}
    GET  /answer/<id>  {id, picked}             picked is null until the owner chooses
"""
import json, sys, time, urllib.request, urllib.error

SCHEMA = "openrappter-door/1"
PORT = 7466


class Door:
    def __init__(self, host="127.0.0.1", port=PORT, timeout=15):
        self.base, self.timeout = "http://%s:%d" % (host, port), timeout

    def _call(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read() or b"{}")
            except ValueError:
                return {"ok": False, "said": "the Mac answered %d" % e.code}

    def left(self):
        """Everything that Mac has left for its owner. Raises if the Mac speaks a different protocol."""
        doc = self._call("/left.json")
        if doc.get("schema") != SCHEMA:
            raise RuntimeError("expected %s, got %r" % (SCHEMA, doc.get("schema")))
        return doc

    def pick(self, label, says=None):
        """Answer something that is waiting, by the words on its button. `says` narrows it to one item."""
        doc = self.left()
        for item in doc["left"]:
            if says and says.lower() not in item["says"].lower():
                continue
            for c in item["choices"]:
                if c["label"].lower() == label.lower():
                    return self._call("/pick", {"token": doc["token"], "offer": c["offer"]})
        return {"ok": False, "said": "nothing waiting offers %r" % label}

    def ask(self, title, choices, text="", wait=0, every=3):
        """Put a question to the owner. With wait > 0, returns what they picked, or None if they did not answer in time.
        With wait == 0, returns the question's id; read it later with answer(id)."""
        r = self._call("/ask", {"title": title, "text": text, "choices": list(choices)})
        if not r.get("ok"):
            raise RuntimeError(r.get("said", "the question was not taken"))
        if not wait:
            return r["id"]
        end = time.time() + wait
        while time.time() < end:
            picked = self.answer(r["id"])
            if picked is not None:
                return picked
            time.sleep(every)
        return None

    def answer(self, qid):
        return self._call("/answer/" + qid).get("picked")


def main(argv):
    if len(argv) < 3 or argv[1] not in ("left", "ask", "pick"):
        print(__doc__); return 2
    door = Door(argv[2])
    if argv[1] == "left":
        doc = door.left()
        print("%s: %d left for you%s" % (doc["mac"], len(doc["left"]), " (hands off is on)" if doc["held"] else ""))
        for item in doc["left"]:
            print("  %s  [%s]" % (item["says"], " | ".join(c["label"] for c in item["choices"])))
    elif argv[1] == "ask":
        if len(argv) < 5:
            print("ask needs a question and at least one choice"); return 2
        picked = door.ask(argv[3], argv[4:], wait=3600)
        print(picked if picked is not None else "no answer"); return 0 if picked is not None else 1
    else:
        r = door.pick(argv[3]); print(r.get("said", r)); return 0 if r.get("ok") else 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
