"""Device agents against a fake doors/1 server (no app, no macOS grants). python3 -m unittest agents/test_device_agents.py"""
import importlib.util, json, os, socket, sys, tempfile, threading, unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class FakeDoor:
    """A doors/1 socket that records every request and answers from a table of door -> result (or error)."""

    def __init__(self, answers):
        self.answers, self.seen = answers, []
        self.path = os.path.join(tempfile.mkdtemp(prefix="fd"), "d.sock")
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path); self.srv.listen(8)
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            buf = b""
            while b"\n" not in buf:
                chunk = c.recv(65536)
                if not chunk:
                    break
                buf += chunk
            req = json.loads(buf.split(b"\n")[0]); self.seen.append(req)
            a = self.answers.get(req["door"])
            out = {"ok": False, "error": a[1:]} if isinstance(a, str) and a.startswith("!") else {"ok": True, "result": a}
            c.sendall((json.dumps(out) + "\n").encode()); c.close()

    def close(self):
        self.srv.close()


def load(name, sock):
    os.environ["OPENRAPPTER_DOORS_SOCK"] = sock
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


class Base(unittest.TestCase):
    def door(self, answers):
        d = FakeDoor(answers); self.addCleanup(d.close); return d

    def assertEveryCallCarriesWhy(self, d, caller):
        self.assertTrue(d.seen)
        for r in d.seen:
            self.assertEqual(r["caller"], caller)
            self.assertTrue(r.get("why"), r)
            self.assertLessEqual(len(r["why"]), 200)


class RemindersTests(Base):
    def test_list_add_complete(self):
        d = self.door({"reminders.open": [{"id": "x-apple-reminder://1", "title": "Milk"}],
                       "reminders.add": {"id": "x-apple-reminder://2", "title": "Eggs"},
                       "reminders.done": {"id": "x-apple-reminder://1", "done": True}})
        a = load("reminders_agent", d.path).Reminders()
        self.assertIn("- Milk", a.perform(action="list"))
        self.assertEqual(a.perform(action="add", title="Eggs"), "Added to Reminders: Eggs")
        self.assertEqual(a.perform(action="complete", title="milk"), "Ticked off.")
        self.assertEqual(d.seen[-1]["args"]["id"], "x-apple-reminder://1")
        self.assertIn("couldn't find", a.perform(action="complete", title="Bread"))
        self.assertEveryCallCarriesWhy(d, "Reminders")

    def test_custom_why_and_refusal_are_plain_words(self):
        d = self.door({"reminders.open": "!Kody said no (or did not answer) to Reminders using reminders.open"})
        a = load("reminders_agent", d.path).Reminders()
        self.assertIn("Kody said no", a.perform(action="list", why="Morning brief needs your list"))
        self.assertEqual(d.seen[0]["why"], "Morning brief needs your list")

    def test_no_app_running(self):
        a = load("reminders_agent", "/tmp/no-such-doors.sock").Reminders()
        self.assertIn("OpenRappter is not running", a.perform(action="list"))


class NotesTests(Base):
    def test_publish_and_read(self):
        d = self.door({"notes.publish": {"note_id": "x-coredata://n/p1", "link": "https://airaptr.github.io/note-link/?n=abc"},
                       "notes.read": {"title": "Beam · Errands", "body": "<div><b>Nov 2</b> Done &amp; dusted</div><div>line two</div>"}})
        a = load("notes_agent", d.path).Notes()
        self.assertIn("Link: https://airaptr.github.io/note-link/?n=abc", a.perform(action="publish", topic="Errands", headline="Done"))
        out = a.perform(action="read", title="Beam · Errands")
        self.assertIn("Nov 2 Done & dusted", out); self.assertIn("line two", out); self.assertNotIn("<div>", out)
        self.assertIn("topic and a headline", a.perform(action="publish", topic="x"))
        self.assertEveryCallCarriesWhy(d, "Notes")


class MessagesTests(Base):
    def test_send_and_recent(self):
        d = self.door({"messages.send": {"sent": True},
                       "messages.recent": [{"rowid": 9, "ts": 1, "text": "hi", "from_me": False, "handle": "+15550000000"}]})
        a = load("messages_agent", d.path).Messages()
        self.assertEqual(a.perform(action="send", to="+15550000000", text="hello"), "Sent.")
        self.assertEqual(a.perform(action="recent", limit=3), "them +15550000000: hi")
        self.assertEqual(d.seen[-1]["args"], {"since_rowid": 0, "limit": 3, "newest": True})
        self.assertIn("who to text", a.perform(action="send", to=""))
        self.assertEveryCallCarriesWhy(d, "Messages")

    def test_manifest_is_rar_shaped(self):
        for name in ("reminders_agent", "notes_agent", "messages_agent"):
            m = load(name, "/tmp/x.sock").__manifest__
            self.assertEqual(m["schema"], "rapp-agent/1.0"); self.assertIn("device", m["tags"])
            self.assertTrue(m["name"].startswith("@kody-w/"))


if __name__ == "__main__":
    unittest.main()
