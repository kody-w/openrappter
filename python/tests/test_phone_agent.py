#!/usr/bin/env python3
"""
The Python phone agent, and its agreement with the TypeScript one.

Two claims are tested here:

  1. `phone_agent.py` satisfies the grail agent contract, so a RAPP brainstem
     can place calls with the same guardrails openrappter has, writing to the
     same hash-chained second-brain log.

  2. Its decision core agrees with the TypeScript implementation on every case
     in tests/decision-parity.json. The logic exists twice because there is no
     runtime both can import from; that fixture is what stops them drifting.

Run:  python3 python/tests/test_phone_agent.py
"""

from __future__ import annotations

import json
import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PARITY = ROOT / "tests" / "decision-parity.json"

sys.path.insert(0, str(ROOT / "python"))


# ---------------------------------------------------------------------------
# The brainstem's module interception, reproduced: a grail agent imports
# `agents.basic_agent` and `utils.azure_file_storage`, and the kernel supplies
# both. We do the same so the agent is loaded the way a brainstem loads it.
# ---------------------------------------------------------------------------


class GrailBasicAgent:
    def __init__(self, name=None, metadata=None):
        if name is not None:
            self.name = name
        if metadata is not None:
            self.metadata = metadata

    def perform(self, **kwargs):
        return "Not implemented."

    def system_context(self):
        return None

    def to_tool(self):
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.metadata.get("description", ""),
                "parameters": self.metadata.get("parameters", {}),
            },
        }


def install_grail_shims(data_dir: Path) -> None:
    class AzureFileStorageManager:
        def __init__(self, share_name=None, **kwargs):
            os.makedirs(data_dir, exist_ok=True)

        def set_memory_context(self, user_guid=None):
            return True

        def read_file(self, file_path):
            full = data_dir / file_path
            return full.read_text() if full.exists() else None

        def write_file(self, file_path, content):
            full = data_dir / file_path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content)
            return True

        def file_exists(self, file_path):
            return (data_dir / file_path).exists()

    agents_pkg = types.ModuleType("agents")
    agents_pkg.__path__ = []
    basic = types.ModuleType("agents.basic_agent")
    basic.BasicAgent = GrailBasicAgent

    utils_pkg = types.ModuleType("utils")
    utils_pkg.__path__ = []
    storage = types.ModuleType("utils.azure_file_storage")
    storage.AzureFileStorageManager = AzureFileStorageManager

    for name, module in [
        ("agents", agents_pkg),
        ("agents.basic_agent", basic),
        ("utils", utils_pkg),
        ("utils.azure_file_storage", storage),
    ]:
        sys.modules[name] = module


