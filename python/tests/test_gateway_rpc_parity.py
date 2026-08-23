"""The Python gateway registers exactly the shared RPC surface it promises.

The two gateways drifted and nothing noticed: Python registers `agents.execute`
and TypeScript does not, while the macOS Bar carries a wrapper for that name.
Different scopes are fine — TypeScript is the full daemon — but the overlap has
to agree, and a method must not quietly appear in one runtime only.

`contracts/gateway-rpc-parity.json` is the pin. TypeScript has the matching test.
"""

from __future__ import annotations

import json
from pathlib import Path

from openrappter.gateway.server import GatewayServer

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "gateway-rpc-parity.json").read_text(
        encoding="utf-8"
    )
)


def registered() -> set[str]:
    return set(getattr(GatewayServer(), "_methods", {}))


class TestContractHonesty:
    def test_it_says_what_it_does_not_pin(self):
        """The contract pins names, not response shapes.

        `agents.list` is shared and the two runtimes return payloads with
        almost nothing in common, so a reader must not take "shared" to mean
        a client can consume either. Losing that note would make this file
        quietly overstate what it guarantees.
        """
        assert "what_this_does_not_pin" in CONTRACT
        note = " ".join(CONTRACT["what_this_does_not_pin"])
        assert "agents.list" in note
        assert "Response shapes" in note


class TestSharedSurface:
    def test_the_contract_lists_something(self):
        # Guards the rest: an empty contract would make every assertion vacuous.
        assert len(CONTRACT["shared"]) > 4

    def test_every_shared_method_is_registered(self):
        missing = sorted(set(CONTRACT["shared"]) - registered())
        assert missing == [], f"Python stopped registering shared methods: {missing}"

    def test_python_only_methods_are_still_python_only(self):
        # If one of these is removed here, it is either gone or was promoted to
        # shared; either way the contract must be updated rather than drift.
        absent = sorted(set(CONTRACT["python_only"]) - registered())
        assert absent == [], f"declared python-only but not registered: {absent}"

    def test_nothing_is_registered_that_the_contract_does_not_explain(self):
        # The whole point: a new method cannot appear without being classified.
        explained = set(CONTRACT["shared"]) | set(CONTRACT["python_only"])
        unexplained = sorted(registered() - explained)
        assert unexplained == [], (
            "these Python gateway methods are in neither `shared` nor `python_only`; "
            f"add them to contracts/gateway-rpc-parity.json: {unexplained}"
        )


class TestHealthChecks:
    """`health` is shared, and `checks` is the part a monitor actually reads.

    The contract described `checks` in prose as agreeing between the runtimes.
    It did not: TypeScript reported five checks and Python two. Prose cannot
    fail a build, so the disagreement survived. These tests assert the lists in
    `health_checks`, and TypeScript has the matching test.
    """

    def test_the_contract_declares_the_check_names(self):
        # Guards the rest: an empty list would make every assertion vacuous.
        assert len(CONTRACT["health_checks"]["shared"]) >= 4

    def test_health_reports_exactly_the_shared_checks(self):
        checks = set(GatewayServer().get_health()["checks"])
        expected = set(CONTRACT["health_checks"]["shared"])
        assert checks == expected, (
            f"missing={sorted(expected - checks)} unexpected={sorted(checks - expected)}; "
            "update contracts/gateway-rpc-parity.json#health_checks rather than drifting"
        )

    def test_typescript_only_checks_are_not_reported_here(self):
        # If Python gains one of these it is no longer TypeScript-only and the
        # contract must move it to `shared`.
        checks = set(GatewayServer().get_health()["checks"])
        crossed = sorted(set(CONTRACT["health_checks"]["typescript_only"]) & checks)
        assert crossed == [], f"declared typescript-only but reported by Python: {crossed}"

    def test_the_channels_check_tracks_the_channel_registry(self):
        """The reason this check has to exist.

        All five shared `channels.*` methods guard on `channel_registry is
        None`, and `channels.list` answers `[]` in that case — which a client
        cannot tell apart from "zero channels are configured". TypeScript
        exposes the difference as `checks.channels`; without it, Python offers
        no way to pre-flight the channel surface it advertises as shared.
        """
        assert GatewayServer().get_health()["checks"]["channels"] is False
        assert GatewayServer(channel_registry=object()).get_health()["checks"]["channels"] is True
