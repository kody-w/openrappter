"""What a Quantum RAPPID must survive.

Mirrors ``typescript/src/rappids/__tests__/organism.test.ts``. The claims under
test are the ones the product makes out loud: one identity across every
dimension, weight that is verified rather than asserted, growth that appends
instead of re-minting, and a habitat that refuses to play bytes which no longer
match their content address.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from openrappter import rappids as R  # noqa: E402
from openrappter.rappids.types import BodyFrame, QuantumRappidError  # noqa: E402

from tests.quantum_rappid_fixture import (  # noqa: E402
    ExtraDimension,
    build_organism,
    make_habitat,
    remove_habitat,
)

#: The eleven keys RAPP/1 pins on every frame, and nothing else.
FRAME_KEYS = [
    "frame_hash",
    "kind",
    "payload",
    "payload_hash",
    "prev",
    "prev_wave",
    "seq",
    "sig",
    "spec",
    "stream_id",
    "utc",
]


@pytest.fixture
def habitat():
    created = []

    def factory(label):
        home = make_habitat(label)
        created.append(home)
        return home

    yield factory
    for home in created:
        remove_habitat(home)


def check(organism, name):
    report = R.verify_organism(organism)
    found = next((entry for entry in report.checks if entry.name == name), None)
    assert found is not None, f"no check named {name}"
    return found


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def test_verifies_every_claim_it_makes_about_itself(habitat):
    fixture = build_organism(habitat("verified"))
    report = R.verify_organism(R.load_organism(fixture.directory))

    assert [entry for entry in report.checks if entry.status == "fail"] == []
    assert report.ok is True
    # Two MIDI assets, each counted once by (dimension, sha256).
    assert len(report.verified_addresses) == 2


def test_weighs_exactly_what_it_can_produce(habitat):
    fixture = build_organism(habitat("weight"))
    organism = R.load_organism(fixture.directory)
    summary = R.summarize(organism, R.verify_organism(organism))

    assert summary["stats"]["residentWeightBytes"] == (
        fixture.prompt_midi_bytes + fixture.autocomplete_midi_bytes
    )
    # Verified bytes are reported even when the total cannot be completed.
    assert summary["stats"]["verifiedWeightBytes"] == (
        fixture.prompt_midi_bytes + fixture.autocomplete_midi_bytes
    )
    assert summary["stats"]["uniqueAssets"] == 2
    assert summary["stats"]["frameHeight"] == 0
    # The memory dimension points at an engram cursor whose size is not known
    # here, so the total is incomplete rather than estimated.
    assert summary["stats"]["weightComplete"] is False
    assert summary["stats"]["totalWeightBytes"] is None
    assert summary["unmeasuredDimensions"] == ["memory"]


def test_never_counts_the_same_content_address_twice(habitat):
    fixture = build_organism(habitat("dedupe"))
    organism = R.load_organism(fixture.directory)
    report = R.verify_organism(organism)
    doubled = R.VerificationReport(
        rappid=report.rappid,
        ok=report.ok,
        checks=report.checks,
        assets=[*report.assets, *report.assets],
        verified_addresses=report.verified_addresses,
    )
    dimensions = R.dimension_states(organism, doubled)

    assert R.derive_stats(organism, doubled, dimensions).resident_weight_bytes == (
        fixture.prompt_midi_bytes + fixture.autocomplete_midi_bytes
    )


def _absent(path, digest, size):
    """An asset the manifest records and the disk does not have.

    Nothing hashed it, because the bytes are not here, so it carries no RAPP
    egg address at all -- only the digest its manifest recorded.
    """
    return R.AssetVerification(
        dimension="sonic",
        path=path,
        status="missing",
        address_space=R.RAPP_EGG_DOMAIN,
        address_hash="",
        expected_bytes=size,
        actual_bytes=None,
        expected_sha256=digest,
        actual_sha256=None,
        media_type="audio/wav",
    )


def test_linked_weight_counts_each_absent_file_by_its_own_digest(habitat):
    fixture = build_organism(
        habitat("linked-weight"),
        extra_dimensions=[
            # Every dimension must be measurable, or the total is null and the
            # linked arithmetic below is never reached.
            ExtraDimension(
                name="memory",
                status="awake",
                refs={"engrams": "memory/engrams.jsonl"},
                files={"memory/engrams.jsonl": '{"cursor":"0002"}\n'},
            )
        ],
    )
    organism = R.load_organism(fixture.directory)
    report = R.verify_organism(organism)
    assert R.derive_stats(
        organism, report, R.dimension_states(organism, report)
    ).weight_complete is True

    linked = R.VerificationReport(
        rappid=report.rappid,
        ok=report.ok,
        checks=report.checks,
        assets=[
            *report.assets,
            _absent("assets/wake-call.wav", "a" * 64, 4096),
            _absent("assets/wake-call.m4a", "b" * 64, 2048),
            # The same bytes under a second name: one file's worth of weight.
            _absent("assets/wake-call-copy.m4a", "b" * 64, 2048),
        ],
        verified_addresses=report.verified_addresses,
    )
    stats = R.derive_stats(organism, linked, R.dimension_states(organism, linked))

    # Absent files have no address to count by, so they are deduplicated by the
    # digest their manifest recorded. Keying them all on the empty address
    # would collapse three known files into one and lose 6144 bytes.
    assert stats.linked_weight_bytes == 4096 + 2048
    assert stats.total_weight_bytes == stats.resident_weight_bytes + 4096 + 2048
    # Weight that was actually produced is reported separately, and unchanged.
    assert stats.verified_weight_bytes == stats.resident_weight_bytes


def test_the_stage_a_frame_records_is_the_stage_the_habitat_derives(habitat):
    fixture = build_organism(
        habitat("stage-ladder"),
        extra_dimensions=[
            ExtraDimension(
                name="skill",
                status="recorded",
                refs={"manifest": "skill/SKILL.md"},
                files={"skill/SKILL.md": "# Recorded skill\n"},
            )
        ],
    )

    organism = R.load_organism(fixture.directory)
    first = R.build_growth_proposal(organism, "sonic").proposal
    assert first.predicted_stage == "baby"
    first_result = R.grow_organism(organism, first.id, "2026-08-20T20:00:00.000Z")
    assert first_result["appended"]["payload"]["stage"] == {"name": "baby", "ordinal": 0}

    organism = R.load_organism(fixture.directory)
    second = R.build_growth_proposal(organism, "sonic").proposal
    result = R.grow_organism(organism, second.id, "2026-08-20T21:00:00.000Z")

    organism = R.load_organism(fixture.directory)
    summary = R.summarize(organism, R.verify_organism(organism))

    # Both frames landed on the sonic dimension, so a ladder that counted only
    # the families frames witnessed would still read "baby" here. The declared
    # skill dimension is active evidence, and one ladder reads it for the
    # frame's own record, the preview, and the habitat summary alike.
    assert summary["lifecycleStage"] == "hatchling"
    assert second.predicted_stage == "hatchling"
    assert result["appended"]["payload"]["stage"] == {"name": "hatchling", "ordinal": 1}
    assert result["summary"]["lifecycleStage"] == "hatchling"


def test_starts_as_a_baby_and_reports_its_playback_policy(habitat):
    fixture = build_organism(habitat("baby"))
    organism = R.load_organism(fixture.directory)
    summary = R.summarize(organism, R.verify_organism(organism))

    assert summary["lifecycleStage"] == "baby"
    assert summary["parentRappid"] is None
    assert summary["localOnly"] is True
    assert summary["stats"]["displayHeightMm"] == 420

    manifest = R.playback_manifest(fixture.rappid, fixture.habitat).to_wire()
    assert manifest["playbackMode"] == "in-process-bytes"
    assert manifest["requiresUserGesture"] is True
    assert manifest["stopControlRequired"] is True
    assert [track["role"] for track in manifest["tracks"]] == ["midi-dna", "midi-autocomplete"]
    assert all(track["verified"] for track in manifest["tracks"])


def test_lists_organisms_and_finds_one_by_rappid(habitat):
    home = habitat("list")
    first = build_organism(home, tail="one", name="first-organism")
    second = build_organism(home, tail="two", name="second-organism")

    summaries = R.list_organism_summaries(home)
    assert sorted(entry["rappid"] for entry in summaries) == sorted(
        [first.rappid, second.rappid]
    )
    assert R.load_organism_by_rappid(second.rappid, home).directory == second.directory


def test_keeps_identity_midi_fixed_while_live_traits_evolve(habitat):
    home = habitat("birth-traits")
    fixture = build_organism(home, with_sonic=False)
    before = R.load_organism(fixture.directory)
    before_params, before_prompt = R.sonic_context(before)
    before_completion = R.complete_rappid(fixture.rappid, home)

    traits_path = Path(fixture.directory) / "traits.json"
    document = read_json(traits_path)
    document["traits"]["autonomy"] = 0.11
    document["traits"]["curiosity"] = 0.12
    document["traits"]["playfulness"] = 0.13
    write_json(traits_path, document)

    after = R.load_organism(fixture.directory)
    after_params, after_prompt = R.sonic_context(after)
    after_completion = R.complete_rappid(fixture.rappid, home)

    # Identity and the birth snapshot fix the motif; live traits move only the
    # continuation the provider proposes on top of it.
    assert after_params.to_wire() == before_params.to_wire()
    assert [note.to_wire() for note in after_prompt] == [
        note.to_wire() for note in before_prompt
    ]
    assert after_completion["prompt"] == before_completion["prompt"]
    assert after_completion["midiSha256"] != before_completion["midiSha256"]
    # The wire carries camelCase notes; only files carry the snake_case form.
    assert sorted(after_completion["prompt"][0]) == [
        "deltaOnset",
        "duration",
        "pitch",
        "velocity",
    ]


def test_a_traits_document_without_a_birth_snapshot_reads_its_live_traits(habitat):
    home = habitat("legacy-traits")
    fixture = build_organism(home, with_sonic=False)
    traits_path = Path(fixture.directory) / "traits.json"
    document = read_json(traits_path)
    del document["birth_traits"]
    write_json(traits_path, document)

    organism = R.load_organism(fixture.directory)

    # A document written before the snapshot existed still has to sing: its
    # live traits are the best record of birth it carries.
    assert organism.traits.birth_traits == organism.traits.traits
    assert organism.traits.birth_traits_milli == organism.traits.traits_milli
    params, prompt = R.sonic_context(organism)
    assert len(prompt) == 16
    assert params.to_wire() == R.sonic_parameters(
        fixture.rappid, organism.traits.traits_milli
    ).to_wire()


def test_a_malformed_birth_snapshot_is_refused_rather_than_ignored(habitat):
    home = habitat("bad-birth-traits")
    fixture = build_organism(home, with_sonic=False)
    traits_path = Path(fixture.directory) / "traits.json"
    document = read_json(traits_path)
    document["birth_traits"] = None
    write_json(traits_path, document)

    with pytest.raises(QuantumRappidError, match="birth_traits must be an object"):
        R.load_organism(fixture.directory)


def test_catches_a_media_file_whose_bytes_no_longer_match(habitat):
    fixture = build_organism(habitat("media-hash"))
    asset = Path(fixture.directory) / "sonic" / "assets" / "dna-prompt.mid"
    payload = bytearray(asset.read_bytes())
    # Same length, one different byte: a byte-count check alone would miss it.
    payload[-2] ^= 0x01
    asset.write_bytes(bytes(payload))

    report = R.verify_organism(R.load_organism(fixture.directory))
    broken = next(entry for entry in report.assets if entry.path == "assets/dna-prompt.mid")
    assert broken.status == "hash-mismatch"
    assert broken.actual_bytes == len(payload)
    assert report.ok is False
    assert len(report.verified_addresses) == 1


def test_catches_a_truncated_media_file_as_a_byte_mismatch(habitat):
    fixture = build_organism(habitat("media-bytes"))
    asset = Path(fixture.directory) / "sonic" / "assets" / "autocomplete.mid"
    asset.write_bytes(asset.read_bytes()[:32])

    report = R.verify_organism(R.load_organism(fixture.directory))
    broken = next(entry for entry in report.assets if entry.path == "assets/autocomplete.mid")
    assert broken.status == "byte-mismatch"
    assert report.ok is False


def test_refuses_to_hand_a_player_bytes_that_do_not_match(habitat):
    home = habitat("playback-tamper")
    fixture = build_organism(home)
    asset = Path(fixture.directory) / "sonic" / "assets" / "dna-prompt.mid"
    asset.write_bytes(asset.read_bytes() + b"\x00")

    with pytest.raises(QuantumRappidError, match="does not match its content address"):
        R.read_asset_payload(fixture.rappid, "midi-dna", home)


def test_serves_verified_bytes_with_their_content_address(habitat):
    home = habitat("playback-ok")
    fixture = build_organism(home)
    payload = R.read_asset_payload(fixture.rappid, "midi-dna", home)

    assert payload["mediaType"] == "audio/midi"
    assert payload["bytes"] == fixture.prompt_midi_bytes


def test_catches_an_edited_sonic_manifest(habitat):
    fixture = build_organism(habitat("manifest"))
    profile_path = Path(fixture.directory) / "sonic" / "sonic-profile.json"
    profile = read_json(profile_path)
    profile["musical_parameters"]["bpm"] = 999
    write_json(profile_path, profile)

    assert check(R.load_organism(fixture.directory), "sonic.manifest").status == "fail"


def test_will_not_call_a_dimension_verified_without_a_manifest_hash(habitat):
    fixture = build_organism(habitat("no-manifest"))
    profile_path = Path(fixture.directory) / "sonic" / "sonic-profile.json"
    profile = read_json(profile_path)
    del profile["manifest_sha256"]
    write_json(profile_path, profile)

    failure = check(R.load_organism(fixture.directory), "sonic.manifest")
    assert failure.status == "fail"
    assert "no manifest hash" in failure.detail


def test_reads_a_sha256sum_sidecar_and_catches_it_disagreeing(habitat):
    fixture = build_organism(habitat("sidecar"))
    sidecar = Path(fixture.directory) / "sonic" / "sonic-profile.sha256"
    sidecar.write_text("0" * 64 + "  sonic-profile.json\n", encoding="utf-8")

    failure = check(R.load_organism(fixture.directory), "sonic.manifest")
    assert failure.status == "fail"
    assert "sonic-profile.sha256 records" in failure.detail


def test_catches_a_dangling_dimension_ref(habitat):
    fixture = build_organism(
        habitat("dangling-ref"),
        extra_dimensions=[
            ExtraDimension(name="skill", status="recorded", refs={"manifest": "skill/SKILL.md"})
        ],
    )

    assert check(R.load_organism(fixture.directory), "dimensions.refs").status == "fail"


def test_refuses_a_manifest_path_that_climbs_out_of_the_organism(habitat):
    fixture = build_organism(habitat("escape"))
    rappid_path = Path(fixture.directory) / "rappid.json"
    document = read_json(rappid_path)
    document["quantum"]["dimensions"]["sonic"]["profile"] = "../../../../etc/passwd"
    write_json(rappid_path, document)

    failure = check(R.load_organism(fixture.directory), "dimensions.refs")
    assert failure.status == "fail"
    assert "resolves outside the organism directory" in failure.detail


def test_catches_a_second_identity_hiding_inside_one_organism(habitat):
    other = "rappid:@openrappter/other-organism:" + "a" * 64
    fixture = build_organism(habitat("drift"), traits_rappid=other)

    failure = check(R.load_organism(fixture.directory), "identity.single")
    assert failure.status == "fail"
    assert "traits.json says" in failure.detail


def test_catches_a_habitat_directory_that_does_not_match(habitat):
    home = habitat("habitat-drift")
    fixture = build_organism(home)
    moved = Path(home) / ("b" * 64)
    Path(fixture.directory).rename(moved)

    failure = check(R.load_organism(str(moved)), "identity.habitat")
    assert failure.status == "fail"
    assert "does not match the RAPPID hex" in failure.detail


def test_accepts_offspring_and_refuses_self_parenthood(habitat):
    parent = "rappid:@openrappter/parent-organism:" + "c" * 64
    child = build_organism(habitat("offspring"), parent_rappid=parent)
    organism = R.load_organism(child.directory)
    assert organism.document.parent_rappid == parent
    assert "true offspring of" in check(organism, "identity.lineage").detail

    selfish = build_organism(habitat("self-parent"))
    rappid_path = Path(selfish.directory) / "rappid.json"
    document = read_json(rappid_path)
    document["parent_rappid"] = selfish.rappid
    write_json(rappid_path, document)

    with pytest.raises(QuantumRappidError, match="points at itself as its parent"):
        R.load_organism(selfish.directory)


def test_appends_a_verified_frame_without_touching_the_identity(habitat):
    fixture = build_organism(habitat("grow"))
    before = R.load_organism(fixture.directory)
    proposal = R.build_growth_proposal(before, "sonic").proposal

    assert proposal.to_wire()["authoritative"] is False
    assert proposal.to_wire()["appendable"] is True
    assert proposal.predicted_stats.frame_height == 1

    organism = R.load_organism(fixture.directory)
    result = R.grow_organism(organism, proposal.id, "2026-08-20T20:00:00.000Z")

    assert result["rappid"] == fixture.rappid
    assert result["summary"]["rappid"] == fixture.rappid
    # The exact eleven-key RAPP/1 envelope, and no private wrapper around it.
    assert sorted(result["appended"]) == FRAME_KEYS
    assert result["appended"]["spec"] == "rapp/1"
    assert result["appended"]["kind"] == "body.dimension"
    assert result["appended"]["seq"] == 0
    assert result["appended"]["prev"] is None
    assert result["appended"]["prev_wave"] is None
    assert result["appended"]["sig"] is None
    assert result["appended"]["utc"] == "2026-08-20T20:00:00.000Z"
    assert sorted(result["appended"]["payload"]) == [
        "dimension",
        "media",
        "rappid",
        "sources",
        "stage",
        "traits",
        "traits_hash",
        "version",
    ]
    assert result["summary"]["stats"]["frameHeight"] == 1
    assert result["verification"]["ok"] is True
    assert Path(result["framePath"]).is_file()
    # The prediction quoted exact bytes, so it has to match what landed.
    assert result["summary"]["stats"]["residentWeightBytes"] == (
        proposal.predicted_stats.resident_weight_bytes
    )


def test_a_frame_media_ref_resolves_in_the_local_egg_store(habitat):
    fixture = build_organism(habitat("egg-store"))
    organism = R.load_organism(fixture.directory)
    proposal = R.build_growth_proposal(organism, "sonic").proposal
    result = R.grow_organism(organism, proposal.id, "2026-08-20T20:00:00.000Z")

    reference = result["appended"]["payload"]["media"]["midi-autocomplete"]
    assert sorted(reference) == ["bytes", "hash", "media_type", "space"]
    assert reference["space"] == R.RAPP_EGG_DOMAIN
    assert reference["media_type"] == "application/x-midi"

    stored = Path(fixture.directory) / R.OBJECTS_DIRECTORY / reference["hash"]
    assert stored.is_file()
    payload = stored.read_bytes()
    assert len(payload) == reference["bytes"]
    assert R.rapp_hb(R.RAPP_EGG_DOMAIN, payload) == reference["hash"]
    # The egg address the frame names is what verification counts as weight.
    report = R.verify_organism(R.load_organism(fixture.directory))
    assert f"{R.RAPP_EGG_DOMAIN}:{reference['hash']}" in report.verified_addresses


def test_every_verified_asset_carries_its_rapp_address_on_the_wire(habitat):
    fixture = build_organism(habitat("addresses"))
    organism = R.load_organism(fixture.directory)
    wire = R.verify_organism(organism).to_wire()

    assert wire["assets"], "the organism carries no assets to address"
    for asset in wire["assets"]:
        assert asset["addressSpace"] == R.RAPP_EGG_DOMAIN
        # A verified asset is verified *at* an address, and weight is counted
        # by that address rather than by the path it happens to sit at.
        assert len(asset["addressHash"]) == 64
        assert f"{asset['addressSpace']}:{asset['addressHash']}" in wire["verifiedAddresses"]


def test_a_stats_only_preview_predicts_but_cannot_be_appended(habitat):
    fixture = build_organism(habitat("stats-preview"))
    organism = R.load_organism(fixture.directory)
    pending = R.build_growth_proposal(organism, "stats")

    assert pending.proposal.appendable is False
    assert pending.proposal.to_wire()["appendable"] is False
    assert pending.proposal.assets == []
    assert pending.proposal.dimension == "skill"

    with pytest.raises(QuantumRappidError, match="preview only"):
        R.grow_organism(R.load_organism(fixture.directory), pending.proposal.id)


def test_refuses_a_proposal_id_it_cannot_rederive(habitat):
    fixture = build_organism(habitat("bad-proposal"))
    organism = R.load_organism(fixture.directory)

    with pytest.raises(QuantumRappidError, match="does not match any growth"):
        R.grow_organism(organism, "not-a-real-proposal")


def test_refuses_to_grow_an_organism_that_does_not_verify(habitat):
    fixture = build_organism(habitat("grow-broken"))
    asset = Path(fixture.directory) / "sonic" / "assets" / "dna-prompt.mid"
    asset.write_bytes(b"\x00")
    organism = R.load_organism(fixture.directory)

    with pytest.raises(QuantumRappidError, match="does not verify"):
        R.grow_organism(organism, "anything")


def _draft(fixture, prev, seq, dimension, stage, utc, media=None, version=1):
    """One well-formed ``body.dimension`` frame, exactly as the habitat builds it."""
    return R.build_dimension_frame(
        rappid=fixture.rappid,
        seq=seq,
        utc=utc,
        prev=prev,
        dimension=dimension,
        version=version,
        stage=stage,
        traits={"evidence_bound": 980},
        media={} if media is None else media,
    )


def test_keeps_history_append_only(habitat):
    fixture = build_organism(habitat("append-only"))
    organism = R.load_organism(fixture.directory)
    proposal = R.build_growth_proposal(organism, "sonic").proposal
    R.grow_organism(organism, proposal.id, "2026-08-20T20:00:00.000Z")

    replay = _draft(
        fixture,
        None,
        0,
        "capability",
        {"name": "baby", "ordinal": 0},
        "2026-08-20T21:00:00.000Z",
    )
    # Sequence 0 is taken: the chain has moved on, and rewriting it is refused.
    with pytest.raises(QuantumRappidError, match="does not continue"):
        R.append_body_frame(R.load_organism(fixture.directory), replay)


def test_refuses_a_frame_whose_dimensional_payload_shape_is_invalid(habitat):
    fixture = build_organism(habitat("payload-refusal"))
    valid = _draft(
        fixture,
        None,
        0,
        "sonic",
        {"name": "baby", "ordinal": 0},
        "2026-08-20T22:00:00.000Z",
    )
    malformed = BodyFrame(
        spec=valid.spec,
        kind=valid.kind,
        stream_id=valid.stream_id,
        seq=valid.seq,
        utc=valid.utc,
        payload={**valid.payload, "extra": "not-lawful"},
        payload_hash="0" * 64,
        frame_hash="0" * 64,
        prev=valid.prev,
        prev_wave=None,
        sig=None,
    )

    with pytest.raises(QuantumRappidError, match="exact key set"):
        R.append_body_frame(R.load_organism(fixture.directory), malformed)


def test_stops_counting_at_the_first_broken_link(habitat):
    fixture = build_organism(habitat("broken-chain"))
    organism = R.load_organism(fixture.directory)
    first = R.build_growth_proposal(organism, "sonic").proposal
    R.grow_organism(organism, first.id, "2026-08-20T20:00:00.000Z")

    orphan = _draft(
        fixture,
        "f" * 64,
        1,
        "capability",
        {"name": "hatchling", "ordinal": 1},
        "2026-08-20T22:00:00.000Z",
    )
    frames_dir = Path(fixture.directory) / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    write_json(frames_dir / "000001.json", R.body_frame_to_json(orphan))

    reloaded = R.load_organism(fixture.directory)
    assert len(reloaded.frames) == 2
    assert R.contiguous_frame_height(reloaded.frames) == 1
    assert check(reloaded, "frames.chain").status == "fail"


def test_grows_from_baby_to_hatchling(habitat):
    fixture = build_organism(
        habitat("hatchling"),
        extra_dimensions=[
            ExtraDimension(
                name="skill",
                status="recorded",
                refs={"manifest": "skill/SKILL.md"},
                files={"skill/SKILL.md": "# Recorded skill\n"},
            )
        ],
    )

    organism = R.load_organism(fixture.directory)
    assert R.summarize(organism, R.verify_organism(organism))["lifecycleStage"] == "baby"

    organism = R.load_organism(fixture.directory)
    proposal = R.build_growth_proposal(organism, "sonic").proposal
    R.grow_organism(organism, proposal.id, "2026-08-20T20:00:00.000Z")

    organism = R.load_organism(fixture.directory)
    skill_bytes = (Path(fixture.directory) / "skill" / "SKILL.md").read_bytes()
    skill_hash = R.store_rapp_object(organism, skill_bytes)
    assert len(skill_hash) == 64
    R.append_body_frame(
        organism,
        _draft(
            fixture,
            organism.frames[0].payload_hash,
            1,
            "skill",
            {"name": "hatchling", "ordinal": 1},
            "2026-08-20T21:00:00.000Z",
            media={"skill": R.media_ref(skill_bytes, "text/markdown")},
        ),
    )

    organism = R.load_organism(fixture.directory)
    summary = R.summarize(organism, R.verify_organism(organism))
    assert summary["stats"]["frameHeight"] == 2
    assert summary["lifecycleStage"] == "hatchling"
    # Height is presentation over frame height; identity is untouched.
    assert summary["stats"]["displayHeightMm"] == 600
    assert summary["rappid"] == fixture.rappid


def test_reaches_raptor_only_with_deep_history_and_four_dimensions(habitat):
    fixture = build_organism(
        habitat("raptor"),
        extra_dimensions=[
            ExtraDimension(
                name="skill",
                status="recorded",
                refs={"manifest": "skill/SKILL.md"},
                files={"skill/SKILL.md": "# Recorded skill\n"},
            ),
            ExtraDimension(
                name="visual",
                status="rendered",
                refs={"sheet": "visual/sheet.json"},
                files={"visual/sheet.json": '{"schema":"quantum-rappid-visual/1.0"}\n'},
            ),
        ],
    )

    # A local memory dimension: the engrams are here, not merely referenced.
    rappid_path = Path(fixture.directory) / "rappid.json"
    document = read_json(rappid_path)
    document["quantum"]["dimensions"]["memory"] = {
        "status": "awake",
        "engrams": "memory/engrams.jsonl",
    }
    write_json(rappid_path, document)
    memory_dir = Path(fixture.directory) / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "engrams.jsonl").write_text('{"cursor":"0002"}\n', encoding="utf-8")

    organism = R.load_organism(fixture.directory)
    families = ["memory", "skill", "sonic", "visual"]
    for index in range(1, 9):
        dimension = families[(index - 1) % len(families)]
        R.append_body_frame(
            organism,
            _draft(
                fixture,
                None if index == 1 else organism.frames[index - 2].payload_hash,
                index - 1,
                dimension,
                {
                    "name": "raptor" if index == 8 else "hatchling" if index >= 2 else "baby",
                    "ordinal": 2 if index == 8 else 1 if index >= 2 else 0,
                },
                f"2026-08-2{index}T00:00:00.000Z",
                version=1 + (index - 1) // len(families),
            ),
        )

    organism = R.load_organism(fixture.directory)
    report = R.verify_organism(organism)
    dimensions = R.dimension_states(organism, report)
    stats = R.derive_stats(organism, report, dimensions)

    assert report.ok is True
    assert stats.frame_height == 8
    assert [entry.name for entry in dimensions if entry.status == "active"] == [
        "memory",
        "skill",
        "sonic",
        "visual",
    ]
    assert R.derive_stage(stats, dimensions) == "raptor"
    # Frames carry weight of their own, and it is exact.
    assert stats.resident_weight_bytes > (
        fixture.prompt_midi_bytes + fixture.autocomplete_midi_bytes
    )
