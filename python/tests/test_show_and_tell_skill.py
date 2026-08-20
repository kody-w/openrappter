"""Deterministic evaluation of the recorder pipeline.

The scenarios live in ``contracts/show-and-tell-scenarios-v1.json`` because
TypeScript replays exactly the same ones in
``typescript/src/show-and-tell/skill-recorder.test.ts``. A number that only one
runtime produces is drift, and the shared file is what makes that visible
instead of leaving each suite to agree with itself.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from pathlib import Path

import pytest

from openrappter.agents.show_and_tell_agent import ShowAndTellAgent
from openrappter.show_and_tell import (
    SHOW_AND_TELL_PLAN_SCHEMA,
    SHOW_AND_TELL_SCHEMA,
    SENSITIVE_MASK,
    ShowAndTellStore,
    build_deterministic_analysis,
    privacy_reduced_path,
)
from openrappter.show_and_tell_marketplace import (
    MARKETPLACE_ATTRIBUTION,
    render_marketplace_export,
    validate_marketplace_export,
    write_marketplace_export,
)
from openrappter.show_and_tell_skill import (
    build_session_bundle,
    build_skill_plan,
    revise_plan,
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads(
    (ROOT / "contracts" / "show-and-tell-scenarios-v1.json").read_text(encoding="utf-8")
)
SCENARIOS = {scenario["id"]: scenario for scenario in CONTRACT["scenarios"]}


def scenario_session(scenario):
    base = CONTRACT["session"]
    return {
        "schema": SHOW_AND_TELL_SCHEMA,
        "id": base["id"],
        "state": "stopped",
        "title": "",
        "intentHint": scenario["intentHint"],
        "captureMode": "context",
        "createdAt": base["startedAt"],
        "startedAt": base["startedAt"],
        "stoppedAt": base["startedAt"] + 60_000,
        "updatedAt": base["startedAt"] + 60_000,
        "collectorRuntime": None,
        "collectorPid": None,
        "collectorNonce": None,
        "collectorStartedAt": None,
        "collectorHeartbeatAt": None,
        "stopRequestedAt": None,
        "maxDurationMs": base["maxDurationMs"],
        "pollIntervalMs": base["pollIntervalMs"],
        "lastError": None,
    }


def scenario_events(scenario):
    base = CONTRACT["session"]
    return [
        {
            "id": f"e{index}",
            "sessionId": base["id"],
            "sequence": index,
            "timestamp": base["startedAt"] + event["elapsedMs"],
            "elapsedMs": event["elapsedMs"],
            "type": event["type"],
            "source": event["source"],
            "data": event["data"],
        }
        for index, event in enumerate(scenario["events"])
    ]


def replay(scenario):
    session = scenario_session(scenario)
    events = scenario_events(scenario)
    analysis = build_deterministic_analysis(session, events)
    bundle = build_session_bundle(session, events)
    plan = build_skill_plan(analysis, bundle, now=1_700_000_100_000)
    return analysis, bundle, plan


def approved_plan(scenario):
    _analysis, _bundle, plan = replay(scenario)
    return revise_plan(plan, approve=True, now=1_700_000_200_000)


@pytest.mark.parametrize("scenario_id", sorted(SCENARIOS))
def test_segments_the_recording_and_counts_what_it_could_not_explain(scenario_id):
    scenario = SCENARIOS[scenario_id]
    analysis, bundle, _plan = replay(scenario)
    expected = scenario["expect"]["bundle"]

    assert [step["id"] for step in analysis["steps"]] == scenario["expect"][
        "analysisStepIds"
    ]
    for key in (
        "meaningfulEventCount",
        "segmentCount",
        "narratedSegments",
        "silentSegments",
        "detourSegments",
        "silentEvents",
        "unexplainedFrames",
        "longestGapMs",
        "explainedRatioMilli",
    ):
        assert bundle["stats"][key] == expected[key], f"{scenario_id} stats.{key}"
    assert [segment["kind"] for segment in bundle["segments"]] == expected["segmentKinds"]
    for substring in expected.get("warningSubstrings", []):
        assert substring in "\n".join(bundle["warnings"])


@pytest.mark.parametrize("scenario_id", sorted(SCENARIOS))
def test_proposes_a_plan_whose_values_risks_and_privacy_match_the_contract(scenario_id):
    scenario = SCENARIOS[scenario_id]
    _analysis, _bundle, plan = replay(scenario)
    expected = scenario["expect"]["plan"]

    assert plan["schema"] == SHOW_AND_TELL_PLAN_SCHEMA
    assert plan["approved"] is False
    assert [step["id"] for step in plan["steps"]] == expected["stepIds"]
    assert [value["id"] for value in plan["values"]] == expected["valueIds"]
    assert [
        step["id"] for step in plan["steps"] if step["requiresConfirmation"]
    ] == expected["confirmationStepIds"]
    assert sorted({finding["kind"] for finding in plan["privacy"]["findings"]}) == (
        expected["privacyKinds"]
    )

    steps = {step["id"]: step for step in plan["steps"]}
    values = {value["id"]: value for value in plan["values"]}
    for step_id, detail in expected.get("stepDetails", {}).items():
        assert steps[step_id]["detail"] == detail
    for step_id, url in expected.get("stepUrls", {}).items():
        assert steps[step_id]["url"] == url
    for value_id, example in expected.get("valueExamples", {}).items():
        assert values[value_id]["example"] == example
    for step_id, categories in expected.get("stepRiskCategories", {}).items():
        assert steps[step_id]["riskCategories"] == categories

    serialized = json.dumps(plan)
    for forbidden in expected.get("forbiddenSubstrings", []):
        assert forbidden not in serialized
    for substring in expected.get("openQuestionSubstrings", []):
        assert substring in "\n".join(plan["openQuestions"])
    for substring in expected.get("doNotUseWhenSubstrings", []):
        assert substring in "\n".join(plan["doNotUseWhen"])
    if expected.get("privacyMasked") is True:
        assert plan["privacy"]["masked"] is True
    assert plan["privacy"]["rawFramesShared"] is False


@pytest.mark.parametrize("scenario_id", sorted(SCENARIOS))
def test_produces_the_same_plan_twice_from_the_same_events(scenario_id):
    scenario = SCENARIOS[scenario_id]
    assert json.dumps(replay(scenario)[2]) == json.dumps(replay(scenario)[2])


def test_refuses_to_edit_and_approve_in_the_same_turn():
    _analysis, _bundle, plan = replay(SCENARIOS["hardcoded-values"])

    with pytest.raises(ValueError, match="separate turns"):
        revise_plan(
            plan,
            approve=True,
            steps_json=json.dumps(
                [{"id": "s1", "title": "Open the invoice", "detail": "Edited detail."}]
            ),
        )
    with pytest.raises(ValueError, match="separate turns"):
        revise_plan(plan, approve=True, title="A title the reviewer did not read")
    with pytest.raises(ValueError, match="separate turns"):
        revise_plan(plan, approve=True, intent="Run for a different class of request")


def test_keeps_an_edited_plan_unapproved_until_it_is_approved_on_its_own():
    _analysis, _bundle, plan = replay(SCENARIOS["hardcoded-values"])

    edited = revise_plan(
        plan,
        steps_json=json.dumps(
            [
                {
                    "id": "s1",
                    "title": "Open the invoice",
                    "detail": "Open invoice {{identifier_1}} and delete the draft.",
                }
            ]
        ),
        feedback="Only one step is needed.",
        now=1_700_000_250_000,
    )

    assert edited["approved"] is False
    assert len(edited["steps"]) == 1
    assert edited["steps"][0]["values"] == ["identifier_1"]
    assert edited["steps"][0]["requiresConfirmation"] is True
    assert "destructive" in edited["steps"][0]["riskCategories"]
    assert edited["feedbackLog"][-1]["feedback"] == "Only one step is needed."

    approved = revise_plan(edited, approve=True, now=1_700_000_300_000)
    assert approved["approved"] is True
    assert approved["approvedAt"] == 1_700_000_300_000
    assert approved["revision"] == edited["revision"] + 1


def test_masks_personal_data_a_reviewer_types_into_an_edit():
    _analysis, _bundle, plan = replay(SCENARIOS["hardcoded-values"])

    edited = revise_plan(
        plan,
        steps_json=json.dumps(
            [
                {
                    "id": "s1",
                    "title": "Open the invoice",
                    "detail": "Mail the invoice to dana.reed@example.com every month.",
                }
            ]
        ),
    )

    assert edited["steps"][0]["detail"] == (
        f"Mail the invoice to {SENSITIVE_MASK} every month."
    )
    assert any(
        finding["kind"] == "email" for finding in edited["privacy"]["findings"]
    )


def test_rejects_an_edited_value_that_names_an_id_the_plan_never_had():
    _analysis, _bundle, plan = replay(SCENARIOS["hardcoded-values"])

    with pytest.raises(ValueError, match="Unknown Show-and-Tell value id"):
        revise_plan(plan, values_json=json.dumps([{"id": "not_a_value", "example": "x"}]))


def test_reduces_local_path_examples_before_a_generated_skill_publishes_them():
    assert privacy_reduced_path(str(Path.home() / "Private" / "invoice.pdf")) == (
        "~/Private/invoice.pdf"
    )
    assert privacy_reduced_path("/Volumes/Secret/customer/invoice.pdf") == (
        "<absolute>/invoice.pdf"
    )


def test_refuses_to_render_an_export_from_a_plan_nobody_approved(tmp_path):
    _analysis, _bundle, plan = replay(SCENARIOS["hardcoded-values"])

    with pytest.raises(ValueError, match="Approve the Show-and-Tell plan"):
        render_marketplace_export(plan, root=str(tmp_path))


def test_writes_the_marketplace_layout_the_contract_describes(tmp_path):
    exported = write_marketplace_export(
        approved_plan(SCENARIOS["hardcoded-values"]),
        lambda file, content: Path(file).write_text(content, encoding="utf-8"),
        root=str(tmp_path),
        plugin_name="file-the-monthly-invoice",
    )

    relative = [str(Path(file).relative_to(exported["root"])) for file in exported["files"]]
    assert relative == [
        entry.replace("{plugin}", exported["pluginName"]).replace(
            "{skill}", exported["skillName"]
        )
        for entry in CONTRACT["marketplace"]["files"]
    ]

    marketplace = json.loads(Path(exported["marketplacePath"]).read_text(encoding="utf-8"))
    assert marketplace["plugins"][0]["source"] == f"./plugins/{exported['pluginName']}"

    skill = Path(exported["skillPath"]).read_text(encoding="utf-8")
    for marker in CONTRACT["marketplace"]["descriptionMarkers"]:
        assert marker in skill
    for claim in CONTRACT["marketplace"]["forbiddenClaims"]:
        assert claim not in skill
    assert MARKETPLACE_ATTRIBUTION in skill
    assert "{{identifier_1}}" in skill

    validation = validate_marketplace_export(exported["root"])
    assert [check for check in validation["checks"] if not check["ok"]] == []
    assert validation["ok"] is True


def test_keeps_a_traversal_shaped_plugin_name_inside_the_export_root(tmp_path):
    rendered = render_marketplace_export(
        approved_plan(SCENARIOS["hardcoded-values"]),
        root=str(tmp_path),
        plugin_name="../../escape",
    )

    assert ".." not in rendered["pluginName"]
    for file in rendered["files"]:
        assert Path(file["path"]).is_relative_to(tmp_path)


def test_fails_validation_when_a_skill_loses_its_trigger_metadata(tmp_path):
    exported = write_marketplace_export(
        approved_plan(SCENARIOS["hardcoded-values"]),
        lambda file, content: Path(file).write_text(content, encoding="utf-8"),
        root=str(tmp_path),
    )
    skill_path = Path(exported["skillPath"])
    skill_path.write_text(
        skill_path.read_text(encoding="utf-8").replace("USE WHEN:", "WHEN:", 1),
        encoding="utf-8",
    )

    validation = validate_marketplace_export(exported["root"])
    assert validation["ok"] is False
    assert any(
        check["name"].startswith("skill-triggers") and not check["ok"]
        for check in validation["checks"]
    )


def test_refuses_to_write_an_export_that_claims_someone_else_endorsed_it(tmp_path):
    plan = approved_plan(SCENARIOS["hardcoded-values"])
    claiming = {
        **plan,
        "intent": "File the monthly invoice, official Microsoft workflow",
    }

    with pytest.raises(RuntimeError, match="third-party ownership or endorsement"):
        write_marketplace_export(
            claiming,
            lambda file, content: Path(file).write_text(content, encoding="utf-8"),
            root=str(tmp_path),
        )


def seed_consent(store, purpose):
    store.initialize()
    token = secrets.token_hex(32)
    now = int(time.time() * 1000)
    store.connection.execute(
        "INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) "
        "VALUES (?, ?, ?, ?)",
        (hashlib.sha256(token.encode()).hexdigest(), purpose, now, now + 60_000),
    )
    return token


@pytest.fixture
def recorded(tmp_path, monkeypatch):
    """A stopped, analyzed, approved session -- the state review leaves behind."""
    monkeypatch.setenv("OPENRAPPTER_MARKETPLACE_DIR", str(tmp_path / "marketplace"))
    monkeypatch.setenv("OPENRAPPTER_SKILLS_DIR", str(tmp_path / "skills"))
    root = tmp_path / "show"
    agent = ShowAndTellAgent(
        root=root,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "collector-nonce",
            "verify": False,
        },
    )
    store = ShowAndTellStore(root)
    started = json.loads(
        agent.perform(
            action="start",
            intent="File the monthly invoice",
            consent_token=seed_consent(store, "start"),
        )
    )
    session_id = started["session"]["id"]
    agent.perform(
        action="observe",
        session_id=session_id,
        title="Open the invoice",
        detail="Opened invoice INV-10428 for 4,820.00 USD and paid it.",
        app="Finance",
    )
    agent.perform(
        action="note",
        session_id=session_id,
        note="The invoice number changes every month.",
    )
    store.finish_session(session_id, "stopped")
    agent.perform(action="analyze", session_id=session_id)
    agent.perform(
        action="review",
        session_id=session_id,
        approve=True,
        consent_token=seed_consent(store, "approve"),
    )
    yield agent, store, session_id
    store.close()


def test_bundle_returns_the_session_with_its_honesty_stats(recorded):
    agent, _store, session_id = recorded

    result = json.loads(agent.perform(action="bundle", session_id=session_id))

    assert result["status"] == "success"
    assert result["bundle"]["stats"]["meaningfulEventCount"] > 0
    assert len(result["bundle"]["segments"]) > 0


def test_propose_proposes_exactly_one_plan_and_builds_nothing(recorded):
    agent, store, session_id = recorded

    proposed = json.loads(agent.perform(action="propose", session_id=session_id))

    assert proposed["status"] == "success"
    assert proposed["proposal_only"] is True
    assert proposed["built"] is False
    assert "artifacts" not in proposed
    assert proposed["plan"]["approved"] is False
    assert "identifier_1" in [value["id"] for value in proposed["plan"]["values"]]
    assert store.artifacts(session_id) == []


def test_build_refuses_while_the_proposed_plan_is_unapproved(recorded):
    agent, store, session_id = recorded
    agent.perform(action="propose", session_id=session_id)

    built = json.loads(
        agent.perform(action="build", session_id=session_id, target="skill")
    )

    assert built["status"] == "error"
    assert built["code"] == "plan_not_approved"
    assert store.artifacts(session_id) == []


def test_approving_the_plan_requires_a_local_consent_token(recorded):
    agent, store, session_id = recorded
    agent.perform(action="propose", session_id=session_id)

    denied = json.loads(
        agent.perform(action="revise_plan", session_id=session_id, approve=True)
    )

    assert denied["status"] == "error"
    assert denied["code"] == "local_approval_required"
    assert store.get_plan(session_id)["approved"] is False


def test_builds_a_templated_skill_and_offers_it_as_a_rappid_dimension(recorded):
    agent, store, session_id = recorded
    agent.perform(action="propose", session_id=session_id)
    approved = json.loads(
        agent.perform(
            action="revise_plan",
            session_id=session_id,
            approve=True,
            consent_token=seed_consent(store, "approve"),
        )
    )
    assert approved["plan"]["approved"] is True

    built = json.loads(
        agent.perform(action="build", session_id=session_id, target="rappid")
    )

    assert built["status"] == "success"
    dimension = built["rappid_dimension"]
    assert dimension["kind"] == "skill"
    assert dimension["sessionId"] == session_id
    # Offered, never attached: the habitat owns the append.
    assert dimension["attached"] is False
    assert dimension["privacyScanned"] is True
    assert len(dimension["contentHash"]) == 64
    assert Path(dimension["artifactPath"]).is_file()

    skill = Path(dimension["artifactPath"]).read_text(encoding="utf-8")
    assert "USE WHEN:" in skill
    assert "{{identifier_1}}" in skill
    assert "INV-10428 for 4,820.00 USD" not in skill
    assert "Ask for confirmation first" in skill

    tested = json.loads(agent.perform(action="test", session_id=session_id))
    assert [check for check in tested["checks"] if not check["ok"]] == []


def test_exports_an_approved_plan_to_a_validated_marketplace_and_publishes_nothing(
    recorded,
):
    agent, store, session_id = recorded
    agent.perform(action="propose", session_id=session_id)

    blocked = json.loads(agent.perform(action="export", session_id=session_id))
    assert blocked["code"] == "plan_not_approved"

    agent.perform(
        action="revise_plan",
        session_id=session_id,
        approve=True,
        consent_token=seed_consent(store, "approve"),
    )
    exported = json.loads(
        agent.perform(
            action="export",
            session_id=session_id,
            plugin_name="invoice-plugin",
            skill_name="invoice-skill",
        )
    )

    assert exported["status"] == "success"
    assert exported["published"] is False
    assert len(exported["marketplace"]["files"]) == 3
    for file in exported["marketplace"]["files"]:
        assert Path(file).is_file()
    # The custom names are what landed on disk, not the plan slug.
    assert exported["marketplace"]["pluginName"] == "invoice-plugin"
    assert exported["marketplace"]["skillName"] == "invoice-skill"
    assert validate_marketplace_export(exported["marketplace"]["root"])["ok"] is True
    assert exported["artifact"]["kind"] == "marketplace"
    assert len(exported["artifact"]["contentHash"]) == 64

    agent.perform(
        action="revise_plan",
        session_id=session_id,
        title="File and archive the monthly invoice",
    )
    tested = json.loads(agent.perform(action="test", session_id=session_id))
    integrity = next(
        check for check in tested["checks"] if check["name"] == "marketplace-integrity"
    )
    # Revising after export makes the plan stale without touching the frozen
    # export: nothing edited those bytes, so nothing may report them as edited.
    assert integrity["ok"] is True
    assert any(
        check["name"] == "plan-approved" and not check["ok"]
        for check in tested["checks"]
    )


def test_will_not_build_against_an_analysis_revised_after_the_plan_was_approved(
    recorded,
):
    agent, store, session_id = recorded
    agent.perform(action="propose", session_id=session_id)
    agent.perform(
        action="revise_plan",
        session_id=session_id,
        approve=True,
        consent_token=seed_consent(store, "approve"),
    )
    agent.perform(
        action="review",
        session_id=session_id,
        approve=True,
        consent_token=seed_consent(store, "approve"),
        intent="File the monthly invoice and archive it",
    )

    built = json.loads(
        agent.perform(action="build", session_id=session_id, target="skill")
    )

    assert built["status"] == "error"
    assert "Propose the plan again" in built["message"]


def test_a_session_without_a_plan_still_builds_from_its_approved_analysis(recorded):
    agent, store, session_id = recorded

    # Backward compatibility: the analysis-only flow predates plans and must
    # keep working for a session that never proposed one.
    built = json.loads(
        agent.perform(action="build", session_id=session_id, target="skill")
    )

    assert built["status"] == "success"
    assert [artifact["kind"] for artifact in built["artifacts"]] == ["skill"]
    assert store.get_plan(session_id) is None