def load_agent_module(data_dir: Path):
    install_grail_shims(data_dir)
    for stale in [m for m in sys.modules if m.endswith("phone_agent")]:
        del sys.modules[stale]

    import importlib.util

    path = ROOT / "python" / "openrappter" / "agents" / "phone_agent.py"
    spec = importlib.util.spec_from_file_location("phone_agent", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FIXTURE = json.loads(PARITY.read_text())
_bootstrap = load_agent_module(Path(os.environ.get("TMPDIR", "/tmp")) / "_phone_agent_bootstrap")


# ---------------------------------------------------------------------------
# Parity — the reason this file matters most
# ---------------------------------------------------------------------------


class TestDecisionParity(unittest.TestCase):
    """Every case here is also asserted by the TypeScript suite."""

    mod = _bootstrap

    def test_constraint_parsing(self) -> None:
        for case in FIXTURE["constraints"]:
            with self.subTest(text=case["text"]):
                parsed = self.mod.parse_constraint(case["text"])
                if case["expect"] is None:
                    self.assertIsNone(parsed, f"{case['text']!r} should not parse — dropping it silently is the bug")
                    continue
                self.assertIsNotNone(parsed, f"{case['text']!r} failed to parse")
                for key, value in case["expect"].items():
                    self.assertEqual(parsed[key], value, f"{case['text']!r} -> {key}")

    def test_constraint_lists(self) -> None:
        for case in FIXTURE["constraintLists"]:
            with self.subTest(texts=case["texts"]):
                constraints, unparsed = self.mod.parse_constraints(case["texts"])
                self.assertEqual([c["kind"] for c in constraints], case["expectKinds"])
                self.assertEqual(unparsed, case["expectUnparsed"])

    def test_offer_extraction(self) -> None:
        for case in FIXTURE["extraction"]:
            with self.subTest(utterance=case["utterance"]):
                offer = self.mod.extract_offer(case["utterance"], case["date"], case.get("hint", "none"))
                if case["expect"] is None:
                    self.assertIsNone(offer, f"{case['utterance']!r} contains no offer")
                    continue
                self.assertIsNotNone(offer, f"{case['utterance']!r} should yield an offer")
                for key, value in case["expect"].items():
                    self.assertEqual(offer.get(key), value, f"{case['utterance']!r} -> {key}")

    def test_refusal_detection(self) -> None:
        for case in FIXTURE["refusal"]:
            with self.subTest(utterance=case["utterance"]):
                self.assertEqual(self.mod.sounds_like_refusal(case["utterance"]), case["expect"])

    def test_agreement_detection(self) -> None:
        for case in FIXTURE["agreement"]:
            with self.subTest(utterance=case["utterance"]):
                self.assertEqual(self.mod.sounds_like_agreement(case["utterance"]), case["expect"])

    def test_decisions(self) -> None:
        for case in FIXTURE["decisions"]:
            with self.subTest(why=case.get("$why", "")):
                decision = self.mod.decide(
                    case["objective"], case["offer"], room_to_negotiate=case.get("roomToNegotiate", True)
                )
                self.assertEqual(decision["action"], case["expect"], case.get("$why", ""))

    def test_an_illegal_offer_is_never_escalated(self) -> None:
        """Belt and braces on the rule that matters most."""
        objective = {
            "goal": "Book a table",
            "constraints": [{"kind": "not_after", "time": "20:00"}],
            "ideal": {"start": "2026-08-07T19:00:00"},
        }
        for time in ["21:00", "22:30", "23:59"]:
            decision = self.mod.decide(objective, {"start": f"2026-08-07T{time}:00"})
            self.assertNotIn(decision["action"], ("escalate", "accept"), f"{time} must not reach the owner")


# ---------------------------------------------------------------------------
# Grail contract
# ---------------------------------------------------------------------------


class AgentTestCase(unittest.TestCase):
    def setUp(self) -> None:
        import shutil
        import tempfile

        self.data_dir = Path(tempfile.mkdtemp(prefix="phone-agent-"))
        self.addCleanup(shutil.rmtree, self.data_dir, ignore_errors=True)
        self.mod = load_agent_module(self.data_dir)
        self.agent = self.mod.PhoneAgent()

    def act(self, **kwargs) -> dict:
        raw = self.agent.perform(**kwargs)
        self.assertIsInstance(raw, str, "perform() must return a string — the grail ABI requires it")
        return json.loads(raw)


class TestGrailContract(AgentTestCase):
    def test_extends_basic_agent(self) -> None:
        self.assertIsInstance(self.agent, GrailBasicAgent)

    def test_metadata_becomes_a_tool_definition(self) -> None:
        tool = self.agent.to_tool()
        self.assertEqual(tool["function"]["name"], "Phone")
        self.assertEqual(tool["function"]["parameters"]["required"], ["action"])

    def test_has_a_manifest(self) -> None:
        self.assertEqual(self.mod.__manifest__["schema"], "rapp-agent/1.0")

    def test_every_advertised_action_is_implemented(self) -> None:
        for action in self.agent.metadata["parameters"]["properties"]["action"]["enum"]:
            result = self.act(action=action, id="x", pin="1234", to="+15551234567")
            self.assertNotIn("unknown action", json.dumps(result), f"{action} is advertised but not handled")

    def test_perform_never_raises(self) -> None:
        for kwargs in [{}, {"action": None}, {"action": "call"}, {"action": "approve"}, {"action": "transcript"}]:
            json.loads(self.agent.perform(**kwargs))

    def test_documents_the_constraint_grammar(self) -> None:
        description = self.agent.metadata["parameters"]["properties"]["constraints"]["description"]
        self.assertIn("no later than", description)
        self.assertIn("party size exactly", description)

    def test_writes_through_the_storage_shim(self) -> None:
        self.act(action="call", to="+15551234567", objective="Book a table", rehearse=["Seven works."])
        self.assertTrue((self.data_dir / "second_brain" / "events.jsonl").exists())

    def test_emits_data_slush(self) -> None:
        result = self.act(action="call", to="+15551234567", objective="Book a table", rehearse=["Seven works."])
        self.assertEqual(result["data_slush"]["call_id"], result["call_id"])


class TestAgentBehaviour(AgentTestCase):
    def rehearsal(self, replies, **overrides) -> dict:
        kwargs = {
            "action": "call",
            "to": "+15551234567",
            "objective": "Book a table for 2 on Friday at 7pm",
            "constraints": ["not before 6pm", "no later than 8pm", "party size exactly 2"],
            "wanted_time": "2026-08-07T19:00",
            "rehearse": replies,
        }
        kwargs.update(overrides)
        return self.act(**kwargs)

    def test_books_what_was_asked_for(self) -> None:
        result = self.rehearsal(["Seven o'clock, table for two, that's fine."])
        self.assertEqual(result["outcome"], "agreed")
        self.assertTrue(result["booked"])
        self.assertIsNone(result["approval_id"])

    def test_holds_a_legal_but_different_offer(self) -> None:
        result = self.rehearsal(["Seven is booked. I could do seven forty-five?"])
        self.assertEqual(result["outcome"], "escalated")
        self.assertFalse(result["booked"])
        self.assertTrue(result["needs_your_approval"])
        self.assertIn("19:45", result["question"])

    def test_will_not_book_outside_the_limits(self) -> None:
        result = self.rehearsal(["Only nine thirty.", "Nine thirty.", "Nine thirty.", "Nine thirty."])
        self.assertFalse(result["booked"])
        self.assertFalse(result["needs_your_approval"])

    def test_refuses_to_dial_on_an_unparsed_limit(self) -> None:
        result = self.rehearsal(["ok"], constraints=["no later than 8pm", "vibes must be immaculate"])
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["unparsed"], ["vibes must be immaculate"])

    def test_refuses_a_malformed_wanted_time(self) -> None:
        result = self.rehearsal(["ok"], wanted_time="friday-ish")
        self.assertEqual(result["status"], "error")

    def test_refuses_to_pretend_without_a_provider(self) -> None:
        result = self.act(action="call", to="+15551234567", objective="Book a table")
        self.assertEqual(result["status"], "error")
        self.assertIn("rehearse", result["message"])

    def test_needs_someone_to_call(self) -> None:
        self.assertEqual(self.act(action="call", objective="Book a table")["status"], "error")

    def test_approval_flow_confirms_only_after_a_yes(self) -> None:
        call = self.rehearsal(["Seven is booked. I could do seven forty-five?"])

        pending = self.act(action="approvals")
        self.assertEqual(pending["count"], 1)

        before = self.act(action="brief")
        self.assertEqual(len(before["confirmed_appointments"]), 0)

        approved = self.act(action="approve", id=call["approval_id"], note="go ahead")
        self.assertEqual(approved["confirmed_appointment"], call["appointment_id"])

        after = self.act(action="brief")
        self.assertEqual(len(after["confirmed_appointments"]), 1)
        self.assertEqual(self.act(action="approvals")["count"], 0)

    def test_denying_cancels_the_hold(self) -> None:
        call = self.rehearsal(["I could do seven forty-five."])
        self.act(action="deny", id=call["approval_id"])
        self.assertEqual(len(self.act(action="brief")["confirmed_appointments"]), 0)

    def test_cannot_decide_twice(self) -> None:
        call = self.rehearsal(["I could do seven forty-five."])
        self.act(action="approve", id=call["approval_id"])
        self.assertEqual(self.act(action="deny", id=call["approval_id"])["status"], "error")

    def test_transcript_is_recoverable(self) -> None:
        call = self.rehearsal(["Seven is booked. I could do seven forty-five?"])
        transcript = self.act(action="transcript", id=call["call_id"])
        self.assertEqual(transcript["status"], "ok")
        self.assertIn("forty-five", json.dumps(transcript["call"]))

    def test_hotline_requires_a_valid_pin(self) -> None:
        self.assertEqual(self.act(action="hotline_check")["status"], "error")
        self.assertEqual(self.act(action="hotline_check", pin="12")["status"], "error")
        self.assertEqual(self.act(action="hotline_check", pin="4821", **{"from": "+1555"})["outcome"], "challenge")


