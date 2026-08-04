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

import pytest



ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "parity_harness.py"
VECTORS = ROOT / "parity_vectors"


def _run(tier, report=None, runtime="python"):
    cmd = [sys.executable, str(HARNESS), "--tier", tier, "--runtime", runtime]
    if report:
        cmd += ["--report", str(report)]
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)


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

    def test_tier_comes_from_spec_md_not_a_constant(self):
        """The declaration and the test must not be able to drift apart.

        A hardcoded tier would let SPEC.md be edited to claim `full` while CI
        went on proving `core`, and the badge would stay green.
        """
        sys.path.insert(0, str(ROOT))
        import parity_harness

        assert parity_harness.declared_tier() == "core"
        spec = (ROOT / "SPEC.md").read_text(encoding="utf-8")
        assert "Declared parity tier: `core`" in spec

    def test_python_runtime_passes_its_declared_tier(self, tmp_path):
        report_path = tmp_path / "report.json"
        result = _run("core", report_path, runtime="python")
        assert result.returncode == 0, result.stdout + result.stderr
        report = json.loads(report_path.read_text(encoding="utf-8"))
        block = report["runtimes"]["python"]["summary"]
        assert block["failed"] == 0, report["runtimes"]["python"]["results"]
        # Never folded into `passed`: a silent skip is the failure the corpus
        # exists to prevent.
        assert block["not_executed"] == 0
        assert report["summary"]["tier_satisfied"] is True

    def test_full_tier_passes_on_both_runtimes(self, tmp_path):
        """Parity means the two runtimes agree, not that one of them works.

        Needs the TypeScript build, which the Python CI job does not produce.
        Skipping is safe *only* because this is not the enforcement point: the
        `parity` job in `.github/workflows/rapp-conformance.yml` builds both and
        runs exactly this command on every push and pull request, and fails the
        build. If that job is ever removed, this skip stops being harmless — so
        the skip reason names it.
        """
        ts_build = ROOT / "typescript/dist/agents/Assistant.js"
        if not ts_build.exists():
            pytest.skip(
                "typescript/dist is not built; the both-runtimes assertion is "
                "enforced by the `parity` job in rapp-conformance.yml, which "
                "builds it. Run `cd typescript && npm ci && npm run build` to "
                "exercise it here."
            )
        report_path = tmp_path / "report.json"
        result = _run("full", report_path, runtime="both")
        assert result.returncode == 0, result.stdout + result.stderr
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert set(report["summary"]["runtimes_measured"]) == {"python", "typescript"}
        for name in ("python", "typescript"):
            block = report["runtimes"][name]["summary"]
            assert block["total"] == 14, name
            assert block["failed"] == 0, (name, report["runtimes"][name]["results"])
            assert block["not_executed"] == 0, name
