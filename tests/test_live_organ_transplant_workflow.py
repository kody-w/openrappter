import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CI_PATH = ROOT / ".github" / "workflows" / "ci.yml"
COLD_PATH = ROOT / ".github" / "workflows" / "live-organ-transplant-cold.yml"
FORBIDDEN_CREDENTIAL_MARKERS = (
    "secrets.",
    "ANTHROPIC",
    "OPENAI",
    "AZURE",
    "COPILOT_TOKEN",
    "API_KEY",
    "MODEL_TOKEN",
    "PROVIDER_TOKEN",
)


def job_block(source: str, job_name: str) -> str:
    marker = f"  {job_name}:\n"
    start = source.index(marker)
    next_job = re.search(
        r"^  [a-zA-Z0-9_-]+:\s*$",
        source[start + len(marker) :],
        re.MULTILINE,
    )
    end = len(source) if next_job is None else start + len(marker) + next_job.start()
    return source[start:end]


class LiveOrganTransplantWorkflowTests(unittest.TestCase):
    def test_required_gate_is_fail_hard_on_exact_supported_platforms(self) -> None:
        source = CI_PATH.read_text(encoding="utf-8")
        job = job_block(source, "flagship-transplant")

        self.assertIn("os: [ubuntu-latest, macos-latest]", job)
        self.assertEqual(job.count("ubuntu-latest"), 1)
        self.assertEqual(job.count("macos-latest"), 1)
        self.assertNotIn("windows", job.lower())
        self.assertIn("runs-on: ${{ matrix.os }}", job)
        self.assertNotIn("continue-on-error:", job)
        self.assertNotRegex(job, r"(?m)^\s+if:")
        self.assertNotRegex(job, r"(?m)^\s+env:")

    def test_required_gate_pins_node_python_and_command_order(self) -> None:
        source = CI_PATH.read_text(encoding="utf-8")
        job = job_block(source, "flagship-transplant")

        self.assertIn("actions/setup-node@v4", job)
        self.assertIn("node-version: 22", job)
        self.assertIn("actions/setup-python@v5", job)
        self.assertIn("python-version: '3.12'", job)
        self.assertEqual(job.count("npm run gate:transplant"), 1)
        self.assertEqual(
            re.findall(r"(?m)^        run: npm run gate:transplant$", job),
            ["        run: npm run gate:transplant"],
        )

        install = job.index("run: npm ci")
        build = job.index("run: npm run build")
        gate = job.index("run: npm run gate:transplant")
        self.assertLess(install, build)
        self.assertLess(build, gate)

    def test_required_gate_has_no_provider_credentials(self) -> None:
        job = job_block(CI_PATH.read_text(encoding="utf-8"), "flagship-transplant")
        for marker in FORBIDDEN_CREDENTIAL_MARKERS:
            self.assertNotIn(marker, job)

    def test_cold_path_is_separate_measured_and_non_releasing(self) -> None:
        source = COLD_PATH.read_text(encoding="utf-8")
        job = job_block(source, "cold-transplant")

        self.assertIn("workflow_dispatch: {}", source)
        self.assertIn("schedule:", source)
        self.assertNotRegex(source, r"(?m)^\s+push:")
        self.assertNotRegex(source, r"(?m)^\s+pull_request:")
        self.assertNotRegex(source, r"(?i)(npm publish|git push|gh release|create-release)")
        self.assertIn("os: [ubuntu-latest, macos-latest]", job)
        self.assertNotIn("cache: npm", job)
        self.assertIn('rm -rf "$cache"', job)
        self.assertIn('npm ci --cache "$cache" --prefer-online', job)
        self.assertEqual(job.count("duration_ms=$(((finished - started) / 1000000))"), 3)
        self.assertNotIn("continue-on-error:", job)
        self.assertNotRegex(job, r"(?m)^\s+env:")

        gate = job.index("npm run gate:transplant")
        budget = job.index("total_ms=$((install_ms + build_ms + runtime_ms))")
        threshold = job.index("total_ms > 300000")
        self.assertLess(gate, budget)
        self.assertLess(budget, threshold)
        self.assertIn("if: failure()", job)
        self.assertIn(".test-scratch/live-organ-transplant", job)
        for marker in FORBIDDEN_CREDENTIAL_MARKERS:
            self.assertNotIn(marker, job)


if __name__ == "__main__":
    unittest.main()
