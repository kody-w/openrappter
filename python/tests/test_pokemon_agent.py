import json
import os
import queue
import asyncio
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from types import SimpleNamespace
import threading

import pytest

import openrappter.agents.pokemon_agent as pokemon_module
from openrappter.agents.pokemon_agent import (
    CopilotBrain,
    GAME_SYSTEM_PROMPT,
    ActionPlayer,
    ClipRecorder,
    PokemonAgent,
    PokemonRunner,
    ViewerServer,
    acquire_runtime_lock,
    build_parser,
    discover_pokemon_red_rom,
    ensure_copilot_runtime,
    file_sha256,
    is_cloud_placeholder,
    is_pokemon_red_rom,
    list_clips,
    normalize_brain_decision,
    parse_agent_action,
    public_runtime_status,
    runtime_command,
    runner_main,
    runtime_status,
    seed_legacy_ram_provenance,
    supervisor_main,
    wait_for_supervised_child,
    wait_supervisor_backoff,
)


def make_rom(path: Path, title: bytes = b"POKEMON RED") -> Path:
    data = bytearray(256 * 1024)
    data[0x134 : 0x134 + len(title)] = title
    path.write_bytes(data)
    return path


def test_agent_contract():
    agent = PokemonAgent()

    assert agent.name == "Pokemon"
    assert agent.metadata["name"] == "Pokemon"
    assert agent.metadata["parameters"]["type"] == "object"
    assert "checkpoint" in agent.metadata["parameters"]["properties"]["action"]["enum"]
    assert "manual" in agent.metadata["parameters"]["properties"]["action"]["enum"]
    assert "autonomy" in agent.metadata["parameters"]["properties"]["action"]["enum"]


def test_rom_validation_uses_header(tmp_path):
    rom = make_rom(tmp_path / "renamed.gb")

    assert not is_cloud_placeholder(rom)
    assert is_pokemon_red_rom(rom)
    assert discover_pokemon_red_rom(str(rom)) == rom.resolve()


def test_rom_validation_rejects_other_game(tmp_path):
    rom = make_rom(tmp_path / "other.gb", b"OTHER GAME")

    assert not is_pokemon_red_rom(rom)
    with pytest.raises(FileNotFoundError):
        discover_pokemon_red_rom(str(rom))


def test_normalize_brain_decision_filters_buttons():
    response = """```json
    {
      "phase": "overworld",
      "observation": "Standing near a path",
      "objective": "Reach Viridian City",
      "reason": "The path continues north",
      "buttons": ["UP", "invalid", "a"],
      "checkpoint": true
    }
    ```"""

    decision = normalize_brain_decision(response)

    assert decision["buttons"] == ["up", "a"]
    assert decision["checkpoint"] is True
    assert decision["objective"] == "Reach Viridian City"


def test_normalize_brain_decision_requires_valid_button():
    with pytest.raises(ValueError, match="valid button"):
        normalize_brain_decision('{"buttons":["x"],"checkpoint":false}')


def test_copilot_prompt_keeps_static_rules_in_system_message():
    brain = CopilotBrain.__new__(CopilotBrain)
    prompt = brain._prompt(
        {"location": "Pallet Town", "badges": []},
        "####\n#P.#",
        [{"buttons": ["up"], "objective": "Leave home"}],
    )

    assert "Pallet Town" in prompt
    assert "Leave home" in prompt
    assert "####" in prompt
    assert "finish Pokemon Red" not in prompt
    assert "finish Pokemon Red" in GAME_SYSTEM_PROMPT
    assert not hasattr(CopilotBrain, "_decide_cli")


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("save checkpoint and start a new clip", ("checkpoint", None)),
        ("pause the game", ("pause", None)),
        ("continue playing", ("autonomy", None)),
        ("take over manually", ("manual", None)),
        ("press start", ("press", "start")),
        ("show progress", ("status", None)),
        ("open viewer", ("view", None)),
        ("stop playing", ("stop", None)),
        ("play Pokemon", ("start", None)),
    ],
)
def test_parse_agent_action(query, expected):
    assert parse_agent_action(query) == expected


def test_runtime_status_reports_stopped(tmp_path):
    (tmp_path / "status.json").write_text(
        json.dumps({"running": True, "pid": 999_999_999, "port": 9999})
    )

    status = runtime_status(tmp_path)

    assert status["running"] is False
    assert status["viewer_url"] == "http://127.0.0.1:9999"
    assert status["clips"] == []


def test_agent_rejects_control_when_not_running(tmp_path):
    result = json.loads(
        PokemonAgent().perform(action="checkpoint", runtime_dir=str(tmp_path))
    )

    assert result["status"] == "error"
    assert "not running" in result["message"]


def test_runtime_lock_rejects_second_owner(tmp_path):
    first = acquire_runtime_lock(tmp_path, "first")
    try:
        with pytest.raises(RuntimeError, match="Another Pokemon player"):
            acquire_runtime_lock(tmp_path, "second")
    finally:
        first.close()


def test_public_status_redacts_private_paths(tmp_path):
    (tmp_path / "status.json").write_text(
        json.dumps(
            {
                "running": True,
                "pid": os.getpid(),
                "child_pid": os.getpid(),
                "supervisor_pid": os.getpid(),
                "port": 9999,
                "rom_path": "/private/Pokemon Red.gb",
                "rom_sha256": "secret-hash",
                "runtime_dir": str(tmp_path),
                "instance_id": "private-instance",
                "recordings": str(tmp_path / "clips"),
                "brain_worker_pid": os.getpid(),
                "checkpoint_sha256": "unknown-private-hash",
                "last_error": "failed at /private/runtime/secret.state",
                "current_clip": str(tmp_path / "clips" / "clip-1.mp4"),
                "last_completed_clip": str(tmp_path / "clips" / "clip-0.mp4"),
                "last_checkpoint": {
                    "path": str(tmp_path / "states" / "state-1.state"),
                    "sha256": "private-state-hash",
                    "reason": "badge",
                },
            }
        )
    )

    status = public_runtime_status(tmp_path)

    assert status["running"] is True
    assert status["current_clip"] == "clip-1.mp4"
    assert status["last_completed_clip"] == "clip-0.mp4"
    assert status["last_checkpoint"] == {"reason": "badge"}
    assert status["last_error"] == (
        "Pokemon runtime reported an error; inspect the local player log"
    )
    assert "/private/" not in json.dumps(status)
    for key in (
        "pid",
        "child_pid",
        "supervisor_pid",
        "rom_path",
        "rom_sha256",
        "runtime_dir",
        "instance_id",
        "recordings",
        "brain_worker_pid",
        "checkpoint_sha256",
    ):
        assert key not in status


def test_agent_status_and_running_start_return_public_status(tmp_path):
    (tmp_path / "status.json").write_text(
        json.dumps(
            {
                "running": True,
                "pid": os.getpid(),
                "rom_path": "/private/Pokemon Red.gb",
                "rom_sha256": "secret-hash",
                "runtime_dir": str(tmp_path),
                "instance_id": "private-instance",
            }
        )
    )

    for action in ("status", "start"):
        result = json.loads(
            PokemonAgent().perform(action=action, runtime_dir=str(tmp_path))
        )
        assert result["status"] == "success"
        for key in (
            "pid",
            "rom_path",
            "rom_sha256",
            "runtime_dir",
            "instance_id",
        ):
            assert key not in result


