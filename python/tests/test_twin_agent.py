#!/usr/bin/env python3
"""
The twin, on the grail brainstem — and its agreement with openrappter.

Two claims:

  1. `twin_agent.py` satisfies the grail agent contract, so the twin is a
     first-class citizen of a brainstem and not an openrappter-only feature.

  2. It renders the SAME vault to the SAME persona as openrappter's TypeScript
     `renderSoul()`. That is what makes the twin portable: the GOD half belongs
     to the operator, so it must survive changing platforms.

Both suites read tests/twin-parity.json. Change the projection in one language
without mirroring it and both builds fail.

Run:  python3 python/tests/test_twin_agent.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = json.loads((ROOT / "tests" / "twin-parity.json").read_text())

sys.path.insert(0, str(ROOT / "python"))


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


def load_module():
    import importlib.util

    agents_pkg = types.ModuleType("agents")
    agents_pkg.__path__ = []
    basic = types.ModuleType("agents.basic_agent")
    basic.BasicAgent = GrailBasicAgent
    sys.modules["agents"] = agents_pkg
    sys.modules["agents.basic_agent"] = basic

    path = ROOT / "python" / "openrappter" / "agents" / "twin_agent.py"
    spec = importlib.util.spec_from_file_location("twin_agent", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


twin_agent = load_module()
PROFILE = FIXTURE["profile"]
SECRETS = FIXTURE["secrets"]


class TestGrailContract(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = twin_agent.TwinAgent()

    def test_extends_basic_agent(self) -> None:
        self.assertIsInstance(self.agent, GrailBasicAgent)

    def test_metadata_becomes_a_tool(self) -> None:
        tool = self.agent.to_tool()
        self.assertEqual(tool["function"]["name"], "Twin")
        self.assertEqual(tool["function"]["parameters"]["required"], ["action"])

    def test_has_a_manifest(self) -> None:
        self.assertEqual(twin_agent.__manifest__["schema"], "rapp-agent/1.0")

    def test_perform_never_raises(self) -> None:
        for kwargs in [{}, {"action": None}, {"action": "nope"}, {"action": "soul"}]:
            self.assertIsInstance(self.agent.perform(**kwargs), str)

    def test_reports_a_missing_twin_usefully(self) -> None:
        with tempfile.TemporaryDirectory() as empty:
            os.environ["RAPP_TWIN_HOME"] = empty
            try:
                result = json.loads(self.agent.perform(action="show"))
            finally:
                os.environ.pop("RAPP_TWIN_HOME", None)
        self.assertEqual(result["status"], "error")
        self.assertIn("twin init", result["fix"])

    def test_warns_when_the_vault_is_inside_a_repo(self) -> None:
        with tempfile.TemporaryDirectory() as base:
            repo = Path(base) / "repo"
            (repo / ".git").mkdir(parents=True)
            vault = repo / "twin"
            vault.mkdir()
            (vault / "profile.json").write_text(json.dumps(PROFILE))

            os.environ["RAPP_TWIN_HOME"] = str(vault)
            try:
                result = json.loads(self.agent.perform(action="where"))
            finally:
                os.environ.pop("RAPP_TWIN_HOME", None)

        self.assertTrue(result["inside_git_repo"])
        self.assertIn("unsafe", result["warning"])


class TestPortability(unittest.TestCase):
    """The same vault must render the same persona on either set of bones."""

    def soul(self, audience: str) -> str:
        return twin_agent.render_soul(PROFILE, audience)

    def test_audience_projections_match_the_fixture(self) -> None:
        for audience, expectations in FIXTURE["expect"].items():
            if audience == "fingerprint":
                continue
            soul = self.soul(audience)
            with self.subTest(audience=audience):
                for needle in expectations["contains"]:
                    self.assertIn(needle, soul, f"{audience} should contain {needle!r}")
                for needle in expectations["absent"]:
                    self.assertNotIn(needle, soul, f"{audience} LEAKED {needle!r}")

    def test_rendered_bytes_match_the_pin(self) -> None:
        """
        The claim is byte-identity across platforms, so pin the bytes.

        contains/absent alone let a paraphrase drift between the two
        implementations undetected — which is exactly what happened once.
        """
        import hashlib

        for audience, expected in FIXTURE["expect"].items():
            if audience == "fingerprint" or "sha256" not in expected:
                continue
            got = hashlib.sha256(self.soul(audience).encode()).hexdigest()
            with self.subTest(audience=audience):
                self.assertEqual(
                    got, expected["sha256"],
                    f"{audience} render drifted from the pin — if this change is intended, "
                    "re-pin BOTH suites together",
                )

    def test_accounts_never_reach_the_prompt(self) -> None:
        # Accounts are loaded so the twin can act, never so it can talk about them.
        for audience in ("owner", "trusted", "public"):
            soul = self.soul(audience)
            self.assertNotIn("private.person@example.com", soul)
            self.assertNotIn("+15551234567", soul)

    def test_public_projection_leaks_nothing(self) -> None:
        soul = self.soul("public")
        for secret in SECRETS:
            self.assertNotIn(secret, soul, f"the public soul leaked {secret!r}")

    def test_never_claims_to_be_human(self) -> None:
        for audience in ("owner", "trusted", "public"):
            self.assertIn("Never claim to be human", self.soul(audience))

    def test_boundaries_survive_an_empty_profile(self) -> None:
        bare = {"identity": {"name": "Nobody"}}
        soul = twin_agent.render_soul(bare, "public")
        self.assertIn("Never claim to be human", soul)
        self.assertIn("Do not disclose ANY personal detail", soul)

    def test_shape_matches_the_fixture(self) -> None:
        shape = twin_agent.to_shape(PROFILE)
        self.assertEqual(shape["present"], FIXTURE["shape"]["present"])

    def test_shape_carries_no_values(self) -> None:
        body = json.dumps(twin_agent.to_shape(PROFILE))
        for secret in SECRETS:
            self.assertNotIn(secret, body)
        self.assertNotIn("Alex Doe", body)

    def test_fingerprint_is_stable_and_empty(self) -> None:
        first = twin_agent.fingerprint(PROFILE)
        self.assertEqual(first, twin_agent.fingerprint(json.loads(json.dumps(PROFILE))))
        self.assertRegex(first, r"^[0-9a-f]{16}$")
        for secret in SECRETS:
            self.assertNotIn(secret[:8].lower(), first)

    def test_system_context_injects_the_twin(self) -> None:
        with tempfile.TemporaryDirectory() as vault:
            Path(vault, "profile.json").write_text(json.dumps(PROFILE))
            os.environ["RAPP_TWIN_HOME"] = vault
            try:
                context = twin_agent.TwinAgent().system_context()
            finally:
                os.environ.pop("RAPP_TWIN_HOME", None)

        self.assertTrue(context.startswith("<twin>"))
        self.assertIn("Alex Doe", context)
        self.assertNotIn("private.person@example.com", context)


class TestOneVault(unittest.TestCase):
    """Both platforms read one file at one path — that is the portability."""

    def test_default_vault_is_outside_any_repo(self) -> None:
        default = twin_agent._vault_dir()
        self.assertIn(".rapp", default)
        # ~/.openrappter is both a checkout and a runtime home; never the vault.
        self.assertNotIn(".openrappter", default)

    def test_honours_the_shared_env_var(self) -> None:
        os.environ["RAPP_TWIN_HOME"] = "/tmp/somewhere-else"
        try:
            self.assertEqual(twin_agent._vault_dir(), "/tmp/somewhere-else")
        finally:
            os.environ.pop("RAPP_TWIN_HOME", None)

    def test_reads_the_same_filename_openrappter_writes(self) -> None:
        self.assertTrue(twin_agent._profile_path().endswith("profile.json"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
