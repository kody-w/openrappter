"""R9 — the credential scan — is a check that had never once run.

It looks for a `rapp-keyring` binary and returned SKIP when it found none, so on
every developer machine without the broker the claim "the repository contains no
credential of its own" was reported without ever being tested. conformance.py
exits 0 on a skip, so it read as green.

Installing the broker and running it revealed the more serious half. R9 parsed
the scanner's prose output and counted a line as a finding if it contained an
em dash. Two consequences:

  - the remediation advice rapp-keyring prints on a hit ("rotate the credential
    at its source — assume it already leaked") was itself counted, so one leaked
    credential was reported as two files; and

  - a broker that failed outright printed nothing, so no line matched, the count
    stayed at zero, and R9 announced "1079 tracked files scanned, no plaintext
    credential" over files it had never opened.

The second one is why these tests exist. A scanner that cannot run must never be
indistinguishable from a scanner that ran and found nothing — that is strictly
worse than the SKIP it replaced, because a skip is visible and this is not.

The stub-broker tests below pin R9's handling of each outcome. Because a stub
that agrees with our own assumptions proves nothing about the real tool, the
tests at the bottom pin the contract we are relying on against a real installed
rapp-keyring.
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# Split so this file does not itself trip the scanner it is testing: the
# pattern is AKIA followed by sixteen upper-alphanumerics, and no single
# literal here provides that.
FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"


def _load_conformance():
    spec = importlib.util.spec_from_file_location(
        "openrappter_conformance_under_test", ROOT / "conformance.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


conformance = _load_conformance()


def _git_repo(tmp_path, files):
    tmp_path.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        (tmp_path / name).write_text(body)
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    return tmp_path


def _stub_broker(tmp_path, script):
    """A fake rapp-keyring, first on PATH."""
    bindir = tmp_path / "stubbin"
    bindir.mkdir(exist_ok=True)
    broker = bindir / "rapp-keyring"
    broker.write_text("#!/usr/bin/env bash\n" + script)
    broker.chmod(0o755)
    return bindir


def _use(monkeypatch, repo, bindir=None, home=None):
    monkeypatch.setattr(conformance, "ROOT", str(repo))
    if bindir is not None:
        monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    if home is not None:
        # R9 falls back to ~/.local/bin, so a test for "no broker" has to move
        # HOME as well or it finds the one this machine really has installed.
        monkeypatch.setenv("HOME", str(home))


# ── the regression this file exists for ──────────────────────────────────────

def test_a_broker_that_fails_is_never_reported_as_a_clean_scan(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"a.txt": "hello\n"})
    bindir = _stub_broker(tmp_path, 'echo "fatal: vault unreadable" >&2\nexit 3\n')
    _use(monkeypatch, repo, bindir)

    ok, detail = conformance.r9_no_secrets()

    assert ok is not True, (
        "a broker that exited 3 without scanning anything was reported as proof "
        "that the repository holds no credentials: %r" % detail)
    assert "did not complete" in detail
    # It must not read as "we found a credential" either — the honest statement
    # is that there is no verdict at all.
    assert "no verdict" in detail or "absence of a verdict" in detail


def test_a_broker_emitting_unparseable_output_is_not_a_clean_scan(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"a.txt": "hello\n"})
    bindir = _stub_broker(tmp_path, 'echo "not json at all"\nexit 0\n')
    _use(monkeypatch, repo, bindir)

    ok, detail = conformance.r9_no_secrets()

    assert ok is not True, detail
    assert "did not complete" in detail


def test_a_missing_broker_skips_rather_than_passing(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"a.txt": "hello\n"})
    empty = tmp_path / "emptybin"
    empty.mkdir()
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(conformance, "ROOT", str(repo))
    monkeypatch.setenv("PATH", str(empty))
    monkeypatch.setenv("HOME", str(fake_home))

    ok, detail = conformance.r9_no_secrets()

    assert ok is None, "an unrunnable scan must not claim either verdict"
    assert "not installed" in detail
    # A skip that does not say how to stop skipping stays skipped forever.
    assert "install.sh" in detail


# ── ordinary outcomes ────────────────────────────────────────────────────────

def test_clean_repository_passes(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"a.txt": "hello\n"})
    bindir = _stub_broker(
        tmp_path, 'echo \'{"findings": [], "suppressed": [], "scanned": 1}\'\nexit 0\n')
    _use(monkeypatch, repo, bindir)

    ok, detail = conformance.r9_no_secrets()

    assert ok is True, detail
    assert "no plaintext credential" in detail


def test_one_finding_is_reported_as_one_file_and_names_it(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"a.txt": "hello\n"})
    payload = json.dumps({
        "findings": [{"file": "config/prod.env", "line": 4, "kind": "AWS access key id"}],
        "suppressed": [], "scanned": 1})
    bindir = _stub_broker(tmp_path, "cat <<'EOF'\n%s\nEOF\nexit 1\n" % payload)
    _use(monkeypatch, repo, bindir)

    ok, detail = conformance.r9_no_secrets()

    assert ok is False
    # The prose parse counted rapp-keyring's own remediation advice as a hit and
    # turned one finding into two.
    assert "1 credential-shaped value(s) in 1 file(s)" in detail
    assert "config/prod.env" in detail


def test_pragma_suppressions_are_surfaced_rather_than_silently_dropped(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"a.txt": "hello\n"})
    payload = json.dumps({
        "findings": [],
        "suppressed": [{"file": "t.ts", "line": 9, "kind": "Slack token",
                        "reason": "mock fixture"}],
        "scanned": 1})
    bindir = _stub_broker(tmp_path, "cat <<'EOF'\n%s\nEOF\nexit 0\n" % payload)
    _use(monkeypatch, repo, bindir)

    ok, detail = conformance.r9_no_secrets()

    assert ok is True
    # Deliberate suppressions are legitimate, but an invisible one is a place to
    # hide a real credential behind a comment.
    assert "1 suppressed" in detail


# ── the contract we are relying on, checked against the real tool ────────────

REAL_BROKER = conformance.keyring_broker()
needs_broker = pytest.mark.skipif(
    REAL_BROKER is None,
    reason="rapp-keyring not installed; CI installs it and runs these")


@needs_broker
def test_real_broker_honours_the_json_contract_r9_depends_on(tmp_path):
    planted = tmp_path / "creds.txt"
    planted.write_text("aws_access_key_id = %s\n" % FAKE_AWS_KEY)

    proc = subprocess.run([REAL_BROKER, "scan", "--json", str(planted)],
                          capture_output=True, text=True)

    assert proc.returncode == 1, "a hit must exit 1; R9 treats other codes as broken"
    report = json.loads(proc.stdout)
    assert len(report["findings"]) == 1
    assert report["findings"][0]["kind"] == "AWS access key id"
    # It reports where, never the value.
    assert FAKE_AWS_KEY not in proc.stdout


@needs_broker
def test_real_broker_exits_zero_on_a_clean_file(tmp_path):
    clean = tmp_path / "clean.txt"
    clean.write_text("nothing credential-shaped here\n")

    proc = subprocess.run([REAL_BROKER, "scan", "--json", str(clean)],
                          capture_output=True, text=True)

    assert proc.returncode == 0
    assert json.loads(proc.stdout)["findings"] == []


@needs_broker
def test_r9_end_to_end_catches_a_credential_committed_to_a_repo(tmp_path, monkeypatch):
    """The whole check, the real broker, a real git checkout."""
    repo = _git_repo(tmp_path / "repo", {
        "ok.txt": "nothing here\n",
        "leak.env": "aws_access_key_id = %s\n" % FAKE_AWS_KEY,
    })
    monkeypatch.setattr(conformance, "ROOT", str(repo))

    ok, detail = conformance.r9_no_secrets()

    assert ok is False, "R9 did not catch a credential in a tracked file: %s" % detail
    assert "leak.env" in detail
    assert "1 credential-shaped value(s) in 1 file(s)" in detail
    assert FAKE_AWS_KEY not in detail


@needs_broker
def test_r9_passes_on_a_repo_with_nothing_to_find(tmp_path, monkeypatch):
    repo = _git_repo(tmp_path / "repo", {"ok.txt": "nothing here\n"})
    monkeypatch.setattr(conformance, "ROOT", str(repo))

    ok, detail = conformance.r9_no_secrets()

    assert ok is True, detail
    assert "1 tracked files scanned" in detail
