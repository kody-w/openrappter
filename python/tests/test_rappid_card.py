"""Authenticated Debug Card trust, replay, parity, QR, and CLI tests."""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import pytest

from openrappter.rappid_card import (
    RAPPID_CARD_FIXTURE_NAMES,
    BoundedCardStateStore,
    CardProviders,
    RappidCardError,
    SqliteCardStateStore,
    build_rappid_card_fixture,
    build_rappid_card_vector_document,
    make_deep_link,
    manifest_hash,
    parse_deep_link,
    parse_manifest_json,
    reduce_card_state,
    render_rappid_card_qr_png,
    render_rappid_card_qr_svg,
    sign_fixture_authorization,
    sign_fixture_manifest,
    sign_fixture_policy,
    sign_fixture_revocations,
    simulate_rappid_card,
    simulate_rappid_card_fixture,
    simulate_rappid_card_fixture_input,
    unsigned_document,
    validate_manifest,
    write_rappid_card_fixture_deck,
)

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads(
    (ROOT / "tests" / "rappid-card-vectors.json").read_text(encoding="utf-8")
)
PRODUCTION_VECTORS = json.loads(
    (ROOT / "tests" / "rappid-card-production-vectors.json").read_text(
        encoding="utf-8"
    )
)


def _fixture_with_manifest(fixture, manifest):
    digest = manifest_hash(manifest)
    fixture.manifest = manifest
    fixture.manifest_hash = digest
    fixture.deep_link = make_deep_link(manifest, digest)
    fixture.providers.get_manifest = (
        lambda _endpoint, _hash: copy.deepcopy(manifest)
    )
    fixture.state_store = BoundedCardStateStore()
    return fixture


def _production_providers(vector):
    return CardProviders(
        get_manifest=lambda _endpoint, _hash: copy.deepcopy(
            vector["manifest"]
        ),
        get_policy_for_origin=lambda _origin: copy.deepcopy(vector["policy"]),
        get_authorization=lambda _policy_id, _key_id, _subject: copy.deepcopy(
            vector["authorization"]
        ),
        get_revocations=lambda _policy_id: copy.deepcopy(
            vector["revocations"]
        ),
        get_authority_key=lambda key_id, _algorithm: vector[
            "authorityKeys"
        ].get(key_id),
        get_part=lambda content_hash: (
            None
            if content_hash not in vector["contents"]
            else __import__("base64").b64decode(
                vector["contents"][content_hash]
            )
        ),
        challenge_response=lambda _request: vector["challengeResponse"],
    )


