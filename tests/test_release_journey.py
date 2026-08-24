import importlib.util
import json
import os
import shutil
import stat
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_journey", ROOT / "scripts/release_journey.py")
journey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journey)


def initial_state():
    return {
        "indexes": {
            ring: {
                "schema": "openrappter-request-index/v1",
                "ring": ring,
                "base_sequence": 1,
                "next_sequence": 2,
                "entries": [],
            }
            for ring in journey.RINGS
        },
        "heads": {
            ring: {
                "sequence": 1,
                "promotion_id": f"{1:064x}",
                "target_manifest_commit": f"{1:040x}",
                "artifact_sha256": "a" * 64,
            }
            for ring in journey.RINGS
        },
        "acks": {},
        "calls": [],
        "candidate": False,
        "stable_pr": None,
        "pages": False,
        "pages_configured": True,
        "tag": False,
        "released": False,
    }


class JourneyTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / ".journey-test"
        shutil.rmtree(self.work, ignore_errors=True)
        self.work.mkdir()
        self.fixture = self.work / "state.json"
        self.checkpoint = self.work / "checkpoint.json"
        self.fixture.write_text(json.dumps(initial_state()))

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def args(self, resume=False):
        return types.SimpleNamespace(
            root=str(ROOT),
            channel_version=None if resume else "0.1.0-beta.11",
            checkpoint=str(self.checkpoint),
            resume=resume,
            dry_run=True,
            fixtures=str(self.work),
            timeout=10,
        )

    def test_full_sequence_is_stateful_resumable_and_exact(self):
        self.assertEqual(journey.run(self.args()), 0)
        checkpoint = json.loads(self.checkpoint.read_text())
        self.assertEqual(checkpoint["phase"], "stable_review")
        self.assertEqual(stat.S_IMODE(self.checkpoint.stat().st_mode), 0o600)
        state = json.loads(self.fixture.read_text())
        workflows = [call["workflow"] for call in state["calls"]]
        self.assertEqual(workflows[:2], ["build-candidate.yml", "observe-main.yml"])
        self.assertEqual(workflows.count("request-promotion.yml"), 4)
        self.assertFalse(state["tag"])
        with self.assertRaisesRegex(RuntimeError, "not merged"):
            journey.run(self.args(resume=True))
        state = json.loads(self.fixture.read_text())
        state["stable_pr"]["merged_at"] = "2026-08-23T23:00:00Z"
        state["stable_pr"]["merge_commit_sha"] = "f" * 40
        self.fixture.write_text(json.dumps(state))
        self.assertEqual(journey.run(self.args(resume=True)), 0)
        state = json.loads(self.fixture.read_text())
        self.assertTrue(state["pages"] and state["tag"] and state["released"])
        calls = [call["workflow"] for call in state["calls"]]
        self.assertLess(calls.index("pages.yml"), calls.index("create-release-tag.yml"))
        self.assertLess(calls.index("create-release-tag.yml"), calls.index("release.yml"))

    def test_failed_workflow_and_prepopulated_future_index_fail(self):
        state = initial_state()
        state["fail_workflow"] = "observe-main.yml"
        self.fixture.write_text(json.dumps(state))
        with self.assertRaisesRegex(RuntimeError, "observe-main.yml failed"):
            journey.run(self.args())
        state = initial_state()
        state["indexes"]["alpha"]["entries"].append({
            "sequence": 2, "request_id": "2" * 64, "path": "future",
        })
        self.fixture.write_text(json.dumps(state))
        with self.assertRaisesRegex(RuntimeError, "prepopulate"):
            journey.FakeGitHub(self.fixture)

    def test_missing_request_promotion_and_stale_index_fail(self):
        gh = journey.FakeGitHub(self.fixture)
        with self.assertRaisesRegex(RuntimeError, "prior ring"):
            gh.workflow(journey.TRAIN, "request-promotion.yml", {"target_ring": "alpha"})
        gh.state["indexes"]["nightly"]["entries"] = [{
            "sequence": 3, "request_id": "3" * 64, "path": "stale",
        }]
        gh.save()
        with self.assertRaisesRegex(RuntimeError, "stale index"):
            journey.latest_request(gh, "nightly", 2)
        with self.assertRaisesRegex(RuntimeError, "tag before stable"):
            gh.workflow("kody-w/openrappter", "create-release-tag.yml", {})

    def test_incorrect_resume_merge_is_rejected(self):
        journey.run(self.args())
        state = json.loads(self.fixture.read_text())
        state["stable_pr"]["number"] = 100
        state["stable_pr"]["merged_at"] = "2026-08-23T23:00:00Z"
        state["stable_pr"]["merge_commit_sha"] = "e" * 40
        self.fixture.write_text(json.dumps(state))
        with self.assertRaisesRegex(RuntimeError, "PR mismatch"):
            journey.run(self.args(resume=True))


if __name__ == "__main__":
    unittest.main()
