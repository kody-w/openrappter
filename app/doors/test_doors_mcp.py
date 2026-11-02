"""MCP door tests: a scripted stdio session against a fake door socket. python3 -m unittest app/doors/test_doors_mcp.py"""
import json, os, socket, subprocess, sys, tempfile, threading, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.join(HERE, "rappter-doors-mcp")


class FakeDoors(threading.Thread):
    """Answers like OpenRappter; refuses callers named in `refuse`. Records every request."""
    def __init__(self, path, refuse=()):
        super().__init__(daemon=True)
        self.path, self.refuse, self.seen = path, set(refuse), []
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); self.srv.bind(path); self.srv.listen(8)

    def run(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            f = c.makefile("rwb")
            for line in f:
                req = json.loads(line); self.seen.append(req)
                if req["door"] == "doors.hello":
                    r = {"ok": True, "result": {"contract": "doors/1", "doors": ["doors.hello", "reminders.open", "pets.feed"]}}
                elif req.get("caller") in self.refuse:
                    r = {"ok": False, "error": "Kody said no"}
                elif req["door"] == "reminders.open":
                    r = {"ok": True, "result": [{"id": "r1", "title": "milk"}]}
                elif req["door"] == "pets.feed":
                    r = {"ok": True, "result": {"fed": req["args"].get("pet")}}
                else:
                    r = {"ok": False, "error": "no door " + req["door"]}
                f.write((json.dumps(r) + "\n").encode()); f.flush()
            c.close()


def session(sock, msgs, client="claude-code"):
    env = dict(os.environ, OPENRAPPTER_DOORS_SOCK=sock)
    init = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": client, "version": "1"}}}
    lines = [init, {"jsonrpc": "2.0", "method": "notifications/initialized"}] + msgs
    out = subprocess.run([sys.executable, MCP], input="".join(json.dumps(m) + "\n" for m in lines),
                         capture_output=True, text=True, env=env, timeout=30)
    return {r["id"]: r for r in map(json.loads, out.stdout.splitlines())}


def call(i, name, args=None):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}


class McpDoor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(dir="/tmp"); self.sock = os.path.join(self.dir, "d.sock")
        self.fake = FakeDoors(self.sock, refuse={"stranger"}); self.fake.start()

    def tearDown(self):
        self.fake.srv.close()

    def test_initialize_list_call(self):
        r = session(self.sock, [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, call(2, "reminders_open", {"list": "Beam"})])
        self.assertEqual(r[0]["result"]["serverInfo"]["name"], "openrappter-doors")
        tools = {t["name"]: t for t in r[1]["result"]["tools"]}
        for t in tools.values():
            self.assertIn("approves each new caller on the OpenRappter notch", t["description"])
        self.assertIn("list", tools["reminders_open"]["inputSchema"]["properties"])
        self.assertEqual(tools["messages_send"]["inputSchema"]["required"], ["to", "text"])
        self.assertEqual(tools["messages_recent"]["inputSchema"]["properties"]["limit"]["type"], "integer")
        self.assertFalse(r[2]["result"].get("isError"))
        self.assertEqual(json.loads(r[2]["result"]["content"][0]["text"]), [{"id": "r1", "title": "milk"}])
        req = [s for s in self.fake.seen if s["door"] == "reminders.open"][-1]
        self.assertEqual(req["caller"], "claude-code"); self.assertEqual(req["args"], {"list": "Beam"})

    def test_new_door_needs_no_code(self):
        r = session(self.sock, [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, call(2, "pets_feed", {"pet": "rex"})], client="copilot")
        self.assertIn("pets_feed", [t["name"] for t in r[1]["result"]["tools"]])
        self.assertEqual(json.loads(r[2]["result"]["content"][0]["text"]), {"fed": "rex"})
        self.assertEqual(self.fake.seen[-1]["caller"], "copilot")

    def test_caller_refused_is_plain(self):
        r = session(self.sock, [call(1, "reminders_open")], client="stranger")
        self.assertTrue(r[1]["result"]["isError"])
        self.assertEqual(r[1]["result"]["content"][0]["text"], "OpenRappter refused reminders.open for stranger: Kody said no")

    def test_app_not_running_is_plain(self):
        r = session(os.path.join(self.dir, "absent.sock"), [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, call(2, "reminders_open")])
        self.assertIn("reminders_open", [t["name"] for t in r[1]["result"]["tools"]])  # contract doors still listed
        self.assertTrue(r[2]["result"]["isError"])
        self.assertIn("OpenRappter is not running", r[2]["result"]["content"][0]["text"])

    def test_unknown_method(self):
        r = session(self.sock, [{"jsonrpc": "2.0", "id": 1, "method": "resources/list"}])
        self.assertEqual(r[1]["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main()
