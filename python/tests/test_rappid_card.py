"""Exact RAPP/1 §7.10 deck, drift, physical, scanner, state, and CLI tests."""

from __future__ import annotations

import base64
import json
import multiprocessing
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from openrappter.rappid_card import (
    CARD_AUTHORITY_SCHEMA,
    CARD_AUTHORITY_VIEW_KEYS,
    CARD_CALLING,
    CARD_CLASSIFICATIONS,
    CARD_DEBUG,
    CARD_PAYLOAD_KEYS,
    CARD_PROFILE,
    CARD_REVOCATION_SCHEMA,
    CARD_REVOCATION_VIEW_KEYS,
    CARD_RUNTIME_POLICY_KEYS,
    CARD_RUNTIME_POLICY_SCHEMA,
    CARD_TEST_PROFILE,
    CARD_VERIFY_STEPS,
    CARD_VIRTUAL_SUFFIX,
    FRAME_KEYS,
    H,
    Hb,
    RAPPID_CARD_FIXTURE_NAMES,
    CardTrustStore,
    SQLiteCardState,
    build_rappid_card_fixture,
    canonical,
    load_rappid_card_deck,
    load_rappid_card_trust_config,
    inspect_card_offline,
    parse_card_link,
    physical_vector_bytes,
    read_card_resource,
    render_rappid_card_qr_png,
    render_rappid_card_qr_svg,
    simulate_rappid_card_fixture,
    write_rappid_card_fixture_deck,
)
from openrappter.rappid_card import protocol_reference as R

ROOT = Path(__file__).resolve().parents[2]
VECTOR_ROOT = ROOT / "tests" / "vectors" / "rapp-1-08893fd" / "rappid-card"

MANDATORY = (
    "valid-test", "valid-production", "expired", "manifest-revoked", "key-revoked",
    "subject-revoked", "wrong-manifest-hash", "deep-payload",
    "oversized-payload", "newline-rappid", "newline-manifest-hash",
    "newline-lclabel", "newline-profile-token", "newline-connection-id",
    "unknown-signing-key",
    "attacker-key-impersonation", "delegation-expired", "delegation-revoked",
    "forged-revocation-view", "stale-revocation-view", "unavailable-revocation-view",
    "rollback-revocation-view", "protocol-incompatible", "runtime-incompatible",
    "unsupported-feature", "feature-superset", "classification-violation",
    "insufficient-scope", "missing-engram-part", "continuity-challenge-failure",
    "reconnect-during-hydration", "duplicate-replayed-nonce",
    "physical-payload-reproduction", "test-profile-production",
    "synthetic-key-production", "auto-execute", "endpoint-userinfo",
    "endpoint-empty-query", "endpoint-empty-fragment", "endpoint-space",
    "endpoint-backslash", "endpoint-bad-percent", "endpoint-double-encoding",
    "endpoint-numeric-127-1", "endpoint-numeric-octal",
    "endpoint-numeric-hex", "endpoint-numeric-short-private",
    "endpoint-loopback-literal", "endpoint-private-literal",
    "endpoint-link-local-literal", "endpoint-reserved-literal",
    "endpoint-unapproved-origin", "endpoint-redirect-origin",
    "endpoint-private-dns", "fetch-numeric-alias",
    "secret-endpoint-password", "secret-password", "secret-api-key", "secret-cookie",
    "secret-bearer", "secret-private-memory",
    "secret-unicode-latin-adjacency", "secret-unicode-cjk-adjacency",
)


