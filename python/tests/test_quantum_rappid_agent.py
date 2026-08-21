"""The model-facing RAPPID agent reads and proposes, and cannot append.

Mirrors ``typescript/src/agents/QuantumRappidAgent.test.ts``. The claim under
test is a boundary, not a feature: every operation this agent exposes is a read
or a prediction, growth is refused with the reason said out loud, and the
private engram pointer never reaches the model.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from openrappter.agents.quantum_rappid_agent import (  # noqa: E402
    OPERATIONS,
    QuantumRappidAgent,
    __manifest__ as MANIFEST,
)

from tests.quantum_rappid_fixture import (  # noqa: E402
    build_organism,
    make_habitat,
    remove_habitat,
)


@pytest.fixture
def organism(monkeypatch):
    home = make_habitat("agent")
    monkeypatch.setenv("RAPP_RAPPIDS_HOME", home)
    try:
        yield build_organism(home)
    finally:
        remove_habitat(home)


def call(agent, **kwargs):
    return json.loads(agent.perform(**kwargs))


def test_lists_organisms_without_the_private_engram_pointer(organism):
    listed = call(QuantumRappidAgent(), operation="list")

    assert listed["status"] == "success"
    assert [entry["rappid"] for entry in listed["organisms"]] == [organism.rappid]
    # The episode ref names a private local memory key. A model gets the
    # creature, not the pointer into the operator's memory.
    assert "externalEpisode" not in listed["organisms"][0]


def test_inspect_hides_the_habitat_path_and_the_engram_pointer(organism):
    inspected = call(QuantumRappidAgent(), operation="inspect", rappid=organism.rappid)

    assert inspected["status"] == "success"
    assert "directory" not in inspected["result"]
    assert "externalEpisode" not in inspected["result"]["summary"]
    assert inspected["result"]["summary"]["rappid"] == organism.rappid
    assert inspected["data_slush"]["mutation"] is False


def test_every_read_operation_answers_and_declares_no_mutation(organism):
    agent = QuantumRappidAgent()

    verified = call(agent, operation="verify", rappid=organism.rappid)
    assert verified["status"] == "success"
    assert verified["result"]["ok"] is True

    completed = call(agent, operation="complete", rappid=organism.rappid)
    assert completed["status"] == "success"
    # A continuation is a proposal until a verified frame appends it.
    assert completed["result"]["authoritative"] is False

    playback = call(agent, operation="playback-manifest", rappid=organism.rappid)
    assert playback["status"] == "success"
    assert playback["result"]["playbackMode"] == "in-process-bytes"

    for answer in (verified, completed, playback):
        assert answer["data_slush"] == {
            "source_agent": "QuantumRappid",
            "rappid": organism.rappid,
            "mutation": False,
        }


def test_a_proposal_is_neither_authoritative_nor_appendable(organism):
    proposed = call(
        QuantumRappidAgent(),
        operation="propose",
        rappid=organism.rappid,
        dimension="stats",
    )

    assert proposed["status"] == "success"
    assert proposed["result"]["authoritative"] is False
    assert proposed["result"]["appendable"] is False
    assert proposed["data_slush"]["mutation"] is False


def test_growth_is_refused_and_named_as_the_habitat_seam(organism):
    refused = call(QuantumRappidAgent(), operation="grow", rappid=organism.rappid)

    assert refused["status"] == "error"
    assert "authenticated Habitat" in refused["message"]
    # A refusal is not a half-success: nothing is carried back with it.
    assert "result" not in refused
    assert "data_slush" not in refused


def test_an_operation_that_needs_an_identity_says_so(organism):
    answer = call(QuantumRappidAgent(), operation="inspect")

    assert answer["status"] == "error"
    assert answer["message"] == "rappid is required"


def test_an_unknown_rappid_is_reported_rather_than_raised(organism):
    answer = call(
        QuantumRappidAgent(),
        operation="verify",
        rappid="rappid:@openrappter/absent-organism:" + "a" * 64,
    )

    assert answer["status"] == "error"
    assert "carries" in answer["message"]


def test_the_declared_surface_offers_no_mutating_operation():
    agent = QuantumRappidAgent()
    declared = agent.metadata["parameters"]["properties"]["operation"]["enum"]

    assert declared == list(OPERATIONS)
    assert not {"grow", "append", "attach", "delete"} & set(declared)
    assert agent.metadata["parameters"]["required"] == ["operation"]
    assert MANIFEST["name"] == "@openrappter/quantum-rappid"
    assert MANIFEST["schema"] == "rapp-agent/1.0"


def test_the_answer_envelopes_are_exactly_the_shape_the_other_runtime_sends(organism):
    agent = QuantumRappidAgent()

    # A listing answers with the organisms and nothing about mutation, because
    # no identity was named for a slush record to be about.
    listed = call(agent, operation="list")
    assert sorted(listed) == ["operation", "organisms", "status"]

    read = call(agent, operation="verify", rappid=organism.rappid)
    assert sorted(read) == ["data_slush", "operation", "result", "status"]
    assert sorted(read["data_slush"]) == ["mutation", "rappid", "source_agent"]

    # An error is three keys and never carries a partial result.
    failed = call(agent, operation="verify", rappid="not-a-rappid")
    assert sorted(failed) == ["message", "operation", "status"]
    assert failed["operation"] == "verify"
