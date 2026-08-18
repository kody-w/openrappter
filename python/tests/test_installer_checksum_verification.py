"""The installer's checksum check has to actually check something.

``docs/install.sh`` is what ``README.md`` tells people to pipe into bash. It
downloads a ``gum`` release tarball and verifies it against the project's
published ``checksums.txt``.

The verification used ``--ignore-missing``, which is necessary — the checksums
file lists every platform and only one asset is downloaded — but GNU
``sha256sum`` exits 0 when that leaves nothing to verify at all. An asset
absent from the list therefore read as a pass, so anyone able to serve the
release could omit the line rather than forge a hash. macOS ``shasum`` exits 1
in the same situation, so whether the installer was safe depended on which tool
happened to be installed, and ``sha256sum`` is tried first.

These tests run the real function out of the real installer.
"""

import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

INSTALLER = Path(__file__).resolve().parents[2] / "docs" / "install.sh"

GUM_ASSET = "gum_0.17.0_Linux_x86_64.tar.gz"
OTHER_ASSET = "gum_0.17.0_Darwin_arm64.tar.gz"


def run_verify(tmp_path, checksums_body, files, target=GUM_ASSET):
    """Call verify_sha256sum_file from the shipped installer."""
    for name, content in files.items():
        (tmp_path / name).write_bytes(content)
    (tmp_path / "checksums.txt").write_text(checksums_body, encoding="utf-8")
    script = textwrap.dedent(f"""
        set -u
        # Source only the helper, not the installer's side effects.
        eval "$(sed -n '/^verify_sha256sum_file() {{/,/^}}/p' {INSTALLER!s})"
        cd {tmp_path!s}
        verify_sha256sum_file checksums.txt {target}
    """)
    return subprocess.run(["bash", "-c", script], capture_output=True).returncode


def sha256_of(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


def test_a_matching_asset_verifies(tmp_path):
    payload = b"pretend tarball\n"
    body = f"{sha256_of(payload)}  {GUM_ASSET}\n"
    assert run_verify(tmp_path, body, {GUM_ASSET: payload}) == 0


def test_a_tampered_asset_is_rejected(tmp_path):
    body = f"{'0' * 64}  {GUM_ASSET}\n"
    assert run_verify(tmp_path, body, {GUM_ASSET: b"pretend tarball\n"}) != 0


def test_an_asset_absent_from_the_checksums_is_not_a_pass(tmp_path):
    # The defect. Every other platform is listed; the one actually downloaded
    # is not. With --ignore-missing alone, GNU sha256sum verifies nothing and
    # reports success.
    payload = b"unverified content\n"
    body = f"{sha256_of(b'something else')}  {OTHER_ASSET}\n"
    assert run_verify(tmp_path, body, {GUM_ASSET: payload}) != 0


def test_other_platforms_being_listed_does_not_break_a_real_check(tmp_path):
    # Anti-vacuity: the rule must not reject the normal case, where the
    # checksums file legitimately lists assets that were never downloaded.
    payload = b"pretend tarball\n"
    body = (
        f"{sha256_of(b'other')}  {OTHER_ASSET}\n"
        f"{sha256_of(payload)}  {GUM_ASSET}\n"
    )
    assert run_verify(tmp_path, body, {GUM_ASSET: payload}) == 0


def test_binary_mode_marker_is_accepted(tmp_path):
    # Some tools write `*name` to mean binary mode.
    payload = b"pretend tarball\n"
    body = f"{sha256_of(payload)} *{GUM_ASSET}\n"
    assert run_verify(tmp_path, body, {GUM_ASSET: payload}) == 0


@pytest.mark.skipif(shutil.which("sha256sum") is None,
                    reason="GNU sha256sum is the tool with the permissive exit code")
def test_gnu_sha256sum_really_does_exit_zero_on_nothing(tmp_path):
    # Pins the premise rather than asserting it in prose: if a future coreutils
    # tightened this, the guard above would be belt-and-braces rather than
    # load-bearing, and this test says so by failing.
    (tmp_path / "checksums.txt").write_text(f"{'0' * 64}  absent.bin\n", encoding="utf-8")
    proc = subprocess.run(
        ["sha256sum", "--ignore-missing", "-c", "checksums.txt"],
        cwd=tmp_path, capture_output=True,
    )
    assert proc.returncode == 0, (
        "GNU sha256sum no longer passes when it verified nothing; "
        "the installer guard can be simplified"
    )