@pytest.mark.skipif(
    sys.version_info < (3, 11),
    reason="The Copilot SDK-backed Pokemon runtime requires Python 3.11+",
)
def test_fresh_start_returns_public_status(monkeypatch, tmp_path):
    rom = make_rom(tmp_path / "Pokemon Red.gb")
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()

    class Process:
        pid = 4321

        def poll(self):
            return None

    def fake_popen(*args, **kwargs):
        del args, kwargs
        (runtime_dir / "status.json").write_text(
            json.dumps(
                {
                    "running": True,
                    "pid": os.getpid(),
                    "supervisor_pid": 4321,
                    "lifecycle": "ready",
                    "heartbeat_at": pokemon_module.utc_now(),
                    "instance_id": "test-instance",
                    "rom_path": str(rom),
                    "rom_sha256": "private-hash",
                    "runtime_dir": str(runtime_dir),
                    "recordings": str(runtime_dir / "clips"),
                    "brain_backend": "sdk",
                }
            )
        )
        return Process()

    monkeypatch.setattr(
        pokemon_module.importlib.util,
        "find_spec",
        lambda name: object(),
    )
    monkeypatch.setattr(pokemon_module.shutil, "which", lambda name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(pokemon_module, "ensure_copilot_runtime", lambda: None)
    monkeypatch.setattr(
        pokemon_module.uuid,
        "uuid4",
        lambda: SimpleNamespace(hex="test-instance"),
    )
    monkeypatch.setattr(pokemon_module.subprocess, "Popen", fake_popen)

    result = json.loads(
        PokemonAgent().perform(
            action="start",
            rom_path=str(rom),
            runtime_dir=str(runtime_dir),
        )
    )

    assert result["status"] == "success"
    assert result["message"] == "Copilot Plays Pokemon Red is ready"
    for key in (
        "pid",
        "supervisor_pid",
        "rom_path",
        "rom_sha256",
        "runtime_dir",
        "instance_id",
        "recordings",
    ):
        assert key not in result


def test_start_rejects_python_below_311(monkeypatch, tmp_path):
    rom = make_rom(tmp_path / "Pokemon Red.gb")
    monkeypatch.setattr(
        pokemon_module.importlib.util,
        "find_spec",
        lambda name: object(),
    )
    monkeypatch.setattr(pokemon_module.sys, "version_info", (3, 10))

    result = json.loads(
        PokemonAgent().perform(
            action="start",
            rom_path=str(rom),
            runtime_dir=str(tmp_path / "runtime"),
        )
    )

    assert result["status"] == "error"
    assert "Python 3.11+" in result["message"]


def test_invalid_rom_error_does_not_expose_local_path(tmp_path):
    rom = make_rom(tmp_path / "private-invalid.gb", b"OTHER GAME")

    result = json.loads(
        PokemonAgent().perform(
            action="start",
            rom_path=str(rom),
            runtime_dir=str(tmp_path / "runtime"),
        )
    )

    assert result["status"] == "error"
    assert str(rom) not in result["message"]
    assert result["message"] == "No valid local Pokemon Red ROM was found"


@pytest.mark.parametrize(
    "clip_minutes",
    [0, -1, float("nan"), float("inf"), -float("inf")],
)
def test_clip_minutes_must_be_positive_and_finite(tmp_path, clip_minutes):
    result = json.loads(
        PokemonAgent().perform(
            action="start",
            runtime_dir=str(tmp_path),
            clip_minutes=clip_minutes,
        )
    )

    assert result["status"] == "error"
    assert "positive finite number" in result["message"]
    with pytest.raises(SystemExit):
        build_parser().parse_args(
            [
                "run",
                "--rom",
                str(tmp_path / "Pokemon Red.gb"),
                "--clip-minutes",
                str(clip_minutes),
            ]
        )


def test_clip_listing_hides_partial_files_and_reads_manifest(tmp_path):
    clips = tmp_path / "clips"
    clips.mkdir()
    (clips / ".clip-0001.partial.mp4").write_bytes(b"partial")
    completed = clips / "clip-0001.mp4"
    completed.write_bytes(b"video")
    completed.with_suffix(".json").write_text(
        json.dumps(
            {
                "duration_seconds": 12.5,
                "reason": "badge",
                "game_state": {"location": "Pewter Gym"},
            }
        )
    )

    result = list_clips(tmp_path)

    assert [clip["name"] for clip in result] == ["clip-0001.mp4"]
    assert result[0]["duration_seconds"] == 12.5
    assert result[0]["location"] == "Pewter Gym"


def test_clip_listing_orders_numeric_indices(tmp_path):
    clips = tmp_path / "clips"
    clips.mkdir()
    older = clips / "clip-9999-20260711-120000.mp4"
    newer = clips / "clip-10000-20260711-120001.mp4"
    older.write_bytes(b"older")
    newer.write_bytes(b"newer")

    result = list_clips(tmp_path)

    assert [clip["name"] for clip in result] == [newer.name, older.name]


def test_interrupted_clip_manifest_is_recovered(tmp_path):
    clips = tmp_path / "clips"
    clips.mkdir()
    clip = clips / "clip-10000-20260711-120001.mp4"
    clip.write_bytes(b"crash-finalized video")
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.recorder = SimpleNamespace(clips_dir=clips)

    runner._recover_orphaned_clips()

    manifest = json.loads(clip.with_suffix(".json").read_text())
    assert manifest["recovered"] is True
    assert manifest["name"] == clip.name
    assert manifest["sha256"] == file_sha256(clip)


class FakeStateEmulator:
    def __init__(self):
        self.memory = bytearray(65536)
        self.loaded = []
        self.released = []
        self.ticks = 0

    def save_state(self, handle):
        handle.write(b"valid-state")

    def load_state(self, handle):
        self.loaded.append(handle.read())

    def button_release(self, button):
        self.released.append(button)

    def tick(self):
        self.ticks += 1
        return True


def test_checkpoint_is_atomic_and_manifested(tmp_path):
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.states_dir = tmp_path
    runner.pyboy = FakeStateEmulator()
    runner.player = ActionPlayer()
    runner.status = {"rom_sha256": "rom-hash", "game_state": {}}

    checkpoint = runner._save_checkpoint("test boundary")
    manifest = json.loads(checkpoint.with_suffix(".json").read_text())

    assert checkpoint.read_bytes() == b"valid-state"
    assert manifest["sha256"] == file_sha256(checkpoint)
    assert manifest["rom_sha256"] == "rom-hash"
    assert manifest["reason"] == "test boundary"
    assert list(tmp_path.glob("*.tmp")) == []
    assert set(runner.pyboy.released) == {
        "a", "b", "start", "select", "up", "down", "left", "right"
    }
    assert runner.pyboy.ticks == 1


def test_interrupted_checkpoint_manifest_is_recovered(tmp_path):
    orphaned = tmp_path / "state-20260711-120000-000001.state"
    orphaned.write_bytes(b"recoverable-state")
    orphaned.with_suffix(".pending.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "state_name": orphaned.name,
                "created_at": "2026-07-11T12:00:00+00:00",
                "reason": "interrupted checkpoint",
                "rom_sha256": "rom-hash",
            }
        )
    )
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.states_dir = tmp_path
    runner.status = {"rom_sha256": "rom-hash"}

    runner._recover_orphaned_states()

    manifest = json.loads(orphaned.with_suffix(".json").read_text())
    assert manifest["recovered"] is True
    assert manifest["rom_sha256"] == "rom-hash"
    assert manifest["sha256"] == file_sha256(orphaned)
    assert runner._verified_generated_state(orphaned) is True