def _remove_database(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()


def _process_claim(path, nonce, connection_id, start, results):
    state = SQLiteCardState(path)
    start.wait()
    results.put((connection_id, state.claim_nonce(nonce, connection_id, "2026-08-21T12:30:00.000Z")))


def test_protocol_tokens_and_key_sets_do_not_drift():
    deck = load_rappid_card_deck()
    vector = deck["vectors"][0]
    assert CARD_PROFILE == "rappid-card/1"
    assert CARD_TEST_PROFILE == "rappid-card-test/1"
    assert CARD_VIRTUAL_SUFFIX == ".rappid-card.json"
    assert (CARD_CALLING, CARD_DEBUG) == ("body.calling-card", "body.debug-card")
    assert (
        CARD_RUNTIME_POLICY_SCHEMA,
        CARD_AUTHORITY_SCHEMA,
        CARD_REVOCATION_SCHEMA,
    ) == (
        "rappid-card-runtime-policy/1",
        "rappid-card-authority/1",
        "rappid-card-revocations/1",
    )
    assert CARD_CLASSIFICATIONS == (
        "public", "internal", "confidential", "restricted"
    )
    assert CARD_VERIFY_STEPS == (
        "parse", "content-address", "schema", "signature", "expiry",
        "revocation", "compatibility", "classification-scope", "replay-nonce",
        "hydration", "continuity",
    )
    assert set(vector["frame"]) == FRAME_KEYS
    assert set(vector["frame"]["payload"]) == CARD_PAYLOAD_KEYS
    assert set(vector["runtime_policy"]) == CARD_RUNTIME_POLICY_KEYS
    assert set(vector["authority_view"]) == CARD_AUTHORITY_VIEW_KEYS
    assert set(vector["revocation_view"]) == CARD_REVOCATION_VIEW_KEYS
    card_schema = json.loads(
        (ROOT / "contracts" / "rappid-card.schema.json").read_text()
    )
    trust_schema = json.loads(
        (ROOT / "contracts" / "rappid-card-trust.schema.json").read_text()
    )
    assert set(card_schema["required"]) == FRAME_KEYS
    assert set(card_schema["$defs"]["payload"]["required"]) == CARD_PAYLOAD_KEYS
    assert (
        set(trust_schema["$defs"]["runtime_policy"]["required"])
        == CARD_RUNTIME_POLICY_KEYS
    )
    assert (
        set(trust_schema["$defs"]["authority_view"]["required"])
        == CARD_AUTHORITY_VIEW_KEYS
    )
    assert (
        set(trust_schema["$defs"]["revocation_view"]["required"])
        == CARD_REVOCATION_VIEW_KEYS
    )


def test_mandatory_scenario_names_and_order_do_not_drift():
    deck = load_rappid_card_deck()
    provenance = json.loads((VECTOR_ROOT / "PROVENANCE.json").read_text())
    assert deck["schema"] == "rappid-card-vectors/3"
    assert provenance["deck_schema"] == "rappid-card-vectors/3"
    assert tuple(deck["mandatory_scenarios"]) == MANDATORY
    assert tuple(vector["name"] for vector in deck["vectors"]) == MANDATORY
    assert RAPPID_CARD_FIXTURE_NAMES == MANDATORY


@pytest.mark.parametrize("name", MANDATORY)
def test_every_protocol_scenario_reaches_its_declared_step(name):
    path = ROOT / f".protocol-python-{name}-{os.getpid()}.sqlite"
    _remove_database(path)
    try:
        vector = build_rappid_card_fixture(name)
        verdict = simulate_rappid_card_fixture(name, str(path))
        expected = vector.expected
        assert verdict.ok is expected["ok"]
        assert verdict.step == expected["step"]
        if expected["reason_contains"] is not None:
            assert expected["reason_contains"] in verdict.reason
    finally:
        _remove_database(path)


def test_physical_frame_and_link_are_byte_reproduced_as_check_50():
    frame_octets, link_octets = physical_vector_bytes()
    frame = read_card_resource(frame_octets)
    link = link_octets.decode("utf-8").rstrip("\n")
    vector = build_rappid_card_fixture("physical-payload-reproduction")
    parsed = parse_card_link(link)
    assert frame_octets == canonical(frame).encode("utf-8")
    assert frame == vector.frame
    assert link == vector.deep_link
    assert parsed["manifest_hash"] == frame["payload_hash"]
    assert frame["payload_hash"] == H("rapp/1:particle", frame["payload"])
    assert set(frame) == FRAME_KEYS


def test_vendored_vector_checksums_match_provenance():
    import hashlib

    provenance = json.loads((VECTOR_ROOT / "PROVENANCE.json").read_text())
    assert provenance["source_commit"] == "08893fdf8d495f9da8c202cd004fc1587082816c"
    for name, expected in provenance["sha256"].items():
        assert hashlib.sha256((VECTOR_ROOT / name).read_bytes()).hexdigest() == expected
    package_root = (
        ROOT / "python" / "openrappter" / "rappid_card" / "test_vectors"
    )
    for name in (
        "deck.json",
        "physical.rappid-card.json",
        "physical-payload.txt",
        "PROVENANCE.json",
    ):
        assert (VECTOR_ROOT / name).read_bytes() == (package_root / name).read_bytes()


def test_rfc8032_and_signature_mutation_controls():
    seed = bytes.fromhex(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    )
    public = bytes.fromhex(
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    )
    signature = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    )
    assert R.ed25519_public_key(seed) == public
    assert R.ed25519_sign(seed, b"") == signature
    assert R.ed25519_verify(public, b"", signature)
    mutated = bytes([signature[0] ^ 1]) + signature[1:]
    assert not R.ed25519_verify(public, b"", mutated)


