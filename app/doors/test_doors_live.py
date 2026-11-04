"""Integration test against the RUNNING app (skips when no socket). python3 -m unittest app/doors/test_doors_live.py"""
import json, os, stat, subprocess, sys, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import rappter_doors as doors


@unittest.skipUnless(doors.available(), "OpenRappter is not running")
class Live(unittest.TestCase):
    def test_socket_is_private(self):
        self.assertEqual(stat.S_IMODE(os.stat(doors.SOCK).st_mode), 0o600)

    def test_hello_lists_v1_doors(self):
        r = doors.hello()
        self.assertEqual(r["contract"], "doors/1")
        for d in ["reminders.open", "reminders.done", "notes.publish", "notes.read", "messages.send", "messages.recent"]:
            self.assertIn(d, r["doors"])

    def test_cli_json_and_exit_codes(self):
        ok = subprocess.run([os.path.join(HERE, "rappter-door"), "doors.hello"], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0); self.assertTrue(json.loads(ok.stdout)["ok"])
        bad = subprocess.run([os.path.join(HERE, "rappter-door"), "no.such.door"], capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1); self.assertIn("no door", json.loads(bad.stdout)["error"])


class Offline(unittest.TestCase):
    def test_absent_socket_is_unavailable(self):
        with self.assertRaises(doors.DoorUnavailable):
            doors.raw("doors.hello", path="/tmp/no-such-doors.sock")


if __name__ == "__main__":
    unittest.main()