def test_ambiguous_or_cross_rom_orphaned_state_is_quarantined(tmp_path):
    orphaned = tmp_path / "state-20260711-120000-000001.state"
    orphaned.write_bytes(b"unknown-state")
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.states_dir = tmp_path
    runner.status = {"rom_sha256": "current-rom"}

    runner._recover_orphaned_states()

    assert not orphaned.exists()
    quarantined = list((tmp_path / "quarantine").glob("*.orphan"))
    assert quarantined
    assert quarantined[0].read_bytes() == b"unknown-state"


def test_terminal_checkpoint_survives_closed_window(tmp_path):
    class ClosedWindowEmulator(FakeStateEmulator):
        def tick(self):
            self.ticks += 1
            return False

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.states_dir = tmp_path
    runner.pyboy = ClosedWindowEmulator()
    runner.player = ActionPlayer()
    runner.status = {"rom_sha256": "rom-hash", "game_state": {}}

    checkpoint = runner._save_checkpoint("window closed", allow_stopped=True)

    assert checkpoint.read_bytes() == b"valid-state"
    assert runner.pyboy.ticks == 1


def test_paused_runner_pumps_window_events_without_applying_input():
    class ClosedWindowEmulator:
        ticks = 0

        def tick(self):
            self.ticks += 1
            return False

    class InputSpy:
        ticks = 0

        def tick(self, pyboy):
            del pyboy
            self.ticks += 1

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.control_mode = "paused"
    runner.decision_pending = False
    runner.pyboy = ClosedWindowEmulator()
    runner.player = InputSpy()

    assert runner._tick_emulator() is False
    assert runner.pyboy.ticks == 1
    assert runner.player.ticks == 0


def test_resume_skips_corrupt_newest_checkpoint(tmp_path):
    older = tmp_path / "state-20260711-120000-000001.state"
    older.write_bytes(b"older-valid")
    older.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rom_sha256": "rom-hash",
                "sha256": file_sha256(older),
            }
        )
    )
    newer = tmp_path / "state-20260711-120001-000001.state"
    newer.write_bytes(b"corrupt")
    newer.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rom_sha256": "rom-hash",
                "sha256": "wrong",
            }
        )
    )
    ambiguous = tmp_path / "state-backup.state"
    ambiguous.write_bytes(b"must-not-load")
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.args = SimpleNamespace(resume=True)
    runner.runtime_dir = tmp_path
    runner.states_dir = tmp_path
    runner.pyboy = FakeStateEmulator()
    runner.player = ActionPlayer()
    runner.status = {"rom_sha256": "rom-hash"}

    selected = runner._load_latest_state()

    assert selected == older
    assert runner.pyboy.loaded[-1] == b"older-valid"
    assert b"must-not-load" not in runner.pyboy.loaded
    assert runner.pyboy.ticks == 1
    assert not newer.exists()
    assert list((tmp_path / "quarantine").glob(f"{newer.name}.*.orphan"))


def test_resume_falls_back_after_pyboy_state_exception(tmp_path):
    pyboy_utils = pytest.importorskip("pyboy.utils")
    PyBoyException = getattr(pyboy_utils, "PyBoyException", None)
    if PyBoyException is None:
        pytest.skip("Installed PyBoy does not expose PyBoyException")

    older = tmp_path / "state-20260711-120000-000001.state"
    older.write_bytes(b"older-valid")
    newer = tmp_path / "state-20260711-120001-000001.state"
    newer.write_bytes(b"newer-incompatible")
    for path, created_at in (
        (older, "2026-07-11T12:00:00+00:00"),
        (newer, "2026-07-11T12:01:00+00:00"),
    ):
        path.with_suffix(".json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "rom_sha256": "rom-hash",
                    "sha256": file_sha256(path),
                    "created_at": created_at,
                }
            )
        )

    class RejectNewest(FakeStateEmulator):
        def load_state(self, handle):
            payload = handle.read()
            if payload == b"newer-incompatible":
                raise PyBoyException("incompatible state")
            self.loaded.append(payload)

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.args = SimpleNamespace(resume=True)
    runner.runtime_dir = tmp_path
    runner.states_dir = tmp_path
    runner.pyboy = RejectNewest()
    runner.player = ActionPlayer()
    runner.status = {"rom_sha256": "rom-hash"}

    assert runner._load_latest_state() == older
    assert runner.pyboy.loaded[-1] == b"older-valid"
    assert not newer.exists()
    assert list((tmp_path / "quarantine").glob(f"{newer.name}.*.orphan"))


def test_resume_orders_checkpoints_by_utc_manifest_time(tmp_path):
    pre_fallback = tmp_path / "state-20261101-015500-000001.state"
    pre_fallback.write_bytes(b"older-pre-fallback")
    post_fallback = tmp_path / "state-20261101-010500-000001.state"
    post_fallback.write_bytes(b"newer-post-fallback")
    for path, created_at in (
        (pre_fallback, "2026-11-01T05:55:00+00:00"),
        (post_fallback, "2026-11-01T06:05:00+00:00"),
    ):
        path.with_suffix(".json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "rom_sha256": "rom-hash",
                    "sha256": file_sha256(path),
                    "created_at": created_at,
                }
            )
        )

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.args = SimpleNamespace(resume=True)
    runner.states_dir = tmp_path
    runner.pyboy = FakeStateEmulator()
    runner.player = ActionPlayer()
    runner.status = {"rom_sha256": "rom-hash"}

    assert runner._load_latest_state() == post_fallback
    assert runner.pyboy.loaded[-1] == b"newer-post-fallback"


def test_cartridge_ram_is_rom_scoped_manifested_and_validated(tmp_path):
    class RamEmulator:
        def stop(self, save, ram_file):
            assert save is True
            ram_file.write(b"battery-ram")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "a" * 64
    runner.ram_path = tmp_path / f"pokemon-red-{runner.rom_sha256[:16]}.ram"
    runner.pyboy = RamEmulator()
    runner.status = {}

    runner._save_ram_and_stop()

    manifest = json.loads(runner.ram_path.with_suffix(".json").read_text())
    assert runner.ram_path.read_bytes() == b"battery-ram"
    assert manifest["rom_sha256"] == runner.rom_sha256
    assert manifest["sha256"] == file_sha256(runner.ram_path)
    assert runner._validated_ram_path() == runner.ram_path


def test_invalid_scoped_ram_is_quarantined_without_touching_legacy_ram(tmp_path):
    scoped = tmp_path / f"pokemon-red-{'b' * 16}.ram"
    scoped.write_bytes(b"corrupt")
    scoped.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rom_sha256": "b" * 64,
                "sha256": "wrong",
            }
        )
    )
    legacy = tmp_path / "pokemon-red.ram"
    legacy.write_bytes(b"preserve legacy")
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "b" * 64
    runner.ram_path = scoped
    runner.status = {}

    assert runner._validated_ram_path() is None
    assert not scoped.exists()
    assert list((tmp_path / "quarantine").glob("*.invalid"))
    assert legacy.read_bytes() == b"preserve legacy"


