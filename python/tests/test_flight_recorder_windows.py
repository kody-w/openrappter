import os
import json
import subprocess
import sys
from pathlib import Path

import pytest

from openrappter.flight_recorder import (
    FlightRecorder,
    _harden_private_path,
    _process_is_alive,
)

def test_windows_identity_probe_has_closed_stdin_and_a_deadline(monkeypatch):
    from openrappter import flight_recorder
    observed = {}

    def probe(command, **kwargs):
        observed.update(kwargs)
        assert command[0] == "powershell.exe"
        return "123456\n"

    with monkeypatch.context() as patch:
        patch.setattr(sys, "platform", "win32")
        patch.setattr(os, "name", "nt")
        patch.setattr(subprocess, "check_output", probe)
        assert flight_recorder._read_process_incarnation(123) == "win:123456"
    assert observed["stdin"] == subprocess.DEVNULL
    assert observed["timeout"] == 10


def test_identity_probe_timeout_is_unknown_not_a_dead_owner(monkeypatch):
    from openrappter import flight_recorder

    def timed_out(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    with monkeypatch.context() as patch:
        patch.setattr(sys, "platform", "win32")
        patch.setattr(os, "name", "nt")
        patch.setattr(subprocess, "check_output", timed_out)
        patch.setattr(flight_recorder, "_process_is_alive", lambda _pid: True)
        assert flight_recorder._read_process_incarnation(123) is None
        assert flight_recorder._process_matches_incarnation(123, "previous") is True


def _read_acl(target: Path):
    output = subprocess.check_output(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            (
                "$item = if ([System.IO.Directory]::Exists($env:HF_TARGET)) "
                "{ New-Object System.IO.DirectoryInfo($env:HF_TARGET) } "
                "else { New-Object System.IO.FileInfo($env:HF_TARGET) }; "
                "$acl = $item.GetAccessControl(); "
                "[pscustomobject]@{ Protected = $acl.AreAccessRulesProtected; "
                "Owner = $acl.Owner; "
                "Access = @($acl.Access | ForEach-Object { "
                "[pscustomobject]@{ Identity = $_.IdentityReference.Value; "
                "Rights = $_.FileSystemRights.ToString(); "
                "Inherited = $_.IsInherited } }) } | "
                "ConvertTo-Json -Depth 4 -Compress"
            ),
        ],
        text=True,
        env={**os.environ, "HF_TARGET": str(target)},
    )
    return json.loads(output)


@pytest.mark.skipif(os.name != "nt", reason="Windows-only ACL coverage")
def test_windows_private_storage_initializes(tmp_path: Path):
    directory = tmp_path / "private"
    directory.mkdir()
    _harden_private_path(directory, directory=True)
    database = directory / "flight.db"
    recorder = FlightRecorder(enabled=True, database_path=database)
    try:
        recorder.initialize()
        assert recorder.health()["initialized"] is True, (
            recorder.health().get("lastError")
        )
        recorder.run_trace({"traceId": "windows-storage"}, lambda: None)
        assert database.exists()
        assert Path(f"{database}.identity-key").exists()
        assert Path(f"{database}.owners").exists()
        assert recorder.health()["initialized"] is True
        assert _process_is_alive(os.getpid()) is True
        assert _process_is_alive(4) is True
        assert _process_is_alive(2_147_483_647) is False
        recorder.run_trace(
            {"traceId": "windows-active"},
            lambda: recorder.record(
                {"kind": "inside", "source": "test"}
            ),
        )
        assert recorder.clear() is True
        for target in (
            database,
            Path(f"{database}-wal"),
            Path(f"{database}-shm"),
            Path(f"{database}.identity-key"),
        ):
            acl = _read_acl(target)
            assert acl["Protected"] is True
            assert "\\" in acl["Owner"]
            assert len(acl["Access"]) == 1
            assert "\\" in acl["Access"][0]["Identity"]
            assert "FullControl" in acl["Access"][0]["Rights"]
            assert acl["Access"][0]["Inherited"] is False
    finally:
        recorder.close()


@pytest.mark.skipif(os.name != "nt", reason="Windows-only ACL coverage")
def test_windows_reopen_materializes_private_sidecars(tmp_path: Path):
    directory = tmp_path / "private-reopen"
    directory.mkdir()
    _harden_private_path(directory, directory=True)
    database = directory / "flight.db"
    first = FlightRecorder(enabled=True, database_path=database)
    first.initialize()
    assert first.health()["initialized"] is True, (
        first.health().get("lastError")
    )
    first.close()
    Path(f"{database}-wal").unlink(missing_ok=True)
    Path(f"{database}-shm").unlink(missing_ok=True)

    second = FlightRecorder(enabled=True, database_path=database)
    try:
        second.initialize()
        assert second.health()["initialized"] is True, (
            second.health().get("lastError")
        )
        for target in (
            Path(f"{database}-wal"),
            Path(f"{database}-shm"),
        ):
            assert target.exists()
            acl = _read_acl(target)
            assert acl["Protected"] is True
            assert len(acl["Access"]) == 1
            assert "FullControl" in acl["Access"][0]["Rights"]
            assert acl["Access"][0]["Inherited"] is False
    finally:
        second.close()