def test_authoritative_depth_size_host_token_and_ascii_scanner_fixes():
    nested = None
    for _ in range(65):
        nested = [nested]
    with pytest.raises(ValueError, match="depth"):
        R.canonical(nested)
    with pytest.raises(ValueError, match="1048576"):
        R.canonical("x" * (1024 * 1024 + 1))
    with pytest.raises(ValueError, match="numeric-looking"):
        R._card_url_info("https://127.1/x.rappid-card.json")
    assert not R._lclabel("memory-read\n")
    assert not R.rappid_valid(
        "rappid:@synthetic/x:" + "a" * 64 + "\n"
    )
    assert R._forbidden_card_material("épasswordé")


def test_protocol_container_only_depth_at_63_64_and_65_arrays_and_objects():
    def nested_array(count):
        value = None
        for _ in range(count):
            value = [value]
        return value

    def nested_object(count):
        value = None
        for _ in range(count):
            value = {"k": value}
        return value

    for count in (63, 64):
        assert R.canonical(nested_array(count))
        assert R.canonical(nested_object(count))
    for value in (nested_array(65), nested_object(65)):
        with pytest.raises(ValueError, match="depth"):
            R.canonical(value)


def test_trust_spki_binding_and_core_egg_roots():
    deck = load_rappid_card_deck()
    keys = {
        entry["kid"]: base64.b64decode(entry["spki_der_b64"])
        for entry in deck["trust"]
    }
    CardTrustStore(keys, deck["vectors"][0]["runtime_policy_authority"])
    kid = next(iter(keys))
    mutated = bytearray(keys[kid])
    mutated[-1] ^= 1
    with pytest.raises(ValueError, match="does not bind"):
        CardTrustStore(
            {**keys, kid: bytes(mutated)},
            deck["vectors"][0]["runtime_policy_authority"],
        )
    frame = build_rappid_card_fixture("valid-test").frame
    parts = {
        name: base64.b64decode(value)
        for name, value in deck["parts_b64"].items()
    }
    assert [entry["part"] for entry in frame["payload"]["inventory"]] == [
        "engram", "reflex-capability", "soul"
    ]
    for entry in frame["payload"]["inventory"]:
        assert entry["space"] == "rapp/1:egg"
        assert entry["hash"] == Hb("rapp/1:egg", parts[entry["part"]])


def test_local_trust_config_requires_mode_0600():
    deck = load_rappid_card_deck()
    path = ROOT / f".protocol-trust-config-{os.getpid()}.json"
    path.write_text(
        json.dumps(
            {
                "schema": "openrappter-rappid-card-trust/1",
                "runtime_policy_authority": deck["vectors"][0][
                    "runtime_policy_authority"
                ],
                "keys": deck["trust"],
            }
        ),
        encoding="utf-8",
    )
    try:
        path.chmod(0o600)
        assert load_rappid_card_trust_config(str(path))["trust"]
        path.chmod(0o644)
        with pytest.raises(ValueError, match="0600"):
            load_rappid_card_trust_config(str(path))
    finally:
        path.unlink(missing_ok=True)


