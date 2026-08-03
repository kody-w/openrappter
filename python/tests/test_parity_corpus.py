"""The parity corpus is a gate, not a one-off report.

PARITY §5/§6 mark both the golden corpus and the harness PLANNED, so nothing in
the estate executes them. openrappter declares tier `core` in SPEC.md; this test
is what turns that from an assertion into something CI re-checks on every
change.

Running the corpus the first time found six normative divergences, including a
5-round tool loop where §2.2 freezes 3 and calls looping 5 times non-conformant
by name.
"""

import json
import subprocess
import sys
from pathlib import Path



ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "parity_harness.py"
VECTORS = ROOT / "parity_vectors"


def _run(tier, report=None):
    cmd = [sys.executable, str(HARNESS), "--tier", tier]
    if report:
        cmd += ["--report", str(report)]
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300)


class TestParityCorpus:
    def test_corpus_covers_every_required_class(self):
        """§5.3 names fourteen classes; a corpus missing one cannot attest."""
        required = {
            "empty-input-400", "no-agents-passthrough", "single-tool-then-answer",
            "parallel-tool-calls", "multi-round-tools", "round-cap-3",
            "bad-arguments-fallback", "agent-not-found", "agent-raises",
            "history-role-filter", "system-context-injection",
            "finish-reason-agnostic-trigger", "session-id-minted",
            "voice-sentinel-split",
        }
        present = {
            json.loads(p.read_text(encoding="utf-8"))["name"]
            for p in VECTORS.glob("*.json") if p.name != "CORPUS.json"
        }
        assert present == required

    def test_corpus_digest_matches_the_vectors_on_disk(self):
        """A stale digest would let a runtime attest to a corpus it did not run."""
        import hashlib

        def canonical(obj):
            return json.dumps(
                obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()

        manifest = json.loads((VECTORS / "CORPUS.json").read_text(encoding="utf-8"))
        for path in VECTORS.glob("*.json"):
            if path.name == "CORPUS.json":
                continue
            vector = json.loads(path.read_text(encoding="utf-8"))
            digest = hashlib.sha256(canonical(vector)).hexdigest()
            assert manifest["vectors"][vector["name"]] == digest, vector["name"]

        lines = "\n".join(
            f"{name} {digest}" for name, digest in sorted(manifest["vectors"].items())
        )
        assert manifest["corpus_sha256"] == hashlib.sha256(lines.encode()).hexdigest()

    def test_core_tier_passes(self, tmp_path):
        report_path = tmp_path / "report.json"
        result = _run("core", report_path)
        assert result.returncode == 0, result.stdout + result.stderr
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert report["summary"]["failed"] == 0, report["results"]
        assert report["summary"]["tier_satisfied"] is True

    def test_full_tier_passes(self, tmp_path):
        report_path = tmp_path / "report.json"
        result = _run("full", report_path)
        assert result.returncode == 0, result.stdout + result.stderr
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert report["summary"]["total"] == 14
        assert report["summary"]["failed"] == 0, report["results"]
