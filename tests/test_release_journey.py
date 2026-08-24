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
        "release_runs": [],
        "next_run_id": 5000,
        "clock": 100,
        "release_mode": "fast",
        "concurrent_release_runs": [],
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

    def prepare_merged_resume(self, mutate=None):
        self.assertEqual(journey.run(self.args()), 0)
        state = json.loads(self.fixture.read_text())
        state["stable_pr"]["merged_at"] = "2026-08-23T23:00:00Z"
        state["stable_pr"]["merge_commit_sha"] = "f" * 40
        if mutate:
            mutate(state)
        self.fixture.write_text(json.dumps(state))

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
        self.assertLess(calls.index("release-baseline"), calls.index("create-release-tag.yml"))
        self.assertNotIn("release.yml", calls)
        self.assertEqual(len(state["release_runs"]), 1)
        self.assertEqual(state["release_runs"][0]["event"], "push")
        self.assertEqual(state["release_runs"][0]["headBranch"], checkpoint["intended_release_tag"])
        self.assertEqual(state["release_runs"][0]["headSha"], checkpoint["source_commit"])
        baseline_call = next(call for call in state["calls"] if call["workflow"] == "release-baseline")
        self.assertEqual(baseline_call["fields"]["tag"], checkpoint["intended_release_tag"])
        self.assertEqual(baseline_call["fields"]["source_commit"], checkpoint["source_commit"])
        self.assertIn("captured_at", baseline_call["fields"])

    def test_release_baseline_precedes_fast_automatic_tag_run(self):
        self.prepare_merged_resume()
        self.assertEqual(journey.run(self.args(resume=True)), 0)
        state = json.loads(self.fixture.read_text())
        names = [call["workflow"] for call in state["calls"]]
        self.assertNotIn("release.yml", names)
        self.assertTrue(state["released"])
        self.assertEqual(len(state["release_runs"]), 1)

    def test_delayed_and_unrelated_release_runs_select_only_exact_tag_push(self):
        def mutate(state):
            state["release_mode"] = "delayed"
            state["concurrent_release_runs"] = [
                {
                    "databaseId": 4998, "status": "completed", "conclusion": "success",
                    "event": "workflow_dispatch", "headBranch": "main",
                    "headSha": "e" * 40, "createdAt": 101,
                },
                {
                    "databaseId": 4999, "status": "completed", "conclusion": "success",
                    "event": "push", "headBranch": "v1.13.0",
                    "headSha": "0" * 40, "createdAt": 102,
                },
            ]
        self.prepare_merged_resume(mutate)
        self.assertEqual(journey.run(self.args(resume=True)), 0)
        state = json.loads(self.fixture.read_text())
        exact = [
            row for row in state["release_runs"]
            if row["event"] == "push"
            and row["headBranch"] == "v1.13.0"
            and row["headSha"] == json.loads(self.checkpoint.read_text())["source_commit"]
        ]
        self.assertEqual(len(exact), 1)
        self.assertEqual(exact[0]["conclusion"], "success")

    def test_idempotent_existing_tag_reuses_one_successful_release(self):
        def mutate(state):
            state["tag"] = True
            state["released"] = True
            source = json.loads(self.checkpoint.read_text())["source_commit"]
            state["release_runs"] = [{
                "databaseId": 4099, "status": "completed", "conclusion": "success",
                "event": "push", "headBranch": "v1.13.0", "headSha": source,
                "createdAt": 90,
            }]
        self.prepare_merged_resume(mutate)
        self.assertEqual(journey.run(self.args(resume=True)), 0)
        state = json.loads(self.fixture.read_text())
        self.assertEqual(len(state["release_runs"]), 1)
        self.assertEqual(
            [call["workflow"] for call in state["calls"]].count("create-release-tag.yml"),
            1,
        )

    def test_deleted_tag_history_does_not_replace_fresh_release_run(self):
        def mutate(state):
            source = json.loads(self.checkpoint.read_text())["source_commit"]
            state["release_runs"] = [{
                "databaseId": 4098, "status": "completed", "conclusion": "success",
                "event": "push", "headBranch": "v1.13.0", "headSha": source,
                "createdAt": 90,
            }]
            state["tag"] = False
        self.prepare_merged_resume(mutate)
        self.assertEqual(journey.run(self.args(resume=True)), 0)
        checkpoint = json.loads(self.checkpoint.read_text())
        self.assertEqual(checkpoint["release_run_id"], 5000)

    def test_duplicate_exact_release_runs_fail_ambiguous(self):
        def mutate(state):
            source = json.loads(self.checkpoint.read_text())["source_commit"]
            state["concurrent_release_runs"] = [{
                "databaseId": 4997, "status": "completed", "conclusion": "success",
                "event": "push", "headBranch": "v1.13.0", "headSha": source,
                "createdAt": 101,
            }]
        self.prepare_merged_resume(mutate)
        with self.assertRaisesRegex(RuntimeError, "multiple release.yml runs"):
            journey.run(self.args(resume=True))

    def test_failed_or_cancelled_tag_and_release_fail_closed(self):
        for failure, message in (
            ({"fail_workflow": "create-release-tag.yml"}, "create-release-tag.yml failed"),
            ({"tag_conclusion": "cancelled"}, "create-release-tag.yml failed: cancelled"),
            ({"release_mode": "failure"}, "release.yml failed: failure"),
            ({"release_mode": "cancelled"}, "release.yml failed: cancelled"),
        ):
            with self.subTest(failure=failure):
                shutil.rmtree(self.work, ignore_errors=True)
                self.work.mkdir()
                self.fixture.write_text(json.dumps(initial_state()))
                self.prepare_merged_resume(lambda state: state.update(failure))
                with self.assertRaisesRegex(RuntimeError, message):
                    journey.run(self.args(resume=True))

    def test_real_gh_json_matches_event_tag_sha_and_post_baseline_time(self):
        rows = json.loads((ROOT / "tests/fixtures/gh-release-runs.json").read_text())
        baseline = {
            "run_ids": {4101},
            "captured_at": "2026-08-24T01:10:00Z",
            "tag": "v1.13.0",
            "source_commit": "a" * 40,
        }
        matches = journey.matching_release_runs(rows, baseline, fresh_only=True)
        self.assertEqual([row["databaseId"] for row in matches], [4104])

    def test_pre_fix_post_dispatch_baseline_misses_fast_run(self):
        state = initial_state()
        state["heads"]["stable"]["sequence"] = 2
        state["candidate_identity"] = {
            "intended_release_tag": "v1.13.0",
            "source_commit": "a" * 40,
        }
        self.fixture.write_text(json.dumps(state))
        gh = journey.FakeGitHub(self.fixture, allow_existing=True)
        gh.workflow("kody-w/openrappter", "create-release-tag.yml", {})
        late_baseline = gh.release_baseline("v1.13.0", "a" * 40)
        self.assertEqual(
            journey.matching_release_runs(gh.state["release_runs"], late_baseline, fresh_only=True),
            [],
        )

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