def test_invalid_utf8_ram_manifest_is_quarantined(tmp_path):
    scoped = tmp_path / f"pokemon-red-{'c' * 16}.ram"
    scoped.write_bytes(b"ram")
    scoped.with_suffix(".json").write_bytes(b"\xff\xfeinvalid")
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "c" * 64
    runner.ram_path = scoped
    runner.status = {}

    assert runner._validated_ram_path() is None
    assert not scoped.exists()
    assert list((tmp_path / "quarantine").glob("*.invalid"))


def test_ram_manifest_failure_restores_previous_verified_pair(monkeypatch, tmp_path):
    class NewRamEmulator:
        def stop(self, save, ram_file):
            assert save is True
            ram_file.write(b"new-ram")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "d" * 64
    runner.ram_path = tmp_path / f"pokemon-red-{runner.rom_sha256[:16]}.ram"
    runner.ram_path.write_bytes(b"old-ram")
    old_manifest = {
        "schema_version": 1,
        "rom_sha256": runner.rom_sha256,
        "sha256": file_sha256(runner.ram_path),
    }
    runner.ram_path.with_suffix(".json").write_text(json.dumps(old_manifest))
    runner.pyboy = NewRamEmulator()
    runner.status = {}
    real_atomic_write = pokemon_module.atomic_write_json

    def fail_new_manifest(path, value):
        if path == runner.ram_path.with_suffix(".json") and value.get("bytes") == 7:
            raise OSError("disk full")
        real_atomic_write(path, value)

    monkeypatch.setattr(pokemon_module, "atomic_write_json", fail_new_manifest)

    with pytest.raises(OSError, match="disk full"):
        runner._save_ram_and_stop()

    assert runner.ram_path.read_bytes() == b"old-ram"
    restored = json.loads(runner.ram_path.with_suffix(".json").read_text())
    assert restored["sha256"] == old_manifest["sha256"]


def test_ram_pending_failure_leaves_previous_verified_pair(monkeypatch, tmp_path):
    class NewRamEmulator:
        def stop(self, save, ram_file):
            assert save is True
            ram_file.write(b"new-ram")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "4" * 64
    runner.ram_path = tmp_path / f"pokemon-red-{runner.rom_sha256[:16]}.ram"
    runner.ram_path.write_bytes(b"old-ram")
    old_manifest = {
        "schema_version": 1,
        "rom_sha256": runner.rom_sha256,
        "sha256": file_sha256(runner.ram_path),
    }
    runner.ram_path.with_suffix(".json").write_text(json.dumps(old_manifest))
    runner.pyboy = NewRamEmulator()
    runner.status = {}
    real_atomic_write = pokemon_module.atomic_write_json

    def fail_pending(path, value):
        if path == runner._ram_pending_path():
            raise OSError("pending write failed")
        real_atomic_write(path, value)

    monkeypatch.setattr(pokemon_module, "atomic_write_json", fail_pending)

    with pytest.raises(OSError, match="pending write failed"):
        runner._save_ram_and_stop()

    assert runner.ram_path.read_bytes() == b"old-ram"
    assert json.loads(runner.ram_path.with_suffix(".json").read_text()) == old_manifest
    assert not runner._ram_pending_path().exists()
    assert not any(path.exists() for path in runner._ram_backup_paths())
    assert not (tmp_path / f".{runner.ram_path.name}.tmp").exists()


def test_first_ram_manifest_failure_recovers_from_pending_record(monkeypatch, tmp_path):
    class NewRamEmulator:
        def stop(self, save, ram_file):
            assert save is True
            ram_file.write(b"new-ram")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "2" * 64
    runner.ram_path = tmp_path / f"pokemon-red-{runner.rom_sha256[:16]}.ram"
    runner.pyboy = NewRamEmulator()
    runner.status = {}
    real_atomic_write = pokemon_module.atomic_write_json

    def fail_final_manifest(path, value):
        if path == runner.ram_path.with_suffix(".json"):
            raise OSError("disk full")
        real_atomic_write(path, value)

    monkeypatch.setattr(
        pokemon_module,
        "atomic_write_json",
        fail_final_manifest,
    )

    with pytest.raises(OSError, match="disk full"):
        runner._save_ram_and_stop()

    assert runner.ram_path.read_bytes() == b"new-ram"
    assert runner._ram_pending_path().exists()
    monkeypatch.setattr(pokemon_module, "atomic_write_json", real_atomic_write)

    assert runner._validated_ram_path() == runner.ram_path
    assert not runner._ram_pending_path().exists()
    manifest = json.loads(runner.ram_path.with_suffix(".json").read_text())
    assert manifest["sha256"] == file_sha256(runner.ram_path)


def test_legacy_ram_is_migrated_only_when_rom_context_matches(tmp_path):
    legacy = tmp_path / "pokemon-red.ram"
    legacy.write_bytes(b"\x00" * 32768)
    rom_sha = "e" * 64
    (tmp_path / "legacy-ram-provenance.json").write_text(
        json.dumps({"rom_sha256": rom_sha})
    )
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = rom_sha
    runner.ram_path = tmp_path / f"pokemon-red-{rom_sha[:16]}.ram"
    runner.status = {"rom_title": "POKEMON RED"}

    assert runner._validated_ram_path() == runner.ram_path
    assert not legacy.exists()
    assert runner.ram_path.stat().st_size == 32768
    manifest = json.loads(runner.ram_path.with_suffix(".json").read_text())
    assert manifest["migrated_from"] == "pokemon-red.ram"


def test_legacy_ram_is_not_migrated_from_path_only_provenance(tmp_path):
    legacy = tmp_path / "pokemon-red.ram"
    legacy.write_bytes(b"\x00" * 32768)
    rom = tmp_path / "Pokemon Red.gb"
    make_rom(rom)
    (tmp_path / "legacy-ram-provenance.json").write_text(
        json.dumps({"rom_path": str(rom)})
    )
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom = rom.resolve()
    runner.rom_sha256 = file_sha256(rom)
    runner.ram_path = tmp_path / f"pokemon-red-{runner.rom_sha256[:16]}.ram"
    runner.status = {"rom_title": "POKEMON RED"}

    assert runner._validated_ram_path() is None
    assert legacy.exists()
    assert not runner.ram_path.exists()