class TestOneLog(AgentTestCase):
    """The phone agent must write the same log `rsb` and the sphere read."""

    def test_chain_is_intact_and_matches_the_spec(self) -> None:
        self.rehearsal_result = self.act(
            action="call",
            to="+15551234567",
            objective="Book a table for 2 at 7pm",
            wanted_time="2026-08-07T19:00",
            rehearse=["Seven is booked. I could do seven forty-five?"],
        )

        raw = (self.data_dir / "second_brain" / "events.jsonl").read_text()
        events = [json.loads(line) for line in raw.splitlines() if line.strip()]
        self.assertGreater(len(events), 4)

        prev = self.mod.GENESIS
        for index, event in enumerate(events, start=1):
            self.assertEqual(event["seq"], index)
            self.assertEqual(event["prev"], prev)
            body = {k: v for k, v in event.items() if k != "hash"}
            self.assertEqual(self.mod._sha(self.mod._canon(body)), event["hash"])
            prev = event["hash"]

        kinds = [e["type"] for e in events]
        self.assertIn("call.start", kinds)
        self.assertIn("call.turn", kinds)
        self.assertIn("call.end", kinds)
        self.assertIn("appointment.propose", kinds)
        self.assertIn("approval.request", kinds)
        # An escalated call must NOT have confirmed anything.
        self.assertNotIn("appointment.confirm", kinds)


if __name__ == "__main__":
    unittest.main(verbosity=2)
