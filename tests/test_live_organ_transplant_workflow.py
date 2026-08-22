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
    "BEDROCK",
    "COHERE",
    "GEMINI",
    "MISTRAL",
    "VERTEX",
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


def step_block(job: str, step_name: str) -> str:
    marker = f"      - name: {step_name}\n"
    start = job.index(marker)
    next_step = re.search(r"^      - ", job[start + len(marker) :], re.MULTILINE)
    end = len(job) if next_step is None else start + len(marker) + next_step.start()
    return job[start:end]


def matrix_rows(job: str) -> list[tuple[str, str, str, str]]:
    return re.findall(
        r"(?m)^          - name: ([^\n]+)\n"
        r"            os: ([^\n]+)\n"
        r"            node-version: '([^']+)'\n"
        r"            python-version: '([^']+)'$",
        job,
    )


class LiveOrganTransplantWorkflowTests(unittest.TestCase):
    def assert_no_credentials(self, job: str) -> None:
        self.assertNotRegex(job, r"(?m)^\s+env:")
        for marker in FORBIDDEN_CREDENTIAL_MARKERS:
            self.assertNotIn(marker, job)

    def test_required_matrix_covers_floor_and_current_without_windows(self) -> None:
        job = job_block(CI_PATH.read_text(encoding="utf-8"), "flagship-transplant")

        self.assertEqual(
            matrix_rows(job),
            [
                ("ubuntu-floor", "ubuntu-latest", "20.9.0", "3.10"),
                ("ubuntu-current", "ubuntu-latest", "22", "3.12"),
                ("macos-current", "macos-latest", "22", "3.12"),
            ],
        )
        self.assertIn("runs-on: ${{ matrix.os }}", job)
        self.assertIn("node-version: ${{ matrix.node-version }}", job)
        self.assertIn("python-version: ${{ matrix.python-version }}", job)
        self.assertNotIn("windows", job.lower())
        self.assertNotIn("continue-on-error:", job)

    def test_required_job_runs_exact_journey_contracts_and_deep_gate(self) -> None:
        job = job_block(CI_PATH.read_text(encoding="utf-8"), "flagship-transplant")

        self.assertEqual(job.count("./quickstart.sh --demo live-organ-transplant"), 2)
        self.assertRegex(
            job,
            r"(?m)^            \./quickstart\.sh --demo live-organ-transplant$",
        )
        self.assertIn(
            "run: python -B -m unittest tests/test_live_organ_transplant_workflow.py",
            job,
        )
        self.assertIn(
            "run: bash tests/live-organ-transplant-quickstart.test.sh",
            job,
        )
        self.assertIn("run: bash tests/test_transplant_trust_boundary.sh", job)
        self.assertIn("run: npm run gate:transplant", job)
        self.assertNotRegex(job, r"(?m)^\s+run: npm ci(?:\s|$)")
        self.assertNotRegex(job, r"(?m)^\s+run: npm run build(?:\s|$)")
        self.assertNotIn("defaults:", job)

        quickstart = job.index("./quickstart.sh --demo live-organ-transplant")
        workflow_contract = job.index("tests/test_live_organ_transplant_workflow.py")
        contract = job.index("tests/live-organ-transplant-quickstart.test.sh")
        trust = job.index("tests/test_transplant_trust_boundary.sh")
        gate = job.index("run: npm run gate:transplant")
        self.assertLess(quickstart, workflow_contract)
        self.assertLess(workflow_contract, contract)
        self.assertLess(quickstart, contract)
        self.assertLess(contract, trust)
        self.assertLess(trust, gate)

    def test_required_timing_is_bounded_and_always_uploaded(self) -> None:
        job = job_block(CI_PATH.read_text(encoding="utf-8"), "flagship-transplant")
        timed = step_block(
            job,
            "Run exact quickstart (checkout/runtime setup excluded)",
        )
        upload = step_block(job, "Upload quickstart timing evidence")

        self.assertIn("timeout-minutes: 6", timed)
        self.assertNotIn("working-directory:", timed)
        self.assertIn("elapsed_ms > 300000", timed)
        self.assertIn('"budgetMs":300000', timed)
        self.assertIn('"checkoutAndRuntimeSetupExcluded":true', timed)
        self.assertIn("if: always()", upload)
        self.assertIn("if-no-files-found: error", upload)
        self.assertIn("live-organ-transplant-quickstart-timing.json", upload)

    def test_required_job_is_fail_hard_and_credential_free(self) -> None:
        job = job_block(CI_PATH.read_text(encoding="utf-8"), "flagship-transplant")

        self.assertNotIn("continue-on-error:", job)
        self.assertNotIn("|| true", job)
        self.assert_no_credentials(job)

    def test_cold_path_measures_the_exact_user_flow_without_prebuilding(self) -> None:
        source = COLD_PATH.read_text(encoding="utf-8")
        job = job_block(source, "cold-transplant")
        timed = step_block(
            job,
            "Measure exact cold quickstart (prerequisites excluded)",
        )

        self.assertIn("workflow_dispatch: {}", source)
        self.assertIn("schedule:", source)
        self.assertNotRegex(source, r"(?m)^\s+push:")
        self.assertNotRegex(source, r"(?m)^\s+pull_request:")
        self.assertIn("os: [ubuntu-latest, macos-latest]", job)
        self.assertNotIn("cache: npm", job)
        self.assertIn('rm -rf "$cold_cache"', job)
        self.assertRegex(
            timed,
            r"(?m)^            \./quickstart\.sh --demo live-organ-transplant$",
        )
        self.assertIn("timeout-minutes: 6", timed)
        self.assertIn("elapsed_ms > 300000", timed)
        self.assertIn('"budgetMs":300000', timed)
        self.assertNotRegex(job, r"(?m)^\s+run: npm ci(?:\s|$)")
        self.assertNotRegex(job, r"(?m)^\s+run: npm run build(?:\s|$)")
        self.assertIn("run: npm run gate:transplant", job)

    def test_cold_artifacts_cover_failure_cancel_and_all_timings(self) -> None:
        job = job_block(
            COLD_PATH.read_text(encoding="utf-8"),
            "cold-transplant",
        )
        failure_upload = step_block(
            job,
            "Upload failure or cancellation evidence",
        )
        timing_upload = step_block(job, "Upload cold timing evidence")

        self.assertIn("if: failure() || cancelled()", failure_upload)
        self.assertIn("live-organ-transplant-cold.log", failure_upload)
        self.assertIn(".test-scratch/live-organ-transplant", failure_upload)
        self.assertIn("if: always()", timing_upload)
        self.assertIn("if-no-files-found: error", timing_upload)
        self.assertIn("live-organ-transplant-cold-timing.json", timing_upload)
        self.assertNotIn("continue-on-error:", job)
        self.assert_no_credentials(job)


if __name__ == "__main__":
    unittest.main()
