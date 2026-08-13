import os
import json
import subprocess
from pathlib import Path

import pytest

from openrappter.flight_recorder import (
    FlightRecorder,
    _process_is_alive,
)


def _read_acl(target: Path):
    output = subprocess.check_output(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            (
                "$acl = Get-Acl -LiteralPath $env:HF_TARGET; "
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
    database = tmp_path / "flight.db"
    recorder = FlightRecorder(enabled=True, database_path=database)
    try:
        recorder.initialize()
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
    database = tmp_path / "flight.db"
    first = FlightRecorder(enabled=True, database_path=database)
    first.initialize()
    first.close()
    Path(f"{database}-wal").unlink(missing_ok=True)
    Path(f"{database}-shm").unlink(missing_ok=True)

    second = FlightRecorder(enabled=True, database_path=database)
    try:
        second.initialize()
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