def test_ram_backup_pair_is_synced_before_installing_replacement(
    monkeypatch,
    tmp_path,
):
    class NewRamEmulator:
        def stop(self, save, ram_file):
            assert save is True
            ram_file.write(b"new-ram")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = "3" * 64
    runner.ram_path = tmp_path / f"pokemon-red-{runner.rom_sha256[:16]}.ram"
    runner.ram_path.write_bytes(b"old-ram")
    runner.ram_path.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rom_sha256": runner.rom_sha256,
                "sha256": file_sha256(runner.ram_path),
            }
        )
    )
    runner.pyboy = NewRamEmulator()
    runner.status = {}
    events = []
    real_replace = pokemon_module.os.replace
    real_fsync_directory = pokemon_module.fsync_directory

    def track_replace(source, destination):
        events.append(("replace", Path(source), Path(destination)))
        real_replace(source, destination)

    def track_fsync_directory(path):
        events.append(("fsync", Path(path)))
        real_fsync_directory(path)

    monkeypatch.setattr(pokemon_module.os, "replace", track_replace)
    monkeypatch.setattr(
        pokemon_module,
        "fsync_directory",
        track_fsync_directory,
    )

    runner._save_ram_and_stop()

    backup_ram, backup_manifest = runner._ram_backup_paths()
    temporary = tmp_path / f".{runner.ram_path.name}.tmp"
    backup_manifest_index = events.index(
        ("replace", runner.ram_path.with_suffix(".json"), backup_manifest)
    )
    install_index = events.index(("replace", temporary, runner.ram_path))
    assert any(
        event == ("fsync", tmp_path)
        for event in events[backup_manifest_index + 1 : install_index]
    )
    assert not backup_ram.exists()
    assert not backup_manifest.exists()


def test_ram_recovery_handles_split_backup_pair(tmp_path):
    rom_sha = "f" * 64
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom_sha256 = rom_sha
    runner.ram_path = tmp_path / f"pokemon-red-{rom_sha[:16]}.ram"
    runner.status = {}
    backup_ram, _ = runner._ram_backup_paths()
    backup_ram.write_bytes(b"verified-old")
    runner.ram_path.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rom_sha256": rom_sha,
                "sha256": file_sha256(backup_ram),
            }
        )
    )

    assert runner._validated_ram_path() == runner.ram_path
    assert runner.ram_path.read_bytes() == b"verified-old"


def test_contradictory_legacy_manifest_is_never_overridden_by_size_heuristic(tmp_path):
    legacy = tmp_path / "pokemon-red.ram"
    legacy.write_bytes(b"\x00" * 32768)
    legacy.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rom_sha256": "other-rom",
                "sha256": file_sha256(legacy),
            }
        )
    )
    rom_sha = "1" * 64
    (tmp_path / "legacy-ram-provenance.json").write_text(
        json.dumps({"rom_sha256": rom_sha})
    )
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom = tmp_path / "Pokemon Red.gb"
    runner.rom_sha256 = rom_sha
    runner.ram_path = tmp_path / f"pokemon-red-{rom_sha[:16]}.ram"
    runner.status = {"rom_title": "POKEMON RED"}

    assert runner._validated_ram_path() is None
    assert legacy.exists()
    assert not runner.ram_path.exists()


def test_immutable_legacy_provenance_survives_rewritten_current_config(tmp_path):
    legacy = tmp_path / "pokemon-red.ram"
    legacy.write_bytes(b"\x00" * 32768)
    (tmp_path / "legacy-ram-provenance.json").write_text(
        json.dumps({"rom_sha256": "original-rom"})
    )
    (tmp_path / "config.json").write_text(
        json.dumps({"rom_sha256": "new-rom", "rom_path": "/new/rom.gb"})
    )
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.rom = tmp_path / "new-rom.gb"
    runner.rom_sha256 = "new-rom"
    runner.ram_path = tmp_path / "pokemon-red-new-rom.ram"
    runner.status = {"rom_title": "POKEMON RED"}

    assert runner._validated_ram_path() is None
    assert legacy.exists()
    assert not runner.ram_path.exists()


def test_released_layout_seeds_legacy_provenance_from_prior_status(tmp_path):
    legacy = tmp_path / "pokemon-red.ram"
    legacy.write_bytes(b"\x00" * 32768)
    rom_sha = "2" * 64
    (tmp_path / "config.json").write_text(
        json.dumps({"rom_path": "/owned/Pokemon Red.gb"})
    )
    (tmp_path / "status.json").write_text(
        json.dumps({"rom_sha256": rom_sha})
    )

    seed_legacy_ram_provenance(tmp_path)

    provenance = json.loads(
        (tmp_path / "legacy-ram-provenance.json").read_text()
    )
    assert provenance["rom_sha256"] == rom_sha
    assert provenance["rom_path"] == "/owned/Pokemon Red.gb"


def test_controller_normalization_failure_does_not_quarantine_valid_state(tmp_path):
    state = tmp_path / "state-20260711-120000-000001.state"
    state.write_bytes(b"valid")
    state.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "created_at": "2026-07-11T12:00:00+00:00",
                "rom_sha256": "rom-hash",
                "sha256": file_sha256(state),
            }
        )
    )

    class StopsDuringNormalization(FakeStateEmulator):
        def tick(self):
            return False

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.args = SimpleNamespace(resume=True)
    runner.runtime_dir = tmp_path
    runner.states_dir = tmp_path
    runner.pyboy = StopsDuringNormalization()
    runner.player = ActionPlayer()
    runner.status = {"rom_sha256": "rom-hash"}

    with pytest.raises(RuntimeError, match="normalizing controller"):
        runner._load_latest_state()

    assert state.exists()
    assert state.with_suffix(".json").exists()


def test_stale_ai_decision_is_discarded_after_manual_takeover():
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.brain_results = queue.Queue()
    runner.brain_results.put(
        {
            "decision_id": 1,
            "generation": 0,
            "decision": {
                "phase": "overworld",
                "observation": "walk north",
                "objective": "leave town",
                "reason": "path",
                "buttons": ["up"],
                "checkpoint": False,
            },
        }
    )
    runner.pending_decision_id = 1
    runner.decision_pending = True
    runner.control_generation = 1
    runner.control_mode = "manual"
    runner.emulator_pause_requested = False
    runner.last_decision_finished = 0
    runner.status = {}
    runner.history = []
    runner.total_decisions = 0

    runner._apply_brain_result()

    assert runner.decision_pending is False
    assert runner.history == []
    assert runner.status["last_discarded_decision"]["decision_id"] == 1
    assert runner.status["brain_status"] == "manual"


def test_recording_clock_emits_wall_clock_frame_count(monkeypatch):
    class FakeRecorder:
        fps = 30
        writes = 0

        def write(self, image):
            del image
            self.writes += 1
            return True

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.recorder = FakeRecorder()
    runner.next_record_at = 0
    runner.status = {}
    now = [0.0]
    monkeypatch.setattr(pokemon_module.time, "monotonic", lambda: now[0])

    for frame in range(360):
        now[0] = frame / 60
        runner._record_due_frames(object())

    assert 179 <= runner.recorder.writes <= 181
    assert runner.status.get("recording_frames_skipped", 0) == 0