def test_offline_inspection_never_mutates_supplied_sqlite_state():
    path = ROOT / f".protocol-offline-immutable-{os.getpid()}.sqlite"
    _remove_database(path)
    state = SQLiteCardState(str(path))
    state.seed_nonce(
        "offline-sentinel-nonce",
        "sentinel-connection",
        "awake",
        "2026-08-21T12:30:00.000Z",
    )
    before = path.read_bytes()
    deck = load_rappid_card_deck()
    parts = {
        name: base64.b64decode(value)
        for name, value in deck["parts_b64"].items()
    }
    keys = {
        entry["kid"]: base64.b64decode(entry["spki_der_b64"])
        for entry in deck["trust"]
    }

    def inspect(name):
        vector = build_rappid_card_fixture(name).vector
        return inspect_card_offline(
            uri=vector["link"],
            frame=vector["frame"],
            trust=CardTrustStore(
                keys, vector["runtime_policy_authority"]
            ),
            now_utc=vector["now_utc"],
            runtime_policy=vector["runtime_policy"],
            authority_view=vector["authority_view"],
            revocation_view=vector["revocation_view"],
            connection_id=vector["connection_id"],
            fetch_trace=vector["fetch_trace"],
            hydrated={
                part: parts[part] for part in vector["hydrated_parts"]
            },
            continuity=vector["continuity"],
        )

    first = inspect("valid-production")
    repeated = inspect("valid-production")
    failing = inspect("expired")
    rollback = inspect("rollback-revocation-view")
    replay = inspect("duplicate-replayed-nonce")
    assert first["status"] == "historical-unproven"
    assert first["awake"] is False
    assert first["cryptographic_policy_ok"] is True
    assert first["anti_rollback_checked"] is False
    assert first["replay_checked"] is False
    assert first["verdict"]["reason"] == "historical-unproven"
    assert first["verdict"]["result"] is None
    assert repeated == first
    assert failing["status"] == "historical-unproven"
    assert failing["verdict"]["step"] == "expiry"
    assert failing["verdict"]["result"] is None
    assert rollback["status"] == "historical-unproven"
    assert rollback["anti_rollback_checked"] is False
    assert rollback["verdict"]["reason"] == "historical-unproven"
    assert replay["status"] == "historical-unproven"
    assert replay["replay_checked"] is False
    assert replay["verdict"]["reason"] == "historical-unproven"
    assert path.read_bytes() == before
    assert SQLiteCardState(str(path)).nonce_state(
        "offline-sentinel-nonce"
    ) == {
        "connection_id": "sentinel-connection",
        "state": "awake",
        "updated_utc": "2026-08-21T12:30:00.000Z",
    }
    _remove_database(path)


def test_prohibited_material_scanner_controls_are_real():
    deck = load_rappid_card_deck()
    controls = [vector for vector in deck["vectors"] if vector["scanner_control"]]
    assert len(controls) == 9
    original_card = R._forbidden_card_material
    original_url = R._forbidden_url_material
    try:
        R._forbidden_card_material = lambda value: False
        R._forbidden_url_material = lambda value: False
        for vector in controls:
            path = ROOT / f".protocol-scanner-{vector['name']}-{os.getpid()}.sqlite"
            _remove_database(path)
            try:
                verdict = simulate_rappid_card_fixture(vector["name"], str(path))
                assert verdict.ok, (vector["name"], verdict.to_wire())
            finally:
                _remove_database(path)
    finally:
        R._forbidden_card_material = original_card
        R._forbidden_url_material = original_url


def test_restart_same_connection_resume_and_awake_commit():
    name = "missing-engram-part"
    path = ROOT / f".protocol-restart-{os.getpid()}.sqlite"
    _remove_database(path)
    try:
        vector = build_rappid_card_fixture(name)
        first = simulate_rappid_card_fixture(name, str(path))
        nonce = parse_card_link(vector.deep_link)["nonce"]
        assert first.step == "hydration"
        assert SQLiteCardState(str(path)).nonce_state(nonce)["state"] == "hydrating"
        resumed = simulate_rappid_card_fixture(
            name,
            str(path),
            ["engram", "reflex-capability", "soul"],
        )
        assert resumed.ok
        assert SQLiteCardState(str(path)).nonce_state(nonce)["state"] == "awake"
    finally:
        _remove_database(path)


