"""Virtual RAPPID Debug Card contract, security mutations, parity, QR, and CLI."""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from openrappter.rappid_card import (
    RAPPID_CARD_FIXTURE_NAMES,
    BoundedReplayCache,
    CardPolicy,
    CardProviders,
    RappidCardError,
    build_rappid_card_fixture,
    build_rappid_card_vector_document,
    challenge_value,
    make_deep_link,
    manifest_hash,
    parse_deep_link,
    parse_manifest_json,
    reduce_card_state,
    render_rappid_card_qr_png,
    render_rappid_card_qr_svg,
    sign_manifest,
    simulate_rappid_card,
    simulate_rappid_card_fixture,
    unsigned_manifest,
    validate_manifest,
    write_rappid_card_fixture_deck,
)

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads(
    (ROOT / "tests" / "rappid-card-vectors.json").read_text(encoding="utf-8")
)


def test_shared_typescript_python_vectors_are_identical():
    assert build_rappid_card_vector_document() == VECTORS
    assert len(VECTORS["fixtures"]) == 13


@pytest.mark.parametrize("name", RAPPID_CARD_FIXTURE_NAMES)
def test_deterministic_fixture_deck(name):
    fixture = build_rappid_card_fixture(name)
    result = simulate_rappid_card_fixture(name, True)
    assert result["state"] == fixture.expected_state
    assert (
        result["error"]["code"] if result["error"] is not None else None
    ) == fixture.expected_error


def test_stops_at_preview_until_approval_is_explicit():
    result = simulate_rappid_card_fixture("valid", False)
    assert result["state"] == "preview"
    assert result["hydrated"] == []
    assert "approval.explicit" not in [
        event["event"] for event in result["audit"]
    ]


def test_production_refuses_test_profile_and_synthetic_signatures():
    fixture = build_rappid_card_fixture("valid")
    result = simulate_rappid_card(
        fixture.deep_link,
        approve=False,
        policy=CardPolicy(
            **{
                **fixture.policy.__dict__,
                "mode": "production",
            }
        ),
        providers=fixture.providers,
    )
    assert result["error"]["code"] == "test_profile_forbidden"


def test_production_accepts_only_explicitly_injected_production_key():
    fixture = build_rappid_card_fixture("valid")
    key = bytes.fromhex("44" * 32)
    unsigned = copy.deepcopy(unsigned_manifest(fixture.manifest))
    unsigned["profile"] = "rappid-card-production/1"
    unsigned["challenge"] = {
        "algorithm": "hmac-sha256",
        "keyId": "production-card-key",
    }
    manifest = sign_manifest(
        unsigned, "hmac-sha256", "production-card-key", key
    )
    deep_link = make_deep_link(manifest)
    providers = CardProviders(
        get_manifest=lambda _endpoint, _hash: copy.deepcopy(manifest),
        get_key=lambda _key_id, _algorithm: key,
        is_revoked=lambda _hash, _key_id: False,
        get_part=fixture.providers.get_part,
        challenge_response=lambda request: challenge_value(request, key),
    )
    result = simulate_rappid_card(
        deep_link,
        approve=True,
        policy=CardPolicy(
            **{
                **fixture.policy.__dict__,
                "mode": "production",
            }
        ),
        providers=providers,
    )
    assert result["state"] == "awake"


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
    with pytest.raises(RappidCardError, match="mediaType is invalid"):
        validate_manifest(
            {
                **manifest,
                "parts": [
                    {
                        **manifest["parts"][0],
                        "mediaType": "application/x-executable",
                    }
                ],
            }
        )


def test_canonical_hash_ignores_object_insertion_order():
    manifest = build_rappid_card_fixture("valid").manifest
    reordered = dict(reversed(list(manifest.items())))
    assert manifest_hash(validate_manifest(reordered)) == manifest_hash(manifest)