def test_viewer_requires_same_origin_authenticated_controls(tmp_path):
    controls = queue.Queue()
    server = ViewerServer(tmp_path, 0, controls)
    server.start()
    base_url = f"http://127.0.0.1:{server.port}"
    try:
        with pytest.raises(urllib.error.HTTPError) as unauthenticated:
            urllib.request.urlopen(f"{base_url}/api/status")
        assert unauthenticated.value.code == 403

        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )
        with opener.open(f"{base_url}/") as response:
            assert response.status == 200
            assert response.headers["X-Frame-Options"] == "DENY"

        with opener.open(f"{base_url}/api/status") as response:
            assert json.load(response)["running"] is False

        hostile = urllib.request.Request(
            f"{base_url}/api/control",
            data=b'{"action":"pause"}',
            headers={
                "Content-Type": "application/json",
                "Origin": "https://attacker.example",
            },
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as cross_origin:
            opener.open(hostile)
        assert cross_origin.value.code == 403
        assert controls.empty()

        authorized = urllib.request.Request(
            f"{base_url}/api/control",
            data=b'{"action":"pause"}',
            headers={
                "Content-Type": "application/json",
                "Origin": base_url,
            },
            method="POST",
        )
        with opener.open(authorized) as response:
            assert json.load(response)["status"] == "success"
        assert controls.get_nowait()["action"] == "pause"
    finally:
        server.stop()


def test_brain_worker_reports_base_sdk_exception_and_recovers(monkeypatch, tmp_path):
    instances = []

    class FakeBrain:
        backend = "sdk"

        def __init__(self, *args):
            del args
            self.recoveries = 0
            instances.append(self)

        def start(self):
            return None

        def decide(self, **kwargs):
            del kwargs
            raise Exception("session transport failed")

        def recover(self):
            self.recoveries += 1

        def close(self):
            return None

    monkeypatch.setattr(pokemon_module, "CopilotBrain", FakeBrain)
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.args = SimpleNamespace(model="gpt-5.6-sol", decision_timeout=30)
    runner.runtime_dir = tmp_path
    runner.stop_event = pokemon_module.threading.Event()
    runner.brain_ready = pokemon_module.threading.Event()
    runner.brain_available = pokemon_module.threading.Event()
    runner.brain_requests = queue.Queue()
    runner.brain_results = queue.Queue()
    runner.status = {}
    runner.brain_requests.put(
        {
            "screenshot": str(tmp_path / "frame.png"),
            "game_state": {},
            "collision_map": None,
            "history": [],
            "decision_id": 7,
            "generation": 2,
        }
    )
    runner.brain_requests.put(None)

    runner._brain_loop()

    result = runner.brain_results.get_nowait()
    assert result["decision_id"] == 7
    assert result["generation"] == 2
    assert "session transport failed" in result["error"]
    assert runner.status["brain_failure_count"] == 1
    assert instances[0].recoveries == 1
    assert runner.brain_available.is_set()


def test_copilot_close_force_stops_hung_client(monkeypatch, tmp_path):
    class FakeSession:
        async def disconnect(self):
            return None

    class HungClient:
        forced = False

        async def stop(self):
            await asyncio.sleep(60)

        async def force_stop(self):
            self.forced = True

    monkeypatch.setattr(pokemon_module, "COPILOT_STOP_TIMEOUT_SECONDS", 0.01)
    brain = CopilotBrain.__new__(CopilotBrain)
    brain.runtime_dir = tmp_path
    brain.loop = asyncio.new_event_loop()
    brain.session = FakeSession()
    brain.client = HungClient()

    client = brain.client
    brain.close()

    assert client.forced is True
    assert brain.loop is None


def test_copilot_close_force_stops_after_disconnect_error(monkeypatch):
    class BrokenSession:
        async def disconnect(self):
            raise RuntimeError("transport gone")

    class ClientSpy:
        stopped = False
        forced = False

        async def stop(self):
            self.stopped = True

        async def force_stop(self):
            self.forced = True

    monkeypatch.setattr(pokemon_module, "COPILOT_STOP_TIMEOUT_SECONDS", 0.05)
    brain = CopilotBrain.__new__(CopilotBrain)
    brain.loop = asyncio.new_event_loop()
    brain.current_task = None
    brain.session = BrokenSession()
    brain.client = ClientSpy()

    client = brain.client
    brain.close()

    assert client.stopped is True
    assert client.forced is True
    assert brain.loop is None


def test_copilot_operation_can_be_cancelled_from_runner_thread():
    brain = CopilotBrain.__new__(CopilotBrain)
    brain.loop = None
    brain.current_task = None
    started = threading.Event()
    cancelled = threading.Event()

    async def hanging_operation():
        started.set()
        await asyncio.sleep(60)

    def worker():
        brain.loop = asyncio.new_event_loop()
        try:
            brain._run_operation(hanging_operation(), timeout=60)
        except asyncio.CancelledError:
            cancelled.set()
        finally:
            brain.loop.close()
            brain.loop = None

    thread = threading.Thread(target=worker)
    thread.start()
    assert started.wait(timeout=1)
    brain.cancel()
    thread.join(timeout=1)

    assert cancelled.is_set()
    assert not thread.is_alive()


def test_runner_stop_owns_brain_thread_until_exit():
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.stop_event = threading.Event()
    runner.brain_requests = queue.Queue()
    runner.status = {}

    class BrainSpy:
        cancelled = False

        def cancel(self):
            self.cancelled = True

    runner.brain = BrainSpy()
    runner.brain_thread = threading.Thread(target=runner.brain_requests.get)
    runner.brain_thread.start()

    runner._stop_brain_worker()

    assert runner.brain.cancelled is True
    assert runner.stop_event.is_set()
    assert not runner.brain_thread.is_alive()


def test_pending_ai_decision_stays_emulator_paused_on_resume():
    class PlayerSpy:
        def release(self, pyboy):
            del pyboy

    class EmulatorSpy:
        events = []

        def send_input(self, event):
            self.events.append(event)

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.control_mode = "paused"
    runner.resume_mode = "ai"
    runner.decision_pending = True
    runner.control_generation = 0
    runner.paused = True
    runner.emulator_pause_requested = True
    runner.player = PlayerSpy()
    runner.pyboy = EmulatorSpy()
    runner.status = {}
    runner.last_decision_finished = 0

    runner._set_control_mode("ai")

    assert runner.control_mode == "ai"
    assert runner.emulator_pause_requested is True
    assert runner.pyboy.events == []


def test_shutdown_failures_do_not_skip_remaining_cleanup(tmp_path):
    calls = []

    class PlayerFailure:
        def release(self, pyboy):
            del pyboy
            raise OSError("controller failed")

    class RecorderFailure:
        frames_written = 0
        started_at = None

        def finish(self):
            raise OSError("recorder failed")

    class ViewerSpy:
        def stop(self):
            calls.append("viewer")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.stop_event = threading.Event()
    runner.player = PlayerFailure()
    runner.pyboy = object()
    runner.recorder = RecorderFailure()
    runner.viewer = ViewerSpy()
    runner.status = {"lifecycle": "ready"}
    runner.runtime_dir = tmp_path
    runner._save_checkpoint = lambda *args, **kwargs: calls.append("checkpoint")
    runner._stop_brain_worker = lambda: calls.append("brain")
    runner._save_ram_and_stop = lambda: calls.append("ram")
    runner._write_status = lambda: calls.append("status")

    runner._shutdown_runtime("test shutdown")

    assert calls == ["checkpoint", "brain", "viewer", "ram", "status"]
    assert runner.status["lifecycle"] == "failed"
    assert "controller failed" in runner.status["last_error"]
    assert "recorder failed" in runner.status["last_error"]


def test_recorder_drops_frame_instead_of_blocking_full_queue():
    class ProcessSpy:
        stdin = object()

        def poll(self):
            return None

    class Image:
        def convert(self, mode):
            assert mode == "RGB"
            return self

        def tobytes(self):
            return b"frame"

    recorder = ClipRecorder.__new__(ClipRecorder)
    recorder.process = ProcessSpy()
    recorder.writer_error = None
    recorder.frame_queue = queue.Queue(maxsize=1)
    recorder.frame_queue.put_nowait(b"already queued")
    recorder.frames_written = 0
    recorder.frames_dropped = 0

    assert recorder.write(Image()) is False
    assert recorder.frames_written == 0
    assert recorder.frames_dropped == 1


def test_stalled_recorder_writer_is_unblocked_by_process_termination(monkeypatch):
    entered_write = threading.Event()
    terminated = threading.Event()

    class BlockingStdin:
        closed = False

        def write(self, payload):
            del payload
            entered_write.set()
            terminated.wait()
            raise BrokenPipeError("terminated")

    class StalledProcess:
        stdin = BlockingStdin()
        returncode = None

        def terminate(self):
            self.returncode = -15
            terminated.set()

        def kill(self):
            self.returncode = -9
            terminated.set()

        def wait(self, timeout):
            del timeout
            if self.returncode is None:
                raise pokemon_module.subprocess.TimeoutExpired("ffmpeg", 0.01)
            return self.returncode

    monkeypatch.setattr(pokemon_module, "RECORDER_WRITER_TIMEOUT_SECONDS", 0.01)
    recorder = ClipRecorder.__new__(ClipRecorder)
    recorder.process = StalledProcess()
    recorder.frame_queue = queue.Queue(maxsize=2)
    recorder.frame_queue.put_nowait(b"frame")
    recorder.writer_error = None
    recorder.frames_dropped = 0
    recorder.writer_thread = threading.Thread(target=recorder._writer_loop)
    recorder.writer_thread.start()
    assert entered_write.wait(timeout=1)

    recorder._stop_writer(recorder.process)

    assert terminated.is_set()
    assert not recorder.writer_thread.is_alive()


def test_copilot_runtime_preparation_is_bounded(monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(pokemon_module.subprocess, "run", fake_run)

    ensure_copilot_runtime(timeout_seconds=42)

    assert calls[0][0][-2:] == ["copilot", "download-runtime"]
    assert calls[0][1]["timeout"] == 42


def test_screenshot_retention_never_deletes_inflight_frame(tmp_path):
    runner = PokemonRunner.__new__(PokemonRunner)
    runner.screens_dir = tmp_path
    for index in range(31):
        screenshot = tmp_path / f"decision-aaaaaaaaaaaa-{index:08d}.png"
        screenshot.write_bytes(b"old")
        os.utime(screenshot, ns=(index + 1, index + 1))
    current = tmp_path / "decision-bbbbbbbbbbbb-00000001.png"
    current.write_bytes(b"current")
    unknown = tmp_path / "decision-user-keeps-this.png"
    unknown.write_bytes(b"user")

    runner._prune_decision_screenshots(current, keep=30)

    remaining = [
        path
        for path in tmp_path.glob("decision-*.png")
        if path != unknown
    ]
    assert current in remaining
    assert len(remaining) == 30
    assert not (tmp_path / "decision-aaaaaaaaaaaa-00000000.png").exists()
    assert unknown.read_bytes() == b"user"


def test_runtime_parser_and_command_support_supervision(tmp_path):
    args = build_parser().parse_args(
        [
            "supervise",
            "--rom",
            str(tmp_path / "Pokemon Red.gb"),
            "--runtime-dir",
            str(tmp_path),
            "--port",
            "9999",
        ]
    )
    args.instance_id = "test-instance"

    command = runtime_command(args, open_viewer=True)

    assert args.command == "supervise"
    assert command[2] == "openrappter.agents.pokemon_agent"
    assert command[3] == "run"
    assert "--supervised" in command
    assert "--max-clips" in command
    assert "--max-storage-gb" in command


def test_supervisor_restarts_failed_child_then_stops_cleanly(monkeypatch, tmp_path):
    exit_codes = iter([1, 0])
    children = []

    class FakeChild:
        def __init__(self, command, **kwargs):
            del kwargs
            self.command = command
            self.pid = 1000 + len(children)
            self.returncode = None
            children.append(self)

        def wait(self, timeout=None):
            del timeout
            if self.returncode is None:
                self.returncode = next(exit_codes)
            return self.returncode

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = 0

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr(pokemon_module.subprocess, "Popen", FakeChild)
    monkeypatch.setattr(
        pokemon_module,
        "wait_supervisor_backoff",
        lambda *args: True,
    )
    monkeypatch.setattr(pokemon_module.signal, "signal", lambda *args: None)
    args = build_parser().parse_args(
        [
            "supervise",
            "--rom",
            str(tmp_path / "Pokemon Red.gb"),
            "--runtime-dir",
            str(tmp_path),
            "--instance-id",
            "supervisor-test",
        ]
    )

    assert supervisor_main(args) == 0
    assert len(children) == 2
    assert json.loads((tmp_path / "desired.json").read_text())["running"] is False
    assert json.loads((tmp_path / "supervisor.json").read_text())["running"] is False


def test_retention_removes_only_old_generated_artifacts(tmp_path):
    clips_dir = tmp_path / "clips"
    states_dir = tmp_path / "states"
    screens_dir = tmp_path / "screens"
    clips_dir.mkdir()
    states_dir.mkdir()
    screens_dir.mkdir()
    for index in range(4):
        clip = clips_dir / f"clip-{index:04d}-20260711-120000.mp4"
        clip.write_bytes(b"clip")
        clip.with_suffix(".json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "name": clip.name,
                    "sha256": "clip-hash",
                    "reason": "routine",
                }
            )
        )
        state = states_dir / f"state-20260711-12000{index}-000000.state"
        state.write_bytes(b"state")
        state.with_suffix(".json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "sha256": file_sha256(state),
                    "rom_sha256": "rom-hash",
                    "reason": "routine",
                }
            )
        )
        os.utime(clip, ns=(index + 1, index + 1))
        os.utime(state, ns=(index + 1, index + 1))
    unknown = clips_dir / "user-note.txt"
    unknown.write_text("preserve me")
    unknown_clip = clips_dir / "clip-vacation.mp4"
    unknown_clip.write_bytes(b"user video")
    unknown_state = states_dir / "state-backup.state"
    unknown_state.write_bytes(b"user state")
    orphaned_clip = clips_dir / "clip-9999-20260711-115959.mp4"
    orphaned_clip.write_bytes(b"crash-finalized video")
    os.utime(orphaned_clip, ns=(0, 0))

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.states_dir = states_dir
    runner.screens_dir = screens_dir
    runner.recorder = SimpleNamespace(clips_dir=clips_dir, partial_path=None)
    runner.max_clips = 2
    runner.max_states = 2
    runner.max_storage_bytes = 1024**3
    runner.min_free_bytes = 0
    runner.status = {"rom_sha256": "rom-hash"}

    runner._enforce_retention()

    assert len(
        [
            path
            for path in clips_dir.glob("clip-*.mp4")
            if path.with_suffix(".json").exists()
        ]
    ) == 2
    assert len(
        [path for path in states_dir.glob("state-*.state") if "20260711" in path.name]
    ) == 2
    assert unknown.read_text() == "preserve me"
    assert unknown_clip.read_bytes() == b"user video"
    assert unknown_state.read_bytes() == b"user state"
    assert not orphaned_clip.exists()
    assert runner.status["retained_clips"] == 2
    assert runner.status["retained_states"] == 2