def test_thread_process_and_sequence_linearization():
    root = ROOT / f".protocol-concurrency-{os.getpid()}"
    root.mkdir(exist_ok=True)
    try:
        thread_path = root / "threads.sqlite"
        SQLiteCardState(str(thread_path))
        barrier = threading.Barrier(16)
        results: "queue.Queue[tuple[bool, str]]" = queue.Queue()

        def claim(index):
            state = SQLiteCardState(str(thread_path))
            barrier.wait()
            results.put(
                state.claim_nonce(
                    "thread-contention-nonce",
                    f"thread-{index}",
                    "2026-08-21T12:30:00.000Z",
                )
            )

        threads = [threading.Thread(target=claim, args=(index,)) for index in range(16)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        values = [results.get(timeout=5) for _ in threads]
        assert sum(1 for accepted, _ in values if accepted) == 1

        process_path = root / "processes.sqlite"
        SQLiteCardState(str(process_path))
        context = multiprocessing.get_context("spawn")
        start = context.Event()
        process_results = context.Queue()
        processes = [
            context.Process(
                target=_process_claim,
                args=(
                    str(process_path),
                    "process-contention-nonce",
                    f"process-{index}",
                    start,
                    process_results,
                ),
            )
            for index in range(8)
        ]
        for process in processes:
            process.start()
        start.set()
        values = [process_results.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(30)
        assert all(process.exitcode == 0 for process in processes)
        assert sum(1 for _, (accepted, _) in values if accepted) == 1

        sequence_path = root / "sequence.sqlite"
        state = SQLiteCardState(str(sequence_path))
        authority = load_rappid_card_deck()["vectors"][0]["runtime_policy"][
            "authority_rappid"
        ]
        assert state.accept_sequence("card-revocation", authority, 10, "a" * 64)[0]
        assert not state.accept_sequence("card-revocation", authority, 9, "b" * 64)[0]
        assert state.accept_sequence("card-revocation", authority, 10, "a" * 64)[0]
        assert not state.accept_sequence("card-revocation", authority, 10, "c" * 64)[0]
        assert state.accept_sequence("card-revocation", authority, 11, "d" * 64)[0]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_qr_artifacts_and_fixture_cli():
    link = physical_vector_bytes()[1].decode("utf-8").strip()
    svg = render_rappid_card_qr_svg(link)
    png = render_rappid_card_qr_png(link)
    assert "<svg" in svg and "<path" in svg
    assert png[:8].hex() == "89504e470d0a1a0a"

    directory = ROOT / f".protocol-python-export-{os.getpid()}"
    state = ROOT / f".protocol-python-cli-{os.getpid()}.sqlite"
    bundle_path = ROOT / f".protocol-python-bundle-{os.getpid()}.json"
    trust_path = ROOT / f".protocol-python-trust-{os.getpid()}.json"
    shutil.rmtree(directory, ignore_errors=True)
    _remove_database(state)
    try:
        export = write_rappid_card_fixture_deck(str(directory), "svg")
        assert export["fixtures"] == 63
        assert "08893fdf8d495f9da8c202cd004fc1587082816c" in export["provenance"]
        physical = directory / "physical-payload-reproduction"
        assert (physical / ".rappid-card.json").read_bytes() == physical_vector_bytes()[0]
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "verify",
                str(physical / ".rappid-card.json"),
                "--link",
                str(physical / "rappid-card.link.txt"),
                "--scenario",
                "physical-payload-reproduction",
                "--state",
                str(state),
            ],
            cwd=ROOT / "python",
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        fixture_result = json.loads(result.stdout)
        assert fixture_result["mode"] == "synthetic-conformance-fixture"
        assert fixture_result["live"] is False
        assert fixture_result["scenario"] == "physical-payload-reproduction"
        assert fixture_result["protocol_source_commit"] == "08893fd"
        assert fixture_result["verdict"]["ok"] is True
        _remove_database(state)
        production_fixture = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "simulate",
                "valid-production",
                "--state",
                str(state),
            ],
            cwd=ROOT / "python",
            text=True,
            capture_output=True,
            check=False,
        )
        assert production_fixture.returncode == 0
        production_result = json.loads(production_fixture.stdout)
        assert production_result["mode"] == "synthetic-conformance-fixture"
        assert production_result["live"] is False
        assert production_result["scenario"] == "valid-production"
        assert production_result["protocol_source_commit"] == "08893fd"
        assert production_result["verdict"]["result"]["profile"] == "rappid-card/1"
        deck = load_rappid_card_deck()
        vector = build_rappid_card_fixture("physical-payload-reproduction").vector
        bundle_path.write_text(
            json.dumps(
                {
                    "runtime_policy_authority": vector[
                        "runtime_policy_authority"
                    ],
                    "runtime_policy": vector["runtime_policy"],
                    "authority_view": vector["authority_view"],
                    "revocation_view": vector["revocation_view"],
                    "now_utc": vector["now_utc"],
                    "connection_id": "fixture-bundle-connection",
                    "fetch_trace": vector["fetch_trace"],
                    "hydrated_parts_b64": {
                        part: deck["parts_b64"][part]
                        for part in vector["hydrated_parts"]
                    },
                    "continuity": vector["continuity"],
                }
            ),
            encoding="utf-8",
        )
        trust_path.write_text(
            json.dumps(
                {
                    "schema": "openrappter-rappid-card-trust/1",
                    "runtime_policy_authority": vector[
                        "runtime_policy_authority"
                    ],
                    "keys": deck["trust"],
                }
            ),
            encoding="utf-8",
        )
        trust_path.chmod(0o600)
        _remove_database(state)
        generic = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "verify",
                str(physical / ".rappid-card.json"),
                "--link",
                str(physical / "rappid-card.link.txt"),
                "--bundle",
                str(bundle_path),
                "--trust-config",
                str(trust_path),
                "--state",
                str(state),
            ],
            cwd=ROOT / "python",
            text=True,
            capture_output=True,
            check=False,
        )
        assert generic.returncode == 1, generic.stderr
        assert json.loads(generic.stdout)["reason"] == "live-adapter-required"
        offline = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "inspect-offline",
                str(physical / ".rappid-card.json"),
                "--link",
                str(physical / "rappid-card.link.txt"),
                "--bundle",
                str(bundle_path),
                "--trust-config",
                str(trust_path),
            ],
            cwd=ROOT / "python",
            text=True,
            capture_output=True,
            check=False,
        )
        assert offline.returncode == 0, offline.stderr
        offline_result = json.loads(offline.stdout)
        assert offline_result["status"] == "historical-unproven"
        assert offline_result["awake"] is False
        assert offline_result["cryptographic_policy_ok"] is True
        assert offline_result["anti_rollback_checked"] is False
        assert offline_result["replay_checked"] is False
        assert offline_result["verdict"]["reason"] == "historical-unproven"
        assert offline_result["verdict"]["result"] is None

        attacker_bundle = json.loads(bundle_path.read_text())
        attacker_bundle["trust"] = deck["trust"]
        bundle_path.write_text(json.dumps(attacker_bundle), encoding="utf-8")
        refused = subprocess.run(
            [
                sys.executable,
                "-m",
                "openrappter.cli",
                "rappid-card",
                "verify",
                str(physical / ".rappid-card.json"),
                "--link",
                str(physical / "rappid-card.link.txt"),
                "--bundle",
                str(bundle_path),
                "--trust-config",
                str(trust_path),
                "--state",
                str(state),
            ],
            cwd=ROOT / "python",
            text=True,
            capture_output=True,
            check=False,
        )
        assert refused.returncode == 1
        assert "trust roots are forbidden" in refused.stdout
    finally:
        shutil.rmtree(directory, ignore_errors=True)
        _remove_database(state)
        bundle_path.unlink(missing_ok=True)
        trust_path.unlink(missing_ok=True)