def test_compact_link_requires_exact_m_e_n_query():
    fixture = build_rappid_card_fixture("valid")
    assert parse_deep_link(fixture.deep_link)["deepLink"] == fixture.deep_link
    with pytest.raises(RappidCardError, match="exactly m, e, and n"):
        parse_deep_link(fixture.deep_link + "&extra=1")


def test_duplicate_json_object_keys_are_rejected_before_canonicalization():
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


def test_signature_mutation_fails_even_when_link_hash_is_updated():
    fixture = build_rappid_card_fixture("valid")
    manifest = copy.deepcopy(fixture.manifest)
    value = manifest["signature"]["value"]
    manifest["signature"]["value"] = ("1" if value[0] == "0" else "0") + value[1:]
    providers = CardProviders(
        get_manifest=lambda _endpoint, _hash: copy.deepcopy(manifest),
        get_key=fixture.providers.get_key,
        is_revoked=fixture.providers.is_revoked,
        get_part=fixture.providers.get_part,
        challenge_response=fixture.providers.challenge_response,
    )
    result = simulate_rappid_card(
        make_deep_link(manifest),
        approve=False,
        policy=fixture.policy,
        providers=providers,
    )
    assert result["error"]["code"] == "signature_invalid"


def test_hash_classification_scope_and_challenge_mutation_controls_fail():
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
    corrupted = False

    def get_part(hash_value):
        nonlocal corrupted
        value = fixture.providers.get_part(hash_value)
        if value is None or corrupted:
            return value
        corrupted = True
        result = bytearray(value)
        result[0] ^= 0xFF
        return bytes(result)

    providers = CardProviders(
        get_manifest=fixture.providers.get_manifest,
        get_key=fixture.providers.get_key,
        is_revoked=fixture.providers.is_revoked,
        get_part=get_part,
        challenge_response=fixture.providers.challenge_response,
    )
    result = simulate_rappid_card(
        fixture.deep_link,
        approve=True,
        policy=fixture.policy,
        providers=providers,
    )
    assert result["error"]["code"] == "part_hash_mismatch"


def test_runtime_mismatch_fails_independently_of_protocol():
    fixture = build_rappid_card_fixture("valid")
    policy = CardPolicy(
        **{
            **fixture.policy.__dict__,
            "runtime_version": "2.0.0",
        }
    )
    result = simulate_rappid_card(
        fixture.deep_link,
        approve=False,
        policy=policy,
        providers=fixture.providers,
    )
    assert result["error"]["code"] == "incompatible_runtime"


def test_replay_cache_rejects_second_simulation():
    fixture = build_rappid_card_fixture("valid")
    replay = BoundedReplayCache()
    first = simulate_rappid_card(
        fixture.deep_link,
        approve=True,
        policy=fixture.policy,
        providers=fixture.providers,
        replay_cache=replay,
    )
    second = simulate_rappid_card(
        fixture.deep_link,
        approve=True,
        policy=fixture.policy,
        providers=fixture.providers,
        replay_cache=replay,
    )
    assert first["state"] == "awake"
    assert second["error"]["code"] == "duplicate_nonce"


def test_replay_cache_and_audit_are_bounded():
    replay = BoundedReplayCache(limit=3)
    for nonce in ("a", "b", "c", "d"):
        replay.add(nonce)
    assert replay.values() == ["b", "c", "d"]

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
    # Keep generated files in the isolated worktree instead of the OS temp root.
    directory = ROOT / f".rappid-card-python-test-output-{os.getpid()}"
    if directory.exists():
        shutil.rmtree(directory)
    try:
        result = write_rappid_card_fixture_deck(str(directory), "svg")
        assert result["fixtures"] == 13
        assert len(list(directory.glob("*/.rappid-card.json"))) == 13
        physical = build_rappid_card_fixture(
            "physical-payload-reproduction"
        )
        assert (
            directory
            / "physical-payload-reproduction"
            / "rappid-card.link.txt"
        ).read_text(encoding="utf-8").strip() == physical.deep_link

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