def test_retention_protects_loaded_and_newest_checkpoints(tmp_path):
    clips_dir = tmp_path / "clips"
    states_dir = tmp_path / "states"
    screens_dir = tmp_path / "screens"
    clips_dir.mkdir()
    states_dir.mkdir()
    screens_dir.mkdir()
    states = []
    for index in range(3):
        state = states_dir / f"state-20260711-12000{index}-000000.state"
        state.write_bytes(f"state-{index}".encode())
        state.with_suffix(".json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "sha256": file_sha256(state),
                    "rom_sha256": "rom-hash",
                    "reason": "routine",
                }
            )
        )
        os.utime(state, ns=(index + 1, index + 1))
        states.append(state)

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.states_dir = states_dir
    runner.screens_dir = screens_dir
    runner.recorder = SimpleNamespace(clips_dir=clips_dir, partial_path=None)
    runner.max_clips = 2
    runner.max_states = 2
    runner.max_storage_bytes = 1024**3
    runner.min_free_bytes = 0
    runner.status = {
        "rom_sha256": "rom-hash",
        "loaded_state": str(states[0]),
    }

    runner._enforce_retention()

    assert states[0].exists()
    assert not states[1].exists()
    assert states[2].exists()


def test_supervisor_escalates_hung_child_on_stop():
    stop_requested = threading.Event()
    stop_requested.set()

    class HungChild:
        terminated = False
        killed = False

        def poll(self):
            if self.killed:
                return -9
            if self.terminated:
                return 0
            return None

        def wait(self, timeout):
            if not self.terminated and not self.killed:
                raise pokemon_module.subprocess.TimeoutExpired("child", timeout)
            return -9 if self.killed else 0

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

    child = HungChild()

    assert wait_for_supervised_child(child, stop_requested) == (0, False)
    assert child.terminated is True