def _remove_database(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()


def test_shared_typescript_python_signed_trust_vectors_are_identical():
    assert build_rappid_card_vector_document() == VECTORS
    assert VECTORS["schema"] == "rappid-card-vectors/2"
    assert len(VECTORS["fixtures"]) == 13


@pytest.mark.parametrize("name", RAPPID_CARD_FIXTURE_NAMES)
def test_deterministic_fixture_deck(name):
    fixture = build_rappid_card_fixture(name)
    result = simulate_rappid_card_fixture(name, True)
    assert result["state"] == fixture.expected_state
    assert (
        result["error"]["code"] if result["error"] is not None else None
    ) == fixture.expected_error


def test_production_refuses_fixture_profile_even_with_durable_state():
    fixture = build_rappid_card_fixture("valid")
    path = ROOT / f".rappid-card-test-profile-{os.getpid()}.sqlite"
    _remove_database(path)
    store = SqliteCardStateStore(str(path))
    try:
        result = simulate_rappid_card(
            fixture.deep_link,
            approve=False,
            providers=fixture.providers,
            state_store=store,
        )
        assert result["error"]["code"] == "test_signature_forbidden"
    finally:
        store.close()
        _remove_database(path)


def test_production_requires_concrete_durable_state():
    vector = PRODUCTION_VECTORS["vectors"][0]
    result = simulate_rappid_card(
        vector["deepLink"],
        approve=False,
        providers=_production_providers(vector),
        state_store=BoundedCardStateStore(),  # type: ignore[arg-type]
    )
    assert result["error"]["code"] == "durable_state_required"


def test_closed_schema_rejects_secrets_memory_commands_paths_and_payloads():
    manifest = build_rappid_card_fixture("valid").manifest
    for field in (
        "secret",
        "privateMemory",
        "command",
        "credentials",
        "path",
        "payload",
    ):
        with pytest.raises(RappidCardError, match="card is closed"):
            validate_manifest({**manifest, field: "forbidden"})
    with pytest.raises(RappidCardError, match=r"card\.parts\[0\] is closed"):
        validate_manifest(
            {
                **manifest,
                "parts": [{**manifest["parts"][0], "path": "../../private"}],
            }
        )


def test_canonical_hash_ignores_object_insertion_order():
    manifest = build_rappid_card_fixture("valid").manifest
    reordered = dict(reversed(list(manifest.items())))
    assert manifest_hash(validate_manifest(reordered)) == manifest_hash(manifest)


def test_compact_link_enforces_decoded_secret_free_https_endpoint():
    fixture = build_rappid_card_fixture("valid")
    assert parse_deep_link(fixture.deep_link)["deepLink"] == fixture.deep_link
    with pytest.raises(RappidCardError, match="exactly m, e, and n"):
        parse_deep_link(fixture.deep_link + "&extra=1")
    secret_endpoint = quote(
        "https://user:password@fixture.openrappter.test/rappid-card",
        safe="",
    )
    with pytest.raises(RappidCardError, match="must not contain userinfo"):
        parse_deep_link(
            fixture.deep_link.replace(
                fixture.deep_link.split("&e=", 1)[1].split("&n=", 1)[0],
                secret_endpoint,
            )
        )
    query_endpoint = quote(
        "https://fixture.openrappter.test/rappid-card?token=secret",
        safe="",
    )
    with pytest.raises(RappidCardError, match="must not contain userinfo"):
        parse_deep_link(
            fixture.deep_link.replace(
                fixture.deep_link.split("&e=", 1)[1].split("&n=", 1)[0],
                query_endpoint,
            )
        )


def test_duplicate_json_object_keys_are_rejected():
    raw = json.dumps(
        build_rappid_card_fixture("valid").manifest,
        separators=(",", ":"),
    )
    duplicate = raw.replace(
        '"schema":"rappid-card/1"',
        '"schema":"rappid-card/1","schema":"rappid-card/1"',
    )
    with pytest.raises(RappidCardError, match="duplicate JSON object key: schema"):
        parse_manifest_json(duplicate)


def test_stops_at_authenticated_preview_until_explicit_approval():
    result = simulate_rappid_card_fixture("valid", False)
    assert result["state"] == "preview"
    assert result["hydrated"] == []
    assert result["preview"] | {
        "policyId": "fixture-policy-1",
        "authorizationId": "fixture-authorization-1",
        "origin": "https://fixture.openrappter.test",
        "policySequence": 7,
        "authorizationSequence": 3,
        "revocationSequence": 11,
    } == result["preview"]


def test_signature_mutation_fails_even_when_link_hash_is_updated():
    fixture = build_rappid_card_fixture("valid")
    manifest = copy.deepcopy(fixture.manifest)
    value = manifest["signature"]["value"]
    manifest["signature"]["value"] = ("B" if value[0] == "A" else "A") + value[1:]
    result = simulate_rappid_card_fixture_input(
        _fixture_with_manifest(fixture, manifest), False
    )
    assert result["error"]["code"] == "signature_invalid"


def test_policy_and_revocation_tampering_fail_before_content_use():
    policy_fixture = build_rappid_card_fixture("valid")
    policy = copy.deepcopy(policy_fixture.policy)
    policy["maxClassification"] = "restricted"
    policy_fixture.providers.get_policy_for_origin = lambda _origin: policy
    assert (
        simulate_rappid_card_fixture_input(policy_fixture, False)["error"][
            "code"
        ]
        == "policy_signature_invalid"
    )

    revocation_fixture = build_rappid_card_fixture("valid")
    revocations = copy.deepcopy(revocation_fixture.revocations)
    revocations["revokedManifestHashes"].append(
        revocation_fixture.manifest_hash
    )
    revocation_fixture.providers.get_revocations = (
        lambda _policy_id: revocations
    )
    assert (
        simulate_rappid_card_fixture_input(revocation_fixture, False)["error"][
            "code"
        ]
        == "revocation_signature_invalid"
    )


def test_signer_to_subject_binding_is_enforced_after_authority_signature():
    fixture = build_rappid_card_fixture("valid")
    authorization = sign_fixture_authorization(
        {
            **unsigned_document(fixture.authorization),
            "subjectRappid": (
                "rappid:@openrappter/other-subject:" + "a" * 64
            ),
        }
    )
    fixture.providers.get_authorization = (
        lambda _policy_id, _key_id, _subject: authorization
    )
    result = simulate_rappid_card_fixture_input(fixture, False)
    assert result["error"]["code"] == "signer_subject_unauthorized"


def test_endpoint_origin_requires_signed_policy_and_signer_approval():
    fixture = build_rappid_card_fixture("valid")
    manifest = sign_fixture_manifest(
        {
            **unsigned_document(fixture.manifest),
            "endpoint": "https://unapproved.openrappter.test/rappid-card",
        }
    )
    changed = _fixture_with_manifest(fixture, manifest)
    fetched = False

    def get_manifest(_endpoint, _hash):
        nonlocal fetched
        fetched = True
        return copy.deepcopy(changed.manifest)

    changed.providers.get_manifest = get_manifest
    changed.providers.get_policy_for_origin = (
        lambda _origin: copy.deepcopy(changed.policy)
    )
    result = simulate_rappid_card_fixture_input(
        changed, False
    )
    assert result["error"]["code"] == "origin_not_approved"
    assert fetched is False


def test_hash_classification_scope_and_challenge_controls_fail():
    assert [
        simulate_rappid_card_fixture(name, True)["error"]["code"]
        for name in (
            "wrong-hash",
            "classification-violation",
            "insufficient-scope",
            "challenge-failure",
        )
    ] == [
        "manifest_hash_mismatch",
        "classification_violation",
        "insufficient_scope",
        "challenge_failed",
    ]


def test_same_length_hydrated_content_mutation_fails_hash():
    fixture = build_rappid_card_fixture("valid")
    original_get_part = fixture.providers.get_part
    corrupted = False

    def get_part(hash_value):
        nonlocal corrupted
        value = original_get_part(hash_value)
        if value is None or corrupted:
            return value
        corrupted = True
        result = bytearray(value)
        result[0] ^= 0xFF
        return bytes(result)

    fixture.providers.get_part = get_part
    result = simulate_rappid_card_fixture_input(fixture, True)
    assert result["error"]["code"] == "part_hash_mismatch"


def test_runtime_mismatch_fails_independently_of_protocol():
    fixture = build_rappid_card_fixture("valid")
    manifest = sign_fixture_manifest(
        {
            **unsigned_document(fixture.manifest),
            "runtime": {
                "name": "openrappter",
                "minimum": "2.0.0",
                "maximum": "2.0.0",
            },
        }
    )
    result = simulate_rappid_card_fixture_input(
        _fixture_with_manifest(fixture, manifest), False
    )
    assert result["error"]["code"] == "incompatible_runtime"


def test_signed_revocation_rollback_fails_transactionally():
    store = BoundedCardStateStore()
    current = build_rappid_card_fixture("valid")
    current.state_store = store
    current.revocations = sign_fixture_revocations(
        {
            **unsigned_document(current.revocations),
            "sequence": 12,
        }
    )
    current.providers.get_revocations = (
        lambda _policy_id: copy.deepcopy(current.revocations)
    )
    assert simulate_rappid_card_fixture_input(current, False)["state"] == "preview"

    stale = build_rappid_card_fixture("valid")
    stale.state_store = store
    result = simulate_rappid_card_fixture_input(stale, False)
    assert result["error"]["code"] == "revocation_rollback"


def test_same_sequence_signed_revocation_equivocation_fails():
    store = BoundedCardStateStore()
    first = build_rappid_card_fixture("valid")
    first.state_store = store
    assert simulate_rappid_card_fixture_input(first, False)["state"] == "preview"

    fork = build_rappid_card_fixture("valid")
    fork.state_store = store
    fork.revocations = sign_fixture_revocations(
        {
            **unsigned_document(fork.revocations),
            "revokedManifestHashes": ["e" * 64],
        }
    )
    fork.providers.get_revocations = (
        lambda _policy_id: copy.deepcopy(fork.revocations)
    )
    result = simulate_rappid_card_fixture_input(fork, False)
    assert result["error"]["code"] == "revocation_equivocation"


def test_policy_rollback_fails_before_manifest_provider_call():
    store = BoundedCardStateStore()
    current = build_rappid_card_fixture("valid")
    current.state_store = store
    current.policy = sign_fixture_policy(
        {
            **unsigned_document(current.policy),
            "sequence": 8,
        }
    )
    current.providers.get_policy_for_origin = (
        lambda _origin: copy.deepcopy(current.policy)
    )
    assert simulate_rappid_card_fixture_input(current, False)["state"] == "preview"

    stale = build_rappid_card_fixture("valid")
    stale.state_store = store
    fetched = False

    def get_manifest(_endpoint, _hash):
        nonlocal fetched
        fetched = True
        return copy.deepcopy(stale.manifest)

    stale.providers.get_manifest = get_manifest
    result = simulate_rappid_card_fixture_input(stale, False)
    assert result["error"]["code"] == "policy_rollback"
    assert fetched is False


def test_transactional_replay_rejects_second_acceptance():
    store = BoundedCardStateStore()
    first_fixture = build_rappid_card_fixture("valid")
    first_fixture.state_store = store
    first = simulate_rappid_card_fixture_input(first_fixture, True)
    second_fixture = build_rappid_card_fixture("valid")
    second_fixture.state_store = store
    second = simulate_rappid_card_fixture_input(second_fixture, True)
    assert first["state"] == "awake"
    assert second["error"]["code"] == "duplicate_nonce"


def test_sqlite_replay_survives_close_and_reopen():
    vector = PRODUCTION_VECTORS["vectors"][0]
    path = ROOT / f".rappid-card-durable-replay-{os.getpid()}.sqlite"
    _remove_database(path)
    store = SqliteCardStateStore(str(path))
    first = simulate_rappid_card(
        vector["deepLink"],
        approve=True,
        providers=_production_providers(vector),
        state_store=store,
    )
    store.close()
    store = SqliteCardStateStore(str(path))
    try:
        second = simulate_rappid_card(
            vector["deepLink"],
            approve=True,
            providers=_production_providers(vector),
            state_store=store,
        )
        assert first["state"] == "awake"
        assert second["error"]["code"] == "duplicate_nonce"
    finally:
        store.close()
        _remove_database(path)


def test_replay_and_audit_are_bounded():
    store = BoundedCardStateStore(limit=3)
    for index, nonce in enumerate(("a", "b", "c", "d")):
        store.record(
            {
                "policyId": "p",
                "policySequence": index,
                "policyHash": str(index).zfill(64),
                "authorizationId": "a",
                "authorizationSequence": index,
                "authorizationHash": str(index + 10).zfill(64),
                "revocationSequence": index,
                "revocationHash": str(index + 20).zfill(64),
                "nonce": nonce,
                "manifestHash": "f" * 64,
            },
            True,
        )
    assert store.values() == ["b", "c", "d"]

    snapshot = {
        "state": "idle",
        "outcome": "pending",
        "error": None,
        "manifestHash": None,
        "deepLink": None,
        "preview": None,
        "hydrated": [],
        "audit": [],
    }
    for index in range(100):
        snapshot = reduce_card_state(
            snapshot,
            {
                "state": "parsed",
                "event": "bounded",
                "detail": str(index),
            },
        )
    assert len(snapshot["audit"]) == 64
    assert snapshot["audit"][0]["seq"] == 37
    assert snapshot["audit"][-1]["seq"] == 100


def test_positive_production_vectors_rotate_then_reject_rollback():
    path = ROOT / f".rappid-card-production-vectors-{os.getpid()}.sqlite"
    _remove_database(path)
    store = SqliteCardStateStore(str(path))
    try:
        for vector in PRODUCTION_VECTORS["vectors"]:
            preview = simulate_rappid_card(
                vector["deepLink"],
                approve=False,
                providers=_production_providers(vector),
                state_store=store,
            )
            assert preview == vector["preview"]
            if vector["approved"]["state"] == "awake":
                approved = simulate_rappid_card(
                    vector["deepLink"],
                    approve=True,
                    providers=_production_providers(vector),
                    state_store=store,
                )
                assert approved == vector["approved"]
            else:
                assert preview == vector["approved"]
    finally:
        store.close()
        _remove_database(path)


def test_qr_library_emits_real_svg_and_png_artifacts():
    link = build_rappid_card_fixture(
        "physical-payload-reproduction"
    ).deep_link
    svg = render_rappid_card_qr_svg(link)
    png = render_rappid_card_qr_png(link)
    assert "<svg" in svg
    assert "<path" in svg
    assert png[:8].hex() == "89504e470d0a1a0a"


def test_fixture_deck_and_cli_commands():
    directory = ROOT / f".rappid-card-python-test-output-{os.getpid()}"
    if directory.exists():
        shutil.rmtree(directory)
    try:
        result = write_rappid_card_fixture_deck(str(directory), "svg")
        assert result["fixtures"] == 13
        assert len(list(directory.glob("*/.rappid-card.json"))) == 13
        assert len(list(directory.glob("*/rappid-card.policy.json"))) == 13

        simulate = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "simulate",
                "valid",
                "--approve",
            ],
            cwd=ROOT / "python",
            check=False,
            text=True,
            capture_output=True,
        )
        assert simulate.returncode == 0, simulate.stderr
        assert json.loads(simulate.stdout)["simulation"]["state"] == "awake"

        valid_directory = directory / "valid"
        verify = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "verify",
                str(valid_directory / ".rappid-card.json"),
                "--link",
                str(valid_directory / "rappid-card.link.txt"),
                "--fixture",
            ],
            cwd=ROOT / "python",
            check=False,
            text=True,
            capture_output=True,
        )
        assert verify.returncode == 0, verify.stderr
        assert json.loads(verify.stdout)["simulation"]["state"] == "preview"
    finally:
        if directory.exists():
            shutil.rmtree(directory)