def test_stop_control_sets_supervisor_owned_desired_state(tmp_path):
    (tmp_path / "desired.json").write_text(json.dumps({"running": True}))

    pokemon_module.append_control(tmp_path, {"action": "stop"})

    assert json.loads((tmp_path / "desired.json").read_text())["running"] is False
    assert json.loads((tmp_path / "control.jsonl").read_text())["action"] == "stop"


def test_agent_can_stop_supervisor_between_child_retries(tmp_path):
    (tmp_path / "desired.json").write_text(json.dumps({"running": True}))
    (tmp_path / "supervisor.json").write_text(
        json.dumps({"running": True, "pid": os.getpid()})
    )

    result = json.loads(
        PokemonAgent().perform(action="stop", runtime_dir=str(tmp_path))
    )

    assert result["status"] == "success"
    assert json.loads((tmp_path / "desired.json").read_text())["running"] is False


def test_failed_child_termination_requests_restart(tmp_path):
    stop_requested = threading.Event()
    (tmp_path / "desired.json").write_text(json.dumps({"running": True}))
    (tmp_path / "status.json").write_text(
        json.dumps({"lifecycle": "failed", "pid": 4321})
    )

    class FailedChild:
        pid = 4321
        terminated = False
        returncode = None

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            if self.returncode is None:
                raise pokemon_module.subprocess.TimeoutExpired("child", timeout)
            return self.returncode

        def terminate(self):
            self.terminated = True
            self.returncode = 1

        def kill(self):
            self.returncode = -9

    child = FailedChild()

    assert wait_for_supervised_child(
        child,
        stop_requested,
        tmp_path,
    ) == (1, True)
    assert child.terminated is True
    assert not stop_requested.is_set()


def test_previous_child_status_does_not_kill_replacement(tmp_path):
    stop_requested = threading.Event()
    (tmp_path / "desired.json").write_text(json.dumps({"running": True}))
    (tmp_path / "status.json").write_text(
        json.dumps({"lifecycle": "failed", "pid": 1111})
    )

    class ReplacementChild:
        pid = 2222
        waits = 0
        terminated = False

        def wait(self, timeout):
            del timeout
            self.waits += 1
            if self.waits == 1:
                raise pokemon_module.subprocess.TimeoutExpired("child", 1)
            return 0

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    child = ReplacementChild()

    assert wait_for_supervised_child(
        child,
        stop_requested,
        tmp_path,
    ) == (0, False)
    assert child.terminated is False


def test_supervisor_backoff_observes_desired_stop(tmp_path):
    desired_path = tmp_path / "desired.json"
    desired_path.write_text(json.dumps({"running": True}))

    class StopDuringWait:
        stopped = False

        def wait(self, timeout):
            del timeout
            desired_path.write_text(json.dumps({"running": False}))
            return False

        def set(self):
            self.stopped = True

    stop = StopDuringWait()

    assert wait_supervisor_backoff(stop, tmp_path, 30) is False
    assert stop.stopped is True


def test_failure_lifecycle_returns_nonzero_to_supervisor(monkeypatch, tmp_path):
    class FailedRunner:
        def __init__(self, args):
            del args
            self.status = {"lifecycle": "failed"}
            self.stop_event = threading.Event()
            self.brain_ready = threading.Event()
            self.brain = None

        def run(self):
            return None

    monkeypatch.setattr(pokemon_module, "PokemonRunner", FailedRunner)
    monkeypatch.setattr(pokemon_module.signal, "signal", lambda *args: None)

    exit_code = runner_main(
        [
            "run",
            "--rom",
            str(tmp_path / "Pokemon Red.gb"),
            "--runtime-dir",
            str(tmp_path),
            "--instance-id",
            "failed-runner",
        ]
    )

    assert exit_code == 1


def test_active_recording_suspends_before_exceeding_storage_budget(tmp_path):
    clips_dir = tmp_path / "clips"
    states_dir = tmp_path / "states"
    screens_dir = tmp_path / "screens"
    clips_dir.mkdir()
    states_dir.mkdir()
    screens_dir.mkdir()
    partial = clips_dir / ".clip-0001-20260711-120000.mp4.partial.mp4"
    partial.write_bytes(b"active recording")

    runner = PokemonRunner.__new__(PokemonRunner)
    runner.runtime_dir = tmp_path
    runner.states_dir = states_dir
    runner.screens_dir = screens_dir
    runner.recorder = SimpleNamespace(clips_dir=clips_dir, partial_path=partial)
    runner.max_clips = 2
    runner.max_states = 2
    runner.max_storage_bytes = 1
    runner.min_free_bytes = 0
    runner.status = {"rom_sha256": "rom-hash"}

    runner._enforce_retention()

    assert partial.exists()
    assert runner.status["recording_suspended"] is True


def test_clip_indices_continue_beyond_four_digits(tmp_path):
    clips_dir = tmp_path / "clips"
    clips_dir.mkdir()
    clip = clips_dir / "clip-10000-20260711-120000.mp4"
    clip.write_bytes(b"video")
    clip.with_suffix(".json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "name": clip.name,
                "sha256": "hash",
            }
        )
    )
    recorder = ClipRecorder.__new__(ClipRecorder)
    recorder.clips_dir = clips_dir

    assert recorder._next_index() == 10001
